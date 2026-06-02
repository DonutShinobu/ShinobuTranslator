# Implementation Plan

## Before Coding

- Run `trellis-before-dev` and load the relevant frontend/content-script specs.
- Re-check current git status so user changes are not overwritten.
- Treat the previous Sunday Webry implementation as code to remove/supersede, not as a compatibility target to preserve.

## Ordered Checklist

- [x] Remove Sunday Webry-specific wiring from `src/content/index.ts`.
- [x] Remove `src/content/adapters/sundayWebry.ts` if it becomes unused.
- [x] Remove custom site context target types and TranslatorCore methods that only support that adapter.
- [x] Add shared runtime message types for screenshot capture/start workflow.
- [x] Add background `mt:capture-visible-tab` handling using `chrome.tabs.captureVisibleTab`.
- [x] Add a second Chrome context menu item for screenshot translation and dispatch it to content scripts.
- [x] Add content message handling for `mt:start-screenshot-translate`.
- [x] Implement in-page screenshot region selection UI with `mt-x-` styles.
- [x] Hide selection UI before capture, crop the selected viewport region, and create a PNG `File`.
- [x] Extract/reuse a pipeline-from-`File` helper so screenshot translation does not need an original image URL.
- [x] Render a progress/result overlay at the selected position.
- [x] Add drag behavior to the result overlay.
- [x] Add a top-right `x` close button and cleanup object URLs/listeners.
- [x] Keep existing native image context menu translation working.
- [x] Update or remove the Sunday Webry-specific spec note from `.trellis/spec/frontend/quality-guidelines.md`.

## Validation

- `npm run build` passed.
- `npx tsc --noEmit` passed.
- `npm run test` passed with message type guard and screenshot crop-geometry coverage.
- Manual Chrome extension check:
  - right-click real image -> existing `翻译图片` path still works
  - right-click page/canvas area -> `截图翻译` starts selection
  - selected region translates and overlays at original position
  - result overlay drags and closes
  - canceling selection leaves page unchanged

## Risk Points

- `captureVisibleTab` can include extension UI if the selector is not hidden before capture.
- Coordinate scaling can be wrong under browser zoom unless based on screenshot dimensions.
- Context menu IDs should be stable and avoid duplicate creation errors on service worker restarts.
- Refactoring the pipeline path can break existing image translation if URL-download behavior is mixed with screenshot-file behavior too aggressively.
- High z-index result overlays must not use unprefixed classes or leak page style dependencies.
