import type { FixtureRegion, GroundTruthColumn } from "./types";

export type SourceGeometryStatus =
  | "usable"
  | "non_vertical"
  | "empty_source_text"
  | "column_count_mismatch"
  | "text_mismatch"
  | "spatial_order_mismatch";

export type FixtureSourceGeometryAssessment = {
  status: SourceGeometryStatus;
  usable: boolean;
  sourceColumnCount: number;
  groundTruthColumnCount: number;
  orderedColumns: GroundTruthColumn[];
};

export function normalizeColumnText(text: string): string {
  return text.replace(/\s+/g, "");
}

export function resolveSourceTextColumns(sourceText: string): string[] {
  return sourceText
    .split(/\n+/)
    .map((column) => column.trim())
    .filter(Boolean);
}

export function assessFixtureSourceGeometry(region: FixtureRegion): FixtureSourceGeometryAssessment {
  const groundTruthColumnCount = region.groundTruth.columns.length;
  if (region.direction !== "v") {
    return {
      status: "non_vertical",
      usable: false,
      sourceColumnCount: 0,
      groundTruthColumnCount,
      orderedColumns: [],
    };
  }

  const sourceColumns = resolveSourceTextColumns(region.sourceText);
  if (sourceColumns.length === 0) {
    return {
      status: "empty_source_text",
      usable: false,
      sourceColumnCount: 0,
      groundTruthColumnCount,
      orderedColumns: [],
    };
  }
  if (sourceColumns.length !== groundTruthColumnCount) {
    return {
      status: "column_count_mismatch",
      usable: false,
      sourceColumnCount: sourceColumns.length,
      groundTruthColumnCount,
      orderedColumns: [],
    };
  }

  const remaining = region.groundTruth.columns.map((column) => ({ column, used: false }));
  const orderedColumns: GroundTruthColumn[] = [];
  for (const sourceColumn of sourceColumns) {
    const normalized = normalizeColumnText(sourceColumn);
    const index = remaining.findIndex((entry) =>
      !entry.used && normalizeColumnText(entry.column.text) === normalized,
    );
    if (index < 0) {
      if (sourceColumns.length === 1 && groundTruthColumnCount === 1) {
        return {
          status: "text_mismatch",
          usable: true,
          sourceColumnCount: sourceColumns.length,
          groundTruthColumnCount,
          orderedColumns: [region.groundTruth.columns[0]],
        };
      }
      return {
        status: "text_mismatch",
        usable: false,
        sourceColumnCount: sourceColumns.length,
        groundTruthColumnCount,
        orderedColumns: [],
      };
    }
    remaining[index].used = true;
    orderedColumns.push(remaining[index].column);
  }

  const spatialColumns = [...region.groundTruth.columns].sort((a, b) => b.centerX - a.centerX);
  const sourceOrderMatchesSpatialOrder = orderedColumns.every((column, index) =>
    normalizeColumnText(column.text) === normalizeColumnText(spatialColumns[index]?.text ?? ""),
  );
  if (!sourceOrderMatchesSpatialOrder) {
    return {
      status: "spatial_order_mismatch",
      usable: true,
      sourceColumnCount: sourceColumns.length,
      groundTruthColumnCount,
      orderedColumns,
    };
  }

  return {
    status: "usable",
    usable: true,
    sourceColumnCount: sourceColumns.length,
    groundTruthColumnCount,
    orderedColumns,
  };
}
