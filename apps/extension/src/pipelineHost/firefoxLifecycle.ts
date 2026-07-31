import type {
  JsonValue,
  RuntimeChannel,
  RuntimeChannelDisconnectReason,
} from '../capabilities/contracts';
import {
  ExtensionOperationError,
} from '../capabilities/errors';
import type {
  PipelineHostActivation,
  PipelineHostController,
  PipelineHostDocumentLifecycle,
  PipelineHostStarter,
} from './contracts';
import {
  LOCAL_PIPELINE_OFFSCREEN_PORT,
} from './contracts';

type ChannelListener = (message: JsonValue) => void;
type DisconnectListener = (
  reason: RuntimeChannelDisconnectReason,
) => void;

class DirectRuntimeChannel implements RuntimeChannel {
  readonly name = LOCAL_PIPELINE_OFFSCREEN_PORT;
  readonly source = { kind: 'extension-document' as const };
  private readonly messageListeners = new Set<ChannelListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private readonly pendingMessages: JsonValue[] = [];
  private peer: DirectRuntimeChannel | null = null;
  private disconnected = false;

  pairWith(peer: DirectRuntimeChannel): void {
    this.peer = peer;
  }

  async send(message: JsonValue): Promise<void> {
    if (this.disconnected || !this.peer || this.peer.disconnected) {
      throw new ExtensionOperationError({
        capability: 'runtime-channel',
        operation: 'send',
        code: 'transport-disconnected',
        retryable: false,
      });
    }
    this.peer.deliver(message);
  }

  onMessage(listener: ChannelListener): () => void {
    this.messageListeners.add(listener);
    for (const message of this.pendingMessages.splice(0)) {
      listener(message);
    }
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onDisconnect(listener: DisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    this.disconnected = true;
    this.notifyDisconnect('closed-locally');
    this.peer?.disconnectFromPeer();
  }

  private deliver(message: JsonValue): void {
    if (this.disconnected) return;
    if (this.messageListeners.size === 0) {
      this.pendingMessages.push(message);
      return;
    }
    for (const listener of this.messageListeners) listener(message);
  }

  private disconnectFromPeer(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.notifyDisconnect('peer-disconnected');
  }

  private notifyDisconnect(reason: RuntimeChannelDisconnectReason): void {
    for (const listener of this.disconnectListeners) listener(reason);
    this.messageListeners.clear();
    this.disconnectListeners.clear();
    this.pendingMessages.length = 0;
  }
}

function createDirectChannelPair(): readonly [
  RuntimeChannel,
  RuntimeChannel,
] {
  const broker = new DirectRuntimeChannel();
  const host = new DirectRuntimeChannel();
  broker.pairWith(host);
  host.pairWith(broker);
  return [broker, host];
}

type DirectHostState = {
  readonly brokerChannel: RuntimeChannel;
  readonly hostChannel: RuntimeChannel;
  controller?: Promise<PipelineHostController>;
  disposal?: Promise<void>;
  activated: boolean;
};

function disposeDirectHost(state: DirectHostState): Promise<void> {
  state.disposal ??= (async () => {
    const controller = await state.controller;
    await controller?.dispose();
  })();
  return state.disposal;
}

export function createFirefoxPipelineHostLifecycle(
  startHost: PipelineHostStarter,
):
PipelineHostDocumentLifecycle {
  let state: DirectHostState | null = null;

  return {
    isAvailable() {
      return true;
    },
    accepts() {
      return false;
    },
    async exists() {
      return state !== null;
    },
    async create() {
      if (state) return undefined;
      const [brokerChannel, hostChannel] = createDirectChannelPair();
      const created: DirectHostState = {
        brokerChannel,
        hostChannel,
        activated: false,
      };
      state = created;
      brokerChannel.onDisconnect(() => {
        if (state !== created) return;
        state = null;
        void disposeDirectHost(created).catch(() => undefined);
      });
      return {
        channel: brokerChannel,
        activate() {
          if (state !== created || created.activated) return;
          created.activated = true;
          created.controller = Promise.resolve().then(() => startHost({
            connect: async () => hostChannel,
          }));
          void created.controller.catch(async () => {
            if (state === created) state = null;
            await created.brokerChannel.disconnect();
          });
        },
      } satisfies PipelineHostActivation;
    },
    async close() {
      const closing = state;
      if (!closing) return false;
      state = null;
      try {
        await disposeDirectHost(closing);
      } finally {
        await closing.brokerChannel.disconnect();
      }
      return true;
    },
  };
}
