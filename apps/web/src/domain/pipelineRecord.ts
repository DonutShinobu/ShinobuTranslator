import {
  PIPELINE_RECORD_SCHEMA_VERSION,
  createPipelineRecord,
  isCurrentPipelineRecord,
  recoverPipelineRecord,
  type PipelineRecord,
  type PipelineRecordRegion,
  type WorkingCopySpec,
} from '@shinobu/image-pipeline';

export const WEB_PIPELINE_RECORD_SCHEMA_VERSION =
  PIPELINE_RECORD_SCHEMA_VERSION;
export type WebPipelineRecord = PipelineRecord;

type PipelineRecordArtifacts = {
  original: {
    naturalWidth: number;
    naturalHeight: number;
  };
  stageRegions: {
    detected?: readonly PipelineRecordRegion[];
    ocr: readonly PipelineRecordRegion[];
    merged?: readonly PipelineRecordRegion[];
    ordered: readonly PipelineRecordRegion[];
  };
};

export function createWebPipelineRecord(
  artifacts: PipelineRecordArtifacts,
  workingCopy: WorkingCopySpec = { strategy: 'source-native' },
): WebPipelineRecord {
  return createPipelineRecord({
    image: {
      width: artifacts.original.naturalWidth,
      height: artifacts.original.naturalHeight,
    },
    ocr: artifacts.stageRegions.ocr,
    ordered: artifacts.stageRegions.ordered,
  }, workingCopy);
}

export function isWebPipelineRecord(
  value: unknown,
): value is WebPipelineRecord {
  return isCurrentPipelineRecord(value);
}

export function recoverWebPipelineRecord(
  value: unknown,
  legacyWorkingCopy?: WorkingCopySpec,
): WebPipelineRecord {
  return recoverPipelineRecord(value, legacyWorkingCopy);
}
