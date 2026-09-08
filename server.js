/*
 * CLAIA backend — real server, real database, real audit logging.
 *
 * ONE THING LEFT FOR YOU TO DO to make generation actually work:
 *
 *   1. Get a FREE Gemini API key at https://aistudio.google.com/apikey
 *      (sign in with a Google account — no credit card needed)
 *   2. Copy .env.example to .env and paste it in as GEMINI_API_KEY=...
 *   3. That's it — routes/factsheets.js is already wired to call Gemini.
 *
 *   If Google ever retires the "gemini-3.6-flash" free model, check the
 *   current free-tier list at https://ai.google.dev/gemini-api/docs/pricing
 *   and update the MODEL constant near the top of
 *   callClaudeToGenerateFactSheet() in routes/factsheets.js.
 */

require("dotenv").config();
const express = require("express");
const factSheetsRouter = require("./routes/factsheets");

const app = express();
app.use(express.json());

// Allow browser-based clients (the demo UI) to call this API from a
// different origin. Open to any origin for now, since this is a prototype
// with no real patient data — tighten this to specific domains before any
// real deployment.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/api/factsheets", factSheetsRouter);

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`CLAIA backend running on http://localhost:${PORT}`);
  console.log(`Try: curl http://localhost:${PORT}/health`);
});
