import type { JsonValue } from './contracts';

export type ExtensionErrorCode =
  | 'browser-rejected'
  | 'quota-exceeded'
  | 'transport-disconnected'
  | 'context-unavailable'
  | 'serialization-failed'
  | 'invalid-message-source'
  | 'cleanup-failed';

export type ExtensionErrorDiagnostic = Readonly<Record<string, JsonValue>>;

export type ExtensionCapability =
  | 'authentication-tabs'
  | 'document-referrer-policy'
  | 'extension-cookies'
  | 'extension-environment'
  | 'extension-installation'
  | 'extension-permissions'
  | 'native-commands'
  | 'native-menus'
  | 'persistent-storage'
  | 'request-header-override'
  | 'runtime-channel'
  | 'runtime-request'
  | 'session-storage'
  | 'tab-message'
  | 'visible-tab-capture';

export type ExtensionOperation =
  | 'acquire'
  | 'bindings'
  | 'cancel:onChannel'
  | 'cancel:onChanged'
  | 'cancel:onClosed'
  | 'cancel:onDisconnect'
  | 'cancel:onMessage'
  | 'cancel:onNavigation'
  | 'cancel:onObserved'
  | 'cancel:onSelected'
  | 'cancel:onTriggered'
  | 'cancel:onInstalled'
  | 'cancelRequestListener'
  | 'capturePng'
  | 'check'
  | 'close'
  | 'disconnect'
  | 'initialize'
  | 'metadata'
  | 'normalize-origin'
  | 'onChanged'
  | 'onChannel'
  | 'onClosed'
  | 'onDisconnect'
  | 'onMessage'
  | 'onNavigation'
  | 'onObserved'
  | 'onInstalled'
  | 'onRequest'
  | 'onSelected'
  | 'onTriggered'
  | 'open'
  | 'openSettings'
  | 'read'
  | 'receiveResponse'
  | 'release'
  | 'remove'
  | 'replace'
  | 'request'
  | 'resourceUrl'
  | 'respond'
  | 'send'
  | 'subscribe:onDisconnect'
  | 'subscribe:onMessage'
  | 'translate-document'
  | 'write';

export type ExtensionErrorDetails = {
  capability: ExtensionCapability;
  operation: ExtensionOperation;
  code: ExtensionErrorCode;
  retryable: boolean;
  diagnostic?: ExtensionErrorDiagnostic;
  cause?: unknown;
};

function errorMessage(
  kind: 'contract' | 'operation',
  details: ExtensionErrorDetails,
): string {
  return `Extension ${kind} failure: ${details.capability}.${details.operation} (${details.code})`;
}

export function sanitizedErrorDiagnostic(error: unknown): ExtensionErrorDiagnostic {
  if (error instanceof Error) {
    return {
      errorName: error.name || 'Error',
    };
  }
  if (error === null) {
    return {
      errorType: 'null',
    };
  }
  return {
    errorType: typeof error,
  };
}

export class ExtensionContractError extends Error {
  readonly capability: ExtensionCapability;
  readonly operation: ExtensionOperation;
  readonly code: ExtensionErrorCode;
  readonly retryable: boolean;
  readonly diagnostic: ExtensionErrorDiagnostic;

  constructor(details: ExtensionErrorDetails) {
    super(errorMessage('contract', details), { cause: details.cause });
    this.name = 'ExtensionContractError';
    this.capability = details.capability;
    this.operation = details.operation;
    this.code = details.code;
    this.retryable = details.retryable;
    this.diagnostic = details.diagnostic ?? {};
  }
}

export class ExtensionOperationError extends Error {
  readonly capability: ExtensionCapability;
  readonly operation: ExtensionOperation;
  readonly code: ExtensionErrorCode;
  readonly retryable: boolean;
  readonly diagnostic: ExtensionErrorDiagnostic;

  constructor(details: ExtensionErrorDetails) {
    super(errorMessage('operation', details), { cause: details.cause });
    this.name = 'ExtensionOperationError';
    this.capability = details.capability;
    this.operation = details.operation;
    this.code = details.code;
    this.retryable = details.retryable;
    this.diagnostic = details.diagnostic ?? {};
  }
}
