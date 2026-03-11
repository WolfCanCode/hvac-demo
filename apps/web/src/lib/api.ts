import type {
  AiProgressSnapshot,
  AuthSession,
  DrawingAsset,
  DrawingMtoItem,
  LegendSymbol,
  ModelMtoItem,
  ProjectBundle,
  UploadSignature
} from "@hvac/shared";

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
  return request<AuthSession & { projectBundle: ProjectBundle; sessionToken: string }>("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential })
  });
}

export function logout() {
  return request<{ ok: true }>("/api/auth/logout", {
    method: "POST"
  });
}

export function createProject() {
  return request<ProjectBundle>("/api/projects", { method: "POST" });
}

export function getCurrentProject() {
  return request<ProjectBundle>("/api/projects/current");
}

export function getProject(projectId: string) {
  return request<ProjectBundle>(`/api/projects/${projectId}`);
}

export function signUpload(projectId: string, file: File, kind: DrawingAsset["kind"]) {
  return request<UploadSignature>(`/api/projects/${projectId}/uploads/sign`, {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      kind,
      mimeType: file.type || "application/octet-stream"
    })
  });
}

export async function uploadFile(signature: UploadSignature, file: File) {
  const response = await fetch(`${API_URL}${signature.uploadUrl}`, {
    method: "PUT",
    credentials: "include",
    headers: {
      ...buildHeaders(),
      "Content-Type": file.type || "application/octet-stream"
    },
    body: file
  });

  if (!response.ok) {
    let message = `Upload failed: ${response.status}`;
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
}

export function extractLegend(projectId: string, text: string) {
  return request<{ symbols: LegendSymbol[] }>(`/api/projects/${projectId}/legend/extract`, {
    method: "POST",
    body: JSON.stringify({ text })
  });
}

export function saveLegend(projectId: string, symbols: LegendSymbol[]) {
  return request<ProjectBundle>(`/api/projects/${projectId}/legend`, {
    method: "PUT",
    body: JSON.stringify({
      symbols: symbols.map(({ name, description, notes, previewUrl }) => ({ name, description, notes, previewUrl }))
    })
  });
}

export function extractDrawing(projectId: string, text: string, legendSymbols: LegendSymbol[]) {
  return request<{ items: DrawingMtoItem[] }>(`/api/projects/${projectId}/drawing/extract`, {
    method: "POST",
    body: JSON.stringify({
      text,
      legendSymbols
    })
  });
}

export function saveDrawingItems(projectId: string, items: DrawingMtoItem[]) {
  return request<ProjectBundle>(`/api/projects/${projectId}/drawing/items`, {
    method: "PUT",
    body: JSON.stringify({ items })
  });
}

export function importModelItems(projectId: string, fileName: string, items: ModelMtoItem[]) {
  return request<ProjectBundle>(`/api/projects/${projectId}/model/import`, {
    method: "POST",
    body: JSON.stringify({ fileName, items })
  });
}

export function runReconciliation(projectId: string) {
  return request<ProjectBundle>(`/api/projects/${projectId}/reconciliation/run`, {
    method: "POST"
  });
}

export function submitFeedback(
  projectId: string,
  corrections: Array<{
    targetType: "drawing_item" | "legend_symbol";
    targetId: string;
    action: "approved" | "rejected" | "edited";
    beforeJson: string;
    afterJson: string;
  }>
) {
  return request<AiProgressSnapshot>(`/api/projects/${projectId}/feedback`, {
    method: "POST",
    body: JSON.stringify({ corrections })
  });
}

export function downloadExport(projectId: string) {
  return fetch(`${API_URL}/api/projects/${projectId}/export.xlsx`, {
    credentials: "include",
    headers: buildHeaders()
  }).then(async (response) => {
    if (!response.ok) {
      let message = `Export failed: ${response.status}`;
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

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `reconciliation-${projectId}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
}
