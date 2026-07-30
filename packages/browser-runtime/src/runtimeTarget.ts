/**
 * Runtime target used by Node tests and benchmarks.
 *
 * Browser bundlers select browserRuntimeTarget.ts through the package's
 * conditional export, which makes Node-only branches statically unreachable.
 */
const runtimeGlobal = globalThis as typeof globalThis & {
  process?: {
    versions?: {
      node?: unknown;
    };
  };
};

export const isNodeRuntime = Boolean(
  runtimeGlobal.process?.versions?.node,
);
