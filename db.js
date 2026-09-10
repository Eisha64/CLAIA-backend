const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn("[db] WARNING: DATABASE_URL is not set. Set it to your Render Postgres connection string, or the app will fail on first query.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fact_sheets (
      id TEXT PRIMARY KEY,
      patient_diagnosis TEXT NOT NULL,
      care_context TEXT NOT NULL,
      reading_level TEXT NOT NULL,
      language TEXT NOT NULL,
      content_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      created_by TEXT,
      approved_by TEXT,
      approved_at TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      fact_sheet_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT,
      detail_json TEXT,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (fact_sheet_id) REFERENCES fact_sheets(id)
    );
  `);
  console.log("[db] Schema ready (Postgres)");
}

async function logAudit(factSheetId, action, actor, detail) {
  await pool.query(
    `INSERT INTO audit_log (fact_sheet_id, action, actor, detail_json, occurred_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [factSheetId, action, actor || "unknown", detail ? JSON.stringify(detail) : null, new Date().toISOString()]
  );
}

module.exports = { pool, initSchema, logAudit };
