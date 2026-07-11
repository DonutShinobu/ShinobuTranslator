import { describe, expect, it } from "vitest";
import { parseBakeDirectionArgs } from "../../benchmark/typeset/src/bake-options";

describe("parseBakeDirectionArgs", () => {
  it("defaults to preserving both directions", () => {
    expect(parseBakeDirectionArgs(["image.png"])).toEqual({
      direction: "all",
      remainingArgs: ["image.png"],
    });
  });

  it("accepts h and v in split and equals forms", () => {
    expect(parseBakeDirectionArgs(["--direction", "h"]).direction).toBe("h");
    expect(parseBakeDirectionArgs(["--direction=v"]).direction).toBe("v");
  });

  it("rejects missing and invalid direction values", () => {
    expect(() => parseBakeDirectionArgs(["--direction"])).toThrow(
      "--direction requires a value",
    );
    expect(() => parseBakeDirectionArgs(["--direction=horizontal"])).toThrow(
      "--direction must be one of: all, h, v",
    );
  });
});
