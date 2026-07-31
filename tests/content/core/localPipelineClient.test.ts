import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  JsonValue,
  RuntimeChannel,
  RuntimeChannelClient,
  RuntimeChannelDisconnectReason,
} from '../../../apps/extension/src/capabilities/contracts';
import { createRunLocalPipeline } from '../../../src/content/core/translation/localPipelineClient';
import {
  LOCAL_PIPELINE_HEARTBEAT_INTERVAL_MS,
} from '../../../src/shared/localPipelineProtocol';
import {
  createTranslatorCore,
} from '@shinobu/translator-core';

class TestRuntimeChannel implements RuntimeChannel {
  readonly name = 'mt:local-pipeline-client';
  readonly source = { kind: 'unknown' as const };
  readonly sent: JsonValue[] = [];
  private readonly messageListeners = new Set<(message: JsonValue) => void>();
  private readonly disconnectListeners = new Set<(
    reason: RuntimeChannelDisconnectReason,
  ) => void>();

  async send(message: JsonValue): Promise<void> {
    this.sent.push(message);
  }

  onMessage(listener: (message: JsonValue) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onDisconnect(
    listener: (reason: RuntimeChannelDisconnectReason) => void,
  ): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    for (const listener of this.disconnectListeners) listener('closed-locally');
  }

  emitMessage(message: JsonValue): void {
    for (const listener of this.messageListeners) listener(message);
  }

  emitDisconnect(reason: RuntimeChannelDisconnectReason): void {
    for (const listener of this.disconnectListeners) listener(reason);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Firefox Event Page local pipeline client', () => {
  it('preserves an app-owned owner-ended cancellation reason', async () => {
    const channel = new TestRuntimeChannel();
    const channels: RuntimeChannelClient = {
      async open() {
        return channel;
      },
    };
    const reason = {
      code: 'owner-ended',
      messageKey: 'pipeline.cancelled.ownerEnded',
      diagnosticSummary: 'content owner ended',
    } as const;
    let localResult: Promise<unknown> | undefined;
    const core = createTranslatorCore(
      async (_request: unknown, { signal }) => {
        localResult = createRunLocalPipeline(channels)(
          new File(['image'], 'source.png', { type: 'image/png' }),
          {} as never,
          () => undefined,
          { signal },
        );
        return localResult;
      },
    );
    const task = core.run({ input: null, config: null });
    await vi.waitFor(() => {
      expect(channel.sent).toContainEqual(expect.objectContaining({
        type: 'prepare',
      }));
    });
    const prepare = channel.sent.find(
      (message) => typeof message === 'object'
        && !Array.isArray(message)
        && message?.type === 'prepare',
    ) as { jobId: string };

    const taskCancellation = expect(task.result).rejects.toMatchObject({
      reason,
    });
    task.cancel(reason);
    await vi.waitFor(() => {
      expect(channel.sent).toContainEqual({
        type: 'cancel',
        jobId: prepare.jobId,
        reason,
      });
    });
    channel.emitDisconnect('peer-disconnected');

    await taskCancellation;
    await expect(localResult).rejects.toMatchObject({
      code: 'TASK_CANCELLED',
      cancellationReason: reason,
    });
  });

  it('reports an unexpected Port loss as transport-disconnected cancellation', async () => {
    const channel = new TestRuntimeChannel();
    const task = createRunLocalPipeline({
      async open() {
        return channel;
      },
    })(
      new File(['image'], 'source.png', { type: 'image/png' }),
      {} as never,
      () => undefined,
    );
    await vi.waitFor(() => {
      expect(channel.sent).toContainEqual(expect.objectContaining({
        type: 'prepare',
      }));
    });

    channel.emitDisconnect('peer-disconnected');

    await expect(task).rejects.toMatchObject({
      code: 'TASK_CANCELLED',
      cancellationReason: {
        code: 'transport-disconnected',
        messageKey: 'pipeline.cancelled.transportDisconnected',
      },
    });
  });

  it('keeps the owning native Port active until the task settles', async () => {
    vi.useFakeTimers();
    const channel = new TestRuntimeChannel();
    const channels: RuntimeChannelClient = {
      async open() {
        return channel;
      },
    };
    const run = createRunLocalPipeline(channels);
    const task = run(
      new File(['image'], 'source.png', { type: 'image/png' }),
      {
        sourceLang: 'ja',
        targetLang: 'zh-CHS',
        translator: 'llm',
        llmProvider: 'openai',
        llmAuthMode: 'api_key',
        llmBaseUrl: 'https://api.openai.com/v1',
        llmApiKey: 'sk-test',
        llmModel: 'gpt-5.4-mini',
        typesetDebug: false,
        eraseDebug: false,
        collectDebugLog: false,
        ocrEngine: 'paddleocr_v6_medium',
        processMode: 'translate',
      },
      () => undefined,
    );
    await vi.waitFor(() => {
      expect(channel.sent).toContainEqual(expect.objectContaining({
        type: 'prepare',
      }));
    });
    const prepare = channel.sent.find(
      (message) => typeof message === 'object'
        && !Array.isArray(message)
        && message?.type === 'prepare',
    ) as { jobId: string };

    await vi.advanceTimersByTimeAsync(
      LOCAL_PIPELINE_HEARTBEAT_INTERVAL_MS * 2,
    );
    expect(channel.sent.filter(
      (message) => typeof message === 'object'
        && !Array.isArray(message)
        && message?.type === 'heartbeat',
    )).toEqual([
      { type: 'heartbeat', jobId: prepare.jobId },
      { type: 'heartbeat', jobId: prepare.jobId },
    ]);

    channel.emitMessage({
      type: 'error',
      jobId: prepare.jobId,
      error: {
        name: 'Error',
        code: 'PIPELINE_STAGE_FAILED',
        message: 'settled',
      },
    });
    await expect(task).rejects.toThrow('settled');
    const settledMessageCount = channel.sent.length;

    await vi.advanceTimersByTimeAsync(
      LOCAL_PIPELINE_HEARTBEAT_INTERVAL_MS * 2,
    );
    expect(channel.sent).toHaveLength(settledMessageCount);
  });
});
