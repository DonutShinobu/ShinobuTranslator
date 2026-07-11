import type { RenderFixtureRegion } from "../../../src/pipeline/bake";
import type { SourceTextLineGeometry, TextDirection } from "../../../src/types";
import type { Fixture, GroundTruthColumn } from "./types";

export function groundTruthColumnToSourceGeometry(
  column: GroundTruthColumn,
  direction: TextDirection,
): SourceTextLineGeometry {
  const left = column.centerX - column.width / 2;
  const right = column.centerX + column.width / 2;
  const top = column.topY;
  const bottom = column.bottomY;

  return {
    text: column.text,
    direction,
    box: {
      x: left,
      y: top,
      width: column.width,
      height: column.height,
    },
    quad: column.quad ?? [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
    centerX: column.centerX,
    centerY: (top + bottom) / 2,
    width: column.width,
    height: column.height,
    fontSize: column.estimatedFontSize,
  };
}

export function toRenderFixtureRegions(fixture: Fixture): RenderFixtureRegion[] {
  return fixture.regions.map((region) => ({
    id: region.id,
    direction: region.direction,
    box: region.box,
    quad: region.quad,
    sourceText: region.sourceText,
    fontSize: region.fontSize,
    fgColor: region.fgColor,
    bgColor: region.bgColor,
    originalLineCount: region.originalLineCount,
    translatedColumns: region.translatedColumns,
    sourceLineGeometries: region.groundTruth.columns.map((column) => (
      groundTruthColumnToSourceGeometry(column, region.direction)
    )),
  }));
}
