import type {
  OcrRunDebugInfo,
  OcrPostFilterDebugInfo,
  PipelineArtifacts,
  PipelineConfig,
  PipelineProgress,
  PipelineTypesetDebugLog,
  RuntimeStageStatus,
  StageTiming,
  TranslationDebugInfo,
} from '../types';

export const LOCAL_PIPELINE_CLIENT_PORT = 'mt:local-pipeline-client';
export const LOCAL_PIPELINE_OFFSCREEN_PORT = 'mt:offscreen-pipeline-host';
export const LOCAL_PIPELINE_OFFSCREEN_DOCUMENT = 'offscreen.html';
export const LOCAL_PIPELINE_CHUNK_SIZE = 4 * 1024 * 1024;
export const LOCAL_PIPELINE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export type LocalPipelineErrorCode =
  | 'OFFSCREEN_UNAVAILABLE'
  | 'OFFSCREEN_CREATE_FAILED'
  | 'OFFSCREEN_DISCONNECTED'
  | 'TRANSFER_PROTOCOL_ERROR'
  | 'TASK_CANCELLED'
  | 'WORKER_BOOTSTRAP_FAILED'
  | 'PIPELINE_STAGE_FAILED';

export type LocalPipelineArtifactSummary = {
  image: {
    width: number;
    height: number;
  };
  detectedRegionCount: number;
  stageTimings: StageTiming[];
  runtimeStages: RuntimeStageStatus[];
  translationDebug: TranslationDebugInfo | null;
  ocrDebug: OcrRunDebugInfo | null;
  ocrPostFilterDebug: OcrPostFilterDebugInfo | null;
  typesetDebug: PipelineTypesetDebugLog | null;
};

export type SerializedPipelineError = {
  name: string;
  code: LocalPipelineErrorCode;
  message: string;
  stack?: string;
  stage?: string;
  cause?: SerializedPipelineError | string;
  artifacts?: LocalPipelineArtifactSummary;
};

export type WorkerBootstrapAttempt = {
  mode: 'direct-extension' | 'direct-http' | 'blob-http';
  scriptUrl: string;
  startedAt: string;
  durationMs: number;
  status: 'success' | 'failed';
  error?: SerializedPipelineError;
};

export type LocalPipelineFileMeta = {
  name: string;
  type: string;
  size: number;
  lastModified: number;
};

export type LocalPipelineChunkMeta = {
  chunkCount: number;
  totalChars: number;
};

export type LocalPipelineArtifactMeta = LocalPipelineChunkMeta & {
  contentType: string;
};

export type LocalPipelineClientMessage =
  | {
      type: 'prepare';
      jobId: string;
      diagnosticRunId?: string;
    }
  | {
      type: 'start';
      jobId: string;
      file: LocalPipelineFileMeta;
      config: PipelineConfig;
      input: LocalPipelineChunkMeta;
    }
  | {
      type: 'input-chunk';
      jobId: string;
      index: number;
      data: string;
    }
  | {
      type: 'input-complete';
      jobId: string;
    }
  | {
      type: 'cancel';
      jobId: string;
      reason?: string;
    };

export type LocalPipelineHostMessage =
  | { type: 'host-ready' }
  | { type: 'idle-close' }
  | {
      type: 'ready';
      jobId: string;
    }
  | {
      type: 'queued';
      jobId: string;
      position: number;
    }
  | {
      type: 'progress';
      jobId: string;
      progress: PipelineProgress;
    }
  | {
      type: 'result-meta';
      jobId: string;
      result: LocalPipelineArtifactMeta;
      debug?: LocalPipelineArtifactMeta;
      summary: LocalPipelineArtifactSummary;
    }
  | {
      type: 'result-chunk';
      jobId: string;
      artifact: 'result' | 'debug';
      index: number;
      data: string;
    }
  | {
      type: 'complete';
      jobId: string;
    }
  | {
      type: 'error';
      jobId: string;
      error: SerializedPipelineError;
    };

export type LocalPipelineResult = {
  result: Blob;
  debug?: Blob;
  summary: LocalPipelineArtifactSummary;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isJobMessage(value: Record<string, unknown>): boolean {
  return typeof value.jobId === 'string' && value.jobId.length > 0;
}

export function isLocalPipelineClientMessage(value: unknown): value is LocalPipelineClientMessage {
  if (!isRecord(value) || typeof value.type !== 'string' || !isJobMessage(value)) {
    return false;
  }
  switch (value.type) {
    case 'prepare':
      return value.diagnosticRunId === undefined || typeof value.diagnosticRunId === 'string';
    case 'start':
      return isValidFileMeta(value.file) && isValidPipelineConfig(value.config) && isValidChunkMeta(value.input);
    case 'input-chunk':
      return Number.isInteger(value.index) && (value.index as number) >= 0
        && typeof value.data === 'string'
        && value.data.length <= LOCAL_PIPELINE_CHUNK_SIZE;
    case 'input-complete':
      return true;
    case 'cancel':
      return value.reason === undefined || typeof value.reason === 'string';
    default:
      return false;
  }
}

export function isLocalPipelineHostMessage(value: unknown): value is LocalPipelineHostMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  if (value.type === 'host-ready' || value.type === 'idle-close') {
    return true;
  }
  if (!isJobMessage(value)) {
    return false;
  }
  switch (value.type) {
    case 'ready':
    case 'complete':
      return true;
    case 'queued':
      return Number.isInteger(value.position) && (value.position as number) >= 0;
    case 'progress':
      return isRecord(value.progress)
        && typeof value.progress.stage === 'string'
        && typeof value.progress.detail === 'string';
    case 'result-meta':
      return isValidArtifactMeta(value.result)
        && (value.debug === undefined || isValidArtifactMeta(value.debug))
        && isValidArtifactSummary(value.summary);
    case 'result-chunk':
      return (value.artifact === 'result' || value.artifact === 'debug')
        && Number.isInteger(value.index)
        && (value.index as number) >= 0
        && typeof value.data === 'string'
        && value.data.length <= LOCAL_PIPELINE_CHUNK_SIZE;
    case 'error':
      return isRecord(value.error)
        && typeof value.error.name === 'string'
        && isLocalPipelineErrorCode(value.error.code)
        && typeof value.error.message === 'string';
    default:
      return false;
  }
}

