import { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import * as XLSX from "xlsx";
import {
  computeAiProgress,
  extractDrawingItems,
  extractLegendSymbols,
  normalizeRow,
  reconcileRows,
  type DrawingAsset,
  type DrawingMtoItem,
  type FeedbackCorrection,
  type LegendSymbol,
  type ModelImport,
  type ModelMtoItem,
  type Project,
  type ProjectBundle,
  type ReconciliationResult,
  type TrainingBenchmark,
  type TrainingKnowledge,
  type TrainingSessionSummary,
  type UserProfile
} from "@hvac/shared";

type Bindings = {
  DB: D1Database;
  FILES: R2Bucket;
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  SESSION_SECRET: string;
};

type Variables = {
  sessionUser: UserProfile | null;
};

type Row = Record<string, string | number | null>;

const SESSION_COOKIE = "hvac_session";
const SESSION_ISSUER = "hvac-ai-engineer";
const SESSION_AUDIENCE = "hvac-web";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
let schemaReadyPromise: Promise<void> | null = null;

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use(
  "/api/*",
  cors({
    origin: (origin, c) => origin ?? c.env.APP_ORIGIN,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    credentials: true
  })
);

app.use("/api/*", async (c, next) => {
  await ensureAuthSchema(c.env.DB);
  const authorization = c.req.header("authorization");
  const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : null;
  const token = bearerToken || getCookie(c, SESSION_COOKIE);
  if (!token) {
    c.set("sessionUser", null);
    await next();
    return;
  }

  const user = await verifySessionToken(token, c.env).catch(() => null);
  c.set("sessionUser", user);

  if (!user) {
    clearSessionCookie(c);
  }

  await next();
});

const itemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  source: z.enum(["drawing", "model"]),
  type: z.enum(["duct", "fitting", "equipment", "accessory", "sensor_instrument", "other"]),
  description: z.string(),
  size: z.string(),
  room: z.string(),
  tag: z.string(),
  qty: z.number(),
  confidence: z.number(),
  verificationStatus: z.enum(["pending", "approved", "rejected", "edited"])
});

const legendSchema = z.object({
  name: z.string(),
  description: z.string(),
  notes: z.string().optional(),
  previewUrl: z.string().optional()
});

const googleCredentialSchema = z.object({
  credential: z.string().min(1)
});

function now() {
  return new Date().toISOString();
}

function getSessionSecret(env: Bindings) {
  return new TextEncoder().encode(env.SESSION_SECRET);
}

function isSecureRequest(c: Parameters<typeof getCookie>[0]) {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto === "https";
  }
  return new URL(c.req.url).protocol === "https:";
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string) {
  const secure = isSecureRequest(c);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: secure ? "None" : "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
  });
}

function clearSessionCookie(c: Parameters<typeof deleteCookie>[0]) {
  const secure = isSecureRequest(c);
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    secure,
    sameSite: secure ? "None" : "Lax"
  });
}

async function queryMany<T>(db: D1Database, sql: string, bindings: unknown[] = []): Promise<T[]> {
  const statement = db.prepare(sql).bind(...bindings);
  const result = await statement.all<T>();
  return result.results ?? [];
}

async function queryFirst<T>(db: D1Database, sql: string, bindings: unknown[] = []): Promise<T | null> {
  const rows = await queryMany<T>(db, sql, bindings);
  return rows[0] ?? null;
}

async function execute(db: D1Database, sql: string, bindings: unknown[] = []) {
  return db.prepare(sql).bind(...bindings).run();
}

