import { describe, it, expect } from "vitest";
import { toErrorMessage } from "../../apps/extension/src/shared/utils";

describe("toErrorMessage", () => {
  it("returns Error.message for Error instances", () => {
    const error = new Error("something went wrong");
    expect(toErrorMessage(error)).toBe("something went wrong");
  });

  it("maps structured pipeline failures to a stable host-facing message", () => {
    const error = Object.assign(new Error("pipeline.failure.stage"), {
      messageKey: "pipeline.failure.stage",
      stage: "ocr",
    });

    expect(toErrorMessage(error)).toBe("OCR 识别失败");
    expect(toErrorMessage({
      messageKey: "pipeline.failure.runtime",
    })).toBe("本地图片处理失败");
  });

  it("returns string itself for string input", () => {
    expect(toErrorMessage("plain string")).toBe("plain string");
  });

  it("converts number to string via String()", () => {
    expect(toErrorMessage(42)).toBe("42");
    expect(toErrorMessage(0)).toBe("0");
    expect(toErrorMessage(-1)).toBe("-1");
  });

  it("converts null to 'null'", () => {
    expect(toErrorMessage(null)).toBe("null");
  });

  it("converts undefined to 'undefined'", () => {
    expect(toErrorMessage(undefined)).toBe("undefined");
  });

  it("converts boolean to string", () => {
    expect(toErrorMessage(true)).toBe("true");
    expect(toErrorMessage(false)).toBe("false");
  });

  it("converts objects via toString", () => {
    expect(toErrorMessage({ key: "val" })).toBe("[object Object]");
  });

  it("converts arrays via String()", () => {
    expect(toErrorMessage([1, 2, 3])).toBe("1,2,3");
  });
});
