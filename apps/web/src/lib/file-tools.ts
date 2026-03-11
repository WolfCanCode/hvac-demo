import * as XLSX from "xlsx";
import { inferItemType, type DrawingMtoItem, type LegendSymbol, type ModelMtoItem } from "@hvac/shared";
import * as pdfjs from "pdfjs-dist";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to render page"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

async function runOcr(blob: Blob) {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  const {
    data: { text }
  } = await worker.recognize(blob);
  await worker.terminate();
  return text;
}

type PdfToken = {
  str: string;
  x: number;
  y: number;
  page: number;
};

type RowToken = {
  y: number;
  text: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  column: "left" | "right";
};

const ROOM_PATTERN = /(HVAC ROOM|HV GIS ROOM \d+|MV GIS ROOM \d+|UPS ROOM \d+|BATTERY ROOM \d+|EAT ROOM \d+|FIRE FIGHTING ROOM \d+|COMMUNICATION ROOM \d+|LV ROOM \d+|HV TRANSFORMER ROOM \d+|ROOM \d+)/i;
const FULL_TAG_PATTERN = /=([A-Z0-9]{3,}\s+[A-Z]{2}\d{3}-[A-Z]{2}\d{3}|[A-Z0-9]{3,}\/[A-Z0-9_-]+|[A-Z0-9]{3,}\s+[A-Z]{2}\d{3}-[A-Z]{2}\d{3})/i;
const SIZE_PATTERN = /\b\d{2,4}x\d{2,4}\b/i;
const KNOWN_SYMBOL_CODES = new Set(["UT", "PDT", "FS", "GS", "TS", "PA", "AE", "FC", "M", "H", "HH"]);

function cleanLegendLine(text: string) {
  const parts = text
    .split(/\s+/)
    .filter(Boolean)
    .filter((part, index) => !(index === 0 && KNOWN_SYMBOL_CODES.has(part)));

  return parts.join(" ").replace(/\s+\|\s+/g, " ").trim();
}

async function extractPdfTokens(file: File): Promise<PdfToken[]> {
  const buffer = await file.arrayBuffer();
  const pdfDocument = await pdfjs.getDocument({ data: buffer }).promise;
  const tokens: PdfToken[] = [];

  for (let pageIndex = 1; pageIndex <= pdfDocument.numPages; pageIndex += 1) {
    const page = await pdfDocument.getPage(pageIndex);
    const text = await page.getTextContent();
    for (const item of text.items) {
      if (!("str" in item) || !("transform" in item)) {
        continue;
      }
      const value = item.str.trim();
      if (!value) {
        continue;
      }
      tokens.push({
        str: value,
        x: item.transform[4],
        y: item.transform[5],
        page: pageIndex
      });
    }
  }

  return tokens;
}

function groupRows(tokens: PdfToken[], column: "left" | "right", tolerance = 12): RowToken[] {
  const grouped = new Map<number, PdfToken[]>();
  for (const token of tokens) {
    const bucket = Math.round(token.y / tolerance) * tolerance;
    const current = grouped.get(bucket) ?? [];
    current.push(token);
    grouped.set(bucket, current);
  }

  return [...grouped.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, rowTokens]) => ({
      y,
      minX: Math.min(...rowTokens.map((token) => token.x)),
      maxX: Math.max(...rowTokens.map((token) => token.x)),
      minY: Math.min(...rowTokens.map((token) => token.y)),
      maxY: Math.max(...rowTokens.map((token) => token.y)),
      column,
      text: rowTokens
        .sort((left, right) => left.x - right.x)
        .map((token) => token.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    }))
    .filter((row) => row.text);
}

type LegendRow = {
  name: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  column: "left" | "right";
};

function mergeLegendRows(rows: RowToken[]): LegendRow[] {
  const merged: LegendRow[] = [];
  let buffer = "";
  let previousY = 0;
  let bounds: Omit<LegendRow, "name"> | null = null;

  for (const row of rows) {
    const line = cleanLegendLine(row.text);
    if (!line) {
      continue;
    }

    if (!buffer) {
      buffer = line;
      previousY = row.y;
      bounds = {
        minX: row.minX,
        maxX: row.maxX,
        minY: row.minY,
        maxY: row.maxY,
        column: row.column
      };
      continue;
    }

    if (Math.abs(previousY - row.y) <= 18) {
      buffer = `${buffer} ${line}`.replace(/\s+/g, " ").trim();
      if (bounds) {
        bounds = {
          ...bounds,
          minX: Math.min(bounds.minX, row.minX),
          maxX: Math.max(bounds.maxX, row.maxX),
          minY: Math.min(bounds.minY, row.minY),
          maxY: Math.max(bounds.maxY, row.maxY)
        };
      }
    } else {
      if (bounds) {
        merged.push({
          name: buffer,
          ...bounds
        });
      }
      buffer = line;
      bounds = {
        minX: row.minX,
        maxX: row.maxX,
        minY: row.minY,
        maxY: row.maxY,
        column: row.column
      };
    }
    previousY = row.y;
  }

  if (buffer && bounds) {
    merged.push({
      name: buffer,
      ...bounds
    });
  }

  return merged
    .map((entry) => ({
      ...entry,
      name: entry.name.replace(/^[-+]\s*/, "").trim()
    }))
    .filter((entry) => entry.name.length > 3);
}

