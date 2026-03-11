import type { AuthSession, TrainingBenchmark, TrainingKnowledge, TrainingSessionSummary } from "@hvac/shared";

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();
const API_URL =
  configuredApiUrl ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:8787`
    : "http://localhost:8787");
const SESSION_TOKEN_KEY = "hvac-session-token";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function getSessionToken() {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(SESSION_TOKEN_KEY) ?? "";
}

function buildHeaders(init?: RequestInit) {
  const token = getSessionToken();
  return {
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers ?? {})
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: buildHeaders(init)
  });

  if (!response.ok) {
    let message = `API request failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload.message) {
        message = payload.message;
      }
    } catch {
      // Ignore non-JSON failures.
    }
    throw new ApiError(message, response.status);
  }

  return response.json() as Promise<T>;
}

export function storeSessionToken(token: string) {
  if (typeof window === "undefined") {
    return;
  }
  if (token) {
    window.localStorage.setItem(SESSION_TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(SESSION_TOKEN_KEY);
  }
}

export function getAuthSession() {
  return request<AuthSession>("/api/auth/me");
}

export function signInWithGoogle(credential: string) {
  return request<AuthSession & { sessionToken: string }>("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential })
  });
}

export function logout() {
  return request<{ ok: true }>("/api/auth/logout", {
    method: "POST"
  });
}

export function submitTrainingFeedback(
  corrections: Array<{
    targetType: "drawing_item" | "legend_symbol";
    targetId: string;
    action: "approved" | "rejected" | "edited";
    beforeJson: string;
    afterJson: string;
  }>,
  context?: {
    projectName: string;
    legendSymbolsCount: number;
    drawingItemsCount: number;
    modelItemsCount: number;
    currentAccuracy: number;
  }
) {
  return request<{
    ok: true;
    savedCount: number;
    benchmark: TrainingBenchmark;
    knowledge: TrainingKnowledge;
    sessions: TrainingSessionSummary[];
  }>("/api/training/feedback", {
    method: "POST",
    body: JSON.stringify({ corrections, context })
  });
}

export function getTrainingBenchmark() {
  return request<TrainingBenchmark>("/api/training/benchmark");
}

export function getTrainingKnowledge() {
  return request<TrainingKnowledge>("/api/training/knowledge");
}

export function getTrainingSessions() {
  return request<{ sessions: TrainingSessionSummary[] }>("/api/training/sessions");
}
