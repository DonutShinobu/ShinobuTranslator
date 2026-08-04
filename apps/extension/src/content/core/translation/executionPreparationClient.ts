import type { ExtensionExecutionSnapshot } from '../../../shared/extensionControl';
import { sendExtensionControlCommand } from '../../../shared/extensionControlTransport';
import type { ExtensionRuntime } from '../../../shared/extensionRuntime';

export type PrepareImageTranslationExecution = (
  signal: AbortSignal,
) => Promise<ExtensionExecutionSnapshot>;

export function createExecutionPreparationClient(
  runtime?: ExtensionRuntime,
): PrepareImageTranslationExecution {
  return async (signal) => {
    if (signal.aborted) throw signal.reason;
    const result = await sendExtensionControlCommand(
      { kind: 'prepare-execution' },
      runtime,
    );
    if (signal.aborted) throw signal.reason;
    if (result.kind !== 'execution-snapshot') {
      throw new Error('执行准备未返回配置快照');
    }
    return result.snapshot;
  };
}
