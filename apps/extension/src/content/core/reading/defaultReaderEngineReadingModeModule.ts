import { createComiciReaderEngineAdapter } from '../../readerEngines/comici';
import { createGigaViewerReaderEngineAdapter } from '../../readerEngines/gigaViewer';
import { ReaderEngineRegistry } from '../continuous/readerEngineRegistry';
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
    ]),
    stateStore,
    executionArbiter,
  });
}
