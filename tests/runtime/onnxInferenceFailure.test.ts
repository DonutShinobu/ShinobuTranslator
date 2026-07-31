import { describe, expect, it } from 'vitest';
import {
  throwOnInferenceFailure,
} from '../../src/runtime/onnxBridge';
import { ProviderSessionLostError } from '../../src/runtime/providerExecution';

describe('ONNX inference failure contract', () => {
  it('turns a stable session-loss code into a provider recovery signal', () => {
    expect(() => throwOnInferenceFailure({
      outputs: {},
      failure: {
        code: 'session-lost',
        detail: 'private adapter detail',
      },
    })).toThrow(ProviderSessionLostError);
  });

  it('keeps legacy exception text diagnostic-only', () => {
    expect(() => {
      throwOnInferenceFailure({
        outputs: {},
        error: 'GPU device lost in private driver',
      });
    }).not.toThrow();
  });
});