async function ensureAuthSchema(db: D1Database) {
  if (schemaReadyPromise) {
    return schemaReadyPromise;
  }

  schemaReadyPromise = (async () => {
    await execute(
      db,
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    );

    await execute(
      db,
      `CREATE TABLE IF NOT EXISTS drawing_assets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_name TEXT NOT NULL,
        object_key TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )`
    );

    await execute(
      db,
      `CREATE TABLE IF NOT EXISTS legend_symbols (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        notes TEXT,
        preview_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )`
    );

    await execute(
      db,
      `CREATE TABLE IF NOT EXISTS model_imports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )`
    );

    await execute(
      db,
      `CREATE TABLE IF NOT EXISTS drawing_items (
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
      )`
    );

    await execute(
      db,
      `CREATE TABLE IF NOT EXISTS model_items (
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
      )`
    );

    await execute(
      db,
      `CREATE TABLE IF NOT EXISTS reconciliation_results (
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
      )`
    );

    await execute(
      db,
      `CREATE TABLE IF NOT EXISTS feedback_corrections (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        action TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )`
    );

    await execute(
      db,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        google_sub TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        picture_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    );

    await execute(
      db,
      `CREATE TABLE IF NOT EXISTS training_feedback (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        batch_id TEXT,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        action TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        context_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`
    );

    const projectColumns = await queryMany<{ name: string }>(db, "PRAGMA table_info(projects)");
    const hasOwnerColumn = projectColumns.some((column) => column.name === "owner_user_id");
    if (!hasOwnerColumn) {
      await execute(db, "ALTER TABLE projects ADD COLUMN owner_user_id TEXT");
    }

    const trainingFeedbackColumns = await queryMany<{ name: string }>(db, "PRAGMA table_info(training_feedback)");
    const hasBatchIdColumn = trainingFeedbackColumns.some((column) => column.name === "batch_id");
    if (!hasBatchIdColumn) {
      await execute(db, "ALTER TABLE training_feedback ADD COLUMN batch_id TEXT");
    }

    await execute(db, "CREATE INDEX IF NOT EXISTS idx_legend_symbols_project_id ON legend_symbols(project_id)");
    await execute(db, "CREATE INDEX IF NOT EXISTS idx_drawing_assets_project_id ON drawing_assets(project_id)");
    await execute(db, "CREATE INDEX IF NOT EXISTS idx_drawing_items_project_id ON drawing_items(project_id)");
    await execute(db, "CREATE INDEX IF NOT EXISTS idx_model_items_project_id ON model_items(project_id)");
    await execute(db, "CREATE INDEX IF NOT EXISTS idx_reconciliation_results_project_id ON reconciliation_results(project_id)");
    await execute(db, "CREATE INDEX IF NOT EXISTS idx_feedback_corrections_project_id ON feedback_corrections(project_id)");
    await execute(db, "CREATE INDEX IF NOT EXISTS idx_training_feedback_user_id ON training_feedback(user_id)");
    await execute(db, "CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)");
    await execute(db, "CREATE INDEX IF NOT EXISTS idx_projects_owner_user_id ON projects(owner_user_id)");
  })().catch((error) => {
    schemaReadyPromise = null;
    throw error;
  });

  return schemaReadyPromise;
}

function computeGlobalTrainingBenchmark(rows: Array<Row & { user_id: string; batch_id: string | null }>): TrainingBenchmark {
  const totalCorrections = rows.length;
  const approvedCount = rows.filter((row) => row.action === "approved").length;
  const correctedCount = rows.filter((row) => row.action === "rejected" || row.action === "edited").length;
  const currentAccuracy = totalCorrections === 0 ? 0 : Number(((approvedCount / totalCorrections) * 100).toFixed(1));
  const reliabilityIndex = currentAccuracy >= 90 ? "High" : currentAccuracy >= 70 ? "Medium" : "Low";
  const contributors = new Set(rows.map((row) => String(row.user_id))).size;
  const batches = new Map<string, Array<Row & { user_id: string; batch_id: string | null }>>();

  for (const row of rows) {
    const batchId = row.batch_id ? String(row.batch_id) : `legacy-${row.id}`;
    const current = batches.get(batchId) ?? [];
    current.push(row);
    batches.set(batchId, current);
  }

  const history = [...batches.entries()]
    .sort((left, right) => {
      const leftCreated = String(left[1][0]?.created_at ?? "");
      const rightCreated = String(right[1][0]?.created_at ?? "");
      return leftCreated.localeCompare(rightCreated);
    })
    .slice(-6)
    .map(([_, batchRows], index) => {
      const batchApproved = batchRows.filter((row) => row.action === "approved").length;
      const batchAccuracy = batchRows.length === 0 ? 0 : Number(((batchApproved / batchRows.length) * 100).toFixed(1));
      return {
        label: `S${index + 1}`,
        value: batchAccuracy
      };
    });

  return {
    currentAccuracy,
    learningSessions: batches.size,
    errorsCorrected: correctedCount,
    reliabilityIndex,
    reviewedRows: totalCorrections,
    history,
    contributors,
    totalCorrections,
    lastUpdated: rows.at(-1)?.created_at ? String(rows.at(-1)?.created_at) : undefined
  };
}

async function getGlobalTrainingBenchmark(db: D1Database) {
  const rows = await queryMany<Row & { user_id: string; batch_id: string | null }>(
    db,
    "SELECT id, user_id, batch_id, action, created_at FROM training_feedback ORDER BY created_at ASC"
  );
  return computeGlobalTrainingBenchmark(rows);
}

function normalizeKnowledgeTag(tag: string) {
  return tag.trim().toUpperCase();
}

function deriveTagFamily(tag: string) {
  const matches = [...tag.toUpperCase().matchAll(/[A-Z]{2}\d{3}/g)].map((match) => match[0].slice(0, 2));
  if (matches.length === 0) {
    return "";
  }
  return matches.join("-");
}

