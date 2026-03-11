import { useEffect, useRef, useState } from "react";
import { Box, Check, Cpu, Wind, X } from "lucide-react";
import type {
  AiProgressSnapshot,
  DrawingMtoItem,
  HvacItemType,
  LegendSymbol,
  ModelMtoItem,
  ProjectBundle,
  ReconciliationResult,
  UserProfile,
  VerificationStatus
} from "@hvac/shared";
import {
  ApiError,
  downloadExport,
  getAuthSession,
  getCurrentProject,
  importModelItems,
  logout,
  runReconciliation,
  saveDrawingItems,
  saveLegend,
  signUpload,
  signInWithGoogle,
  storeSessionToken,
  submitFeedback,
  uploadFile
} from "./lib/api";
import {
  buildFeedback,
  extractDrawingItemsFromFile,
  extractLegendFromFile,
  parseSpreadsheet
} from "./lib/file-tools";
import { ProgressChart } from "./components/ProgressChart";
import { StatCard } from "./components/StatCard";
import { StepTabs } from "./components/StepTabs";

function hydrateProject(bundle: ProjectBundle) {
  return {
    project: bundle.project,
    legendSymbols: bundle.legendSymbols,
    drawingItems: bundle.drawingItems,
    modelItems: bundle.modelItems,
    reconciliation: bundle.reconciliation,
    progress: bundle.progress
  };
}

function emptyProgress(): AiProgressSnapshot {
  return {
    currentAccuracy: 0,
    learningSessions: 0,
    errorsCorrected: 0,
    reliabilityIndex: "Low",
    reviewedRows: 0,
    history: []
  };
}

const AUTH_CREDENTIAL_KEY = "hvac-google-credential";
const USER_SNAPSHOT_KEY = "hvac-session-user";
const PROJECT_CACHE_KEY = "hvac-project-cache";

type ToastState = {
  tone: "success" | "error";
  message: string;
} | null;