function titleCase(value: string) {
  return value
    .toLowerCase()
    .split(" ")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export async function extractLegendFromFile(file: File, projectId: string): Promise<LegendSymbol[]> {
  if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
    const text = await (file.type.startsWith("image/") ? runOcr(file) : file.text());
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((name) => ({
        id: crypto.randomUUID(),
        projectId,
        name,
        description: `Detected legend symbol for ${titleCase(name)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));
  }

  const buffer = await file.arrayBuffer();
  const pdfDocument = await pdfjs.getDocument({ data: buffer }).promise;
  const firstPage = await pdfDocument.getPage(1);
  const text = await firstPage.getTextContent();
  const tokens: PdfToken[] = [];
  for (const item of text.items) {
    if (!("str" in item) || !("transform" in item)) {
      continue;
    }
    const value = item.str.trim();
    if (!value) {
      continue;
    }
    tokens.push({
      str: value,
      x: item.transform[4],
      y: item.transform[5],
      page: 1
    });
  }

  const anchor = tokens.find((token) => /SYMBOLS LEGEND/i.test(token.str));
  const legendTokens = tokens.filter((token) => {
    if (!anchor) {
      return token.x > 650 && token.x < 1500 && token.y > 520;
    }
    return token.x > anchor.x - 180 && token.x < anchor.x + 650 && token.y < anchor.y - 40 && token.y > 520;
  });

  const leftRows = groupRows(legendTokens.filter((token) => token.x < 1000), "left");
  const rightRows = groupRows(legendTokens.filter((token) => token.x >= 1000), "right");
  const legendRows = [...mergeLegendRows(leftRows), ...mergeLegendRows(rightRows)];
  const now = new Date().toISOString();
  const baseViewport = firstPage.getViewport({ scale: 1 });
  const viewport = firstPage.getViewport({ scale: 2 });
  const renderScale = viewport.width / baseViewport.width;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context) {
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await firstPage.render({ canvasContext: context, viewport }).promise;
  }

  const deduped = new Map<string, LegendRow>();
  for (const row of legendRows) {
    if (!deduped.has(row.name)) {
      deduped.set(row.name, row);
    }
  }

  return [...deduped.values()].map((row) => ({
    id: crypto.randomUUID(),
    projectId,
    name: row.name,
    description: `Detected legend symbol for ${titleCase(row.name)}`,
    previewUrl: context ? cropLegendPreview(canvas, baseViewport.height, renderScale, row) : undefined,
    createdAt: now,
    updatedAt: now
  }));
}

function cropLegendPreview(sourceCanvas: HTMLCanvasElement, baseViewportHeight: number, renderScale: number, row: LegendRow): string | undefined {
  const cropWidth = Math.max(128, Math.min(220, (row.maxX - row.minX) * renderScale + 90));
  const cropHeight = Math.max(104, (row.maxY - row.minY) * renderScale + 56);
  const targetX = Math.max(0, row.minX * renderScale - cropWidth + 18);
  const centerY = ((row.minY + row.maxY) / 2) * renderScale;
  const targetY = Math.max(0, baseViewportHeight * renderScale - centerY - cropHeight / 2);
  const clampedWidth = Math.min(cropWidth, sourceCanvas.width - targetX);
  const clampedHeight = Math.min(cropHeight, sourceCanvas.height - targetY);

  if (clampedWidth <= 0 || clampedHeight <= 0) {
    return undefined;
  }

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.round(clampedWidth);
  cropCanvas.height = Math.round(clampedHeight);
  const cropContext = cropCanvas.getContext("2d");
  if (!cropContext) {
    return undefined;
  }

  cropContext.fillStyle = "#ffffff";
  cropContext.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropContext.drawImage(
    sourceCanvas,
    targetX,
    targetY,
    clampedWidth,
    clampedHeight,
    0,
    0,
    cropCanvas.width,
    cropCanvas.height
  );

  return squarePreview(trimPreviewWhitespace(cropCanvas) ?? cropCanvas)?.toDataURL("image/png");
}

function trimPreviewWhitespace(sourceCanvas: HTMLCanvasElement): HTMLCanvasElement | undefined {
  const context = sourceCanvas.getContext("2d");
  if (!context) {
    return undefined;
  }

  const { width, height } = sourceCanvas;
  const imageData = context.getImageData(0, 0, width, height);
  const { data } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const alpha = data[offset + 3];

      const isVisibleInk = alpha > 0 && (red < 245 || green < 245 || blue < 245);
      if (!isVisibleInk) {
        continue;
      }

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return sourceCanvas;
  }

  const padding = 10;
  const trimX = Math.max(0, minX - padding);
  const trimY = Math.max(0, minY - padding);
  const trimWidth = Math.min(width - trimX, maxX - minX + padding * 2);
  const trimHeight = Math.min(height - trimY, maxY - minY + padding * 2);
  const trimmed = document.createElement("canvas");
  trimmed.width = trimWidth;
  trimmed.height = trimHeight;
  const trimmedContext = trimmed.getContext("2d");
  if (!trimmedContext) {
    return sourceCanvas;
  }

  trimmedContext.fillStyle = "#ffffff";
  trimmedContext.fillRect(0, 0, trimWidth, trimHeight);
  trimmedContext.drawImage(
    sourceCanvas,
    trimX,
    trimY,
    trimWidth,
    trimHeight,
    0,
    0,
    trimWidth,
    trimHeight
  );

  return trimmed;
}

function squarePreview(sourceCanvas: HTMLCanvasElement): HTMLCanvasElement | undefined {
  const size = Math.max(sourceCanvas.width, sourceCanvas.height);
  if (size <= 0) {
    return undefined;
  }

  const square = document.createElement("canvas");
  square.width = size;
  square.height = size;
  const context = square.getContext("2d");
  if (!context) {
    return undefined;
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);

  const offsetX = Math.round((size - sourceCanvas.width) / 2);
  const offsetY = Math.round((size - sourceCanvas.height) / 2);
  context.drawImage(sourceCanvas, offsetX, offsetY);

  return square;
}

function nearestValue(tokens: PdfToken[], source: PdfToken, pattern: RegExp, maxDistance: number): string {
  let best: { token: PdfToken; distance: number } | null = null;
  for (const token of tokens) {
    if (!pattern.test(token.str)) {
      continue;
    }
    const distance = Math.hypot(token.x - source.x, (token.y - source.y) * 1.4);
    if (distance > maxDistance) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = { token, distance };
    }
  }
  return best?.token.str ?? "";
}

function pickPreferredSize(tokens: PdfToken[], source: PdfToken, maxDistance: number, preferLargest = false): string {
  const matches = tokens
    .filter((token) => SIZE_PATTERN.test(token.str))
    .map((token) => ({
      token,
      distance: Math.hypot(token.x - source.x, (token.y - source.y) * 1.4)
    }))
    .filter((candidate) => candidate.distance <= maxDistance);

  if (matches.length === 0) {
    return "";
  }

  if (!preferLargest) {
    return matches.sort((left, right) => left.distance - right.distance)[0].token.str;
  }

  return matches
    .map((candidate) => {
      const [width, height] = candidate.token.str
        .toLowerCase()
        .split("x")
        .map((value) => Number(value));
      return {
        ...candidate,
        area: (width || 0) * (height || 0)
      };
    })
    .sort((left, right) => right.area - left.area || left.distance - right.distance)[0].token.str;
}

function normalizeTagText(raw: string): string {
  const match = raw.match(FULL_TAG_PATTERN);
  return match ? `=${match[1].replace(/\s+/g, " ").trim()}` : raw.trim();
}

function inferDrawingDescription(tag: string, size: string, pairedHnBases: Set<string>): string {
  if (/BP\d{3}-BP\d{3}/i.test(tag)) {
    return "DIFFERENTIAL PRESSURE TRANSMITTER";
  }
  if (/-MA\d{3}/i.test(tag)) {
    return "ELECTRIC ACTUATOR WITH SPRING RETURN (FAIL CLOSE)";
  }
  if (/FM\d{3}-FM\d{3}/i.test(tag)) {
    return "SHUTOFF DAMPER";
  }
  if (/BR\d{3}-BR\d{3}/i.test(tag)) {
    return "SMOKE DETECTOR";
  }
  if (/QN\d{3}-QN\d{3}/i.test(tag)) {
    const qnBase = tag.match(/QN(\d{3})-QN\d{3}/i)?.[1];
    if (qnBase && pairedHnBases.has(qnBase)) {
      return "PRESSURE RELIEF DAMPER";
    }
    return /^9\d{2}x9\d{2}$/i.test(size) || /^11\d{2}x11\d{2}$/i.test(size)
      ? "WEATHER LOUVER"
      : "PRESSURE RELIEF DAMPER";
  }
  if (/RM\d{3}-RM\d{3}/i.test(tag)) {
    return "ELECTRIC MOTOR";
  }
  return "UNCLASSIFIED HVAC ITEM";
}

export async function extractDrawingItemsFromFile(
  file: File,
  projectId: string,
  _legendSymbols: LegendSymbol[]
): Promise<DrawingMtoItem[]> {
  const now = new Date().toISOString();
  if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
    const text = await (file.type.startsWith("image/") ? runOcr(file) : file.text());
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => FULL_TAG_PATTERN.test(line))
      .slice(0, 40)
      .map((line) => {
        const tag = normalizeTagText(line);
        const size = (line.match(SIZE_PATTERN)?.[0] ?? "").toLowerCase();
        const description = inferDrawingDescription(tag, size, new Set());
        return {
          id: crypto.randomUUID(),
          projectId,
          source: "drawing" as const,
          type: inferItemType(description),
          description,
          size,
          room: "N/A",
          tag,
          qty: 1,
          confidence: 0.58,
          verificationStatus: "pending" as const
        };
      });
  }

  const tokens = (await extractPdfTokens(file)).filter((token) => token.x < 1950 && token.y > 120);
  const tagTokens = tokens.filter((token) => FULL_TAG_PATTERN.test(token.str));
  const deduped = new Map<string, PdfToken>();

  for (const token of tagTokens) {
    const normalized = normalizeTagText(token.str);
    if (!/[A-Z]{2}\d{3}-[A-Z]{2}\d{3}/.test(normalized)) {
      continue;
    }
    if (!deduped.has(normalized)) {
      deduped.set(normalized, token);
    }
  }

  const pairedHnBases = new Set(
    [...deduped.keys()]
      .map((tag) => tag.match(/QN(\d{3})-HN\d{3}/i)?.[1])
      .filter((value): value is string => Boolean(value))
  );

  return [...deduped.entries()].map(([tag, token]) => {
    const size = pickPreferredSize(tokens, token, /QN\d{3}-QN\d{3}/i.test(tag) ? 360 : 170, /QN\d{3}-QN\d{3}/i.test(tag)).toLowerCase();
    const room = nearestValue(tokens, token, ROOM_PATTERN, 360) || "N/A";
    const description = inferDrawingDescription(tag, size, pairedHnBases);
    return {
      id: crypto.randomUUID(),
      projectId,
      source: "drawing" as const,
      type: inferItemType(description),
      description,
      size,
      room,
      tag,
      qty: 1,
      confidence: 0.72,
      verificationStatus: "pending" as const
    };
  });
}

type RawModelRow = Record<string, string | number>;

function firstValue(row: RawModelRow, keys: string[]): string {
  const lowerMap = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lowerMap.get(key);
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

export async function parseSpreadsheet(file: File, projectId: string): Promise<ModelMtoItem[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<RawModelRow>(firstSheet, { defval: "" });

  return rows.map((row, index) => {
    const name1 = firstValue(row, ["name 1", "name"]);
    const name2 = firstValue(row, ["name 2", "reference", "code"]);
    const description = firstValue(row, ["type", "description", "item", "component"]) || name1;
    const width = firstValue(row, ["w1 [mm]", "w1"]);
    const height = firstValue(row, ["h1 [mm]", "h1"]);
    const size = width && height ? `${width.replace(/mm$/i, "")}x${height.replace(/mm$/i, "")}` : firstValue(row, ["size", "dimension"]);
    const room = firstValue(row, ["hvac", "room", "zone", "location"]) || "N/A";
    const tag = name1.split(" of BRANCH")[0] || name2 || `MODEL-${index + 1}`;
    const qty = Number(firstValue(row, ["qty", "quantity", "count"])) || 1;

    return {
      id: crypto.randomUUID(),
      importId: "pending",
      projectId,
      source: "model",
      type: inferItemType(description || tag),
      description,
      size,
      room,
      tag,
      qty,
      confidence: 1,
      verificationStatus: "approved"
    };
  });
}

export function buildFeedback(items: DrawingMtoItem[]): Array<{
  targetType: "drawing_item";
  targetId: string;
  action: "approved" | "rejected" | "edited";
  beforeJson: string;
  afterJson: string;
}> {
  return items
    .filter((item) => item.verificationStatus !== "pending")
    .map((item) => {
      const action: "approved" | "rejected" | "edited" =
        item.verificationStatus === "approved"
          ? "approved"
          : item.verificationStatus === "rejected"
            ? "rejected"
            : "edited";

      return {
        targetType: "drawing_item" as const,
        targetId: item.id,
        action,
        beforeJson: JSON.stringify({ id: item.id }),
        afterJson: JSON.stringify(item)
      };
    });
}
