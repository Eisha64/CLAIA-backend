const express = require("express");
const crypto = require("crypto");
const { db, logAudit } = require("../db");
const { lookupMedlinePlus } = require("../lib/grounding");

const router = express.Router();

// --- Generate a new draft fact sheet ---
// POST /api/factsheets
// body: { diagnosis, careContext, readingLevel, language, meds, labs, allergies, dietTags, requestedBy }
router.post("/", async (req, res) => {
  const { diagnosis, careContext, readingLevel, language, requestedBy } = req.body;
  if (!diagnosis || !diagnosis.trim()) {
    return res.status(400).json({ error: "diagnosis is required" });
  }

  try {
    const medline = await lookupMedlinePlus(diagnosis);

    // NOTE: real Claude API call goes here, using process.env.ANTHROPIC_API_KEY
    // and the anthropic-version header, since this is now a real standalone
    // server (not the in-chat artifact bridge, which needed neither).
    // Wiring the actual call is the one piece left for you to complete with
    // your own API key from console.anthropic.com — see server.js comment.
    const generated = await callClaudeToGenerateFactSheet({
      diagnosis,
      careContext,
      readingLevel,
      language,
      medlineContext: medline,
      body: req.body,
    });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO fact_sheets (id, patient_diagnosis, care_context, reading_level, language, content_json, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
    ).run(id, diagnosis, careContext, readingLevel, language, JSON.stringify(generated), now, requestedBy || "unknown");

    logAudit(id, "generated", requestedBy, { diagnosis, careContext, groundedInMedlinePlus: !!medline });

    res.json({ id, status: "draft", content: generated, medlineGrounding: medline });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Generation failed" });
  }
});

// --- Get a fact sheet + its full audit history ---
// GET /api/factsheets/:id
router.get("/:id", (req, res) => {
  const sheet = db.prepare(`SELECT * FROM fact_sheets WHERE id = ?`).get(req.params.id);
  if (!sheet) return res.status(404).json({ error: "not found" });
  const history = db
    .prepare(`SELECT action, actor, detail_json, occurred_at FROM audit_log WHERE fact_sheet_id = ? ORDER BY occurred_at ASC`)
    .all(req.params.id);
  logAudit(req.params.id, "viewed", req.query.viewer || "unknown");
  res.json({ ...sheet, content: JSON.parse(sheet.content_json), history });
});

// --- Edit a section (logs a real before/after diff, reopens if previously approved) ---
// PUT /api/factsheets/:id/section
// body: { sectionKey, newValue, editedBy }
router.put("/:id/section", (req, res) => {
  const { sectionKey, newValue, editedBy } = req.body;
  const sheet = db.prepare(`SELECT * FROM fact_sheets WHERE id = ?`).get(req.params.id);
  if (!sheet) return res.status(404).json({ error: "not found" });

  const content = JSON.parse(sheet.content_json);
  const before = content.sections?.[sectionKey];
  content.sections[sectionKey] = newValue;

  const wasApproved = sheet.status === "approved";
  const newStatus = "draft"; // any edit reopens for re-approval — this IS the correct behavior, not a bug

  db.prepare(`UPDATE fact_sheets SET content_json = ?, status = ?, approved_by = NULL, approved_at = NULL WHERE id = ?`)
    .run(JSON.stringify(content), newStatus, req.params.id);

  logAudit(req.params.id, wasApproved ? "reopened" : "edited", editedBy, {
    section: sectionKey,
    before,
    after: newValue,
    reopenedFromApproved: wasApproved,
  });

  res.json({ id: req.params.id, status: newStatus, content });
});

// --- Approve (the actual sign-off gate) ---
// POST /api/factsheets/:id/approve
// body: { approvedBy }
router.post("/:id/approve", (req, res) => {
  const { approvedBy } = req.body;
  if (!approvedBy || !approvedBy.trim()) {
    return res.status(400).json({ error: "approvedBy is required — no anonymous approvals" });
  }
  const sheet = db.prepare(`SELECT * FROM fact_sheets WHERE id = ?`).get(req.params.id);
  if (!sheet) return res.status(404).json({ error: "not found" });

  const now = new Date().toISOString();
  db.prepare(`UPDATE fact_sheets SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`).run(
    approvedBy,
    now,
    req.params.id
  );
  logAudit(req.params.id, "approved", approvedBy, { approvedAt: now });

  res.json({ id: req.params.id, status: "approved", approvedBy, approvedAt: now });
});

