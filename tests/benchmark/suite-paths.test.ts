import { describe, expect, it } from "vitest";
import { parseTypesetSuiteArgs } from "../../benchmark/typeset/src/suite-paths";

describe("parseTypesetSuiteArgs", () => {
  it("keeps the configured default suite paths", () => {
    const parsed = parseTypesetSuiteArgs([]);

    expect(parsed.remainingArgs).toEqual([]);
    expect(parsed.paths.imagesDir).toMatch(/benchmark[\\/]typeset[\\/]images$/);
    expect(parsed.paths.fixturesDir).toMatch(/benchmark[\\/]typeset[\\/]fixtures$/);
    expect(parsed.paths.reportsDir).toMatch(/benchmark[\\/]reports$/);
    expect(parsed.paths.baselinePath).toMatch(/benchmark[\\/]typeset[\\/]baseline\.json$/);
  });

  it("expands a suite root into images, fixtures, reports, and baseline paths", () => {
    const parsed = parseTypesetSuiteArgs([
      "--suite-dir",
      "benchmark/typeset/horizontal",
      "--strict",
    ]);

    expect(parsed.paths.suiteDir).toMatch(/benchmark[\\/]typeset[\\/]horizontal$/);
    expect(parsed.paths.imagesDir).toMatch(/horizontal[\\/]images$/);
    expect(parsed.paths.fixturesDir).toMatch(/horizontal[\\/]fixtures$/);
    expect(parsed.paths.reportsDir).toMatch(/horizontal[\\/]reports$/);
    expect(parsed.paths.baselinePath).toMatch(/horizontal[\\/]baseline\.json$/);
    expect(parsed.remainingArgs).toEqual(["--strict"]);
  });

  it("allows specific paths and the bake out-dir alias to override the suite", () => {
    const parsed = parseTypesetSuiteArgs([
      "--suite-dir=benchmark/typeset/horizontal",
      "--images-dir=custom/images",
      "--out-dir",
      "custom/fixtures",
      "sample.png",
    ], { fixtureOutputAlias: true });

    expect(parsed.paths.imagesDir).toMatch(/custom[\\/]images$/);
    expect(parsed.paths.fixturesDir).toMatch(/custom[\\/]fixtures$/);
    expect(parsed.paths.reportsDir).toMatch(/horizontal[\\/]reports$/);
    expect(parsed.remainingArgs).toEqual(["sample.png"]);
  });

  it("rejects a path option without a value", () => {
    expect(() => parseTypesetSuiteArgs(["--suite-dir"])).toThrow(
      "--suite-dir requires a path.",
    );
  });
});
