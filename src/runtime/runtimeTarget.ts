/**
 * Default runtime target used by Node tests/benchmarks and the extension build.
 *
 * Browser hosts may replace this module at build time. Keeping the target in
 * one module lets bundlers remove the unused Node adapter graph completely.
 */
export const isNodeRuntime = (
  typeof process !== 'undefined'
  && Boolean(process.versions?.node)
);
