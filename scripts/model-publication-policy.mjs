const PUBLICATION_STATUSES = new Set(['approved', 'conditional', 'blocked']);

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function validateModelPublicationPolicy(manifest, policy) {
  const manifestRecord = asRecord(manifest, 'model manifest');
  const policyRecord = asRecord(policy, 'model publication policy');
  if (policyRecord.schemaVersion !== 1) {
    throw new Error(`Unsupported model publication policy schema: ${String(policyRecord.schemaVersion)}`);
  }
  if (policyRecord.manifestVersion !== manifestRecord.version) {
    throw new Error(
      `Publication policy targets ${String(policyRecord.manifestVersion)}, but the manifest is ${String(manifestRecord.version)}`,
    );
  }

  const manifestAssets = Array.isArray(manifestRecord.assets) ? manifestRecord.assets : [];
  const policyAssets = asRecord(policyRecord.assets, 'model publication policy assets');
  const manifestIds = new Set();
  const blockers = [];

  for (const rawAsset of manifestAssets) {
    const asset = asRecord(rawAsset, 'model manifest asset');
    const id = String(asset.id ?? '');
    if (!id) throw new Error('Every model manifest asset must have an id');
    if (manifestIds.has(id)) throw new Error(`Duplicate model manifest asset id: ${id}`);
    manifestIds.add(id);

    const entry = asRecord(policyAssets[id], `publication policy for ${id}`);
    if (entry.path !== asset.path) {
      throw new Error(`${id}: publication policy path does not match the manifest`);
    }
    if (entry.sha256 !== asset.sha256) {
      throw new Error(`${id}: publication policy SHA-256 does not match the manifest`);
    }
    if (!PUBLICATION_STATUSES.has(entry.status)) {
      throw new Error(`${id}: unknown publication status ${String(entry.status)}`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`${id}: publication policy must record a reason`);
    }
    if (entry.status !== 'approved') {
      blockers.push({
        id,
        path: String(asset.path),
        status: entry.status,
        reason: entry.reason,
      });
    }
  }

  const extras = Object.keys(policyAssets).filter((id) => !manifestIds.has(id));
  if (extras.length > 0) {
    throw new Error(`Publication policy contains assets outside the manifest: ${extras.join(', ')}`);
  }
  return blockers;
}

export function assertModelPublicationApproved(manifest, policy) {
  const blockers = validateModelPublicationPolicy(manifest, policy);
  if (blockers.length === 0) return;
  const details = blockers
    .map((asset) => `- ${asset.id} (${asset.status}): ${asset.reason}`)
    .join('\n');
  throw new Error(`Model publication is blocked by the reviewed policy:\n${details}`);
}
