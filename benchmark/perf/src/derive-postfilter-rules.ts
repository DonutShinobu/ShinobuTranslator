import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateOcrPostFilterCandidate } from '@shinobu/image-pipeline/benchmark';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_ANALYSIS = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-postfilter-study-analysis-v1-20260721",
);

type OcrVariant = {
  name: string;
  text: string;
  confidence: number;
  accepted: boolean;
};

type FeatureRow = {
  id: string;
  input: string;
  sourceText: string;
  normalizedSourceText: string;
  graphemeCount: number;
  probability: number;
  direction: string;
  originalLineCount: number;
  hasBubble: boolean;
  relativeArea: number;
  aspectRatio: number;
  variants: OcrVariant[];
  ocr: {
    acceptedCount: number;
    stableExact: boolean;
    majorityAgreement: boolean;
    emptyVariantCount: number;
    confidenceMinimum: number;
    confidenceMean: number;
    graphemeCountRange: number;
    maximumNormalizedEditDistance: number;
  };
  mask: {
    maskFillRatioInQuad: number;
    componentCount: number;
    largestComponentRatio: number;
    axisResidual: number;
    boundaryPixelRatio: number;
  };
  cheapGate: boolean;
};

type CrosswalkRow = {
  reviewIndex: number;
  reviewLabel: string;
  input: string;
  matchedFeatureId?: string;
  matchIou?: number;
};

type ReviewDisposition =
  | "filter_false_region"
  | "filter_wrong_ocr_real_text"
  | "filter_wrong_ocr_mixed"
  | "protect_correct_ocr"
  | "exclude_mixed";

type RuleContext = {
  feature: FeatureRow;
  script: ReturnType<typeof textScript>;
  variantScriptDrift: boolean;
  nonEmptyScriptDrift: boolean;
  originalVariantConfidence: number;
  componentCountPerGrapheme: number;
  maskSignalCount: number;
  junkLikeSource: boolean;
  poorConsensus: boolean;
};

type RuleDefinition = {
  id: string;
  description: string;
  test: (context: RuleContext) => boolean;
};

// Provisional visual relabel from the generated contact sheets. The old
// `actual_text` label only asserted that real text existed inside the box; it
// did not assert that the project's OCR transcription was correct.
const CORRECT_OCR_REVIEW_INDICES = new Set([62]);
const SUPPLEMENTAL_CORRECT_OCR_KEYS = new Set([
  "11482661.png#キッ",
  "11529588.png#Chu!",
  "11640561.jpg#危",
]);

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function textScript(text: string): {
  empty: boolean;
  kana: boolean;
  han: boolean;
  latin: boolean;
  digit: boolean;
  punctuationOnly: boolean;
  signature: string;
} {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, "");
  const kana = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(normalized);
  const han = /\p{Script=Han}/u.test(normalized);
  const latin = /\p{Script=Latin}/u.test(normalized);
  const digit = /\p{Number}/u.test(normalized);
  const punctuationOnly = Boolean(normalized)
    && /^[\p{Punctuation}\p{Symbol}]+$/u.test(normalized);
  const signature = [
    kana ? "kana" : "",
    han ? "han" : "",
    latin ? "latin" : "",
    digit ? "digit" : "",
    punctuationOnly ? "punct" : "",
  ].filter(Boolean).join("+") || (normalized ? "other" : "empty");
  return {
    empty: !normalized,
    kana,
    han,
    latin,
    digit,
    punctuationOnly,
    signature,
  };
}

