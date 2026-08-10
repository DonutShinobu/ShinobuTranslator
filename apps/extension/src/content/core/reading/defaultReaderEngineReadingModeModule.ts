import { createComiciReaderEngineAdapter } from '../../readerEngines/comici';
import { createGigaViewerReaderEngineAdapter } from '../../readerEngines/gigaViewer';
import { createBinbReaderEngineAdapter } from '../../readerEngines/binb';
import { createClipStudioReaderAdapter } from '../../readerEngines/clipStudioReader';
import { createPublusReaderAdapter } from '../../readerEngines/publusReader';
import { ReaderEngineRegistry } from './readerEngineRegistry';
import type { PhotoStateStore } from '../state/photoStateStore';
import type { ImageTranslationExecutionArbiter } from '../translation/imageTranslationExecutionArbiter';
import {
  createReaderEngineReadingModeModule,
  type ReaderEngineReadingModeModulePort,
} from './readerEngineReadingModeModule';

export function createDefaultReaderEngineReadingModeModule(
  stateStore: PhotoStateStore,
  executionArbiter: ImageTranslationExecutionArbiter,
): ReaderEngineReadingModeModulePort {
  return createReaderEngineReadingModeModule({
    registry: new ReaderEngineRegistry([
      createComiciReaderEngineAdapter(),
      createGigaViewerReaderEngineAdapter(),
      createBinbReaderEngineAdapter(),
      createClipStudioReaderAdapter(),
      createPublusReaderAdapter(),
    ]),
    stateStore,
    executionArbiter,
  });
}
