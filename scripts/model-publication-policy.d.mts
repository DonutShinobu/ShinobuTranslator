export type ModelPublicationBlocker = {
  id: string;
  path: string;
  status: 'conditional' | 'blocked';
  reason: string;
};

export function validateModelPublicationPolicy(
  manifest: unknown,
  policy: unknown,
): ModelPublicationBlocker[];

export function assertModelPublicationApproved(
  manifest: unknown,
  policy: unknown,
): void;
