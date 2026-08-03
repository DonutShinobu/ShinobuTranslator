import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHINOBU_CHROME_EXTENSION_ID = 'pgehhpbnifjlalmmnpiebkjhphojffef';

const API_ORIGIN = 'https://chromewebstore.googleapis.com';
const RETRYABLE_STATUS = new Set([408, 429]);
const ACTIVE_SUBMISSION_STATES = new Set(['PENDING_REVIEW', 'STAGED']);
const ACCEPTED_PUBLISH_STATES = new Set(['PENDING_REVIEW', 'PUBLISHED']);

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validateVersion(version) {
  const parts = version.split('.');
  if (parts.length < 1 || parts.length > 4) {
    throw new Error(`Chrome extension version must have 1-4 integer components: ${version}`);
  }
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d*)$/.test(part) || Number(part) > 65535) {
      throw new Error(`Invalid Chrome extension version component in ${version}`);
    }
  }
  return version;
}

function revisionVersion(revision) {
  const channels = Array.isArray(asRecord(revision).distributionChannels)
    ? revision.distributionChannels
    : [];
  const versions = channels
    .map((channel) => asRecord(channel).crxVersion)
    .filter((version) => typeof version === 'string' && version !== '');
  return versions[0];
}

function retryDelayMs(response, attempt, baseDelayMs) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  return baseDelayMs * (2 ** attempt);
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

function formatHttpError(method, url, response, body) {
  const suffix = body ? `: ${body.slice(0, 4000)}` : '';
  return new Error(`${method} ${url} failed with HTTP ${response.status}${suffix}`);
}

async function requestJson(url, init, options) {
  const {
    fetchImpl,
    sleep,
    maxAttempts,
    retryBaseDelayMs,
  } = options;
  const method = init.method ?? 'GET';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (attempt + 1 >= maxAttempts) {
        throw new Error(`${method} ${url} failed after ${maxAttempts} attempts`, { cause: error });
      }
      await sleep(retryBaseDelayMs * (2 ** attempt));
      continue;
    }

    const body = await response.text();
    if (response.ok) {
      if (!body) return {};
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new Error(`${method} ${url} returned invalid JSON`, { cause: error });
      }
    }

    if (isRetryableStatus(response.status) && attempt + 1 < maxAttempts) {
      await sleep(retryDelayMs(response, attempt, retryBaseDelayMs));
      continue;
    }
    throw formatHttpError(method, url, response, body);
  }

  throw new Error(`${method} ${url} exhausted its retry budget`);
}

