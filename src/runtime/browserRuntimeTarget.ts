/**
 * Browser build replacement for the shared runtime target.
 *
 * This literal must remain statically analyzable so Rollup can exclude every
 * Node-only dynamic import from extension and Cloudflare Pages artifacts.
 */
export const isNodeRuntime = false;
