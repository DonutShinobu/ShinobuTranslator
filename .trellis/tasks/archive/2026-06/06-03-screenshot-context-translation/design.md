# Design: Generic Screenshot Context Translation

## Architecture

Use a generic screenshot flow instead of a site adapter:

1. Background context menu dispatch starts the screenshot workflow.
2. Content script displays an in-page region selector.
3. Background captures the visible tab.
4. Content script crops the selected viewport rectangle into a PNG `File`.
5. TranslatorCore runs the existing lazy-loaded pipeline from that file.
6. Content script renders a draggable translated-image overlay at the selected document position.

This avoids relying on `event.target`, `<img>` discovery, canvas internals, or site metadata.

## Message Contracts

Add runtime messages with the existing `mt:` prefix:

- `mt:start-screenshot-translate`: background-to-content message sent when the user clicks the screenshot context menu item.
- `mt:capture-visible-tab`: content-to-background request that returns a PNG capture of the currently visible tab.

The capture response should return:

- `base64`
- `contentType`
- `sourceUrl`

`isRuntimeMessage()` should recognize the new content-to-background capture request. It should also include any direct message types that are part of the shared runtime union.

## Context Menu

Keep the current `翻译图片` item for native image translation. Add a second item, for example `截图翻译`, that is available broadly enough to appear on page, canvas, background, link, and image surfaces.

The screenshot item sends `mt:start-screenshot-translate` to the active tab. If the content script is unavailable, the click should fail silently as the current image context flow does.

## Selection UI

The content script owns selection UI because it needs page coordinates and must follow content-script styling rules:

- full-viewport fixed overlay
- `mt-x-` class names
- crosshair cursor
- rectangle drawn from pointer-down to pointer-up
- minimum selection size guard to avoid accidental tiny screenshots
- Chinese status/cancel text
- Escape key cancels where practical

Before calling `mt:capture-visible-tab`, temporarily hide the selector UI and wait for a repaint so the capture does not include ShinobuTranslator controls.

## Cropping

Capture coordinates are viewport-relative, while the returned image is device-pixel-sized. Compute crop scaling from the actual screenshot dimensions:

- `scaleX = screenshotImage.naturalWidth / window.innerWidth`
- `scaleY = screenshotImage.naturalHeight / window.innerHeight`

Clamp the selected rectangle to the screenshot bounds, draw it into an offscreen canvas, and export it as PNG. This handles browser zoom and device pixel ratio better than assuming `devicePixelRatio` directly.

## Pipeline Reuse

The current context menu image flow downloads by URL before running the pipeline. Screenshot translation should add or extract a helper that runs the same settings validation, lazy `getRunPipeline()`, progress handling, debug toggles, and elapsed-time handling from an already available `File`.

Avoid eager pipeline imports. The pipeline should still load only after the user confirms a screenshot region.

## Result Overlay

Create a self-contained translated result overlay:

- initial position: selected rectangle's document coordinates
- initial size: selected rectangle's CSS pixel size
- image content: translated pipeline output
- top-right close button labeled visually as `x`
- draggable by pointer interaction
- high z-index and `mt-x-` styles
- cleanup revokes translated/debug object URLs and removes listeners

During translation, the same overlay area can show progress text so the user sees that work is running at the selected location.

## Migration From Sunday Webry Adapter

Remove the previous site-specific path:

- disconnect `sundayWebryAdapter` from `src/content/index.ts`
- delete or leave unused-free `src/content/adapters/sundayWebry.ts`
- remove `CustomContextMenuTarget`, `resolveCustomContextMenuTarget`, and `showCustomContextMenu` code if no other adapter needs it
- replace the related spec note with screenshot-context guidance if a spec update is warranted after implementation

This keeps the extension from carrying a one-off target resolver for a non-primary compatibility site.

## Trade-Offs

- More generic: works with canvas, CSS backgrounds, overlays, and unknown page structures.
- Less exact: output quality is limited by visible screenshot resolution rather than original image resolution.
- Viewport-bound: selection cannot capture offscreen content.
- Native-menu-bound: this MVP depends on the browser right-click menu opening. A toolbar button or keyboard shortcut can be a later extension if broader blocker resistance becomes important.

## References

- Chrome Extensions Tabs API: `chrome.tabs.captureVisibleTab`
