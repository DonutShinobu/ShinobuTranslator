import type {
  ExtensionMessageSender,
  ExtensionPort,
} from './extensionRuntime';

type MessageListener = (message: unknown, port: ExtensionPort) => void;
type DisconnectListener = (port: ExtensionPort) => void;

class LocalExtensionPort implements ExtensionPort {
  private readonly messageListeners = new Set<MessageListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private peer: LocalExtensionPort | null = null;
  private connected = true;

  constructor(
    readonly name: string,
    readonly sender?: ExtensionMessageSender,
  ) {}

  pairWith(peer: LocalExtensionPort): void {
    this.peer = peer;
  }

  postMessage(message: unknown): void {
    const peer = this.peer;
    if (!this.connected || !peer?.connected) {
      throw new Error('Port 已断开');
    }
    const payload = structuredClone(message);
    queueMicrotask(() => {
      if (!this.connected || !peer.connected) return;
      for (const listener of [...peer.messageListeners]) {
        listener(payload, peer);
      }
    });
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    const peer = this.peer;
    if (!peer?.connected) return;
    peer.connected = false;
    queueMicrotask(() => {
      for (const listener of [...peer.disconnectListeners]) {
        listener(peer);
      }
    });
  }

  readonly onMessage = {
    addListener: (listener: MessageListener): void => {
      this.messageListeners.add(listener);
    },
    removeListener: (listener: MessageListener): void => {
      this.messageListeners.delete(listener);
    },
  };

  readonly onDisconnect = {
    addListener: (listener: DisconnectListener): void => {
      this.disconnectListeners.add(listener);
    },
    removeListener: (listener: DisconnectListener): void => {
      this.disconnectListeners.delete(listener);
    },
  };
}

export function createLocalExtensionPortPair(
  name: string,
  sender?: ExtensionMessageSender,
): [ExtensionPort, ExtensionPort] {
  const left = new LocalExtensionPort(name, sender);
  const right = new LocalExtensionPort(name, sender);
  left.pairWith(right);
  right.pairWith(left);
  return [left, right];
}
