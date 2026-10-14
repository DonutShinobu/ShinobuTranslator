import { getExtensionRuntime, type ExtensionPort, type ExtensionRuntime } from '../../shared/extensionRuntime';
import type { ExtensionControlProjection } from '../../shared/extensionControl';
import { extensionControlChangedEventType, extensionControlPortName, sendExtensionControlCommand } from '../../shared/extensionControlTransport';

type ContentBooleanPreferenceKey = 'enableImageEditing' | 'autoTranslate';

export class ContentBooleanPreference {
  private readonly listeners = new Set<(enabled: boolean) => void>();
  private port?: ExtensionPort;
  private generation = 0;
  private revision = -1;
  private enabled = false;
  private retry?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly runtime: ExtensionRuntime,
    private readonly key: ContentBooleanPreferenceKey = 'enableImageEditing',
  ) {}

  subscribe(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener); listener(this.enabled);
    if (this.listeners.size === 1) this.connect();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.generation++; clearTimeout(this.retry); this.retry = undefined;
        const port = this.port; this.port = undefined; port?.disconnect();
      }
    };
  }

  private apply(projection: ExtensionControlProjection): void {
    if (projection.revision < this.revision) return;
    this.revision = projection.revision;
    const enabled = projection.settings[this.key] === true;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    for (const listener of this.listeners) listener(enabled);
  }

  private connect(): void {
    const generation = ++this.generation;
    try {
      const port = this.runtime.connect(extensionControlPortName); this.port = port;
      port.onMessage.addListener((message) => {
        if (this.port !== port || !message || typeof message !== 'object') return;
        const event = message as { type?: string; projection?: ExtensionControlProjection };
        if (event.type === extensionControlChangedEventType && event.projection) this.apply(event.projection);
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.port = undefined;
        if (this.listeners.size) this.retry = setTimeout(() => this.connect(), 300);
      });
    } catch { /* A read still works while the event port reconnects. */ }
    void sendExtensionControlCommand({ kind: 'read' }, this.runtime).then((result) => {
      if (generation === this.generation && this.listeners.size && result.kind === 'control-projection') this.apply(result.projection);
    }).catch(() => {});
  }
}

const sharedPreferences = new Map<ContentBooleanPreferenceKey, ContentBooleanPreference>();
export function observeContentBooleanPreference(
  key: ContentBooleanPreferenceKey,
  listener: (enabled: boolean) => void,
): () => void {
  const runtime = getExtensionRuntime();
  if (!runtime) return () => {};
  let preference = sharedPreferences.get(key);
  if (!preference) {
    preference = new ContentBooleanPreference(runtime, key);
    sharedPreferences.set(key, preference);
  }
  return preference.subscribe(listener);
}
