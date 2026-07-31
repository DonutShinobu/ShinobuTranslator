# Golden conformance inputs

`inputs/v1` contains the nine redistributable, versioned inputs owned by the
cross-browser conformance harness. The seven text-bearing inputs are fixed
crops, compositions, or transforms of repository-owned documentation images,
plus a synthetic font/punctuation stress card. The two no-text inputs are
synthetic opaque and transparent images.

The scenario matrix records each file's SHA-256. Run `node
apps/extension/conformance/fixtures/generate-fixtures.mjs` only when preparing
an explicitly reviewed input revision; ordinary conformance and test commands
never regenerate or update these files.
