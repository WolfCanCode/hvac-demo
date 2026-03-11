import type {
  HvacItemType,
  LegendSymbol,
  NormalizedMtoRow,
  ReconciliationResult,
  ReconciliationStatus,
  VerificationStatus
} from "./types";

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function inferItemType(text: string): HvacItemType {
  const value = text.toLowerCase();
  if (/(duct|straight|mesh|stiffener)/.test(value)) {
    return "duct";
  }
  if (/(bend|elbow|tee|reducer|transition|fitting)/.test(value)) {
    return "fitting";
  }
  if (/(damper|louver|fan|motor|actuator|weather louver|detector|transmitter)/.test(value)) {
    return "equipment";
  }
  if (/(sensor|instrument|pressure|humidity|temperature)/.test(value)) {
    return "sensor_instrument";
  }
  if (/(accessory|plate|spring return|perforated)/.test(value)) {
    return "accessory";
  }
  return "other";
}

export function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function normalizeSize(value: string): string {
  return value
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[Xx]/g, "x");
}

export function normalizeTag(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeRow<T extends Omit<NormalizedMtoRow, "description" | "size" | "room" | "tag"> & {
  description: string;
  size: string;
  room: string;
  tag: string;
}>(row: T): T {
  return {
    ...row,
    description: normalizeText(row.description),
    size: normalizeSize(row.size),
    room: row.room.trim().toUpperCase(),
    tag: normalizeTag(row.tag),
    qty: Number.isFinite(row.qty) && row.qty > 0 ? row.qty : 1,
    confidence: Math.max(0, Math.min(1, row.confidence))
  };
}

export function buildRowReference(row: Pick<NormalizedMtoRow, "description" | "size" | "room" | "tag">): string {
  return [row.description, row.size, row.room, row.tag].filter(Boolean).join(" | ");
}

function tokenizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function extractLegendSymbols(
  text: string,
  projectId: string,
  now: string
): LegendSymbol[] {
  const lines = tokenizeLines(text);
  const pairs: LegendSymbol[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const name = lines[index];
    if (name.length < 3) {
      continue;
    }

    const next = lines[index + 1] ?? "";
    const description = next && next.length > 8 ? next : `Detected legend symbol for ${name}`;
    pairs.push({
      id: crypto.randomUUID(),
      projectId,
      name: name.replace(/[:\-]$/, ""),
      description,
      createdAt: now,
      updatedAt: now
    });

    if (next) {
      index += 1;
    }
  }

  if (pairs.length > 0) {
    return pairs.slice(0, 24);
  }

  const fallback = Array.from(
    new Set(
      text
        .split(/[^A-Za-z0-9 ]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 4)
        .slice(0, 12)
    )
  );

  return fallback.map((token) => ({
    id: crypto.randomUUID(),
    projectId,
    name: token.toUpperCase(),
    description: `Detected legend symbol for ${token}`,
    createdAt: now,
    updatedAt: now
  }));
}

function detectSize(text: string): string {
  const match = text.match(/(\d{2,4}\s?[xX]\s?\d{2,4})/);
  return match ? normalizeSize(match[1]) : "";
}

function detectRoom(text: string): string {
  const match = text.match(/([A-Z]{1,4}\s(?:GIS|UPS|HV|MV|ROOM|COMMUNICATION|CONTROL|BATTERY|TRANSFORMER|EAT)[A-Z0-9\s]*)/i);
  return match ? match[1].trim().toUpperCase() : "N/A";
}

function detectTag(text: string): string {
  const explicit = text.match(/=([A-Z0-9/-]{4,})/);
  if (explicit) {
    return normalizeTag(explicit[1]);
  }

  const segmented = text.match(/\b([A-Z]{2,}\d{1,4}(?:[-/][A-Z0-9]{2,})+)\b/);
  return segmented ? normalizeTag(segmented[1]) : "";
}

export function extractDrawingItems(
  text: string,
  legendSymbols: LegendSymbol[],
  projectId: string
): NormalizedMtoRow[] {
  const lines = tokenizeLines(text);
  const now = new Date().toISOString();
  const found: NormalizedMtoRow[] = [];

  for (const line of lines) {
    const matchedSymbol = legendSymbols.find((symbol) =>
      normalizeText(line).includes(normalizeText(symbol.name))
    );

    if (!matchedSymbol) {
      continue;
    }

    const description = matchedSymbol.name;
    found.push(
      normalizeRow({
        id: crypto.randomUUID(),
        projectId,
        source: "drawing",
        type: inferItemType(description),
        description,
        size: detectSize(line),
        room: detectRoom(line),
        tag: detectTag(line) || `${slugify(description).toUpperCase()}-${found.length + 1}`,
        qty: 1,
        confidence: matchedSymbol ? 0.82 : 0.55,
        verificationStatus: "pending" satisfies VerificationStatus
      })
    );
  }

  if (found.length > 0) {
    return found;
  }

  return legendSymbols.slice(0, 12).map((symbol, index) =>
    normalizeRow({
      id: crypto.randomUUID(),
      projectId,
      source: "drawing",
      type: inferItemType(symbol.name),
      description: symbol.name,
      size: "",
      room: "N/A",
      tag: `${slugify(symbol.name).toUpperCase()}-${index + 1}`,
      qty: 1,
      confidence: 0.42,
      verificationStatus: "pending"
    })
  );
}

function matchStatus(
  drawingRow: NormalizedMtoRow,
  modelRow?: NormalizedMtoRow
): ReconciliationStatus {
  if (!modelRow) {
    return "missing_in_model";
  }
  if (normalizeSize(drawingRow.size) !== normalizeSize(modelRow.size)) {
    return "size_mismatch";
  }
  if (drawingRow.qty !== modelRow.qty) {
    return "qty_mismatch";
  }
  return "perfect_match";
}

function findCandidate(
  drawingRow: NormalizedMtoRow,
  modelRows: NormalizedMtoRow[],
  usedIds: Set<string>
): NormalizedMtoRow | undefined {
  return modelRows.find((modelRow) => {
    if (usedIds.has(modelRow.id)) {
      return false;
    }
    if (normalizeTag(modelRow.tag) && normalizeTag(drawingRow.tag)) {
      return normalizeTag(modelRow.tag) === normalizeTag(drawingRow.tag);
    }
    return (
      normalizeText(modelRow.description) === normalizeText(drawingRow.description) &&
      normalizeSize(modelRow.size) === normalizeSize(drawingRow.size) &&
      normalizeText(modelRow.room) === normalizeText(drawingRow.room)
    );
  });
}

export function reconcileRows(
  projectId: string,
  drawingRows: NormalizedMtoRow[],
  modelRows: NormalizedMtoRow[]
): ReconciliationResult[] {
  const usedModelIds = new Set<string>();
  const now = new Date().toISOString();
  const results: ReconciliationResult[] = [];

  for (const drawingRow of drawingRows) {
    const candidate = findCandidate(drawingRow, modelRows, usedModelIds);
    if (candidate) {
      usedModelIds.add(candidate.id);
    }
    const status = matchStatus(drawingRow, candidate);
    results.push({
      id: crypto.randomUUID(),
      projectId,
      drawingItemId: drawingRow.id,
      modelItemId: candidate?.id,
      status,
      resolutionNotes:
        status === "perfect_match"
          ? "Drawing and model are aligned."
          : status === "qty_mismatch"
            ? "Review quantity mismatch between drawing and model."
            : status === "size_mismatch"
              ? "Review size mismatch between drawing and model."
              : "Present in drawing, not found in 3D model.",
      qtyDrawing: drawingRow.qty,
      qtyModel: candidate?.qty ?? 0,
      drawingReference: buildRowReference(drawingRow),
      modelReference: candidate ? buildRowReference(candidate) : "None",
      createdAt: now
    });
  }

  for (const modelRow of modelRows) {
    if (usedModelIds.has(modelRow.id)) {
      continue;
    }

    results.push({
      id: crypto.randomUUID(),
      projectId,
      drawingItemId: undefined,
      modelItemId: modelRow.id,
      status: "missing_in_drawing",
      resolutionNotes: "Present in 3D model, not found in drawing.",
      qtyDrawing: 0,
      qtyModel: modelRow.qty,
      drawingReference: "None",
      modelReference: buildRowReference(modelRow),
      createdAt: now
    });
  }

  return results;
}

export function computeAiProgress(
  drawingRows: NormalizedMtoRow[],
  feedbackCount: number
): {
  currentAccuracy: number;
  learningSessions: number;
  errorsCorrected: number;
  reliabilityIndex: "Low" | "Medium" | "High";
  reviewedRows: number;
} {
  const reviewedRows = drawingRows.filter((row) => row.verificationStatus !== "pending");
  const approvedRows = reviewedRows.filter((row) => row.verificationStatus === "approved");
  const correctedRows = reviewedRows.filter((row) => row.verificationStatus === "edited" || row.verificationStatus === "rejected");
  const currentAccuracy = reviewedRows.length === 0 ? 0 : (approvedRows.length / reviewedRows.length) * 100;
  const reliabilityIndex = currentAccuracy >= 90 ? "High" : currentAccuracy >= 70 ? "Medium" : "Low";

  return {
    currentAccuracy: Number(currentAccuracy.toFixed(1)),
    learningSessions: feedbackCount,
    errorsCorrected: correctedRows.length,
    reliabilityIndex,
    reviewedRows: reviewedRows.length
  };
}