function buildRuleContext(feature: FeatureRow): RuleContext {
  const script = textScript(feature.normalizedSourceText);
  const nonEmptySignatures = new Set(
    feature.variants
      .map((variant) => textScript(variant.text))
      .filter((value) => !value.empty)
      .map((value) => value.signature),
  );
  const nonEmptyScriptDrift = nonEmptySignatures.size > 1;
  const variantScriptDrift = nonEmptyScriptDrift
    || feature.ocr.emptyVariantCount > 0;
  const originalVariantConfidence = feature.variants.find(
    (variant) => variant.name === "original",
  )?.confidence ?? 0;
  const componentCountPerGrapheme = (
    feature.mask.componentCount / Math.max(1, feature.graphemeCount)
  );
  const maskSignals = [
    componentCountPerGrapheme >= 8,
    feature.mask.boundaryPixelRatio >= 0.28,
    feature.mask.maskFillRatioInQuad <= 0.13,
    feature.mask.maskFillRatioInQuad >= 0.7,
    feature.mask.largestComponentRatio <= 0.18,
    feature.probability < 0.3,
  ];
  const mixedJapaneseAndAscii = (
    (script.kana || script.han)
    && (script.latin || script.digit)
  );
  const shortLatin = script.latin
    && !script.kana
    && !script.han
    && feature.graphemeCount <= 4;
  const singleHanWithDrift = script.han
    && !script.kana
    && !script.latin
    && !script.digit
    && feature.graphemeCount === 1
    && variantScriptDrift;
  const junkLikeSource = !script.punctuationOnly && (
    mixedJapaneseAndAscii
    || shortLatin
    || singleHanWithDrift
  );
  const poorConsensus = !feature.ocr.majorityAgreement && (
    feature.ocr.maximumNormalizedEditDistance >= 0.67
    || feature.ocr.emptyVariantCount > 0
    || feature.ocr.graphemeCountRange >= 2
    || variantScriptDrift
  );
  return {
    feature,
    script,
    variantScriptDrift,
    nonEmptyScriptDrift,
    originalVariantConfidence,
    componentCountPerGrapheme,
    maskSignalCount: maskSignals.filter(Boolean).length,
    junkLikeSource,
    poorConsensus,
  };
}

function expandedGate(feature: FeatureRow): boolean {
  return (
    Boolean(feature.normalizedSourceText)
    && !feature.hasBubble
    && feature.originalLineCount <= 1
    && feature.graphemeCount <= 5
    && feature.relativeArea >= 0.015
    && feature.aspectRatio <= 2.6
  );
}

function highPrecisionV3(context: RuleContext): boolean {
  return (
    expandedGate(context.feature)
    && context.poorConsensus
    && (
      (
        context.junkLikeSource
        && (
          context.maskSignalCount >= 2
          || (
            context.feature.relativeArea >= 0.12
            && context.maskSignalCount >= 1
          )
        )
      )
      || (
        context.variantScriptDrift
        && !context.script.kana
        && context.feature.ocr.confidenceMean < 0.35
        && context.maskSignalCount >= 1
      )
    )
  );
}

function mediumPrecisionV2(context: RuleContext): boolean {
  return (
    highPrecisionV3(context)
    || (
      expandedGate(context.feature)
      && !context.feature.ocr.majorityAgreement
      && context.nonEmptyScriptDrift
      && (
        context.maskSignalCount >= 1
        || context.feature.ocr.confidenceMean < 0.4
      )
    )
  );
}

function mediumPrecisionV3(context: RuleContext): boolean {
  return mediumPrecisionV2(context)
    || (
      expandedGate(context.feature)
      && !context.feature.ocr.majorityAgreement
      && context.originalVariantConfidence < 0.5
      && context.maskSignalCount >= 1
    );
}

function productionBalancedRule(context: RuleContext): boolean {
  const feature = context.feature;
  return evaluateOcrPostFilterCandidate({
    sourceText: feature.sourceText,
    probability: feature.probability,
    originalLineCount: feature.originalLineCount,
    hasBubble: feature.hasBubble,
    relativeArea: feature.relativeArea,
    aspectRatio: feature.aspectRatio,
    variants: feature.variants,
    mask: feature.mask,
  }).shouldFilter;
}