function buildTrainingKnowledge(rows: Array<Row & { after_json: string; created_at: string }>): TrainingKnowledge {
  const exactCounts = new Map<string, Map<string, { count: number; description: string; type: string; room?: string; size?: string }>>();
  const familyCounts = new Map<string, Map<string, { count: number; description: string; type: string }>>();
  let updatedAt = "";

  for (const row of rows) {
    updatedAt = String(row.created_at ?? updatedAt);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(String(row.after_json ?? "{}")) as Record<string, unknown>;
    } catch {
      continue;
    }

    const tag = typeof parsed.tag === "string" ? normalizeKnowledgeTag(parsed.tag) : "";
    const description = typeof parsed.description === "string" ? parsed.description.trim().toUpperCase() : "";
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const room = typeof parsed.room === "string" ? parsed.room.trim().toUpperCase() : "";
    const size = typeof parsed.size === "string" ? parsed.size.trim().toLowerCase() : "";

    if (!tag || !description || !type) {
      continue;
    }

    const exactKey = tag;
    const exactEntryKey = `${description}|${type}|${room}|${size}`;
    const exactVariants = exactCounts.get(exactKey) ?? new Map();
    const currentExact = exactVariants.get(exactEntryKey) ?? { count: 0, description, type, room, size };
    currentExact.count += 1;
    exactVariants.set(exactEntryKey, currentExact);
    exactCounts.set(exactKey, exactVariants);

    const family = deriveTagFamily(tag);
    if (!family) {
      continue;
    }
    const familyEntryKey = `${description}|${type}`;
    const familyVariants = familyCounts.get(family) ?? new Map();
    const currentFamily = familyVariants.get(familyEntryKey) ?? { count: 0, description, type };
    currentFamily.count += 1;
    familyVariants.set(familyEntryKey, currentFamily);
    familyCounts.set(family, familyVariants);
  }

  const exactTagRules = [...exactCounts.entries()]
    .map(([tag, variants]) => {
      const sorted = [...variants.values()].sort((left, right) => right.count - left.count);
      const winner = sorted[0];
      const total = sorted.reduce((sum, entry) => sum + entry.count, 0);
      return {
        tag,
        description: winner.description,
        type: winner.type as TrainingKnowledge["exactTagRules"][number]["type"],
        room: winner.room || undefined,
        size: winner.size || undefined,
        confidence: total === 0 ? 0 : Number((winner.count / total).toFixed(2)),
        examples: total
      };
    })
    .filter((rule) => rule.examples > 0);

  const familyRules = [...familyCounts.entries()]
    .map(([family, variants]) => {
      const sorted = [...variants.values()].sort((left, right) => right.count - left.count);
      const winner = sorted[0];
      const total = sorted.reduce((sum, entry) => sum + entry.count, 0);
      return {
        family,
        description: winner.description,
        type: winner.type as TrainingKnowledge["familyRules"][number]["type"],
        confidence: total === 0 ? 0 : Number((winner.count / total).toFixed(2)),
        examples: total
      };
    })
    .filter((rule) => rule.examples > 0);

  return {
    exactTagRules,
    familyRules,
    updatedAt: updatedAt || undefined
  };
}

async function getTrainingKnowledge(db: D1Database) {
  const rows = await queryMany<Row & { after_json: string; created_at: string }>(
    db,
    "SELECT after_json, created_at FROM training_feedback WHERE action IN ('approved', 'edited') ORDER BY created_at ASC"
  );
  return buildTrainingKnowledge(rows);
}

