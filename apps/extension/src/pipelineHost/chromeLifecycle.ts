import {
  chromeApi,
  type ChromeApi,
  type ChromeRuntime,
} from '../capabilities/chromeInternal';
import { runtimeChannelClient } from '../capabilities/chromeRuntime';
import type { PipelineHostLifecycle } from './contracts';
import {
  LOCAL_PIPELINE_OFFSCREEN_DOCUMENT,
  LOCAL_PIPELINE_OFFSCREEN_PORT,
} from './contracts';

type ChromePipelineHostRuntime = ChromeRuntime & {
  getContexts?: (filter: {
    contextTypes: Array<'OFFSCREEN_DOCUMENT'>;
    documentUrls: string[];
  }) => Promise<Array<{
    contextType: string;
    documentUrl?: string;
  }>>;
};

type ChromePipelineHostApi = Omit<ChromeApi, 'runtime'> & {
  runtime: ChromePipelineHostRuntime;
  offscreen?: {
    createDocument?: (options: {
      url: string;
      reasons: Array<'WORKERS'>;
      justification: string;
    }) => Promise<void>;
    closeDocument?: () => Promise<void>;
  };
};

type ServiceWorkerClients = {
  matchAll(): Promise<Array<{ url: string }>>;
};

function currentServiceWorkerClients(): ServiceWorkerClients | undefined {
  return (globalThis as typeof globalThis & {
    clients?: ServiceWorkerClients;
  }).clients;
}

export function createChromePipelineHostLifecycle(
  api: unknown,
): PipelineHostLifecycle {
  const chrome = chromeApi(api) as ChromePipelineHostApi;
  const hostUrl = chrome.runtime.getURL(LOCAL_PIPELINE_OFFSCREEN_DOCUMENT);

  return {
    isAvailable() {
      return typeof chrome.offscreen?.createDocument === 'function';
    },
    connect() {
      return runtimeChannelClient(chrome.runtime).open(
        LOCAL_PIPELINE_OFFSCREEN_PORT,
      );
    },
    accepts(channel) {
      return channel.name === LOCAL_PIPELINE_OFFSCREEN_PORT
        && channel.source.kind === 'extension-document'
        && (
          channel.source.url === undefined
          || channel.source.url === hostUrl
        );
    },
    async exists() {
      if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [hostUrl],
        });
        return contexts.length > 0;
      }

      const clients = currentServiceWorkerClients();
      if (!clients) return false;
      return (await clients.matchAll()).some((client) => client.url === hostUrl);
    },
    async create() {
      const createDocument = chrome.offscreen?.createDocument;
      if (!createDocument) {
        throw new TypeError('Chrome offscreen document creation is unavailable');
      }
      try {
        await createDocument({
          url: LOCAL_PIPELINE_OFFSCREEN_DOCUMENT,
          reasons: ['WORKERS'],
          justification: '在扩展同源上下文中运行本地 ONNX 图片翻译流水线',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/single offscreen|already exists|only one offscreen/iu.test(message)) {
          throw error;
        }
      }
      return undefined;
    },
    async close() {
      const closeDocument = chrome.offscreen?.closeDocument;
      if (!closeDocument) return false;
      await closeDocument();
      return true;
    },
  };
}