function isValidFileMeta(value: unknown): value is LocalPipelineFileMeta {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string'
    && typeof value.type === 'string'
    && Number.isInteger(value.size)
    && (value.size as number) >= 0
    && Number.isFinite(value.lastModified);
}

function isValidTranslationContext(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return value.source === 'x_tweet'
    && typeof value.currentTweetText === 'string'
    && (value.quotedTweetText === undefined || typeof value.quotedTweetText === 'string');
}

function isValidPipelineConfig(value: unknown): value is PipelineConfig {
  if (!isRecord(value)) return false;
  const stringKeys = [
    'sourceLang',
    'targetLang',
    'llmBaseUrl',
    'llmApiKey',
    'llmModel',
  ];
  if (!stringKeys.every((key) => typeof value[key] === 'string')) return false;
  if (value.translator !== 'google_web' && value.translator !== 'llm') return false;
  if (!['deepseek', 'gemini', 'glm', 'kimi', 'minimax', 'mimo', 'openai', 'custom'].includes(String(value.llmProvider))) return false;
  if (value.llmAuthMode !== 'api_key' && value.llmAuthMode !== 'openai_oauth' && value.llmAuthMode !== 'gemini_app') return false;
  if (value.ocrEngine !== 'paddleocr_v6_medium') return false;
  if (value.processMode !== 'translate' && value.processMode !== 'erase' && value.processMode !== 'original') return false;
  if (typeof value.typesetDebug !== 'boolean' || typeof value.eraseDebug !== 'boolean' || typeof value.collectDebugLog !== 'boolean') return false;
  if (value.ocrCompactActiveBatch !== undefined && typeof value.ocrCompactActiveBatch !== 'boolean') return false;
  if (
    value.ocrPostFilter !== undefined
    && value.ocrPostFilter !== 'off'
    && value.ocrPostFilter !== 'balanced'
  ) return false;
  if (!isValidTranslationContext(value.translationContext)) return false;
  return value.diagnosticRunId === undefined || typeof value.diagnosticRunId === 'string';
}

function isValidArtifactSummary(value: unknown): value is LocalPipelineArtifactSummary {
  if (!isRecord(value) || !isRecord(value.image)) return false;
  return Number.isFinite(value.image.width)
    && Number.isFinite(value.image.height)
    && Number.isInteger(value.detectedRegionCount)
    && (value.detectedRegionCount as number) >= 0
    && Array.isArray(value.stageTimings)
    && Array.isArray(value.runtimeStages);
}

export function isValidChunkMeta(value: unknown): value is LocalPipelineChunkMeta {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.chunkCount)
    && (value.chunkCount as number) >= 0
    && Number.isInteger(value.totalChars)
    && (value.totalChars as number) >= 0
    && (value.totalChars as number) <= (value.chunkCount as number) * LOCAL_PIPELINE_CHUNK_SIZE
    && ((value.totalChars as number) === 0) === ((value.chunkCount as number) === 0);
}

function isValidArtifactMeta(value: unknown): value is LocalPipelineArtifactMeta {
  return isRecord(value) && typeof value.contentType === 'string' && isValidChunkMeta(value);
}

export function splitBase64Chunks(value: string): string[] {
  if (value.length === 0) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += LOCAL_PIPELINE_CHUNK_SIZE) {
    chunks.push(value.slice(offset, offset + LOCAL_PIPELINE_CHUNK_SIZE));
  }
  return chunks;
}

export class Base64ChunkAssembler {
  private readonly chunks = new Map<number, string>();

  constructor(private readonly meta: LocalPipelineChunkMeta) {
    if (!isValidChunkMeta(meta)) {
      throw createProtocolError('分块元数据无效');
    }
  }

