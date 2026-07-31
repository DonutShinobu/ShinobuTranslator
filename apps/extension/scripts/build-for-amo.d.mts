export function createAmoChildEnvironment(input?: {
  inherited?: Record<string, string | undefined>;
  nodeEnvironment?: string;
}): Record<string, string | undefined>;

export function buildForAmo(): unknown;