function buildTrainingSessions(
  rows: Array<
    Row & {
      user_id: string;
      email: string;
      batch_id: string | null;
      context_json: string | null;
      created_at: string;
    }
  >
): TrainingSessionSummary[] {
  const grouped = new Map<
    string,
    {
      email: string;
      createdAt: string;
      projectName?: string;
      approvedCount: number;
      correctedCount: number;
      totalCorrections: number;
    }
  >();

  for (const row of rows) {
    const batchId = row.batch_id ? String(row.batch_id) : `legacy-${row.id}`;
    const existing = grouped.get(batchId) ?? {
      email: String(row.email),
      createdAt: String(row.created_at),
      projectName: undefined,
      approvedCount: 0,
      correctedCount: 0,
      totalCorrections: 0
    };

    existing.totalCorrections += 1;
    if (row.action === "approved") {
      existing.approvedCount += 1;
    }
    if (row.action === "rejected" || row.action === "edited") {
      existing.correctedCount += 1;
    }

    if (!existing.projectName && row.context_json) {
      try {
        const context = JSON.parse(String(row.context_json)) as { projectName?: string };
        existing.projectName = context.projectName;
      } catch {
        // Ignore malformed context.
      }
    }

    grouped.set(batchId, existing);
  }

  return [...grouped.entries()]
    .map(([id, session]) => ({
      id,
      email: session.email,
      createdAt: session.createdAt,
      projectName: session.projectName,
      currentAccuracy:
        session.totalCorrections === 0 ? 0 : Number(((session.approvedCount / session.totalCorrections) * 100).toFixed(1)),
      totalCorrections: session.totalCorrections,
      approvedCount: session.approvedCount,
      correctedCount: session.correctedCount
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function getTrainingSessions(db: D1Database) {
  const rows = await queryMany<
    Row & {
      user_id: string;
      email: string;
      batch_id: string | null;
      context_json: string | null;
      created_at: string;
    }
  >(
    db,
    `SELECT training_feedback.id, training_feedback.user_id, training_feedback.batch_id, training_feedback.action,
            training_feedback.context_json, training_feedback.created_at, users.email
     FROM training_feedback
     JOIN users ON users.id = training_feedback.user_id
     ORDER BY training_feedback.created_at DESC`
  );

  return buildTrainingSessions(rows);
}

async function signSessionToken(user: UserProfile, env: Bindings) {
  return new SignJWT({
    email: user.email,
    name: user.name,
    pictureUrl: user.pictureUrl ?? "",
    googleSub: user.googleSub
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSessionSecret(env));
}

async function verifySessionToken(token: string, env: Bindings): Promise<UserProfile> {
  const verified = await jwtVerify(token, getSessionSecret(env), {
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE
  });

  const payload = verified.payload;
  return {
    id: payload.sub ?? "",
    googleSub: String(payload.googleSub ?? ""),
    email: String(payload.email ?? ""),
    name: String(payload.name ?? ""),
    pictureUrl: payload.pictureUrl ? String(payload.pictureUrl) : undefined,
    createdAt: "",
    updatedAt: ""
  };
}

function requireSessionUser(c: Context<{ Bindings: Bindings; Variables: Variables }>) {
  const user = c.get("sessionUser");
  if (!user) {
    return {
      ok: false as const,
      response: c.json({ message: "Authentication required" }, 401)
    };
  }

  return {
    ok: true as const,
    user
  };
}

function mapProject(row: Row): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapUser(row: Row): UserProfile {
  return {
    id: String(row.id),
    googleSub: String(row.google_sub),
    email: String(row.email),
    name: String(row.name),
    pictureUrl: row.picture_url ? String(row.picture_url) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapDrawingAsset(row: Row): DrawingAsset {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: String(row.kind) as DrawingAsset["kind"],
    fileName: String(row.file_name),
    objectKey: String(row.object_key),
    mimeType: String(row.mime_type),
    createdAt: String(row.created_at)
  };
}

function mapLegendSymbol(row: Row): LegendSymbol {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    description: String(row.description),
    notes: row.notes ? String(row.notes) : undefined,
    previewUrl: row.preview_url ? String(row.preview_url) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapDrawingItem(row: Row): DrawingMtoItem {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    source: "drawing",
    type: String(row.type) as DrawingMtoItem["type"],
    description: String(row.description),
    size: String(row.size),
    room: String(row.room),
    tag: String(row.tag),
    qty: Number(row.qty),
    confidence: Number(row.confidence),
    verificationStatus: String(row.verification_status) as DrawingMtoItem["verificationStatus"]
  };
}

function mapModelImport(row: Row): ModelImport {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    fileName: String(row.file_name),
    createdAt: String(row.created_at)
  };
}

function mapModelItem(row: Row): ModelMtoItem {
  return {
    id: String(row.id),
    importId: String(row.import_id),
    projectId: String(row.project_id),
    source: "model",
    type: String(row.type) as ModelMtoItem["type"],
    description: String(row.description),
    size: String(row.size),
    room: String(row.room),
    tag: String(row.tag),
    qty: Number(row.qty),
    confidence: Number(row.confidence),
    verificationStatus: String(row.verification_status) as ModelMtoItem["verificationStatus"]
  };
}

function mapReconciliation(row: Row): ReconciliationResult {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    drawingItemId: row.drawing_item_id ? String(row.drawing_item_id) : undefined,
    modelItemId: row.model_item_id ? String(row.model_item_id) : undefined,
    status: String(row.status) as ReconciliationResult["status"],
    resolutionNotes: String(row.resolution_notes),
    qtyDrawing: Number(row.qty_drawing),
    qtyModel: Number(row.qty_model),
    drawingReference: String(row.drawing_reference),
    modelReference: String(row.model_reference),
    createdAt: String(row.created_at)
  };
}

function mapFeedback(row: Row): FeedbackCorrection {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    targetType: String(row.target_type) as FeedbackCorrection["targetType"],
    targetId: String(row.target_id),
    action: String(row.action) as FeedbackCorrection["action"],
    beforeJson: String(row.before_json),
    afterJson: String(row.after_json),
    createdAt: String(row.created_at)
  };
}

async function touchProject(db: D1Database, projectId: string) {
  await execute(db, "UPDATE projects SET updated_at = ? WHERE id = ?", [now(), projectId]);
}

async function createProject(db: D1Database, ownerUserId: string): Promise<Project> {
  const timestamp = now();
  const project: Project = {
    id: crypto.randomUUID(),
    name: "HVAC AI Engineer Project",
    ownerUserId,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await execute(
    db,
    "INSERT INTO projects (id, name, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [project.id, project.name, ownerUserId, project.createdAt, project.updatedAt]
  );

  return project;
}

async function findOwnedProjectRow(db: D1Database, projectId: string, userId: string) {
  return queryFirst<Row>(db, "SELECT * FROM projects WHERE id = ? AND owner_user_id = ?", [projectId, userId]);
}

async function loadProjectBundle(db: D1Database, projectId: string): Promise<ProjectBundle | null> {
  const projectRow = await queryFirst<Row>(db, "SELECT * FROM projects WHERE id = ?", [projectId]);
  if (!projectRow) {
    return null;
  }

  const [legendRows, assetRows, drawingRows, importRows, modelRows, reconciliationRows, feedbackRows] = await Promise.all([
    queryMany<Row>(db, "SELECT * FROM legend_symbols WHERE project_id = ? ORDER BY created_at ASC", [projectId]),
    queryMany<Row>(db, "SELECT * FROM drawing_assets WHERE project_id = ? ORDER BY created_at DESC", [projectId]),
    queryMany<Row>(db, "SELECT * FROM drawing_items WHERE project_id = ? ORDER BY created_at ASC", [projectId]),
    queryMany<Row>(db, "SELECT * FROM model_imports WHERE project_id = ? ORDER BY created_at DESC", [projectId]),
    queryMany<Row>(db, "SELECT * FROM model_items WHERE project_id = ? ORDER BY created_at ASC", [projectId]),
    queryMany<Row>(db, "SELECT * FROM reconciliation_results WHERE project_id = ? ORDER BY created_at DESC", [projectId]),
    queryMany<Row>(db, "SELECT * FROM feedback_corrections WHERE project_id = ? ORDER BY created_at ASC", [projectId])
  ]);

  const drawingItems = drawingRows.map(mapDrawingItem);
  const progressBase = computeAiProgress(drawingItems, feedbackRows.length);

  return {
    project: mapProject(projectRow),
    legendSymbols: legendRows.map(mapLegendSymbol),
    drawingAssets: assetRows.map(mapDrawingAsset),
    drawingItems,
    modelImports: importRows.map(mapModelImport),
    modelItems: modelRows.map(mapModelItem),
    reconciliation: reconciliationRows.map(mapReconciliation),
    progress: {
      ...progressBase,
      history: feedbackRows.slice(-6).map((_, index) => ({
        label: `S${index + 1}`,
        value: Math.min(100, progressBase.currentAccuracy + index * 2)
      }))
    }
  };
}

async function getCurrentProjectBundle(db: D1Database, userId: string) {
  const projectRow = await queryFirst<Row>(
    db,
    "SELECT * FROM projects WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT 1",
    [userId]
  );

  if (projectRow) {
    return loadProjectBundle(db, String(projectRow.id));
  }

  const project = await createProject(db, userId);
  return loadProjectBundle(db, project.id);
}

async function replaceLegendSymbols(db: D1Database, projectId: string, items: z.infer<typeof legendSchema>[]) {
  await execute(db, "DELETE FROM legend_symbols WHERE project_id = ?", [projectId]);
  const timestamp = now();

  for (const item of items) {
    await execute(
      db,
      "INSERT INTO legend_symbols (id, project_id, name, description, notes, preview_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), projectId, item.name, item.description, item.notes ?? "", item.previewUrl ?? "", timestamp, timestamp]
    );
  }

  await touchProject(db, projectId);
}

async function replaceDrawingItems(db: D1Database, projectId: string, items: DrawingMtoItem[]) {
  await execute(db, "DELETE FROM drawing_items WHERE project_id = ?", [projectId]);
  const timestamp = now();

  for (const item of items) {
    const normalized = normalizeRow(item);
    await execute(
      db,
      "INSERT INTO drawing_items (id, project_id, source, type, description, size, room, tag, qty, confidence, verification_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        normalized.id,
        projectId,
        "drawing",
        normalized.type,
        normalized.description,
        normalized.size,
        normalized.room,
        normalized.tag,
        normalized.qty,
        normalized.confidence,
        normalized.verificationStatus,
        timestamp
      ]
    );
  }

  await touchProject(db, projectId);
}

async function replaceReconciliationResults(db: D1Database, projectId: string, results: ReconciliationResult[]) {
  await execute(db, "DELETE FROM reconciliation_results WHERE project_id = ?", [projectId]);
  for (const result of results) {
    await execute(
      db,
      "INSERT INTO reconciliation_results (id, project_id, drawing_item_id, model_item_id, status, resolution_notes, qty_drawing, qty_model, drawing_reference, model_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        result.id,
        projectId,
        result.drawingItemId ?? "",
        result.modelItemId ?? "",
        result.status,
        result.resolutionNotes,
        result.qtyDrawing,
        result.qtyModel,
        result.drawingReference,
        result.modelReference,
        result.createdAt
      ]
    );
  }

  await touchProject(db, projectId);
}

async function saveModelImport(db: D1Database, projectId: string, fileName: string, items: ModelMtoItem[]) {
  const importId = crypto.randomUUID();
  const timestamp = now();
  await execute(db, "DELETE FROM model_items WHERE project_id = ?", [projectId]);
  await execute(db, "DELETE FROM model_imports WHERE project_id = ?", [projectId]);
  await execute(
    db,
    "INSERT INTO model_imports (id, project_id, file_name, created_at) VALUES (?, ?, ?, ?)",
    [importId, projectId, fileName, timestamp]
  );

  for (const item of items) {
    const normalized = normalizeRow({
      ...item,
      importId
    });
    await execute(
      db,
      "INSERT INTO model_items (id, project_id, import_id, source, type, description, size, room, tag, qty, confidence, verification_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        normalized.id,
        projectId,
        importId,
        "model",
        normalized.type,
        normalized.description,
        normalized.size,
        normalized.room,
        normalized.tag,
        normalized.qty,
        normalized.confidence,
        normalized.verificationStatus,
        timestamp
      ]
    );
  }

  await touchProject(db, projectId);
}

async function verifyGoogleCredential(env: Bindings, credential: string) {
  const verified = await jwtVerify(credential, googleJwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: env.GOOGLE_CLIENT_ID
  });

  const payload = verified.payload;
  const emailVerified = payload.email_verified;
  if (!payload.sub || !payload.email || !payload.name || emailVerified === false || emailVerified === "false") {
    throw new Error("Invalid Google account payload");
  }

  return {
    googleSub: String(payload.sub),
    email: String(payload.email),
    name: String(payload.name),
    pictureUrl: payload.picture ? String(payload.picture) : undefined
  };
}

