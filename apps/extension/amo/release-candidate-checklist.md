# Dual-target release candidate checklist

Use the Chromium and Firefox packages produced from the same commit, tag, extension version, model manifest, and SHA-256 manifest. Record the browser version and result for every row.

## Sites and entry points

- X/Twitter: hover image control, tweet-context translation, original/result toggle.
- Pixiv: artwork image control, multi-page navigation, repeated translation.
- eHentai: gallery image control and referer-protected image download.
- Ordinary HTTPS page: image control and screenshot selection.
- Context menus: translate image and screenshot translation.
- Shortcuts: `Alt+Q`, `Alt+W`, and the browser shortcut-settings link.

## Lifecycle and failure recovery

- Run consecutive local translations and confirm one-at-a-time global admission.
- Leave the local pipeline idle for at least five minutes; confirm the host Port closes and the next task recreates it.
- Restart each browser and confirm settings persist while inactive host state does not.
- Disconnect the network before an external translation request; confirm explicit failure and successful recovery after reconnecting.
- Interrupt the Firefox background page during a task; confirm that task fails and the next invocation starts a fresh host.

## Providers and consent

- Google Web translation.
- Every configured API-key LLM provider and custom endpoint.
- OpenAI OAuth login, refresh, and logout without a second authentication-consent prompt.
- Gemini API Key image translation.
- Gemini Cookie login without a second Cookie permission prompt.
- Confirm a missing install-time Cookie permission fails closed without starting a provider request.

## Cross-browser result parity

- Use the same fixed image and mock translator with WASM forced in both browsers.
- Compare OCR text exactly and verify output image dimensions are identical.
- Compare result screenshots at SSIM `>= 0.995`.
- Compare popup and content-control bounding rectangles; every edge must differ by no more than `1 px`.
- Performance may differ, but both browsers must complete without target-specific feature drift.
