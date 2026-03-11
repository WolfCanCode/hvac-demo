export type MtoSource = "drawing" | "model";

export type HvacItemType =
  | "duct"
  | "fitting"
  | "equipment"
  | "accessory"
  | "sensor_instrument"
  | "other";

export type VerificationStatus = "pending" | "approved" | "rejected" | "edited";

export type ReconciliationStatus =
  | "perfect_match"
  | "qty_mismatch"
  | "size_mismatch"
  | "missing_in_model"
  | "missing_in_drawing";

export interface Project {
  id: string;
  name: string;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  id: string;
  googleSub: string;
  email: string;
  name: string;
  pictureUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  user: UserProfile | null;
}

export interface LegendSymbol {
  id: string;
  projectId: string;
  name: string;
  description: string;
  notes?: string;
  previewUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DrawingAsset {
  id: string;
  projectId: string;
  kind: "legend" | "drawing" | "model";
  fileName: string;
  objectKey: string;
  mimeType: string;
  createdAt: string;
}

export interface NormalizedMtoRow {
  id: string;
  projectId: string;
  source: MtoSource;
  type: HvacItemType;
  description: string;
  size: string;
  room: string;
  tag: string;
  qty: number;
  confidence: number;
  verificationStatus: VerificationStatus;
}

export interface DrawingMtoItem extends NormalizedMtoRow {}

export interface ModelMtoItem extends NormalizedMtoRow {
  importId: string;
}

export interface ModelImport {
  id: string;
  projectId: string;
  fileName: string;
  createdAt: string;
}

export interface ReconciliationResult {
  id: string;
  projectId: string;
  drawingItemId?: string;
  modelItemId?: string;
  status: ReconciliationStatus;
  resolutionNotes: string;
  qtyDrawing: number;
  qtyModel: number;
  drawingReference: string;
  modelReference: string;
  createdAt: string;
}

export interface FeedbackCorrection {
  id: string;
  projectId: string;
  targetType: "drawing_item" | "legend_symbol";
  targetId: string;
  action: "approved" | "rejected" | "edited";
  beforeJson: string;
  afterJson: string;
  createdAt: string;
}

export interface AiProgressSnapshot {
  currentAccuracy: number;
  learningSessions: number;
  errorsCorrected: number;
  reliabilityIndex: "Low" | "Medium" | "High";
  reviewedRows: number;
  history: Array<{
    label: string;
    value: number;
  }>;
}

export interface ProjectBundle {
  project: Project;
  legendSymbols: LegendSymbol[];
  drawingAssets: DrawingAsset[];
  drawingItems: DrawingMtoItem[];
  modelImports: ModelImport[];
  modelItems: ModelMtoItem[];
  reconciliation: ReconciliationResult[];
  progress: AiProgressSnapshot;
}

export interface UploadSignature {
  assetId: string;
  objectKey: string;
  uploadUrl: string;
}
