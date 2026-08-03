# AMO reviewer test steps

ShinobuTranslator is a Firefox Desktop 140+ Manifest V3 extension. The submitted source archive builds the reviewed package with Node.js 22 and `web-ext@10.3.0`.

1. Run `npm ci`.
2. Run `npm run build-for-amo`. The pinned model release is declared in `apps/extension/model-release.json`; every model size and SHA-256 is checked against `public/models/models.json`.
3. The command builds `apps/extension/dist-firefox`, requires Firefox lint to report zero errors and exactly the audited dependency warnings, and writes the Firefox package plus source archive to `artifacts/`.
4. Load `apps/extension/dist-firefox/manifest.json` temporarily in Firefox Desktop 140+.
5. Open the popup, change a setting, close/reopen it, and confirm persistence.
6. On an ordinary HTTPS page, X, or Pixiv, hover an image and use the translate control. The first local task lazily starts the pipeline host and the active Port keeps the non-persistent background page alive. After five idle minutes the model sessions and Port are released.
7. Test `Alt+Q`, `Alt+W`, both context-menu items, and the shortcut settings link.
8. Select Gemini Cookie mode. Authentication data and Cookie access are granted once in Firefox's install flow; the popup opens the Gemini login page without a second permission prompt.
9. Disconnect the network and start a local task to confirm an explicit failure; a later task recreates the host automatically.

The package contains no remotely loaded executable code or Tesseract resources. ONNX Runtime Wasm and all models are bundled. The `DANGEROUS_EVAL`/React `innerHTML` lint warnings are from pinned production dependencies and are locked by rule, file, dependency version, and file SHA-256 in `scripts/firefox-lint-baseline.json`.