async function upsertUser(
  db: D1Database,
  input: { googleSub: string; email: string; name: string; pictureUrl?: string }
): Promise<UserProfile> {
  const existing = await queryFirst<Row>(db, "SELECT * FROM users WHERE google_sub = ?", [input.googleSub]);
  const timestamp = now();

  if (existing) {
    await execute(
      db,
      "UPDATE users SET email = ?, name = ?, picture_url = ?, updated_at = ? WHERE id = ?",
      [input.email, input.name, input.pictureUrl ?? "", timestamp, existing.id]
    );
    const updated = await queryFirst<Row>(db, "SELECT * FROM users WHERE id = ?", [existing.id]);
    return mapUser(updated as Row);
  }

  const user: UserProfile = {
    id: crypto.randomUUID(),
    googleSub: input.googleSub,
    email: input.email,
    name: input.name,
    pictureUrl: input.pictureUrl,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await execute(
    db,
    "INSERT INTO users (id, google_sub, email, name, picture_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [user.id, user.googleSub, user.email, user.name, user.pictureUrl ?? "", user.createdAt, user.updatedAt]
  );

  return user;
}

app.post("/api/auth/google", async (c) => {
  const payload = googleCredentialSchema.parse(await c.req.json());
  const googleUser = await verifyGoogleCredential(c.env, payload.credential);
  const user = await upsertUser(c.env.DB, googleUser);
  const sessionToken = await signSessionToken(user, c.env);
  setSessionCookie(c, sessionToken);
  return c.json({ user, sessionToken });
});

app.get("/api/auth/me", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return c.json({ user: null });
  }

  const userRow = await queryFirst<Row>(c.env.DB, "SELECT * FROM users WHERE id = ?", [session.user.id]);
  if (!userRow) {
    clearSessionCookie(c);
    return c.json({ user: null });
  }

  return c.json({ user: mapUser(userRow) });
});