const RULES: RuleDefinition[] = [
  {
    id: "cheap_gate",
    description: "原前置 gate，仅作基线",
    test: ({ feature }) => feature.cheapGate,
  },
  {
    id: "cheap_gate_no_majority",
    description: "原前置 gate + 三次 OCR 无多数一致",
    test: ({ feature }) => feature.cheapGate && !feature.ocr.majorityAgreement,
  },
  {
    id: "expanded_gate_no_majority",
    description: "放宽长宽比的 gate + 三次 OCR 无多数一致",
    test: ({ feature }) => expandedGate(feature) && !feature.ocr.majorityAgreement,
  },
  {
    id: "high_precision_v1",
    description:
      "放宽 gate；OCR 明显不稳定；输出像乱码；raw mask 至少两个异常信号",
    test: (context) => (
      expandedGate(context.feature)
      && context.poorConsensus
      && context.junkLikeSource
      && context.maskSignalCount >= 2
    ),
  },
  {
    id: "high_precision_v2",
    description:
      "v1，并允许占图 12% 以上的巨大候选只需一个 mask 异常信号",
    test: (context) => (
      expandedGate(context.feature)
      && context.poorConsensus
      && context.junkLikeSource
      && (
        context.maskSignalCount >= 2
        || (
          context.feature.relativeArea >= 0.12
          && context.maskSignalCount >= 1
        )
      )
    ),
  },
  {
    id: "high_precision_v3",
    description:
      "v2，并纳入脚本漂移且置信度很低的非日文短输出",
    test: highPrecisionV3,
  },
  {
    id: "medium_precision_v1",
    description:
      "高精度规则，或跨脚本漂移 + mask 异常 + 三次 OCR 平均置信度低",
    test: (context) => (
      highPrecisionV3(context)
      || (
        expandedGate(context.feature)
        && !context.feature.ocr.majorityAgreement
        && context.nonEmptyScriptDrift
        && context.maskSignalCount >= 1
        && context.feature.ocr.confidenceMean < 0.55
      )
    ),
  },
  {
    id: "medium_precision_v2",
    description:
      "高精度规则，或跨脚本漂移且同时有 mask 异常/很低置信度",
    test: mediumPrecisionV2,
  },
  {
    id: "medium_precision_v3",
    description:
      "v2，并纳入原框 OCR 低于 0.50 且有至少一个 mask 异常信号的候选",
    test: mediumPrecisionV3,
  },
  {
    id: "medium_precision_v4",
    description:
      "v3，并保护三次 OCR 中可复核的汉字/假名证据（浊点、半浊点归一化）",
    test: productionBalancedRule,
  },
  {
    id: "medium_precision_v5",
    description:
      "v2，并纳入原框 OCR 低于 0.55 且有至少两个 mask 异常信号的候选",
    test: (context) => (
      mediumPrecisionV2(context)
      || (
        expandedGate(context.feature)
        && !context.feature.ocr.majorityAgreement
        && context.originalVariantConfidence < 0.55
        && context.maskSignalCount >= 2
      )
    ),
  },
];

