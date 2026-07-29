import { describe, expect, it } from 'vitest';
import manifest from '../../packages/model-manifest/manifest.json';
import policy from '../../packages/model-manifest/publication-policy.json';
import {
  assertModelPublicationApproved,
  validateModelPublicationPolicy,
} from '../../scripts/model-publication-policy.mjs';

describe('model publication policy', () => {
  it('records every current asset and exposes the reviewed blockers', () => {
    const blockers = validateModelPublicationPolicy(manifest, policy);
    expect(blockers.map((asset) => asset.id)).toEqual(['detector', 'inpaint', 'bubble']);
    expect(() => assertModelPublicationApproved(manifest, policy)).toThrow(
      /detector[\s\S]*inpaint[\s\S]*bubble/,
    );
  });

  it('allows upload only after every exact asset is approved', () => {
    const approvedPolicy = structuredClone(policy);
    for (const entry of Object.values(approvedPolicy.assets)) {
      entry.status = 'approved';
    }
    expect(() => assertModelPublicationApproved(manifest, approvedPolicy)).not.toThrow();
  });

  it('rejects an approval copied to different model bytes', () => {
    const stalePolicy = structuredClone(policy);
    stalePolicy.assets.detector.sha256 = '0'.repeat(64);
    expect(() => validateModelPublicationPolicy(manifest, stalePolicy)).toThrow(
      /detector: publication policy SHA-256 does not match/,
    );
  });
});