app.post("/api/auth/logout", async (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.post("/api/projects", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const project = await createProject(c.env.DB, session.user.id);
  const bundle = await loadProjectBundle(c.env.DB, project.id);
  return c.json(bundle);
});

app.get("/api/projects/current", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const bundle = await getCurrentProjectBundle(c.env.DB, session.user.id);
  return c.json(bundle);
});

app.get("/api/projects/:projectId", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectRow = await findOwnedProjectRow(c.env.DB, c.req.param("projectId"), session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const bundle = await loadProjectBundle(c.env.DB, String(projectRow.id));
  return c.json(bundle);
});

app.post("/api/projects/:projectId/uploads/sign", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectRow = await findOwnedProjectRow(c.env.DB, c.req.param("projectId"), session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const payload = await c.req.json<{ fileName: string; kind: DrawingAsset["kind"]; mimeType: string }>();
  const assetId = crypto.randomUUID();
  const objectKey = `${c.req.param("projectId")}/${payload.kind}/${assetId}-${payload.fileName}`;
  const timestamp = now();

  await execute(
    c.env.DB,
    "INSERT INTO drawing_assets (id, project_id, kind, file_name, object_key, mime_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [assetId, c.req.param("projectId"), payload.kind, payload.fileName, objectKey, payload.mimeType, timestamp]
  );
  await touchProject(c.env.DB, c.req.param("projectId"));

  return c.json({
    assetId,
    objectKey,
    uploadUrl: `/api/uploads/${assetId}`
  });
});

