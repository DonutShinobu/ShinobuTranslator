import {
  successfulConformanceScenario,
} from './scenarios';
import type {
  PipelineHostRuntimeComposition,
} from '../src/pipelineHost/contracts';

export const CONFORMANCE_COMPOSITION_SENTINEL =
  'shinobu-conformance-test-composition-v1';

export function createConformancePipelineHostComposition():
Required<PipelineHostRuntimeComposition> {
  const scenario = successfulConformanceScenario();
  if (scenario.matrixVersion !== 1) {
    throw new Error(CONFORMANCE_COMPOSITION_SENTINEL);
  }
  return {
    providerPolicy: scenario.providerPolicy,
    translationTransport: {
      async requestChatCompletion() {
        return {
          choices: [{
            message: {
              content: scenario.fixedTranslationResponse,
            },
          }],
        };
      },
      async translatePlain() {
        return scenario.fixedTranslationResponse;
      },
    },
  };
}

export const createTargetPipelineHostComposition =
  createConformancePipelineHostComposition;
