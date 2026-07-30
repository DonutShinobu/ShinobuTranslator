import {
  createTranslatorCore,
  type TranslatorCore,
} from '@shinobu/translator-core';
import type { LocalPipelineResult } from '../../../shared/localPipelineProtocol';
import type { PipelineConfig, PipelineProgress } from '../../../types';
import type { RunLocalPipeline } from './localPipelineClient';

export type ExtensionTranslatorCore = TranslatorCore<
  File,
  PipelineConfig,
  PipelineProgress,
  LocalPipelineResult
>;

export function createExtensionTranslatorCore(
  executePipeline: RunLocalPipeline,
): ExtensionTranslatorCore {
  return createTranslatorCore(
    ({ input, config }, { signal, reportProgress }) => (
      executePipeline(input, config, reportProgress, { signal })
    ),
  );
}