app.put("/api/uploads/:assetId", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const assetRow = await queryFirst<Row>(
    c.env.DB,
    `SELECT drawing_assets.*
     FROM drawing_assets
     JOIN projects ON projects.id = drawing_assets.project_id
     WHERE drawing_assets.id = ? AND projects.owner_user_id = ?`,
    [c.req.param("assetId"), session.user.id]
  );

  if (!assetRow) {
    return c.json({ message: "Upload target not found" }, 404);
  }

  const body = await c.req.arrayBuffer();
  await c.env.FILES.put(String(assetRow.object_key), body, {
    httpMetadata: { contentType: String(assetRow.mime_type) }
  });
  return c.json({ ok: true });
});

app.post("/api/projects/:projectId/legend/extract", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectRow = await findOwnedProjectRow(c.env.DB, c.req.param("projectId"), session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const payload = await c.req.json<{ text: string }>();
  const symbols = extractLegendSymbols(payload.text, c.req.param("projectId"), now());
  return c.json({ symbols });
});

app.put("/api/projects/:projectId/legend", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectId = c.req.param("projectId");
  const projectRow = await findOwnedProjectRow(c.env.DB, projectId, session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const payload = z.object({ symbols: z.array(legendSchema) }).parse(await c.req.json());
  await replaceLegendSymbols(c.env.DB, projectId, payload.symbols);
  const bundle = await loadProjectBundle(c.env.DB, projectId);
  return c.json(bundle);
});

app.post("/api/projects/:projectId/drawing/extract", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectId = c.req.param("projectId");
  const projectRow = await findOwnedProjectRow(c.env.DB, projectId, session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const payload = z.object({
    text: z.string(),
    legendSymbols: z.array(legendSchema.extend({ id: z.string().optional() }))
  }).parse(await c.req.json());

  const nowStamp = now();
  const symbols = payload.legendSymbols.map((symbol) => ({
    id: symbol.id ?? crypto.randomUUID(),
    projectId,
    name: symbol.name,
    description: symbol.description,
    notes: symbol.notes,
    previewUrl: symbol.previewUrl,
    createdAt: nowStamp,
    updatedAt: nowStamp
  }));
  const items = extractDrawingItems(payload.text, symbols, projectId);
  return c.json({ items });
});

app.put("/api/projects/:projectId/drawing/items", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectId = c.req.param("projectId");
  const projectRow = await findOwnedProjectRow(c.env.DB, projectId, session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const payload = z.object({ items: z.array(itemSchema) }).parse(await c.req.json());
  await replaceDrawingItems(c.env.DB, projectId, payload.items as DrawingMtoItem[]);
  const bundle = await loadProjectBundle(c.env.DB, projectId);
  return c.json(bundle);
});

app.post("/api/projects/:projectId/model/import", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectId = c.req.param("projectId");
  const projectRow = await findOwnedProjectRow(c.env.DB, projectId, session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const payload = z.object({
    fileName: z.string(),
    items: z.array(itemSchema)
  }).parse(await c.req.json());

  await saveModelImport(c.env.DB, projectId, payload.fileName, payload.items as ModelMtoItem[]);
  const bundle = await loadProjectBundle(c.env.DB, projectId);
  return c.json(bundle);
});

app.post("/api/projects/:projectId/reconciliation/run", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectId = c.req.param("projectId");
  const projectRow = await findOwnedProjectRow(c.env.DB, projectId, session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const bundle = await loadProjectBundle(c.env.DB, projectId);
  if (!bundle) {
    return c.json({ message: "Project not found" }, 404);
  }

  const results = reconcileRows(projectId, bundle.drawingItems, bundle.modelItems);
  await replaceReconciliationResults(c.env.DB, projectId, results);
  const nextBundle = await loadProjectBundle(c.env.DB, projectId);
  return c.json(nextBundle);
});

