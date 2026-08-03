export const SHINOBU_CHROME_EXTENSION_ID: string;

export type ChromeWebStorePublishResult = {
  extensionId: string;
  version: string;
  outcome: 'already-published' | 'already-submitted' | 'published-staged-submission' | 'submitted';
  state: 'PENDING_REVIEW' | 'PUBLISHED';
};

export type ChromeWebStorePublishOptions = {
  accessToken: string | undefined;
  publisherId: string | undefined;
  extensionId: string | undefined;
  expectedVersion: string;
  packageBytes: Uint8Array;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  uploadPollAttempts?: number;
  uploadPollIntervalMs?: number;
};

export function publishChromeWebStoreUpdate(
  options: ChromeWebStorePublishOptions,
): Promise<ChromeWebStorePublishResult>;

export function parseChromeWebStoreCliArgs(argv: string[]): {
  packagePath: string;
  expectedVersion: string;
};