// Real Google Gemini API call — requires GEMINI_API_KEY in your .env file.
// Uses Gemini's free tier (Flash model): no credit card required.
// Get a key at https://aistudio.google.com/apikey
async function callClaudeToGenerateFactSheet({ diagnosis, careContext, readingLevel, language, medlineContext, body }) {
  const { meds = [], labs = [], allergies = "", dietTags = [], patientAge, patientSex } = body;

  const CARE_FRAMING = {
    newDiagnosis: `Care setting: NEW DIAGNOSIS at a primary care visit. Assume the patient has just been told they have this condition and knows little or nothing about it. Explain what it is and why it matters — this is their foundational introduction, not a reminder.`,
    followUp: `Care setting: ROUTINE FOLLOW-UP visit. Do NOT re-explain the disease from scratch. Focus on what's changed since last visit and what's being adjusted.`,
    discharge: `Care setting: HOSPITAL DISCHARGE after an acute admission. Focus on the immediate recovery window — the next few days to weeks — not general long-term disease education.`,
  };

  const medList = meds.filter((m) => m.name && m.status !== "inactive").map((m) => `- ${m.name}${m.dose ? ` (${m.dose})` : ""}`).join("\n") || "None listed";
  const labList = labs.filter((l) => l.name).map((l) => `- ${l.name}: ${l.value || "n/a"} [${l.flag}]`).join("\n") || "None listed";
  const grounding = medlineContext
    ? `Reference from MedlinePlus on "${medlineContext.title}": ${medlineContext.snippet}\nUse this as grounding, restated in your own words — do not quote directly.`
    : `No MedlinePlus reference found — rely on well-established mainstream clinical knowledge and be conservative.`;

  const systemPrompt = `You are a clinical patient-education assistant drafting a discharge fact sheet as a scannable "cheat sheet" poster. Output is ALWAYS reviewed by a physician before reaching a patient.

${CARE_FRAMING[careContext] || CARE_FRAMING.discharge}

Rules:
- Write at a ${readingLevel} reading level, in ${language}.
- Be specific to the actual diagnosis/meds/labs given — never generic filler.
- Never invent lab values, dosing instructions, or numeric facts you're not confident about.
- For each section, write 2-4 bullets: a short bold "label" (2-4 words) and a short "detail" (one sentence, under 20 words).
- If ONE number/target is worth calling out big, set "highlight" (under 8 words); otherwise null.
- Respond with ONLY valid JSON, no markdown fences:
{"diagnosisLabel":"string","sections":{"overview":{"highlight":"string|null","bullets":[{"label":"string","detail":"string"}]},"medications":{...},"diet":{...},"lifestyle":{...},"dos":{...},"donts":{...},"redFlags":{...}}}`;

  const userPrompt = `Diagnosis: ${diagnosis}
Age/Sex: ${patientAge || "n/a"} / ${patientSex || "n/a"}
Allergies: ${allergies || "None listed"}
Dietary/cultural context: ${dietTags.join(", ") || "None specified"}

Medications:
${medList}

Labs:
${labList}

${grounding}

Generate the fact sheet JSON now.`;

  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set. Add it to your .env file — see server.js for how to get one (it's free).");
  }

  // Free-tier Gemini Flash model. If this specific model ID ever stops
  // working, check the current free-tier model list at
  // https://ai.google.dev/gemini-api/docs/pricing and swap the name below.
  const MODEL = "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: 4000, temperature: 0.4 },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    const blockReason = data.candidates?.[0]?.finishReason;
    throw new Error(`No text in Gemini response${blockReason ? ` (finishReason: ${blockReason})` : ""}.`);
  }

  let cleaned = rawText.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  return JSON.parse(cleaned);
}

module.exports = router;