app.get("/api/projects/:projectId/reconciliation", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectId = c.req.param("projectId");
  const projectRow = await findOwnedProjectRow(c.env.DB, projectId, session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const rows = await queryMany<Row>(
    c.env.DB,
    "SELECT * FROM reconciliation_results WHERE project_id = ? ORDER BY created_at DESC",
    [projectId]
  );
  return c.json({ results: rows.map(mapReconciliation) });
});

app.post("/api/projects/:projectId/feedback", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectId = c.req.param("projectId");
  const projectRow = await findOwnedProjectRow(c.env.DB, projectId, session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const payload = z.object({
    corrections: z.array(
      z.object({
        targetType: z.enum(["drawing_item", "legend_symbol"]),
        targetId: z.string(),
        action: z.enum(["approved", "rejected", "edited"]),
        beforeJson: z.string(),
        afterJson: z.string()
      })
    )
  }).parse(await c.req.json());

  const timestamp = now();
  for (const correction of payload.corrections) {
    await execute(
      c.env.DB,
      "INSERT INTO feedback_corrections (id, project_id, target_type, target_id, action, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        crypto.randomUUID(),
        projectId,
        correction.targetType,
        correction.targetId,
        correction.action,
        correction.beforeJson,
        correction.afterJson,
        timestamp
      ]
    );
  }
  await touchProject(c.env.DB, projectId);

  const bundle = await loadProjectBundle(c.env.DB, projectId);
  return c.json(bundle?.progress ?? null);
});

app.post("/api/training/feedback", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const payload = z.object({
    corrections: z.array(
      z.object({
        targetType: z.enum(["drawing_item", "legend_symbol"]),
        targetId: z.string(),
        action: z.enum(["approved", "rejected", "edited"]),
        beforeJson: z.string(),
        afterJson: z.string()
      })
    ),
    context: z
      .object({
        projectName: z.string(),
        legendSymbolsCount: z.number(),
        drawingItemsCount: z.number(),
        modelItemsCount: z.number(),
        currentAccuracy: z.number()
      })
      .optional()
  }).parse(await c.req.json());

  const timestamp = now();
  const batchId = crypto.randomUUID();
  for (const correction of payload.corrections) {
    await execute(
      c.env.DB,
      "INSERT INTO training_feedback (id, user_id, batch_id, target_type, target_id, action, before_json, after_json, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        crypto.randomUUID(),
        session.user.id,
        batchId,
        correction.targetType,
        correction.targetId,
        correction.action,
        correction.beforeJson,
        correction.afterJson,
        payload.context ? JSON.stringify(payload.context) : "",
        timestamp
      ]
    );
  }

  const [benchmark, knowledge, sessions] = await Promise.all([
    getGlobalTrainingBenchmark(c.env.DB),
    getTrainingKnowledge(c.env.DB),
    getTrainingSessions(c.env.DB)
  ]);
  return c.json({ ok: true, savedCount: payload.corrections.length, benchmark, knowledge, sessions });
});

app.get("/api/training/benchmark", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const benchmark = await getGlobalTrainingBenchmark(c.env.DB);
  return c.json(benchmark);
});

app.get("/api/training/knowledge", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const knowledge = await getTrainingKnowledge(c.env.DB);
  return c.json(knowledge);
});

app.get("/api/training/sessions", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const sessions = await getTrainingSessions(c.env.DB);
  return c.json({ sessions });
});

app.get("/api/projects/:projectId/progress", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectId = c.req.param("projectId");
  const projectRow = await findOwnedProjectRow(c.env.DB, projectId, session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const bundle = await loadProjectBundle(c.env.DB, projectId);
  if (!bundle) {
    return c.json({ message: "Project not found" }, 404);
  }
  return c.json(bundle.progress);
});

app.get("/api/projects/:projectId/export.xlsx", async (c) => {
  const session = requireSessionUser(c);
  if (!session.ok) {
    return session.response;
  }

  const projectId = c.req.param("projectId");
  const projectRow = await findOwnedProjectRow(c.env.DB, projectId, session.user.id);
  if (!projectRow) {
    return c.json({ message: "Project not found" }, 404);
  }

  const bundle = await loadProjectBundle(c.env.DB, projectId);
  if (!bundle) {
    return c.json({ message: "Project not found" }, 404);
  }

  const worksheet = XLSX.utils.json_to_sheet(
    bundle.reconciliation.map((row) => ({
      status: row.status,
      drawingReference: row.drawingReference,
      modelReference: row.modelReference,
      qtyDrawing: row.qtyDrawing,
      qtyModel: row.qtyModel,
      resolutionNotes: row.resolutionNotes
    }))
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Reconciliation");
  const output = XLSX.write(workbook, { type: "array", bookType: "xlsx" });

  return new Response(output, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${bundle.project.name}-reconciliation.xlsx"`
    }
  });
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
