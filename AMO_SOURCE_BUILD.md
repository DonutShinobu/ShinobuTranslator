# Rebuilding the Firefox XPI for AMO

Run the build from the extracted source archive root:

```text
npm run build-for-amo
```

The uploadable build environment is fixed to Ubuntu 24.04.4 LTS on ARM64,
Node 24.14.0, and npm 11.9.0. The command validates those exact versions,
installs the lockfile-v3 dependency graph with
`npm ci --no-audit --no-fund`, verifies every bundled model, runtime metadata,
ORT runtime, and font before Vite starts, builds the existing Firefox target,
and runs the pinned `web-ext` lint gate with warnings treated as errors.

No model or `latest` release is downloaded. Do not set `MODEL_RELEASE_TAG`,
`VITE_*`, `WEB_EXT_*`, `NODE_OPTIONS`, or semantic `npm_config_*` variables.
The source archive already contains the locked model and runtime bytes needed
by the build.

Successful output is written to `artifacts/amo/`:

- `shinobu-translator-<version>-firefox.xpi`
- `shinobu-translator-<version>-source.zip`
- `xpi-files.sha256`
- `source-files.sha256`
- `build-receipt.json`

The command only builds and validates unsigned artifacts. It does not sign,
upload, or read AMO credentials.
