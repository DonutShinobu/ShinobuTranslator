import type { RuntimeChannel } from '../capabilities/contracts';

export const LOCAL_PIPELINE_OFFSCREEN_PORT = 'mt:offscreen-pipeline-host';
export const LOCAL_PIPELINE_OFFSCREEN_DOCUMENT = 'offscreen.html';

export interface PipelineHostConnection {
  connect(): Promise<RuntimeChannel>;
}

export interface PipelineHostController {
  dispose(): Promise<void>;
}

export type PipelineHostStarter = (
  connection: PipelineHostConnection,
) => PipelineHostController | Promise<PipelineHostController>;

export interface PipelineHostActivation {
  readonly channel: RuntimeChannel;
  activate(): void;
}

export interface PipelineHostDocumentLifecycle {
  isAvailable(): boolean;
  accepts(channel: RuntimeChannel): boolean;
  exists(): Promise<boolean>;
  create(): Promise<PipelineHostActivation | undefined>;
  close(): Promise<boolean>;
}

export type PipelineHostLifecycle =
  & PipelineHostConnection
  & PipelineHostDocumentLifecycle;
