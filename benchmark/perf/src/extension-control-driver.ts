import type { BrowserContext } from '@playwright/test';
import type { ExtensionSettingsProjection } from '../../../apps/extension/src/shared/extensionControl';

export type ExtensionControlPatchInput = {
  patch: Partial<ExtensionSettingsProjection>;
  clearDiagnosticLog?: boolean;
};

export async function applyExtensionControlPatchInPage(
  input: ExtensionControlPatchInput,
): Promise<number> {
  type SendMessage = (message: unknown) => Promise<unknown>;
  type ChromeScope = typeof globalThis & {
    chrome?: { runtime?: { sendMessage?: SendMessage } };
  };
  const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  );
  const sendMessage = (globalThis as ChromeScope).chrome?.runtime?.sendMessage;
  if (!sendMessage) throw new Error('chrome.runtime.sendMessage is unavailable');

  const readResponse = await sendMessage({
    type: 'mt:extension-control',
    command: { kind: 'read' },
  });
  if (!isRecord(readResponse) || readResponse.ok !== true) {
    throw new Error(`Extension control read failed: ${JSON.stringify(readResponse)}`);
  }
  const readResult = readResponse.result;
  if (!isRecord(readResult) || readResult.kind !== 'control-projection') {
    throw new Error(`Extension control returned an invalid result: ${JSON.stringify(readResponse)}`);
  }
  const projection = readResult.projection;
  if (
    !isRecord(projection)
    || !Number.isSafeInteger(projection.revision)
    || !isRecord(projection.settings)
  ) {
    throw new Error(`Extension control returned an invalid projection: ${JSON.stringify(readResponse)}`);
  }

  const replaceResponse = await sendMessage({
    type: 'mt:extension-control',
    command: {
      kind: 'replace-settings',
      expectedRevision: projection.revision,
      settings: {
        ...projection.settings,
        ...input.patch,
      },
    },
  });
  if (!isRecord(replaceResponse) || replaceResponse.ok !== true) {
    throw new Error(`Extension control replace failed: ${JSON.stringify(replaceResponse)}`);
  }
  const replaceResult = replaceResponse.result;
  const nextProjection = isRecord(replaceResult) ? replaceResult.projection : undefined;
  if (
    !isRecord(replaceResult)
    || replaceResult.kind !== 'control-projection'
    || !isRecord(nextProjection)
    || !Number.isSafeInteger(nextProjection.revision)
  ) {
    throw new Error(`Extension control returned an invalid replacement: ${JSON.stringify(replaceResponse)}`);
  }

  if (input.clearDiagnosticLog) {
    const clearResponse = await sendMessage({ type: 'mt:diagnostic-log-clear' });
    if (!isRecord(clearResponse) || clearResponse.ok !== true) {
      throw new Error(`Diagnostic log clear failed: ${JSON.stringify(clearResponse)}`);
    }
  }

  return nextProjection.revision as number;
}

export async function applyExtensionControlPatch(
  context: BrowserContext,
  extensionId: string,
  input: ExtensionControlPatchInput,
): Promise<number> {
  const popup = await context.newPage();
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'load' });
    await popup.evaluate('globalThis.__name ??= (target) => target;');
    return await popup.evaluate(applyExtensionControlPatchInPage, input);
  } finally {
    await popup.close();
  }
}
