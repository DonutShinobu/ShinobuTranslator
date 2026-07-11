import { describe, expect, it } from "vitest";
import {
  assessFixtureSourceGeometry,
} from "../../benchmark/typeset/src/source-geometry";
import type { FixtureRegion, GroundTruthColumn } from "../../benchmark/typeset/src/types";

function makeColumn(overrides: Partial<GroundTruthColumn> = {}): GroundTruthColumn {
  return {
    index: 0,
    text: "right",
    charCount: 5,
    centerX: 100,
    topY: 10,
    bottomY: 110,
    width: 20,
    height: 100,
    estimatedFontSize: 20,
    charCenters: [{ y: 20 }, { y: 40 }, { y: 60 }, { y: 80 }, { y: 100 }],
    ...overrides,
  };
}

function makeRegion(overrides: Partial<FixtureRegion> = {}): FixtureRegion {
  return {
    id: "r1",
    direction: "v",
    box: { x: 0, y: 0, width: 140, height: 140 },
    sourceText: "right\nleft",
    groundTruth: {
      columns: [
        makeColumn({ index: 0, text: "left", centerX: 60 }),
        makeColumn({ index: 1, text: "right", centerX: 100 }),
      ],
    },
    currentTypeset: {
      fittedFontSize: 20,
      columns: [],
    },
    ...overrides,
  };
}

describe("fixture source geometry assessment", () => {
  it("matches source text columns by text instead of fixture array order", () => {
    const region = makeRegion();

    const assessment = assessFixtureSourceGeometry(region);

    expect(assessment.status).toBe("usable");
    expect(assessment.orderedColumns.map((column) => column.text)).toEqual(["right", "left"]);
  });

  it("rejects multi-column fixture source geometry when text cannot be matched", () => {
    const region = makeRegion({ sourceText: "right\nmissing" });

    expect(assessFixtureSourceGeometry(region).status).toBe("text_mismatch");
  });

  it("keeps single-column geometry when only the text label is mismatched", () => {
    const region = makeRegion({
      sourceText: "source",
      groundTruth: {
        columns: [makeColumn({ text: "other", centerX: 100 })],
      },
    });

    const assessment = assessFixtureSourceGeometry(region);

    expect(assessment.status).toBe("text_mismatch");
    expect(assessment.usable).toBe(true);
    expect(assessment.orderedColumns.map((column) => column.text)).toEqual(["other"]);
  });

  it("rejects fixture source geometry when source and ground truth counts differ", () => {
    const region = makeRegion({ sourceText: "right" });

    const assessment = assessFixtureSourceGeometry(region);

    expect(assessment.status).toBe("column_count_mismatch");
    expect(assessment.sourceColumnCount).toBe(1);
    expect(assessment.groundTruthColumnCount).toBe(2);
  });

  it("marks geometry when matched source columns are not in spatial reading order", () => {
    const region = makeRegion({
      groundTruth: {
        columns: [
          makeColumn({ index: 0, text: "right", centerX: 60 }),
          makeColumn({ index: 1, text: "left", centerX: 100 }),
        ],
      },
    });

    const assessment = assessFixtureSourceGeometry(region);

    expect(assessment.status).toBe("spatial_order_mismatch");
    expect(assessment.orderedColumns.map((column) => column.text)).toEqual(["right", "left"]);
  });

  it("accepts horizontal source lines in top-to-bottom spatial order", () => {
    const region = makeRegion({
      direction: "h",
      sourceText: "top\nbottom",
      groundTruth: {
        columns: [
          makeColumn({ index: 0, text: "bottom", topY: 50, bottomY: 70 }),
          makeColumn({ index: 1, text: "top", topY: 10, bottomY: 30 }),
        ],
      },
    });

    const assessment = assessFixtureSourceGeometry(region);

    expect(assessment.status).toBe("usable");
    expect(assessment.usable).toBe(true);
    expect(assessment.orderedColumns.map((column) => column.text)).toEqual(["top", "bottom"]);
  });

  it("marks horizontal geometry when source lines are not top-to-bottom", () => {
    const region = makeRegion({
      direction: "h",
      sourceText: "top\nbottom",
      groundTruth: {
        columns: [
          makeColumn({ index: 0, text: "top", topY: 50, bottomY: 70 }),
          makeColumn({ index: 1, text: "bottom", topY: 10, bottomY: 30 }),
        ],
      },
    });

    expect(assessFixtureSourceGeometry(region).status).toBe("spatial_order_mismatch");
  });
});
