import type { ExtensionPort } from '../../shared/extensionRuntime';
import { createLocalExtensionPortPair } from '../../shared/localExtensionPort';
import { LOCAL_PIPELINE_HOST_PORT } from '../../shared/localPipelineProtocol';
import { FixedPipelineHostTransport } from '../../shared/pipelineHostTransport';
import type { PipelineHostDependencies } from '../../offscreen/pipelineHost';
import type {
  PipelineHostAttachment,
  PipelineHostLifecycle,
} from './pipelineHostLifecycle';

export class FirefoxPipelineHostLifecycle implements PipelineHostLifecycle {
  private host: { connect(): void; dispose(): void } | null = null;
  private attachment: PipelineHostAttachment | null = null;
  private loading: Promise<PipelineHostAttachment> | null = null;

  constructor(
    private readonly dependencies: PipelineHostDependencies = {},
  ) {}

  matchesHostPort(port: ExtensionPort): boolean {
    return port === this.attachment?.port;
  }

  async ensureHost(): Promise<PipelineHostAttachment> {
    if (this.host && this.attachment) return this.attachment;
    if (!this.loading) {
      this.loading = import('../../offscreen/pipelineHost').then(({ PipelineHost }) => {
        if (this.host && this.attachment) return this.attachment;
        const [brokerPort, hostPort] = createLocalExtensionPortPair(
          LOCAL_PIPELINE_HOST_PORT,
        );
        const host = new PipelineHost(
          new FixedPipelineHostTransport(hostPort),
          this.dependencies,
        );
        let activated = false;
        const attachment: PipelineHostAttachment = {
          port: brokerPort,
          activate: () => {
            if (activated) return;
            activated = true;
            host.connect();
          },
        };
        const handleDisconnect = (): void => {
          if (this.attachment !== attachment) return;
          this.attachment = null;
          this.host = null;
          host.dispose();
        };
        brokerPort.onDisconnect.addListener(handleDisconnect);
        hostPort.onDisconnect.addListener(handleDisconnect);
        this.host = host;
        this.attachment = attachment;
        return attachment;
      }).finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  async closeHost(): Promise<void> {
    const host = this.host;
    this.host = null;
    this.attachment = null;
    host?.dispose();
  }
}
