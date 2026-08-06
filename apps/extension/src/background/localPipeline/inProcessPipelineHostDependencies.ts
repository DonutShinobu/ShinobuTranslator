import type { ExtensionMessageSender } from '../../shared/extensionRuntime';
import {
  createDiagnosticLogEmitter,
} from '../../shared/diagnosticLogClient';
import {
  createMessageTextTranslationTransport,
} from '../../shared/textTranslationTransport';
import type { PipelineHostDependencies } from '../../offscreen/pipelineHost';
import { dispatchBackgroundMessage } from '../index';
import { createExtensionModelRuntime } from '../../shared/extensionModelRuntime';
import { browserPipelinePlatform } from '../../shared/browserPipelinePlatform';
import { requireExtensionRuntime } from '../../shared/extensionRuntime';
import {
  getPipelineLifecycleTestIdleTimeoutMs,
  isPipelineLifecycleTestBuild,
} from '../../shared/buildFlags';

const pipelineHostSender: ExtensionMessageSender = {};

export function createInProcessPipelineHostDependencies(): PipelineHostDependencies {
  const sendMessage = (message: Parameters<typeof dispatchBackgroundMessage>[0]) =>
    dispatchBackgroundMessage(message, pipelineHostSender);

  return {
    modelRuntime: createExtensionModelRuntime(),
    platform: browserPipelinePlatform,
    idleTimeoutMs: isPipelineLifecycleTestBuild()
      ? getPipelineLifecycleTestIdleTimeoutMs()
      : undefined,
    fontSource: requireExtensionRuntime().getURL.bind(requireExtensionRuntime()),
    translationTransport: createMessageTextTranslationTransport(sendMessage),
    diagnostics: createDiagnosticLogEmitter(async (event) => {
      const response = await sendMessage({
        type: 'mt:diagnostic-log-event',
        event,
      });
      return response.ok && response.type === 'mt:diagnostic-log-event';
    }),
  };
}