function readJson<T>(key: string): T | null {
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

export default function App() {
  const googleButtonRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [activeStep, setActiveStep] = useState(0);
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("HVAC AI Engineer MTO");
  const [sessionUser, setSessionUser] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [legendSymbols, setLegendSymbols] = useState<LegendSymbol[]>([]);
  const [drawingItems, setDrawingItems] = useState<DrawingMtoItem[]>([]);
  const [modelItems, setModelItems] = useState<ModelMtoItem[]>([]);
  const [reconciliation, setReconciliation] = useState<ReconciliationResult[]>([]);
  const [progress, setProgress] = useState<AiProgressSnapshot>(emptyProgress());
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState<ToastState>(null);
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

  function clearToastTimer() {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }

  function showToast(tone: "success" | "error", message: string) {
    clearToastTimer();
    setToast({ tone, message });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3200);
  }

  function describeError(caught: unknown, fallback: string) {
    if (caught instanceof ApiError) {
      if (caught.status === 401) {
        return "Your session expired. Sign in again.";
      }
      if (caught.message) {
        return caught.message;
      }
    }
    if (caught instanceof Error && caught.message) {
      return caught.message;
    }
    return fallback;
  }

  function persistSessionUser(user: UserProfile | null) {
    if (user) {
      window.localStorage.setItem(USER_SNAPSHOT_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(USER_SNAPSHOT_KEY);
    }
  }

  function persistProjectBundle(bundle: ProjectBundle | null) {
    if (bundle) {
      window.localStorage.setItem(PROJECT_CACHE_KEY, JSON.stringify(bundle));
      window.localStorage.setItem("hvac-project-id", bundle.project.id);
    } else {
      window.localStorage.removeItem(PROJECT_CACHE_KEY);
      window.localStorage.removeItem("hvac-project-id");
    }
  }

  function applyBundle(bundle: ProjectBundle, persist = true) {
    const state = hydrateProject(bundle);
    setProjectId(bundle.project.id);
    setProjectName(bundle.project.name);
    setLegendSymbols(state.legendSymbols);
    setDrawingItems(state.drawingItems);
    setModelItems(state.modelItems);
    setReconciliation(state.reconciliation);
    setProgress(state.progress);
    if (persist) {
      persistProjectBundle(bundle);
    }
  }

  function resetWorkspace(clearStoredAuth = false) {
    setActiveStep(0);
    setProjectId("");
    setProjectName("HVAC AI Engineer MTO");
    setAvatarFailed(false);
    setLegendSymbols([]);
    setDrawingItems([]);
    setModelItems([]);
    setReconciliation([]);
    setProgress(emptyProgress());
    persistProjectBundle(null);
    if (clearStoredAuth) {
      window.localStorage.removeItem(AUTH_CREDENTIAL_KEY);
      persistSessionUser(null);
      storeSessionToken("");
    }
  }

  function isUnauthorized(errorValue: unknown) {
    return errorValue instanceof ApiError && errorValue.status === 401;
  }

  async function runTask<T>(
    label: string,
    task: () => Promise<T>,
    options?: {
      successMessage?: string;
      fallbackError?: string;
      clearError?: boolean;
    }
  ) {
    setBusyLabel(label);
    if (options?.clearError) {
      setError("");
    }
    try {
      const result = await task();
      if (options?.successMessage) {
        showToast("success", options.successMessage);
      }
      return result;
    } catch (caught) {
      if (isUnauthorized(caught)) {
        setSessionUser(null);
        resetWorkspace(true);
        setError("Your session expired. Sign in again.");
        showToast("error", "Your session expired. Sign in again.");
        return null;
      }

      const message = describeError(caught, options?.fallbackError ?? "Something went wrong.");
      setError(message);
      showToast("error", message);
      return null;
    } finally {
      setBusyLabel("");
    }
  }

  async function loadWorkspace() {
    const bundle = await getCurrentProject();
    applyBundle(bundle);
  }

  useEffect(() => {
    async function bootstrap() {
      const cachedUser = readJson<UserProfile>(USER_SNAPSHOT_KEY);
      const cachedBundle = readJson<ProjectBundle>(PROJECT_CACHE_KEY);
      const cachedCredential = window.localStorage.getItem(AUTH_CREDENTIAL_KEY);

      if (cachedUser) {
        setSessionUser(cachedUser);
      }
      if (cachedBundle) {
        applyBundle(cachedBundle, false);
      }

      try {
        setBusyLabel("Checking account");
        const session = await getAuthSession();
        setSessionUser(session.user);
        persistSessionUser(session.user);
        if (session.user) {
          setBusyLabel("Loading workspace");
          await loadWorkspace();
          return;
        }

        if (cachedCredential) {
          setBusyLabel("Restoring session");
          const restored = await signInWithGoogle(cachedCredential);
          storeSessionToken(restored.sessionToken);
          setSessionUser(restored.user);
          persistSessionUser(restored.user);
          if (restored.user) {
            applyBundle(restored.projectBundle);
          }
        }
      } catch (caught) {
        const message = describeError(caught, "Failed to initialize project");
        setError(message);
      } finally {
        setAuthLoading(false);
        setBusyLabel("");
      }
    }

    bootstrap();
  }, []);

  async function handleGoogleAuth(credential: string) {
    const session = await runTask(
      "Signing in with Google",
      async () => {
        setError("");
        return signInWithGoogle(credential);
      },
      {
        fallbackError: "Google sign-in failed"
      }
    );

    if (!session) {
      return;
    }

    window.localStorage.setItem(AUTH_CREDENTIAL_KEY, credential);
    storeSessionToken(session.sessionToken);
    setSessionUser(session.user);
    persistSessionUser(session.user);
    setAvatarFailed(false);
    applyBundle(session.projectBundle);
    showToast("success", `Signed in as ${session.user?.name ?? "Google user"}.`);
  }

  useEffect(() => {
    if (authLoading || sessionUser || !googleClientId || !googleButtonRef.current) {
      return;
    }

    let cancelled = false;

    async function mountGoogleButton() {
      try {
        if (!document.querySelector('script[src="https://accounts.google.com/gsi/client"]')) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "https://accounts.google.com/gsi/client";
            script.async = true;
            script.defer = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("Failed to load Google Identity Services"));
            document.head.appendChild(script);
          });
        }

        if (cancelled || !window.google?.accounts.id || !googleButtonRef.current) {
          return;
        }

        googleButtonRef.current.innerHTML = "";
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (response) => {
            if (response.credential) {
              await handleGoogleAuth(response.credential);
            }
          }
        });
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: "filled_black",
          size: "large",
          text: "signin_with",
          shape: "pill",
          width: 292
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Failed to load Google sign-in");
      }
    }

    mountGoogleButton();

    return () => {
      cancelled = true;
    };
  }, [authLoading, googleClientId, sessionUser]);

  async function handleLogout() {
    try {
      setBusyLabel("Signing out");
      await logout();
    } finally {
      setSessionUser(null);
      resetWorkspace(true);
      setBusyLabel("");
    }
  }

  async function persistFile(kind: "legend" | "drawing" | "model", file: File) {
    if (!projectId) {
      return;
    }
    const signature = await signUpload(projectId, file, kind);
    await uploadFile(signature, file);
  }

  async function handleLegendUpload(file: File) {
    if (!projectId) {
      return;
    }
    const ok = await runTask(
      "Scanning legend",
      async () => {
        await persistFile("legend", file);
        const symbols = await extractLegendFromFile(file, projectId);
        setLegendSymbols(symbols);
        setActiveStep(0);
      },
      {
        successMessage: `Legend extracted from ${file.name}.`,
        fallbackError: "Legend extraction failed",
        clearError: true
      }
    );
    if (!ok) {
      return;
    }
  }

  async function handleDrawingUpload(file: File) {
    if (!projectId) {
      return;
    }
    const ok = await runTask(
      "Analyzing drawing MTO",
      async () => {
        await persistFile("drawing", file);
        const items = await extractDrawingItemsFromFile(file, projectId, legendSymbols);
        setDrawingItems(items);
        setActiveStep(1);
      },
      {
        successMessage: `Drawing analysis completed for ${file.name}.`,
        fallbackError: "Drawing extraction failed",
        clearError: true
      }
    );
    if (!ok) {
      return;
    }
  }

  async function handleModelUpload(file: File) {
    if (!projectId) {
      return;
    }
    const ok = await runTask(
      "Parsing model MTO",
      async () => {
        await persistFile("model", file);
        const items = await parseSpreadsheet(file, projectId);
        const bundle = await importModelItems(projectId, file.name, items);
        applyBundle(bundle);
        setActiveStep(2);
      },
      {
        successMessage: `Model data imported from ${file.name}.`,
        fallbackError: "Model import failed",
        clearError: true
      }
    );
    if (!ok) {
      return;
    }
  }

  async function handleSaveLegend() {
    if (!projectId) {
      return;
    }
    await runTask(
      "Saving legend",
      async () => {
        const bundle = await saveLegend(projectId, legendSymbols);
        applyBundle(bundle);
      },
      {
        successMessage: "Legend saved successfully.",
        fallbackError: "Legend save failed"
      }
    );
  }

  async function handleSaveDrawing() {
    if (!projectId) {
      return;
    }
    await runTask(
      "Saving drawing items",
      async () => {
        const bundle = await saveDrawingItems(projectId, drawingItems);
        applyBundle(bundle);
      },
      {
        successMessage: "Drawing MTO saved successfully.",
        fallbackError: "Drawing save failed"
      }
    );
  }

  async function handleRunReconciliation() {
    if (!projectId) {
      return;
    }
    await runTask(
      "Running reconciliation",
      async () => {
        const bundle = await runReconciliation(projectId);
        applyBundle(bundle);
        setActiveStep(3);
      },
      {
        successMessage: "Reconciliation completed.",
        fallbackError: "Reconciliation failed"
      }
    );
  }

  async function handleTrainAi() {
    if (!projectId) {
      return;
    }
    await runTask(
      "Refreshing knowledge base",
      async () => {
        const nextProgress = await submitFeedback(projectId, buildFeedback(drawingItems));
        setProgress(nextProgress);
        const cachedBundle = readJson<ProjectBundle>(PROJECT_CACHE_KEY);
        if (cachedBundle) {
          persistProjectBundle({
            ...cachedBundle,
            progress: nextProgress
          });
        }
        setActiveStep(4);
      },
      {
        successMessage: "AI feedback applied successfully.",
        fallbackError: "AI feedback sync failed"
      }
    );
  }

  async function handleDownloadExport() {
    if (!projectId) {
      return;
    }
    await runTask(
      "Preparing export",
      async () => {
        await downloadExport(projectId);
      },
      {
        successMessage: "Export downloaded successfully.",
        fallbackError: "Export failed"
      }
    );
  }

  useEffect(() => {
    return () => {
      clearToastTimer();
    };
  }, []);

  const reconciliationSummary = {
    perfect: reconciliation.filter((row) => row.status === "perfect_match").length,
    mismatches: reconciliation.filter((row) => row.status === "qty_mismatch" || row.status === "size_mismatch").length,
    missingInModel: reconciliation.filter((row) => row.status === "missing_in_model").length,
    missingInDrawing: reconciliation.filter((row) => row.status === "missing_in_drawing").length
  };

  return (
    <div className="screen-shell">
      <div className="product-shell">
        <header className="brand-bar">
          <div className="brand-inner">
            <div className="brand-lockup">
              <div className="brand-mark">
                <Wind size={19} strokeWidth={2.2} />
              </div>
              <div>
                <div className="brand-name">HVAC AI ENGINEER</div>
                <div className="brand-tagline">SPATIAL &amp; FLOW INTELLIGENCE</div>
              </div>
            </div>
            <div className="brand-controls">
              {sessionUser ? (
                <div className="user-chip">
                  {sessionUser.pictureUrl && !avatarFailed ? (
                    <img
                      alt={sessionUser.name}
                      className="avatar-image"
                      onError={() => setAvatarFailed(true)}
                      referrerPolicy="no-referrer"
                      src={sessionUser.pictureUrl}
                    />
                  ) : (
                    <div className="avatar-dot avatar-fallback">{sessionUser.name.slice(0, 1).toUpperCase()}</div>
                  )}
                  <span>{sessionUser.name}</span>
                </div>
              ) : null}
              {sessionUser ? (
                <button className="reset-button" onClick={handleLogout} type="button">
                  SIGN OUT
                </button>
              ) : null}
            </div>
          </div>
        </header>

        <div className="workspace-shell">
          <div className="workspace-inner">
            {error ? <div className="notice error">{error}</div> : null}

            {authLoading ? <div className="auth-loading">Checking your Google session...</div> : null}

            {!authLoading && !sessionUser ? (
              <AuthGate googleClientId={googleClientId} googleButtonRef={googleButtonRef} />
            ) : null}

            {sessionUser ? (
              <>
                <StepTabs activeStep={activeStep} onChange={setActiveStep} />

                {activeStep === 0 ? (
                  <LegendStep symbols={legendSymbols} onChange={setLegendSymbols} onSave={handleSaveLegend} onUpload={handleLegendUpload} />
                ) : null}

                {activeStep === 1 ? (
                  <DrawingStep
                    onExport={handleDownloadExport}
                    items={drawingItems}
                    onChange={setDrawingItems}
                    onSave={handleSaveDrawing}
                    onTrain={handleTrainAi}
                    onUpload={handleDrawingUpload}
                  />
                ) : null}

                {activeStep === 2 ? <ModelStep items={modelItems} onUpload={handleModelUpload} /> : null}

                {activeStep === 3 ? (
                  <ReconciliationStep
                    onRun={handleRunReconciliation}
                    results={reconciliation}
                    summary={reconciliationSummary}
                  />
                ) : null}

                {activeStep === 4 ? (
                  <AiProgressStep
                    drawingItems={drawingItems}
                    onTrain={handleTrainAi}
                    progress={progress}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        <footer className="status-bar">
          <div className="status-inner">
            <span>HVAC AI ENGINEER V3.1</span>
            <span>AI MODEL ACTIVE &nbsp; BFE: ISO 9001:2015 COMPLIANT</span>
          </div>
        </footer>

        {busyLabel ? <LoadingOverlay label={busyLabel} /> : null}
        {toast ? <Toast toast={toast} onClose={() => setToast(null)} /> : null}
      </div>
    </div>
  );
}

function LegendStep({
  symbols,
  onChange,
  onSave,
  onUpload
}: {
  symbols: LegendSymbol[];
  onChange: (symbols: LegendSymbol[]) => void;
  onSave: () => Promise<void>;
  onUpload: (file: File) => Promise<void>;
}) {
  return (
    <div className="page-stack">
      <section className="upload-stage">
        <div className="stage-icon">
          <Cpu size={34} strokeWidth={1.8} />
        </div>
        <h2>Study Project Legend</h2>
        <p>
          Upload the legend page and review the extracted symbol library before continuing to drawing analysis.
        </p>
        <label className="cta-button dark">
          UPLOAD LEGEND
          <input
            hidden
            onChange={(event) => event.target.files?.[0] && onUpload(event.target.files[0])}
            type="file"
            accept="application/pdf,image/*"
          />
        </label>
      </section>

      <div className="section-row">
        <div className="section-title">RECOGNIZED SYMBOLS ({symbols.length})</div>
        <button className="link-button" onClick={onSave} type="button">
          CONTINUE TO EXTRACTION -&gt;
        </button>
      </div>

      <div className="legend-wall">
        {symbols.length === 0 ? <div className="empty-state">No legend symbols extracted yet.</div> : null}
        {symbols.map((symbol, index) => (
          <article className="symbol-tile" key={symbol.id || `${symbol.name}-${index}`}>
            <div className="symbol-preview">
              {symbol.previewUrl ? (
                <img alt={symbol.name} className="symbol-preview-image" src={symbol.previewUrl} />
              ) : (
                "NO PREVIEW"
              )}
            </div>
            <div className="symbol-copy">
              <input
                className="tile-title"
                onChange={(event) => onChange(updateSymbol(symbols, index, "name", event.target.value))}
                value={symbol.name}
              />
              <textarea
                className="tile-text"
                onChange={(event) => onChange(updateSymbol(symbols, index, "description", event.target.value))}
                rows={3}
                value={symbol.description}
              />
            </div>
          </article>
        ))}
      </div>

      <div className="actions-row">
        <button className="cta-button" onClick={() => onChange([...symbols, blankLegend()])} type="button">
          ADD SYMBOL
        </button>
        <button className="cta-button green" onClick={onSave} type="button">
          SAVE LEGEND
        </button>
      </div>
    </div>
  );
}

function AuthGate({
  googleButtonRef,
  googleClientId
}: {
  googleButtonRef: React.RefObject<HTMLDivElement | null>;
  googleClientId: string;
}) {
  return (
    <section className="auth-gate">
      <div className="auth-card">
        <div className="stage-icon">
          <Cpu size={34} strokeWidth={1.8} />
        </div>
        <h2>Connect Your Google Account</h2>
        <p>
          Sign in with Google to load your HVAC AI Engineer workspace, keep projects linked to your account, and sync files securely across sessions.
        </p>
        {googleClientId ? (
          <div className="google-button-slot" ref={googleButtonRef} />
        ) : (
          <div className="auth-missing-config">
            Add <code>VITE_GOOGLE_CLIENT_ID</code> to the web app and <code>GOOGLE_CLIENT_ID</code> to the Worker before signing in.
          </div>
        )}
      </div>
    </section>
  );
}

function DrawingStep({
  onExport,
  items,
  onChange,
  onSave,
  onTrain,
  onUpload
}: {
  onExport: () => Promise<void>;
  items: DrawingMtoItem[];
  onChange: (items: DrawingMtoItem[]) => void;
  onSave: () => Promise<void>;
  onTrain: () => Promise<void>;
  onUpload: (file: File) => Promise<void>;
}) {
  return (
    <div className="page-stack">
      <div className="action-ribbon">
        <div className="ribbon-left">
          <label className="cta-button">
            ANALYZE DIAGRAM
            <input
              hidden
              onChange={(event) => event.target.files?.[0] && onUpload(event.target.files[0])}
              type="file"
              accept="application/pdf,image/*"
            />
          </label>
          <button className="cta-button green" onClick={onExport} type="button">
            EXPORT EXCEL
          </button>
        </div>
        <div className="ribbon-right">
          <span>VERIFY RESULTS TO TRAIN:</span>
          <button className="cta-button dark" onClick={onTrain} type="button">
            TRAIN AI FROM FEEDBACK
          </button>
        </div>
      </div>

      <section className="table-card">
        <div className="table-card-header">
          <div className="table-heading">FLOW-AWARE MTO EXTRACTION</div>
          <div className="chip-row">
            <span className="filter-chip active">ALL</span>
            <span className="filter-chip">EQUIPMENT</span>
          </div>
        </div>
        <DrawingTable items={items} onChange={onChange} />
      </section>

      <div className="actions-row">
        <button className="cta-button green" onClick={onSave} type="button">
          SAVE DRAWING MTO
        </button>
      </div>
    </div>
  );
}

function LoadingOverlay({ label }: { label: string }) {
  return (
    <div className="loading-overlay" role="status" aria-live="polite" aria-busy="true">
      <div className="loading-card">
        <div className="loading-spinner" />
        <strong>{label}</strong>
        <span>Please wait while the workspace is updated.</span>
      </div>
    </div>
  );
}

function Toast({
  onClose,
  toast
}: {
  onClose: () => void;
  toast: Exclude<ToastState, null>;
}) {
  return (
    <div className={`toast ${toast.tone}`} role="status" aria-live="polite">
      <span>{toast.message}</span>
      <button onClick={onClose} type="button" aria-label="Dismiss notification">
        <X size={14} strokeWidth={2.4} />
      </button>
    </div>
  );
}

function ModelStep({
  items,
  onUpload
}: {
  items: ModelMtoItem[];
  onUpload: (file: File) => Promise<void>;
}) {
  return (
    <div className="page-stack">
      <section className="model-hero">
        <div className="model-copy">
          <h2>3D Model Verification</h2>
          <p>
            Import MTO data exported from Aveva E3D or Excel/CSV to compare against the D&amp;ID extraction set.
          </p>
          <label className="cta-button white">
            IMPORT MODEL DATA (EXCEL/CSV)
            <input
              hidden
              onChange={(event) => event.target.files?.[0] && onUpload(event.target.files[0])}
              type="file"
              accept=".xlsx,.xls,.csv"
            />
          </label>
        </div>
        <div className="model-glyph">
          <Box size={92} strokeWidth={1.5} />
        </div>
      </section>

      <section className="table-card">
        <div className="table-card-header">
          <div className="table-heading">3D MODEL MTO SOURCE</div>
          <div className="chip-row">
            <span className="filter-chip active">ALL</span>
            <span className="filter-chip">EQUIPMENT</span>
          </div>
        </div>
        <SimpleTable
          columns={["TYPE", "DESCRIPTION", "SIZE", "ROOM", "TAG", "QTY"]}
          rows={items.map((item) => [
            <TypeBadge key={`${item.id}-type`} type={item.type} />,
            <span key={`${item.id}-description`} className="primary-cell">
              {item.description}
            </span>,
            item.size,
            item.room,
            <span key={`${item.id}-tag`} className="tag-link">
              {item.tag}
            </span>,
            `${item.qty}pcs`
          ])}
        />
      </section>
    </div>
  );
}

function ReconciliationStep({
  onRun,
  results,
  summary
}: {
  onRun: () => Promise<void>;
  results: ReconciliationResult[];
  summary: {
    perfect: number;
    mismatches: number;
    missingInModel: number;
    missingInDrawing: number;
  };
}) {
  return (
    <div className="page-stack">
      <div className="status-pair">
        <StatusPanel title="STEP 2: DRAWING MTO" subtitle="D&ID ANALYSIS STATUS" complete />
        <StatusPanel title="STEP 3: 3D MODEL MTO" subtitle="AVEVA E3D DATA STATUS" complete />
      </div>

      <section className="report-card">
        <div className="section-row">
          <div className="report-title">RECONCILIATION REPORT</div>
          <div className="chip-row">
            <span className="filter-chip active">ALL ITEMS</span>
            <span className="filter-chip">EQUIPMENT ONLY</span>
          </div>
        </div>

        <div className="summary-row">
          <StatCard accent="mint" label="Perfect Matches" value={`${summary.perfect}`} />
          <StatCard accent="amber" label="Discrepancies" value={`${summary.mismatches}`} />
          <StatCard accent="rose" label="Not in Model" value={`${summary.missingInModel}`} />
          <StatCard accent="lavender" label="Not in Drawing" value={`${summary.missingInDrawing}`} />
        </div>

        <button className="cta-button" onClick={onRun} type="button">
          RUN RECONCILIATION
        </button>

        <ReconciliationTable results={results} />
      </section>
    </div>
  );
}

function AiProgressStep({
  drawingItems,
  onTrain,
  progress
}: {
  drawingItems: DrawingMtoItem[];
  onTrain: () => Promise<void>;
  progress: AiProgressSnapshot;
}) {
  return (
    <div className="page-stack">
      <div className="summary-row">
        <StatCard accent="mint" label="CURRENT ACCURACY" value={`${progress.currentAccuracy}%`} />
        <StatCard accent="lavender" label="LEARNING SESSIONS" value={`${progress.learningSessions}`} />
        <StatCard accent="amber" label="ERRORS CORRECTED" value={`${progress.errorsCorrected}`} />
        <StatCard accent="lavenderStrong" label="RELIABILITY INDEX" value={progress.reliabilityIndex} />
      </div>

      <div className="progress-grid">
        <ProgressChart history={progress.history} />
        <aside className="focus-card">
          <h3>CURRENT AI FOCUS</h3>
          <ul>
            <li>Refining Boundary Detection</li>
            <li>Trace Logic Upstream Inference</li>
            <li>Taper Detection Optimization</li>
          </ul>
          <button className="cta-button" onClick={onTrain} type="button">
            REFRESH KNOWLEDGE BASE
          </button>
          <div className="mini-list">
            {drawingItems.slice(0, 3).map((item) => (
              <div className="mini-row" key={item.id}>
                <span>{item.description}</span>
                <strong>{item.verificationStatus}</strong>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function DrawingTable({
  items,
  onChange
}: {
  items: DrawingMtoItem[];
  onChange: (items: DrawingMtoItem[]) => void;
}) {
  return (
    <SimpleTable
      columns={["VERIFY", "TYPE", "DESCRIPTION", "SIZE", "ROOM", "TAG", "QTY"]}
      rows={
        items.length === 0
          ? []
          : items.map((item, index) => [
              <VerifyControls
                item={item}
                key={`${item.id}-verify`}
                onChange={(status) => onChange(updateItem(items, index, "verificationStatus", status))}
              />,
              <TypeBadge key={`${item.id}-type`} type={item.type} />,
              <input
                className="table-input long"
                key={`${item.id}-description`}
                onChange={(event) => onChange(updateItem(items, index, "description", event.target.value))}
                value={item.description}
              />,
              <input
                className="table-input small"
                key={`${item.id}-size`}
                onChange={(event) => onChange(updateItem(items, index, "size", event.target.value))}
                value={item.size}
              />,
              <input
                className="table-input room"
                key={`${item.id}-room`}
                onChange={(event) => onChange(updateItem(items, index, "room", event.target.value))}
                value={item.room}
              />,
              <input
                className="table-input tag"
                key={`${item.id}-tag`}
                onChange={(event) => onChange(updateItem(items, index, "tag", event.target.value))}
                value={item.tag}
              />,
              <input
                className="table-input qty"
                key={`${item.id}-qty`}
                onChange={(event) => onChange(updateItem(items, index, "qty", Number(event.target.value) || 1))}
                type="number"
                value={item.qty}
              />
            ])
      }
      emptyMessage="No drawing items extracted yet."
    />
  );
}

function ReconciliationTable({ results }: { results: ReconciliationResult[] }) {
  return (
    <SimpleTable
      columns={["STATUS", "DRAWING REFERENCE", "MODEL REFERENCE", "QTY COMPARISON", "RESOLUTION NOTES"]}
      rows={
        results.length === 0
          ? []
          : results.map((item) => [
              <StatusBadge key={`${item.id}-status`} status={item.status} />,
              <div key={`${item.id}-drawing`} className="stacked-cell">
                <strong>{firstLine(item.drawingReference)}</strong>
                <span>{secondLine(item.drawingReference)}</span>
              </div>,
              <div key={`${item.id}-model`} className="faded-cell">
                {item.modelReference}
              </div>,
              <span key={`${item.id}-qty`} className="qty-pill">
                {item.qtyDrawing} <em>-&gt;</em> {item.qtyModel}
              </span>,
              <div key={`${item.id}-notes`} className="resolution-text">
                {item.resolutionNotes}
              </div>
            ])
      }
      emptyMessage="No reconciliation results yet."
    />
  );
}

function SimpleTable({
  columns,
  rows,
  emptyMessage = "No data loaded yet."
}: {
  columns: string[];
  rows: React.ReactNode[][];
  emptyMessage?: string;
}) {
  return (
    <div className="data-table">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="empty-table" colSpan={columns.length}>
                {emptyMessage}
              </td>
            </tr>
          ) : null}
          {rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`cell-${rowIndex}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VerifyControls({
  item,
  onChange
}: {
  item: DrawingMtoItem;
  onChange: (status: VerificationStatus) => void;
}) {
  return (
    <div className="verify-controls">
      <button
        aria-label="Mark row as approved"
        className={item.verificationStatus === "approved" ? "verify-button approved active" : "verify-button approved"}
        onClick={() => onChange("approved")}
        type="button"
      >
        <Check size={12} strokeWidth={2.6} />
        <span>Approve</span>
      </button>
      <button
        aria-label="Mark row as rejected"
        className={item.verificationStatus === "rejected" ? "verify-button rejected active" : "verify-button rejected"}
        onClick={() => onChange("rejected")}
        type="button"
      >
        <X size={12} strokeWidth={2.6} />
        <span>Reject</span>
      </button>
    </div>
  );
}

function TypeBadge({ type }: { type: HvacItemType }) {
  const label =
    type === "sensor_instrument" ? "SENSOR/INSTRUMENT" : type.toUpperCase();
  return <span className={`type-chip ${type}`}>{label}</span>;
}

function StatusBadge({ status }: { status: ReconciliationResult["status"] }) {
  const label = status.replaceAll("_", " ").toUpperCase();
  return <span className={`status-chip ${status}`}>{label}</span>;
}

function StatusPanel({
  title,
  subtitle,
  complete
}: {
  title: string;
  subtitle: string;
  complete?: boolean;
}) {
  return (
    <div className="status-panel">
      <div className="status-icon">{complete ? "OK" : ".."}</div>
      <div className="status-copy">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <div className="status-pill">{complete ? "DA HOAN THANH" : "PENDING"}</div>
    </div>
  );
}

function firstLine(value: string) {
  return value.split("|")[0]?.trim() || value;
}

function secondLine(value: string) {
  return value.split("|").slice(1).join(" | ").trim();
}

function updateSymbol(symbols: LegendSymbol[], index: number, key: keyof LegendSymbol, value: string) {
  return symbols.map((symbol, symbolIndex) => (symbolIndex === index ? { ...symbol, [key]: value } : symbol));
}

function blankLegend(): LegendSymbol {
  return {
    id: crypto.randomUUID(),
    projectId: "",
    name: "NEW SYMBOL",
    description: "Describe the legend symbol",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function updateItem(items: DrawingMtoItem[], index: number, key: keyof DrawingMtoItem, value: string | number | VerificationStatus) {
  return items.map((item, itemIndex) => (itemIndex === index ? { ...item, [key]: value } : item));
}
