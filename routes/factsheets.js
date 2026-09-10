const express = require("express");
const crypto = require("crypto");
const { pool, logAudit } = require("../db");
const { lookupMedlinePlus, searchRxNorm } = require("../lib/grounding");

const router = express.Router();

// --- Generate a new draft fact sheet ---
// POST /api/factsheets
// body: { diagnosis, careContext, readingLevel, language, meds, labs, allergies, dietTags, requestedBy }
router.post("/", async (req, res) => {
  const { diagnosis, careContext, readingLevel, language, requestedBy, meds = [] } = req.body;
  if (!diagnosis || !diagnosis.trim()) {
    return res.status(400).json({ error: "diagnosis is required" });
  }

  try {
    const medline = await lookupMedlinePlus(diagnosis);

    // Ground each ACTIVE medication against RxNorm (NIH) — confirms the name
    // is a real, recognized drug and surfaces its official RxNorm-listed
    // name/strength, which we hand to the model as reference, not a
    // replacement for a licensed dosing source.
    const activeMedNames = meds.filter((m) => m.name && m.status !== "inactive").map((m) => m.name);
    const rxnormResults = {};
    for (const medName of activeMedNames) {
      rxnormResults[medName] = await searchRxNorm(medName, 3);
    }

    const generated = await callClaudeToGenerateFactSheet({
      diagnosis,
      careContext,
      readingLevel,
      language,
      medlineContext: medline,
      rxnormContext: rxnormResults,
      body: req.body,
    });

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO fact_sheets (id, patient_diagnosis, care_context, reading_level, language, content_json, status, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8)`,
      [id, diagnosis, careContext, readingLevel, language, JSON.stringify(generated), now, requestedBy || "unknown"]
    );

    await logAudit(id, "generated", requestedBy, { diagnosis, careContext, groundedInMedlinePlus: !!medline });

    res.json({ id, status: "draft", content: generated, medlineGrounding: medline, rxnormGrounding: rxnormResults });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Generation failed" });
  }
});

// --- Get a fact sheet + its full audit history ---
// GET /api/factsheets/:id
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM fact_sheets WHERE id = $1`, [req.params.id]);
    const sheet = result.rows[0];
    if (!sheet) return res.status(404).json({ error: "not found" });
    const historyResult = await pool.query(
      `SELECT action, actor, detail_json, occurred_at FROM audit_log WHERE fact_sheet_id = $1 ORDER BY occurred_at ASC`,
      [req.params.id]
    );
    await logAudit(req.params.id, "viewed", req.query.viewer || "unknown");
    res.json({ ...sheet, content: JSON.parse(sheet.content_json), history: historyResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Lookup failed" });
  }
});

// --- Edit a section (logs a real before/after diff, reopens if previously approved) ---
// PUT /api/factsheets/:id/section
// body: { sectionKey, newValue, editedBy }
router.put("/:id/section", async (req, res) => {
  try {
    const { sectionKey, newValue, editedBy } = req.body;
    const result = await pool.query(`SELECT * FROM fact_sheets WHERE id = $1`, [req.params.id]);
    const sheet = result.rows[0];
    if (!sheet) return res.status(404).json({ error: "not found" });

    const content = JSON.parse(sheet.content_json);
    const before = content.sections?.[sectionKey];
    content.sections[sectionKey] = newValue;

    const wasApproved = sheet.status === "approved";
    const newStatus = "draft"; // any edit reopens for re-approval — this IS the correct behavior, not a bug

    await pool.query(
      `UPDATE fact_sheets SET content_json = $1, status = $2, approved_by = NULL, approved_at = NULL WHERE id = $3`,
      [JSON.stringify(content), newStatus, req.params.id]
    );

    await logAudit(req.params.id, wasApproved ? "reopened" : "edited", editedBy, {
      section: sectionKey,
      before,
      after: newValue,
      reopenedFromApproved: wasApproved,
    });

    res.json({ id: req.params.id, status: newStatus, content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Edit failed" });
  }
});

// --- Approve (the actual sign-off gate) ---
// POST /api/factsheets/:id/approve
// body: { approvedBy }
router.post("/:id/approve", async (req, res) => {
  try {
    const { approvedBy } = req.body;
    if (!approvedBy || !approvedBy.trim()) {
      return res.status(400).json({ error: "approvedBy is required — no anonymous approvals" });
    }
    const result = await pool.query(`SELECT * FROM fact_sheets WHERE id = $1`, [req.params.id]);
    const sheet = result.rows[0];
    if (!sheet) return res.status(404).json({ error: "not found" });

    const now = new Date().toISOString();
    await pool.query(`UPDATE fact_sheets SET status = 'approved', approved_by = $1, approved_at = $2 WHERE id = $3`, [
      approvedBy,
      now,
      req.params.id,
    ]);
    await logAudit(req.params.id, "approved", approvedBy, { approvedAt: now });

    res.json({ id: req.params.id, status: "approved", approvedBy, approvedAt: now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Approval failed" });
  }
});

// Real Google Gemini API call — requires GEMINI_API_KEY in your .env file.
// Uses Gemini's free tier (Flash model): no credit card required.
// Get a key at https://aistudio.google.com/apikey
async function callClaudeToGenerateFactSheet({ diagnosis, careContext, readingLevel, language, medlineContext, rxnormContext, body }) {
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

  // RxNorm (NIH) confirms each medication is a real, recognized drug name
  // and its official listed strength/form. This is a name/existence check,
  // NOT a dosing authority — it tells the model "this drug name is real
  // and commonly comes in these forms," not "this is the correct dose for
  // this patient." The model is told that explicitly below.
  const rxnormLines = Object.entries(rxnormContext || {})
    .map(([medName, matches]) => {
      if (!matches || matches.length === 0) return `- "${medName}": not found in RxNorm — verify this is a real, correctly-spelled medication name.`;
      return `- "${medName}" matches RxNorm entries: ${matches.join(" | ")}`;
    })
    .join("\n");
  const medGrounding = rxnormLines
    ? `RxNorm (NIH) medication name check:\n${rxnormLines}\nThis confirms drug names/forms exist — it is NOT a dosing source. Never state a specific dose as "confirmed" or "verified" based on this; only use doses the physician actually entered above.`
    : "";

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

${medGrounding}

Generate the fact sheet JSON now.`;

  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set. Add it to your .env file — see server.js for how to get one (it's free).");
  }

  // Free-tier Gemini Flash model. If this specific model ID ever stops
  // working, check the current free-tier model list at
  // https://ai.google.dev/gemini-api/docs/pricing and swap the name below.
  const MODEL = "gemini-3.6-flash";
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

// --- Public, read-only view for patients ---
// GET /api/factsheets/:id/public
// Only ever returns APPROVED sheets, with a minimal patient-facing shape —
// never exposes drafts, internal audit history, or who requested generation.
router.get("/:id/public", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT patient_diagnosis, care_context, content_json, status, approved_by, approved_at FROM fact_sheets WHERE id = $1`,
      [req.params.id]
    );
    const sheet = result.rows[0];
    // Deliberately vague error for both "doesn't exist" and "not approved yet" —
    // don't leak which case it is to an unauthenticated visitor.
    if (!sheet || sheet.status !== "approved") {
      return res.status(404).json({ error: "This fact sheet is not available." });
    }
    await logAudit(req.params.id, "viewed_by_patient", "patient_link", {});
    res.json({
      diagnosis: sheet.patient_diagnosis,
      careContext: sheet.care_context,
      content: JSON.parse(sheet.content_json),
      approvedBy: sheet.approved_by,
      approvedAt: sheet.approved_at,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading this." });
  }
});

module.exports = router;