function dispositionForReview(row: CrosswalkRow): ReviewDisposition {
  if (row.reviewLabel === "face_text_mixed") {
    return "exclude_mixed";
  }
  if (row.reviewLabel === "actual_text") {
    return CORRECT_OCR_REVIEW_INDICES.has(row.reviewIndex)
      ? "protect_correct_ocr"
      : "filter_wrong_ocr_real_text";
  }
  return "filter_false_region";
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) {
    const label = key(value);
    output[label] = (output[label] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(output).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function main(): Promise<void> {
  const analysisDir = resolve(readOption("analysis") ?? DEFAULT_ANALYSIS);
  await mkdir(analysisDir, { recursive: true });
  const features = JSON.parse(
    await readFile(join(analysisDir, "postfilter-features.json"), "utf8"),
  ) as FeatureRow[];
  const crosswalk = JSON.parse(
    await readFile(join(analysisDir, "review-crosswalk.json"), "utf8"),
  ) as CrosswalkRow[];
  const featureById = new Map(features.map((feature) => [feature.id, feature]));
  const reviewed = crosswalk
    .filter((row) => row.matchedFeatureId && featureById.has(row.matchedFeatureId))
    .map((row) => {
      const feature = featureById.get(row.matchedFeatureId!)!;
      let disposition = dispositionForReview(row);
      if (
        disposition === "exclude_mixed"
        && expandedGate(feature)
        && !feature.ocr.majorityAgreement
      ) {
        disposition = "filter_wrong_ocr_mixed";
      }
      return {
        ...row,
        disposition,
        feature,
        context: buildRuleContext(feature),
      };
    });

  const oldReviewedFeatureIds = new Set(reviewed.map((row) => row.feature.id));
  const supplementalReviewed = features
    .filter((feature) => !oldReviewedFeatureIds.has(feature.id))
    .filter((feature) => expandedGate(feature) && !feature.ocr.majorityAgreement)
    .map((feature) => {
      const key = `${feature.input}#${feature.normalizedSourceText}`;
      return {
        reviewIndex: undefined,
        reviewLabel: "supplemental_rule_hit_review",
        input: feature.input,
        disposition: SUPPLEMENTAL_CORRECT_OCR_KEYS.has(key)
          ? "protect_correct_ocr" as const
          : "filter_false_region" as const,
        feature,
        context: buildRuleContext(feature),
      };
    });
  const allReviewed = [...reviewed, ...supplementalReviewed];

  const labels = allReviewed.map((row) => ({
    reviewIndex: row.reviewIndex,
    input: row.input,
    featureId: row.feature.id,
    previousLabel: row.reviewLabel,
    disposition: row.disposition,
    pipelineText: row.feature.sourceText,
    tripleOcr: row.feature.variants.map((variant) => ({
      name: variant.name,
      text: variant.text,
      confidence: variant.confidence,
      accepted: variant.accepted,
    })),
    provisional: true,
    provenance: row.reviewLabel === "supplemental_rule_hit_review"
      ? "Codex visual review of expanded-gate incremental contact sheets; user confirmation still recommended"
      : "Codex visual review of ocr-correctness-sheets; user confirmation still recommended",
  }));
  await writeFile(
    join(analysisDir, "ocr-correctness-labels.provisional.json"),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      note:
        "The old actual_text label meant that text was present, not that OCR was correct.",
      correctOcrReviewIndices: [...CORRECT_OCR_REVIEW_INDICES],
      supplementalCorrectOcrKeys: [...SUPPLEMENTAL_CORRECT_OCR_KEYS],
      counts: countBy(labels, (row) => row.disposition),
      items: labels,
    }, null, 2),
    "utf8",
  );

  const filterTargets = allReviewed.filter((row) => (
    row.disposition === "filter_false_region"
    || row.disposition === "filter_wrong_ocr_real_text"
    || row.disposition === "filter_wrong_ocr_mixed"
  ));
  const reviewedProtected = allReviewed.filter(
    (row) => row.disposition === "protect_correct_ocr",
  );
  const reviewedFeatureIds = new Set(allReviewed.map((row) => row.feature.id));
  const conservativeControls = features
    .filter((feature) => !reviewedFeatureIds.has(feature.id))
    .filter((feature) => (
      (
        feature.ocr.stableExact
        && feature.ocr.acceptedCount === 3
        && feature.ocr.confidenceMinimum >= 0.5
      )
      || (
        feature.hasBubble
        && feature.graphemeCount >= 3
        && feature.ocr.majorityAgreement
      )
    ))
    .map((feature) => ({
      feature,
      context: buildRuleContext(feature),
    }));

  const evaluations = RULES.map((rule) => {
    const targetHits = filterTargets.filter((row) => rule.test(row.context));
    const reviewedProtectedHits = reviewedProtected.filter(
      (row) => rule.test(row.context),
    );
    const controlHits = conservativeControls.filter(
      (row) => rule.test(row.context),
    );
    const allHits = features
      .map((feature) => ({ feature, context: buildRuleContext(feature) }))
      .filter((row) => rule.test(row.context));
    return {
      id: rule.id,
      description: rule.description,
      filterTargetCount: filterTargets.length,
      filterTargetHits: targetHits.length,
      filterTargetRecall: targetHits.length / Math.max(1, filterTargets.length),
      targetHitsByPreviousLabel: countBy(targetHits, (row) => row.reviewLabel),
      targetHitsByDisposition: countBy(targetHits, (row) => row.disposition),
      reviewedProtectedCount: reviewedProtected.length,
      reviewedProtectedHits: reviewedProtectedHits.length,
      conservativeControlCount: conservativeControls.length,
      conservativeControlHits: controlHits.length,
      allRegionHits: allHits.length,
      allImageHits: new Set(allHits.map((row) => row.feature.input)).size,
      hitFeatureIds: allHits.map((row) => row.feature.id),
    };
  });

  const selectedRuleId = readOption("selected-rule") ?? "medium_precision_v4";
  const selected = evaluations.find((row) => row.id === selectedRuleId);
  if (!selected) {
    throw new Error(
      `Unknown --selected-rule=${selectedRuleId}; expected one of ${RULES.map((rule) => rule.id).join(", ")}`,
    );
  }
  const excludeRuleId = readOption("exclude-rule");
  const excluded = excludeRuleId
    ? evaluations.find((row) => row.id === excludeRuleId)
    : undefined;
  if (excludeRuleId && !excluded) {
    throw new Error(
      `Unknown --exclude-rule=${excludeRuleId}; expected one of ${RULES.map((rule) => rule.id).join(", ")}`,
    );
  }
  const reviewScope = readOption("review-scope") ?? "all";
  const excludedHitIds = new Set(excluded?.hitFeatureIds ?? []);
  const selectedHitIds = new Set(
    selected.hitFeatureIds.filter((id) => !excludedHitIds.has(id)),
  );
  const selectedHits = features
    .filter((feature) => selectedHitIds.has(feature.id))
    .map((feature) => {
      const context = buildRuleContext(feature);
      const review = allReviewed.find((row) => row.feature.id === feature.id);
      return {
        id: feature.id,
        input: feature.input,
        sourceText: feature.sourceText,
        tripleOcr: feature.variants.map((variant) => ({
          name: variant.name,
          text: variant.text,
          confidence: variant.confidence,
          accepted: variant.accepted,
        })),
        previousLabel: review?.reviewLabel,
        disposition: review?.disposition,
        relativeArea: feature.relativeArea,
        aspectRatio: feature.aspectRatio,
        detectorProbability: feature.probability,
        ocr: feature.ocr,
        mask: feature.mask,
        derived: {
          variantScriptDrift: context.variantScriptDrift,
          nonEmptyScriptDrift: context.nonEmptyScriptDrift,
          originalVariantConfidence: context.originalVariantConfidence,
          componentCountPerGrapheme: context.componentCountPerGrapheme,
          maskSignalCount: context.maskSignalCount,
          junkLikeSource: context.junkLikeSource,
          poorConsensus: context.poorConsensus,
        },
      };
    })
    .filter((row) => (
      reviewScope !== "unreviewed-or-mixed"
      || !row.disposition
      || row.disposition === "exclude_mixed"
    ));

  await writeFile(
    join(analysisDir, "postfilter-rule-evaluation.json"),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      featureCount: features.length,
      reviewedCount: allReviewed.length,
      dispositions: countBy(allReviewed, (row) => row.disposition),
      conservativeControlDefinition:
        "unreviewed stable 3/3 OCR with min confidence >= 0.5, or bubble-matched >=3 graphemes with OCR majority",
      conservativeControlCount: conservativeControls.length,
      selectedRule: selected.id,
      selectedHitFile: buildHitFileName(selectedRuleId, excludeRuleId, reviewScope),
      evaluations,
    }, null, 2),
    "utf8",
  );
  const hitFileName = buildHitFileName(selectedRuleId, excludeRuleId, reviewScope);
  await writeFile(
    join(analysisDir, hitFileName),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      rule: selected.id,
      excludeRule: excluded?.id,
      reviewScope,
      count: selectedHits.length,
      imageCount: new Set(selectedHits.map((row) => row.input)).size,
      items: selectedHits,
    }, null, 2),
    "utf8",
  );

  const giantLaughter = features.find((feature) => (
    feature.input === "11375742.png"
    && feature.normalizedSourceText === "民"
  ));
  const giantLaughterEvaluation = giantLaughter
    ? buildRuleContext(giantLaughter)
    : undefined;
  const markdown = [
    "# Danbooru post-filter rule study",
    "",
    `- Full rerun regions: ${features.length}`,
    `- Reviewed candidates and supplemental rule hits: ${allReviewed.length}`,
    `- Provisional filter targets: ${filterTargets.length}`,
    `- Provisional correct-OCR protected samples: ${reviewedProtected.length}`,
    `- Conservative unreviewed controls: ${conservativeControls.length}`,
    "",
    "## Rule comparison",
    "",
    "| Rule | Target hits | Recall | Reviewed protected hits | Control hits | All hits/images |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...evaluations.map((evaluation) => (
      `| ${evaluation.id} | ${evaluation.filterTargetHits}/${evaluation.filterTargetCount}`
      + ` | ${(evaluation.filterTargetRecall * 100).toFixed(1)}%`
      + ` | ${evaluation.reviewedProtectedHits}/${evaluation.reviewedProtectedCount}`
      + ` | ${evaluation.conservativeControlHits}/${evaluation.conservativeControlCount}`
      + ` | ${evaluation.allRegionHits}/${evaluation.allImageHits} |`
    )),
    "",
    "## Selected production rule",
    "",
    `Selected: \`${selected.id}\` (${selected.filterTargetHits}/${selected.filterTargetCount}`,
    `provisional targets, ${(selected.filterTargetRecall * 100).toFixed(1)}%;`,
    `${selected.reviewedProtectedHits}/${selected.reviewedProtectedCount} reviewed correct OCR hits;`,
    `${selected.conservativeControlHits}/${selected.conservativeControlCount} conservative control hits).`,
    "",
    "Candidate gate: non-empty OCR, no matched bubble, one pre-merge line, at most",
    "five graphemes, at least 1.5% of the image, and aspect ratio at most 2.6.",
    "Every filtered candidate must have no exact 2/3 OCR majority across 0.94x,",
    "1.00x, and 1.06x crops, plus one of the following guarded paths:",
    "",
    "- junk-like OCR with poor consensus and multiple raw-mask anomalies (one",
    "  anomaly is enough above 12% image area);",
    "- non-empty script-family drift plus a mask anomaly or mean OCR confidence",
    "  below 0.40;",
    "- original-crop OCR confidence below 0.50 plus a mask anomaly.",
    "",
    "Before filtering, v4 protects corroborated Japanese evidence across OCR",
    "variants. Kana comparison ignores dakuten/handakuten differences; narrow",
    "fallbacks cover multi-character source overlap, large confident kanji, and",
    "a strong alternate kana reading when the pipeline source is numeric.",
    "",
    "Mask anomalies are: >=8 connected components per OCR grapheme, boundary",
    "pixel ratio >=0.28, fill ratio <=0.13 or >=0.70, largest component ratio",
    "<=0.18, or initial merged OCR probability <0.30.",
    ...(giantLaughter && giantLaughterEvaluation
      ? [
          "",
          `The giant laughter example \`${giantLaughter.input}\` is caught: OCR`,
          `\`${giantLaughter.sourceText}\`, ${(giantLaughter.relativeArea * 100).toFixed(1)}% image area,`,
          `${giantLaughterEvaluation.maskSignalCount} mask signals, and variants`,
          `\`${giantLaughter.variants.map((variant) => variant.text || "∅").join(" / ")}\`.`,
        ]
      : []),
    "",
    "The labels are provisional. In particular, `actual_text` was split by OCR",
    "correctness after visual review; it must not be used as a synonym for valid OCR.",
    "",
  ].join("\n");
  await writeFile(join(analysisDir, "postfilter-rule-study.md"), markdown, "utf8");

  console.log(markdown);
}

function buildHitFileName(
  selectedRuleId: string,
  excludeRuleId: string | undefined,
  reviewScope: string,
): string {
  if (
    selectedRuleId === "medium_precision_v4"
    && !excludeRuleId
    && reviewScope === "all"
  ) {
    return "postfilter-rule-hits.json";
  }
  const parts = ["postfilter-rule-hits", selectedRuleId];
  if (excludeRuleId) parts.push(`minus-${excludeRuleId}`);
  if (reviewScope !== "all") parts.push(reviewScope);
  return `${parts.join(".")}.json`;
}

await main();
