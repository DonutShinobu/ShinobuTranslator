import type { ExtensionPort } from './extensionRuntime';
import { requireExtensionRuntime } from './extensionRuntime';

export interface PipelineHostTransport {
  readonly reconnectOnDisconnect: boolean;
  connect(name: string): ExtensionPort;
}

export class RuntimePipelineHostTransport implements PipelineHostTransport {
  readonly reconnectOnDisconnect = true;

  connect(name: string): ExtensionPort {
    return requireExtensionRuntime().connect(name);
  }
}

export class FixedPipelineHostTransport implements PipelineHostTransport {
  readonly reconnectOnDisconnect = false;

  constructor(private readonly port: ExtensionPort) {}

  connect(): ExtensionPort {
    return this.port;
  }
}
