import {
  createTranslatorCore,
  type TranslatorCore,
} from '@shinobu/translator-core';
import type { LocalPipelineResult } from '@shinobu/image-pipeline/protocol';
import type { PipelineConfig, PipelineProgress } from '@shinobu/image-pipeline';
import {
  runLocalPipeline,
  type RunLocalPipeline,
} from './localPipelineClient';

export type ExtensionTranslatorCore = TranslatorCore<
  File,
  PipelineConfig,
  PipelineProgress,
  LocalPipelineResult
>;

export function createExtensionTranslatorCore(
  executePipeline: RunLocalPipeline = runLocalPipeline,
): ExtensionTranslatorCore {
  return createTranslatorCore(
    ({ input, config }, { signal, reportProgress }) => (
      executePipeline(input, config, reportProgress, { signal })
    ),
  );
}
