import { describe, expect, it } from "vitest";
import { evaluateOcrPostFilterCandidate } from "../../../packages/image-pipeline/src/pipeline/ocrPostFilter/rule";

describe("evaluateOcrPostFilterCandidate", () => {
  it("keeps kana evidence when OCR only disagrees about voicing marks", () => {
    const result = evaluateOcrPostFilterCandidate({
      sourceText: "木杰",
      probability: 0.31336872947181355,
      originalLineCount: 1,
      hasBubble: false,
      relativeArea: 0.028369140625,
      aspectRatio: 1.434567901234568,
      variants: [
        { name: "inset", text: "ホポ", confidence: 0.5010663619622564, accepted: true },
        { name: "original", text: "木杰", confidence: 0.3062990983835552, accepted: true },
        { name: "outset", text: "ホ办", confidence: 0.23012687607207752, accepted: true },
      ],
      mask: {
        maskFillRatioInQuad: 0.3548553033320058,
        componentCount: 15,
        largestComponentRatio: 0.5733458031330372,
        boundaryPixelRatio: 0.1276128127191957,
      },
    });

    expect(result.shouldFilter).toBe(false);
    expect(result.protectionReason).toBe("shared-kana");
  });

  it("keeps repeated multi-kanji evidence from confident OCR variants", () => {
    const result = evaluateOcrPostFilterCandidate({
      sourceText: "絵描<工P",
      probability: 0.5,
      originalLineCount: 1,
      hasBubble: false,
      relativeArea: 0.07656172606081264,
      aspectRatio: 2.1739130434782608,
      variants: [
        { name: "inset", text: "絵描<工17", confidence: 0.8016540163797108, accepted: true },
        { name: "original", text: "絵描<工P", confidence: 0.6631578131207105, accepted: true },
        { name: "outset", text: "絵之描<工P", confidence: 0.6389859845629553, accepted: true },
      ],
      mask: {
        maskFillRatioInQuad: 0.18058199619254828,
        componentCount: 8,
        largestComponentRatio: 0.34073795180722893,
        boundaryPixelRatio: 0.4137801204819277,
      },
    });

    expect(result.shouldFilter).toBe(false);
    expect(result.protectionReason).toBe("shared-multi-han");
  });

  it("keeps multi-character source overlap without shielding an extreme mask", () => {
    const protectedResult = evaluateOcrPostFilterCandidate({
      sourceText: "あうOわ",
      probability: 0.2,
      originalLineCount: 1,
      hasBubble: false,
      relativeArea: 0.016774193548387096,
      aspectRatio: 2.1538461538461537,
      variants: [
        { name: "inset", text: "DOOO", confidence: 0.17731872362147424, accepted: false },
        { name: "original", text: "あうつわ", confidence: 0.20229085660967464, accepted: true },
        { name: "outset", text: "OOや", confidence: 0.15739932442848964, accepted: false },
      ],
      mask: {
        maskFillRatioInQuad: 0.2614040033831407,
        componentCount: 9,
        largestComponentRatio: 0.5289042277825712,
        boundaryPixelRatio: 0.22465487489214842,
      },
    });
    const extremeMaskResult = evaluateOcrPostFilterCandidate({
      sourceText: "おぶ",
      probability: 0.2,
      originalLineCount: 1,
      hasBubble: false,
      relativeArea: 0.03909900826419226,
      aspectRatio: 1.4155555555555555,
      variants: [
        { name: "inset", text: "", confidence: 0, accepted: false },
        { name: "original", text: "おぶ", confidence: 0.20399312005260256, accepted: true },
        { name: "outset", text: "はぶ", confidence: 0.21420928217038274, accepted: true },
      ],
      mask: {
        maskFillRatioInQuad: 0.10174137877324695,
        componentCount: 29,
        largestComponentRatio: 0.30235762400489896,
        boundaryPixelRatio: 0.32731169626454376,
      },
    });

    expect(protectedResult.shouldFilter).toBe(false);
    expect(protectedResult.protectionReason).toBe("source-kana-overlap");
    expect(extremeMaskResult.shouldFilter).toBe(true);
    expect(extremeMaskResult.protectionReason).toBeNull();
  });

  it("keeps a large region when two variants repeat a confident kanji", () => {
    const result = evaluateOcrPostFilterCandidate({
      sourceText: "事",
      probability: 0.5,
      originalLineCount: 1,
      hasBubble: false,
      relativeArea: 0.28698187315969487,
      aspectRatio: 1.565891472868217,
      variants: [
        { name: "inset", text: "はたちにしm", confidence: 0.2274427468457549, accepted: true },
        { name: "original", text: "事", confidence: 0.5731340646743774, accepted: true },
        { name: "outset", text: "29事", confidence: 0.3317442930061591, accepted: true },
      ],
      mask: {
        maskFillRatioInQuad: 0.40191744759434983,
        componentCount: 20,
        largestComponentRatio: 0.9675432593606413,
        boundaryPixelRatio: 0.21517254863623034,
      },
    });

    expect(result.shouldFilter).toBe(false);
    expect(result.protectionReason).toBe("large-high-confidence-han");
  });

  it("keeps a strong alternate kana reading for a numeric source", () => {
    const result = evaluateOcrPostFilterCandidate({
      sourceText: "7192",
      probability: 0.5,
      originalLineCount: 1,
      hasBubble: false,
      relativeArea: 0.0983158819395643,
      aspectRatio: 1.2429210134128168,
      variants: [
        { name: "inset", text: "ライ9ル", confidence: 0.4924815081576211, accepted: true },
        { name: "original", text: "7192", confidence: 0.7157332881564471, accepted: true },
        { name: "outset", text: "7TR12", confidence: 0.6875269761579349, accepted: true },
      ],
      mask: {
        maskFillRatioInQuad: 0.06052779112606119,
        componentCount: 23,
        largestComponentRatio: 0.1538207079060536,
        boundaryPixelRatio: 0.3820707906053589,
      },
    });

    expect(result.shouldFilter).toBe(false);
    expect(result.protectionReason).toBe("strong-alternate-kana");
  });

  it("filters the giant stylized laughter region that OCR reads as 民", () => {
    const result = evaluateOcrPostFilterCandidate({
      sourceText: "民",
      probability: 0.207,
      originalLineCount: 1,
      hasBubble: false,
      relativeArea: 0.399,
      aspectRatio: 1.792,
      variants: [
        { name: "inset", text: "KIVWA", confidence: 0.2736, accepted: true },
        { name: "original", text: "民", confidence: 0.9779, accepted: true },
        { name: "outset", text: "", confidence: 0, accepted: false },
      ],
      mask: {
        maskFillRatioInQuad: 0.124,
        componentCount: 80,
        largestComponentRatio: 0.171,
        boundaryPixelRatio: 0.462,
      },
    });

    expect(result.shouldFilter).toBe(true);
  });

  it.each([
    {
      label: "stable punctuation",
      sourceText: "!?",
      probability: 0.28945154591044875,
      relativeArea: 0.06746326890804687,
      aspectRatio: 1.224009900990099,
      variants: [
        { name: "inset", text: "!?", confidence: 0.8697927049925402, accepted: true },
        { name: "original", text: "!?", confidence: 0.3638102408956617, accepted: true },
        { name: "outset", text: "!?", confidence: 0.7915430456277883, accepted: true },
      ],
      mask: {
        maskFillRatioInQuad: 0.146856,
        componentCount: 15,
        largestComponentRatio: 0.528225,
        boundaryPixelRatio: 0.229694,
      },
    },
    {
      label: "kana sound effect",
      sourceText: "キッ",
      probability: 0.6085115884071317,
      relativeArea: 0.021582034523210995,
      aspectRatio: 1.4574468085106382,
      variants: [
        { name: "inset", text: "キッ…", confidence: 0.4624014497806295, accepted: true },
        { name: "original", text: "キッ", confidence: 0.5963760632283273, accepted: true },
        { name: "outset", text: "キ贝…", confidence: 0.4097322496487328, accepted: true },
      ],
      mask: {
        maskFillRatioInQuad: 0.363624,
        componentCount: 6,
        largestComponentRatio: 0.635701,
        boundaryPixelRatio: 0.171209,
      },
    },
    {
      label: "latin sound effect",
      sourceText: "Chu!",
      probability: 0.7361779316348259,
      relativeArea: 0.054125058188411755,
      aspectRatio: 1.398818316100443,
      variants: [
        { name: "inset", text: "Chal", confidence: 0.7057269548213447, accepted: true },
        { name: "original", text: "Chu!", confidence: 0.7361779316348259, accepted: true },
        { name: "outset", text: "Chl", confidence: 0.683467821942622, accepted: true },
      ],
      mask: {
        maskFillRatioInQuad: 0.260717,
        componentCount: 17,
        largestComponentRatio: 0.963371,
        boundaryPixelRatio: 0.152517,
      },
    },
    {
      label: "single kanji",
      sourceText: "危",
      probability: 0.6153147220611572,
      relativeArea: 0.03689808973861284,
      aspectRatio: 1.0495356037151702,
      variants: [
        { name: "inset", text: "宛", confidence: 0.2688615322113037, accepted: true },
        { name: "original", text: "危", confidence: 0.5970391035079956, accepted: true },
        { name: "outset", text: "苑", confidence: 0.30166009068489075, accepted: true },
      ],
      mask: {
        maskFillRatioInQuad: 0,
        componentCount: 0,
        largestComponentRatio: 0,
        boundaryPixelRatio: 0,
      },
    },
  ])("keeps reviewed correct OCR: $label", ({
    sourceText,
    probability,
    relativeArea,
    aspectRatio,
    variants,
    mask,
  }) => {
    const result = evaluateOcrPostFilterCandidate({
      sourceText,
      probability,
      originalLineCount: 1,
      hasBubble: false,
      relativeArea,
      aspectRatio,
      variants,
      mask,
    });

    expect(result.shouldFilter).toBe(false);
  });
});