  add(index: number, data: string): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.meta.chunkCount) {
      throw createProtocolError(`分块索引越界: ${index}/${this.meta.chunkCount}`);
    }
    if (data.length > LOCAL_PIPELINE_CHUNK_SIZE) {
      throw createProtocolError(`分块超过 ${LOCAL_PIPELINE_CHUNK_SIZE} 字符限制`);
    }
    if (this.chunks.has(index)) {
      throw createProtocolError(`收到重复分块: ${index}`);
    }
    this.chunks.set(index, data);
  }

  complete(): string {
    if (this.chunks.size !== this.meta.chunkCount) {
      const missing: number[] = [];
      for (let index = 0; index < this.meta.chunkCount; index += 1) {
        if (!this.chunks.has(index)) missing.push(index);
      }
      throw createProtocolError(`分块缺失: ${missing.slice(0, 20).join(',')}`);
    }
    const value = Array.from({ length: this.meta.chunkCount }, (_item, index) => this.chunks.get(index) ?? '').join('');
    if (value.length !== this.meta.totalChars) {
      throw createProtocolError(`分块总长度不符: 期望 ${this.meta.totalChars}, 实际 ${value.length}`);
    }
    return value;
  }
}

export function summarizePipelineArtifacts(artifacts: PipelineArtifacts): LocalPipelineArtifactSummary {
  return {
    image: {
      width: artifacts.original.naturalWidth,
      height: artifacts.original.naturalHeight,
    },
    detectedRegionCount: artifacts.detectedRegions.length,
    stageTimings: artifacts.stageTimings,
    runtimeStages: artifacts.runtimeStages,
    translationDebug: artifacts.translationDebug,
    ocrDebug: artifacts.ocrDebug,
    ocrPostFilterDebug: artifacts.ocrPostFilterDebug,
    typesetDebug: artifacts.typesetDebugLog,
  };
}

function toSerializedCause(
  value: unknown,
  fallbackCode: LocalPipelineErrorCode,
  seen: WeakSet<object>,
  depth: number,
): SerializedPipelineError | string | undefined {
  if (value === undefined) return undefined;
  if (depth >= 6) return '[TRUNCATED_DEPTH]';
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    const objectValue = value as object;
    if (seen.has(objectValue)) return '[CIRCULAR_CAUSE]';
    seen.add(objectValue);
  }
  if (value instanceof Error || isRecord(value)) {
    const record = value as Error & Record<string, unknown>;
    const code = isLocalPipelineErrorCode(record.code) ? record.code : fallbackCode;
    const serialized: SerializedPipelineError = {
      name: typeof record.name === 'string' && record.name ? record.name : 'Error',
      code,
      message: typeof record.message === 'string' ? record.message : String(value),
    };
    if (typeof record.stack === 'string') serialized.stack = record.stack;
    if (typeof record.stage === 'string') serialized.stage = record.stage;
    const nested = toSerializedCause(record.cause, code, seen, depth + 1);
    if (nested !== undefined) serialized.cause = nested;
    const artifacts = record.artifacts;
    if (isRecord(artifacts) && Array.isArray(artifacts.stageTimings)) {
      serialized.artifacts = summarizePipelineArtifacts(artifacts as PipelineArtifacts);
    }
    return serialized;
  }
  return String(value);
}

export function serializePipelineError(
  error: unknown,
  fallbackCode: LocalPipelineErrorCode = 'PIPELINE_STAGE_FAILED',
): SerializedPipelineError {
  const serialized = toSerializedCause(error, fallbackCode, new WeakSet<object>(), 0);
  if (typeof serialized === 'string' || serialized === undefined) {
    return {
      name: 'Error',
      code: fallbackCode,
      message: serialized ?? '未知流水线错误',
    };
  }
  return serialized;
}

export function createProtocolError(message: string, cause?: unknown): Error & { code: LocalPipelineErrorCode } {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & { code: LocalPipelineErrorCode };
  error.name = 'LocalPipelineProtocolError';
  error.code = 'TRANSFER_PROTOCOL_ERROR';
  return error;
}

export function createCancelledError(message = '本地流水线任务已取消'): Error & { code: LocalPipelineErrorCode } {
  const error = new Error(message) as Error & { code: LocalPipelineErrorCode };
  error.name = 'AbortError';
  error.code = 'TASK_CANCELLED';
  return error;
}

export function isLocalPipelineErrorCode(value: unknown): value is LocalPipelineErrorCode {
  return value === 'OFFSCREEN_UNAVAILABLE'
    || value === 'OFFSCREEN_CREATE_FAILED'
    || value === 'OFFSCREEN_DISCONNECTED'
    || value === 'TRANSFER_PROTOCOL_ERROR'
    || value === 'TASK_CANCELLED'
    || value === 'WORKER_BOOTSTRAP_FAILED'
    || value === 'PIPELINE_STAGE_FAILED';
}

export class LocalPipelineRemoteError extends Error {
  readonly code: LocalPipelineErrorCode;
  readonly stage?: string;
  readonly artifacts?: LocalPipelineArtifactSummary;

  constructor(readonly serialized: SerializedPipelineError) {
    super(serialized.message, serialized.cause === undefined ? undefined : { cause: serialized.cause });
    this.name = serialized.name;
    this.code = serialized.code;
    this.stage = serialized.stage;
    this.artifacts = serialized.artifacts;
    if (serialized.stack) this.stack = serialized.stack;
  }
}
