const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const db = new DatabaseSync(path.join(__dirname, "claia.db"));

// --- Schema ---
db.exec(`
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

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_sheet_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  detail_json TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (fact_sheet_id) REFERENCES fact_sheets(id)
);
`);

function logAudit(factSheetId, action, actor, detail) {
  db.prepare(
    `INSERT INTO audit_log (fact_sheet_id, action, actor, detail_json, occurred_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(factSheetId, action, actor || "unknown", detail ? JSON.stringify(detail) : null, new Date().toISOString());
}

module.exports = { db, logAudit };
