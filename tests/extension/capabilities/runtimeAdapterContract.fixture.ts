import { expect, it } from 'vitest';
import type {
  BackgroundExtensionCapabilities,
  ContentExtensionCapabilities,
  ExtensionMessageSource,
  JsonValue,
} from '../../../apps/extension/src/capabilities/contracts';
import {
  ExtensionOperationError,
} from '../../../apps/extension/src/capabilities/errors';

export type RuntimeAdapterContractDriver = {
  capabilities: ContentExtensionCapabilities;
  extensionDocumentUrl(path: string): string;
  respondWith(response: JsonValue | undefined): void;
  makeNextRequestUnavailable(): void;
  rejectNextRequest(error: Error): void;
  dispatchRequest(
    request: JsonValue,
    source: ExtensionMessageSource,
  ): Promise<JsonValue | undefined>;
  removedRequestListeners(): number;
  sentRequests(): unknown[];
  emitChannelMessage(message: unknown): void;
  emitChannelDisconnect(): void;
  removedChannelMessageListeners(): number;
  rawChannelDisconnects(): number;
  sentChannelMessages(): unknown[];
};

export function runRuntimeAdapterContract(
  createDriver: () => RuntimeAdapterContractDriver,
): void {
  it('delivers a successful one-time request through a Promise result', async () => {
    const driver = createDriver();
    driver.respondWith({ pong: true });

    await expect(driver.capabilities.runtimeRequests.request({
      type: 'ping',
    })).resolves.toEqual({
      status: 'response',
      value: { pong: true },
    });
  });

  it('returns an explicit no-response result for an expected empty response', async () => {
    const driver = createDriver();
    driver.respondWith(undefined);

    await expect(driver.capabilities.runtimeRequests.request({
      type: 'optional-query',
    })).resolves.toEqual({ status: 'no-response' });
  });

  it('returns an explicit unavailable result when no receiver exists', async () => {
    const driver = createDriver();
    driver.makeNextRequestUnavailable();

    await expect(driver.capabilities.runtimeRequests.request({
      type: 'optional-query',
    })).resolves.toEqual({ status: 'unavailable' });
  });

  it('normalizes a browser rejection without exposing its sensitive message', async () => {
    const driver = createDriver();
    driver.rejectNextRequest(new Error('Bearer top-secret-token'));

    const request = driver.capabilities.runtimeRequests.request({
      type: 'rejected-query',
    });

    await expect(request).rejects.toMatchObject({
      name: 'ExtensionOperationError',
      capability: 'runtime-request',
      operation: 'request',
      code: 'browser-rejected',
      retryable: false,
      diagnostic: {
        errorName: 'Error',
      },
    });
    await expect(request).rejects.not.toThrow('top-secret-token');
  });

  it('rejects non-JSON requests before they reach the browser', async () => {
    const invalidValues: unknown[] = [
      1n,
      new Date('2026-01-01T00:00:00.000Z'),
      new Map([['key', 'value']]),
      Object.assign(Object.create({ inherited: true }), { own: true }),
      Array(1),
    ];

    for (const value of invalidValues) {
      const driver = createDriver();
      const invalidRequest = {
        type: 'invalid-query',
        value,
      } as unknown as JsonValue;

      const request = driver.capabilities.runtimeRequests.request(invalidRequest);

      await expect(request).rejects.toBeInstanceOf(ExtensionOperationError);
      await expect(request).rejects.toMatchObject({
        code: 'serialization-failed',
        retryable: false,
      });
      expect(driver.sentRequests()).toEqual([]);
    }
  });

  it('removes a request listener once when cancellation is repeated', async () => {
    const driver = createDriver();
    const source: ExtensionMessageSource = {
      kind: 'tab-document',
      documentId: 'document-1',
      tabId: 7,
      windowId: 3,
      frameId: 0,
      url: 'https://example.test/page',
    };
    const cancel = driver.capabilities.runtimeRequests.onRequest(
      async (request, actualSource) => ({
        request,
        documentId: actualSource.kind === 'tab-document'
          ? actualSource.documentId
          : null,
        windowId: actualSource.kind === 'tab-document'
          ? actualSource.windowId ?? null
          : null,
      }),
    );

    await expect(driver.dispatchRequest({ type: 'incoming' }, source)).resolves.toEqual({
      request: { type: 'incoming' },
      documentId: 'document-1',
      windowId: 3,
    });

    cancel();
    cancel();

    expect(driver.removedRequestListeners()).toBe(1);
    await expect(driver.dispatchRequest({ type: 'late' }, source)).resolves.toBeUndefined();
  });

  it('keeps extension documents distinct from tab documents', async () => {
    const driver = createDriver();
    const observed: ExtensionMessageSource[] = [];
    const cancel = driver.capabilities.runtimeRequests.onRequest(
      async (_request, source) => {
        observed.push(source);
        return { ok: true };
      },
    );
    const source: ExtensionMessageSource = {
      kind: 'extension-document',
      documentId: 'extension-document-1',
      url: driver.extensionDocumentUrl('popup.html'),
    };

    await driver.dispatchRequest({ type: 'extension-query' }, source);

    expect(observed).toEqual([source]);
    cancel();
  });

  it('sends JSON messages over a named runtime channel', async () => {
    const driver = createDriver();
    const channel = await driver.capabilities.runtimeChannels.open('pipeline');

    expect(channel.name).toBe('pipeline');
    await expect(channel.send({ type: 'start', taskId: 'task-1' })).resolves.toBeUndefined();
    expect(driver.sentChannelMessages()).toEqual([
      { type: 'start', taskId: 'task-1' },
    ]);
  });

  it('rejects non-JSON channel messages before posting them', async () => {
    const driver = createDriver();
    const channel = await driver.capabilities.runtimeChannels.open('pipeline');
    const invalidMessage = {
      type: 'start',
      callback: () => undefined,
    } as unknown as JsonValue;

    await expect(channel.send(invalidMessage)).rejects.toMatchObject({
      capability: 'runtime-channel',
      operation: 'send',
      code: 'serialization-failed',
      retryable: false,
    });
    expect(driver.sentChannelMessages()).toEqual([]);
  });

  it('uses idempotent channel listener cancellation and disconnect', async () => {
    const driver = createDriver();
    const channel = await driver.capabilities.runtimeChannels.open('pipeline');
    const received: JsonValue[] = [];
    const disconnects: string[] = [];
    const cancelMessages = channel.onMessage((message) => {
      received.push(message);
    });
    channel.onDisconnect((reason) => {
      disconnects.push(reason);
    });

    driver.emitChannelMessage({ type: 'progress', completed: 1 });
    cancelMessages();
    cancelMessages();
    driver.emitChannelMessage({ type: 'late' });
    driver.emitChannelDisconnect();

    expect(received).toEqual([{ type: 'progress', completed: 1 }]);
    expect(driver.removedChannelMessageListeners()).toBe(1);
    expect(disconnects).toEqual(['peer-disconnected']);

    const locallyClosedChannel = await driver.capabilities.runtimeChannels.open('pipeline');
    const localDisconnects: string[] = [];
    locallyClosedChannel.onDisconnect((reason) => {
      localDisconnects.push(reason);
    });
    await locallyClosedChannel.disconnect();
    await locallyClosedChannel.disconnect();
    expect(driver.rawChannelDisconnects()).toBe(1);
    expect(localDisconnects).toEqual(['closed-locally']);
  });

}

export type RuntimeServerAdapterContractDriver = {
  capabilities: Pick<BackgroundExtensionCapabilities, 'runtimeChannels'>;
  emitChannel(): void;
  removedChannelListeners(): number;
};

export function runRuntimeServerAdapterContract(
  createDriver: () => RuntimeServerAdapterContractDriver,
): void {
  it('normalizes incoming channels and cancels the server listener once', () => {
    const driver = createDriver();
    const channels: Array<{ name: string; source: ExtensionMessageSource }> = [];
    const cancel = driver.capabilities.runtimeChannels.onChannel((channel) => {
      channels.push({
        name: channel.name,
        source: channel.source,
      });
    });

    driver.emitChannel();
    expect(channels).toEqual([{
      name: 'pipeline-host',
      source: { kind: 'unknown' },
    }]);

    cancel();
    cancel();
    expect(driver.removedChannelListeners()).toBe(1);
  });
}
