import type {
  PipelineHostRuntimeComposition,
  PipelineHostTranslationTransport,
} from '../src/pipelineHost/contracts';
import {
  createConformancePipelineHostComposition,
} from './pipelineHostComposition';
import type {
  ConformanceBarrierSink,
} from './pipelineHostComposition.detectorFailure';

type RetryableNetworkError = TypeError & {
  retryable: true;
  retryAfterMs: number;
};

export type BarrierAwareTranslationTransport =
  & PipelineHostTranslationTransport
  & {
    setConformanceBarrierSink(sink: ConformanceBarrierSink): void;
  };

function retryableNetworkError(): RetryableNetworkError {
  return Object.assign(new TypeError('conformance network failure'), {
    retryable: true as const,
    retryAfterMs: 1,
  });
}

export function createTranslationFailureTransport(
  onBarrier: ConformanceBarrierSink = () => undefined,
): BarrierAwareTranslationTransport {
  let attempt = 0;
  let barrierSink = onBarrier;
  const fail = async (): Promise<never> => {
    attempt += 1;
    barrierSink(`translation-network-attempt-${attempt}`);
    throw retryableNetworkError();
  };
  return {
    setConformanceBarrierSink(sink) {
      barrierSink = sink;
    },
    requestChatCompletion: fail,
    translatePlain: fail,
  };
}

export function createTargetPipelineHostComposition():
PipelineHostRuntimeComposition {
  const common = createConformancePipelineHostComposition();
  return {
    ...common,
    translationTransport: createTranslationFailureTransport(),
  };
}
