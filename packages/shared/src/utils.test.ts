import { describe, expect, it } from "vitest";
import { computeAiProgress, extractDrawingItems, extractLegendSymbols, normalizeRow, reconcileRows } from "./utils";

describe("normalizeRow", () => {
  it("normalizes core text fields", () => {
    const row = normalizeRow({
      id: "1",
      projectId: "p1",
      source: "drawing" as const,
      type: "equipment" as const,
      description: "  WEATHER LOUVER  ",
      size: "300 X 200",
      room: " hvac room ",
      tag: " fd/xam01 ",
      qty: 0,
      confidence: 2,
      verificationStatus: "pending" as const
    });

    expect(row.description).toBe("weather louver");
    expect(row.size).toBe("300x200");
    expect(row.room).toBe("HVAC ROOM");
    expect(row.tag).toBe("FD/XAM01");
    expect(row.qty).toBe(1);
    expect(row.confidence).toBe(1);
  });
});

describe("extractors", () => {
  it("extracts legend pairs from text", () => {
    const symbols = extractLegendSymbols("WEATHER LOUVER\nSupply air intake\nSMOKE DETECTOR\nAlarm device", "p1", "2026-03-11T00:00:00.000Z");
    expect(symbols).toHaveLength(2);
    expect(symbols[0].name).toBe("WEATHER LOUVER");
  });

  it("builds drawing candidates from legend matches", () => {
    const legend = extractLegendSymbols("WEATHER LOUVER\nSupply air intake", "p1", "2026-03-11T00:00:00.000Z");
    const items = extractDrawingItems("Room HVAC ROOM WEATHER LOUVER 300x200 =XAM01", legend, "p1");
    expect(items).toHaveLength(1);
    expect(items[0].tag.length).toBeGreaterThan(0);
  });
});

describe("reconciliation", () => {
  it("flags missing model rows", () => {
    const drawing = [
      normalizeRow({
        id: "d1",
        projectId: "p1",
        source: "drawing" as const,
        type: "equipment" as const,
        description: "weather louver",
        size: "300x200",
        room: "room 1",
        tag: "TAG-1",
        qty: 1,
        confidence: 0.9,
        verificationStatus: "approved" as const
      })
    ];

    const results = reconcileRows("p1", drawing, []);
    expect(results[0].status).toBe("missing_in_model");
  });
});

describe("progress", () => {
  it("computes progress metrics", () => {
    const rows = [
      normalizeRow({
        id: "d1",
        projectId: "p1",
        source: "drawing" as const,
        type: "equipment" as const,
        description: "weather louver",
        size: "300x200",
        room: "room 1",
        tag: "TAG-1",
        qty: 1,
        confidence: 0.9,
        verificationStatus: "approved" as const
      }),
      normalizeRow({
        id: "d2",
        projectId: "p1",
        source: "drawing" as const,
        type: "equipment" as const,
        description: "damper",
        size: "300x200",
        room: "room 2",
        tag: "TAG-2",
        qty: 1,
        confidence: 0.9,
        verificationStatus: "edited" as const
      })
    ];

    const progress = computeAiProgress(rows, 3);
    expect(progress.currentAccuracy).toBe(50);
    expect(progress.learningSessions).toBe(3);
    expect(progress.errorsCorrected).toBe(1);
    expect(progress.reliabilityIndex).toBe("Low");
  });
});