function createApiClient(options) {
  const {
    accessToken,
    publisherId,
    extensionId,
    fetchImpl,
    sleep,
    maxAttempts,
    retryBaseDelayMs,
  } = options;
  const name = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}`;
  const authHeaders = {
    authorization: `Bearer ${accessToken}`,
  };
  const requestOptions = { fetchImpl, sleep, maxAttempts, retryBaseDelayMs };

  return {
    async fetchStatus() {
      const url = `${API_ORIGIN}/v2/${name}:fetchStatus`;
      return requestJson(url, { headers: authHeaders }, requestOptions);
    },
    async upload(packageBytes) {
      const url = `${API_ORIGIN}/upload/v2/${name}:upload`;
      return requestJson(url, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': 'application/zip',
        },
        body: packageBytes,
      }, requestOptions);
    },
    async publish() {
      const url = `${API_ORIGIN}/v2/${name}:publish`;
      return requestJson(url, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          publishType: 'DEFAULT_PUBLISH',
          deployInfos: [{ deployPercentage: 100 }],
          skipReview: false,
          blockOnWarnings: true,
        }),
      }, requestOptions);
    },
  };
}

function assertHealthyItem(status) {
  if (status.takenDown === true) {
    throw new Error('Chrome Web Store item has been taken down; inspect the Developer Dashboard');
  }
  if (status.warned === true) {
    throw new Error('Chrome Web Store item has an unresolved policy warning; inspect the Developer Dashboard');
  }
}

function inspectExistingSubmission(status, expectedVersion) {
  assertHealthyItem(status);
  const published = asRecord(status.publishedItemRevisionStatus);
  const submitted = asRecord(status.submittedItemRevisionStatus);
  const publishedVersion = revisionVersion(published);
  const submittedVersion = revisionVersion(submitted);

  if (published.state === 'PUBLISHED' && publishedVersion === expectedVersion) {
    return { action: 'skip', outcome: 'already-published', state: 'PUBLISHED' };
  }
  if (submittedVersion === expectedVersion && submitted.state === 'PENDING_REVIEW') {
    return { action: 'skip', outcome: 'already-submitted', state: 'PENDING_REVIEW' };
  }
  if (submittedVersion === expectedVersion && submitted.state === 'STAGED') {
    return { action: 'publish', outcome: 'staged', state: 'STAGED' };
  }
  if (ACTIVE_SUBMISSION_STATES.has(submitted.state) && submittedVersion !== expectedVersion) {
    throw new Error(
      `Chrome Web Store already has ${submittedVersion ?? 'another version'} in state ${submitted.state}`,
    );
  }
  return { action: 'upload' };
}

function validatePublishResponse(response) {
  const warnings = asRecord(response.warningInfo).warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    const descriptions = warnings
      .map((warning) => asRecord(warning).description ?? asRecord(warning).reason)
      .filter(Boolean)
      .join('; ');
    throw new Error(`Chrome Web Store publish returned warnings: ${descriptions || 'unknown warning'}`);
  }
  if (!ACCEPTED_PUBLISH_STATES.has(response.state)) {
    throw new Error(`Chrome Web Store returned unexpected publish state: ${String(response.state)}`);
  }
}

async function waitForUpload(api, options) {
  const { sleep, uploadPollAttempts, uploadPollIntervalMs } = options;
  for (let attempt = 0; attempt < uploadPollAttempts; attempt += 1) {
    await sleep(uploadPollIntervalMs);
    const status = await api.fetchStatus();
    assertHealthyItem(status);
    if (status.lastAsyncUploadState === 'SUCCEEDED') return;
    if (status.lastAsyncUploadState === 'FAILED' || status.lastAsyncUploadState === 'NOT_FOUND') {
      throw new Error(`Chrome Web Store asynchronous upload ${status.lastAsyncUploadState.toLowerCase()}`);
    }
  }
  throw new Error('Chrome Web Store asynchronous upload did not finish within the polling budget');
}

export async function publishChromeWebStoreUpdate(options) {
  const accessToken = requireString(options.accessToken, 'CHROME_WEBSTORE_ACCESS_TOKEN');
  const publisherId = requireString(options.publisherId, 'CHROME_WEBSTORE_PUBLISHER_ID');
  const extensionId = requireString(options.extensionId, 'CHROME_WEBSTORE_EXTENSION_ID');
  const expectedVersion = validateVersion(requireString(options.expectedVersion, '--version'));
  if (extensionId !== SHINOBU_CHROME_EXTENSION_ID) {
    throw new Error(
      `Refusing to publish unexpected Chrome extension ${extensionId}; expected ${SHINOBU_CHROME_EXTENSION_ID}`,
    );
  }
  if (!(options.packageBytes instanceof Uint8Array) || options.packageBytes.byteLength === 0) {
    throw new Error('Chrome extension package must be a non-empty Uint8Array');
  }

  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  }));
  const api = createApiClient({
    accessToken,
    publisherId,
    extensionId,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    sleep,
    maxAttempts: options.maxAttempts ?? 4,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 1000,
  });

  const existing = inspectExistingSubmission(await api.fetchStatus(), expectedVersion);
  if (existing.action === 'skip') {
    return {
      extensionId,
      version: expectedVersion,
      outcome: existing.outcome,
      state: existing.state,
    };
  }

  if (existing.action === 'upload') {
    const upload = await api.upload(options.packageBytes);
    if (upload.uploadState === 'SUCCEEDED') {
      if (upload.crxVersion !== expectedVersion) {
        throw new Error(
          `Chrome Web Store accepted version ${String(upload.crxVersion)}, expected ${expectedVersion}`,
        );
      }
    } else if (upload.uploadState === 'IN_PROGRESS') {
      await waitForUpload(api, {
        sleep,
        uploadPollAttempts: options.uploadPollAttempts ?? 12,
        uploadPollIntervalMs: options.uploadPollIntervalMs ?? 5000,
      });
    } else {
      throw new Error(`Chrome Web Store upload failed with state ${String(upload.uploadState)}`);
    }
  }

  const published = await api.publish();
  validatePublishResponse(published);
  return {
    extensionId,
    version: expectedVersion,
    outcome: existing.action === 'publish' ? 'published-staged-submission' : 'submitted',
    state: published.state,
  };
}

export function parseChromeWebStoreCliArgs(argv) {
  function option(name) {
    const inline = argv.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : undefined;
    return value && !value.startsWith('--') ? value : undefined;
  }
  return {
    packagePath: requireString(option('--package'), '--package'),
    expectedVersion: requireString(option('--version'), '--version'),
  };
}

async function writeStepSummary(result) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const summary = [
    '### Chrome Web Store submission',
    '',
    `- Extension: \`${result.extensionId}\``,
    `- Version: \`${result.version}\``,
    `- Result: \`${result.outcome}\``,
    `- State: \`${result.state}\``,
    '',
  ].join('\n');
  await appendFile(summaryPath, summary, 'utf8');
}

async function main() {
  const { packagePath, expectedVersion } = parseChromeWebStoreCliArgs(process.argv.slice(2));
  const result = await publishChromeWebStoreUpdate({
    accessToken: process.env.CHROME_WEBSTORE_ACCESS_TOKEN,
    publisherId: process.env.CHROME_WEBSTORE_PUBLISHER_ID,
    extensionId: process.env.CHROME_WEBSTORE_EXTENSION_ID,
    expectedVersion,
    packageBytes: await readFile(resolve(packagePath)),
  });
  console.log(`Chrome Web Store ${result.outcome}: v${result.version} (${result.state})`);
  await writeStepSummary(result);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
