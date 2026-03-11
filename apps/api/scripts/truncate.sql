CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS training_feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  batch_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

DELETE FROM training_feedback;
DELETE FROM feedback_corrections;
DELETE FROM reconciliation_results;
DELETE FROM model_items;
DELETE FROM drawing_items;
DELETE FROM model_imports;
DELETE FROM legend_symbols;
DELETE FROM drawing_assets;
DELETE FROM projects;
DELETE FROM users;
