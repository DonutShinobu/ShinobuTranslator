import type { ExtensionMessageSender } from '../../shared/extensionRuntime';
import {
  createDiagnosticLogEmitter,
} from '../../shared/diagnosticLogClient';
import {
  createMessageTextTranslationTransport,
} from '../../translators/transport';
import type { PipelineHostDependencies } from '../../offscreen/pipelineHost';
import { dispatchBackgroundMessage } from '../index';

const pipelineHostSender: ExtensionMessageSender = {};

export function createInProcessPipelineHostDependencies(): PipelineHostDependencies {
  const sendMessage = (message: Parameters<typeof dispatchBackgroundMessage>[0]) =>
    dispatchBackgroundMessage(message, pipelineHostSender);

  return {
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
