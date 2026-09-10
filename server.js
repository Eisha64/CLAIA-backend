/*
 * CLAIA backend — real server, real Postgres database, real audit logging.
 *
 * TWO THINGS LEFT FOR YOU TO DO:
 *
 *   1. Create a free Postgres database on Render:
 *      Dashboard → New + → "Create a Postgres database" → free tier.
 *      Once created, copy its "Internal Database URL" and add it as an
 *      environment variable on THIS web service named DATABASE_URL.
 *      (Free Render Postgres expires after 30 days — fine for continued
 *      prototyping, just know you'll need to recreate it after that.)
 *
 *   2. Get a FREE Gemini API key at https://aistudio.google.com/apikey
 *      (sign in with a Google account — no credit card needed), add it
 *      as GEMINI_API_KEY.
 *
 *   If Google ever retires the "gemini-3.6-flash" free model, check the
 *   current free-tier list at https://ai.google.dev/gemini-api/docs/pricing
 *   and update the MODEL constant near the top of
 *   callClaudeToGenerateFactSheet() in routes/factsheets.js.
 */

require("dotenv").config();
const express = require("express");
const factSheetsRouter = require("./routes/factsheets");
const { initSchema } = require("./db");

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

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`CLAIA backend running on http://localhost:${PORT}`);
      console.log(`Try: curl http://localhost:${PORT}/health`);
    });
  })
  .catch((err) => {
    console.error("[startup] Failed to initialize database schema:", err.message);
    console.error("[startup] Check that DATABASE_URL is set correctly.");
    process.exit(1);
  });
