CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drawing_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS legend_symbols (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  notes TEXT,
  preview_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS model_imports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drawing_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  size TEXT NOT NULL,
  room TEXT NOT NULL,
  tag TEXT NOT NULL,
  qty INTEGER NOT NULL,
  confidence REAL NOT NULL,
  verification_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS model_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  import_id TEXT NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  size TEXT NOT NULL,
  room TEXT NOT NULL,
  tag TEXT NOT NULL,
  qty INTEGER NOT NULL,
  confidence REAL NOT NULL,
  verification_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (import_id) REFERENCES model_imports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reconciliation_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  drawing_item_id TEXT,
  model_item_id TEXT,
  status TEXT NOT NULL,
  resolution_notes TEXT NOT NULL,
  qty_drawing INTEGER NOT NULL,
  qty_model INTEGER NOT NULL,
  drawing_reference TEXT NOT NULL,
  model_reference TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feedback_corrections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_legend_symbols_project_id ON legend_symbols(project_id);
CREATE INDEX IF NOT EXISTS idx_drawing_assets_project_id ON drawing_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_drawing_items_project_id ON drawing_items(project_id);
CREATE INDEX IF NOT EXISTS idx_model_items_project_id ON model_items(project_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_results_project_id ON reconciliation_results(project_id);
CREATE INDEX IF NOT EXISTS idx_feedback_corrections_project_id ON feedback_corrections(project_id);
