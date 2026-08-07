import type { ImageTranslationExecutionArbiter } from '../translation/imageTranslationExecutionArbiter';
import { createComiciReaderEngineAdapter } from '../../readerEngines/comici';
import type { ContinuousTranslationModule } from './contracts';
import { ContinuousTranslationBar } from './continuousTranslationBar';
import { createContinuousTranslationModule } from './continuousTranslationController';
import { RuntimeContinuousTabStatePort } from './continuousTabStatePort';
import { RuntimePageArtifactPort } from './pageArtifactPort';
import { PageProjectionController } from './pageProjectionController';
import { PageSourceResolver } from './pageSourceResolver';
import { ReaderEngineRegistry } from './readerEngineRegistry';

export function createDefaultContinuousTranslationModule(
  contentSessionId: string,
  executionArbiter: ImageTranslationExecutionArbiter,
): ContinuousTranslationModule {
  const artifacts = new RuntimePageArtifactPort(contentSessionId);
  return createContinuousTranslationModule({
    registry: new ReaderEngineRegistry([createComiciReaderEngineAdapter()]),
    artifacts,
    tabState: new RuntimeContinuousTabStatePort(),
    sourceResolver: new PageSourceResolver(),
    executionArbiter,
    bar: new ContinuousTranslationBar(),
    projection: new PageProjectionController(artifacts),
  });
}
