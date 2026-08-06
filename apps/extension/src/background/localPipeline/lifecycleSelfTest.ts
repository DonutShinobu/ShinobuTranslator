import { createLocalExtensionPortPair } from '../../shared/localExtensionPort';
import {
  getPipelineLifecycleTestIdleTimeoutMs,
  getPipelineLifecycleTestReportUrl,
} from '../../shared/buildFlags';
import { LOCAL_PIPELINE_CLIENT_PORT } from '@shinobu/image-pipeline/protocol';
import type {
  PipelineHostBroker,
  PipelineHostLifecycleSnapshot,
} from './offscreenBroker';

type LifecycleSelfTestReport = {
  ok: boolean;
  idleTimeoutMs: number;
  firstHostInstanceId?: string;
  secondHostInstanceId?: string;
  closedSnapshot?: PipelineHostLifecycleSnapshot;
  error?: string;
};

async function waitForSnapshot(
  broker: PipelineHostBroker,
  predicate: (snapshot: PipelineHostLifecycleSnapshot) => boolean,
  timeoutMs: number,
): Promise<PipelineHostLifecycleSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = broker.getLifecycleSnapshot();
    if (predicate(snapshot)) return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `等待流水线宿主生命周期状态超时（${timeoutMs}ms）：${JSON.stringify(broker.getLifecycleSnapshot())}`,
  );
}

async function createPreparedClient(
  broker: PipelineHostBroker,
  jobId: string,
): Promise<ReturnType<typeof createLocalExtensionPortPair>[1]> {
  const [brokerPort, clientPort] = createLocalExtensionPortPair(
    LOCAL_PIPELINE_CLIENT_PORT,
  );
  const ready = new Promise<void>((resolve, reject) => {
    clientPort.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return;
      const response = message as { type?: unknown; jobId?: unknown; error?: unknown };
      if (response.jobId !== jobId) return;
      if (response.type === 'ready') resolve();
      if (response.type === 'error') reject(new Error(`准备测试任务失败: ${JSON.stringify(response.error)}`));
    });
  });
  broker.handlePort(brokerPort);
  clientPort.postMessage({ type: 'prepare', jobId });
  await ready;
  return clientPort;
}

async function postReport(reportUrl: string, report: LifecycleSelfTestReport): Promise<void> {
  if (!reportUrl) throw new Error('生命周期测试缺少报告 URL');
  const response = await fetch(reportUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
  if (!response.ok) {
    throw new Error(`生命周期测试报告提交失败: HTTP ${response.status}`);
  }
}

export async function runPipelineHostLifecycleSelfTest(
  broker: PipelineHostBroker,
): Promise<void> {
  const reportUrl = getPipelineLifecycleTestReportUrl();
  const idleTimeoutMs = getPipelineLifecycleTestIdleTimeoutMs();
  const timeoutMs = idleTimeoutMs + 10_000;
  let firstClient: ReturnType<typeof createLocalExtensionPortPair>[1] | null = null;
  let secondClient: ReturnType<typeof createLocalExtensionPortPair>[1] | null = null;
  try {
    firstClient = await createPreparedClient(broker, 'lifecycle-self-test-first');
    const firstReady = await waitForSnapshot(
      broker,
      (snapshot) => snapshot.hostReady && Boolean(snapshot.hostInstanceId),
      10_000,
    );
    const firstHostInstanceId = firstReady.hostInstanceId!;
    firstClient.disconnect();
    firstClient = null;

    const closedSnapshot = await waitForSnapshot(
      broker,
      (snapshot) => (
        !snapshot.hostReady
        && snapshot.hostInstanceId === null
        && snapshot.lastClosedHostInstanceId === firstHostInstanceId
      ),
      timeoutMs,
    );

    secondClient = await createPreparedClient(broker, 'lifecycle-self-test-second');
    const secondReady = await waitForSnapshot(
      broker,
      (snapshot) => (
        snapshot.hostReady
        && Boolean(snapshot.hostInstanceId)
        && snapshot.hostInstanceId !== firstHostInstanceId
      ),
      10_000,
    );
    await postReport(reportUrl, {
      ok: true,
      idleTimeoutMs,
      firstHostInstanceId,
      secondHostInstanceId: secondReady.hostInstanceId!,
      closedSnapshot,
    });
  } catch (error) {
    await postReport(reportUrl, {
      ok: false,
      idleTimeoutMs,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    firstClient?.disconnect();
    secondClient?.disconnect();
  }
}
