/**
 * Browser-specific runtime target selected by the package export map.
 *
 * Keep this literal statically analyzable so browser bundles cannot retain
 * Node-only runtime adapters.
 */
export const isNodeRuntime = false;
