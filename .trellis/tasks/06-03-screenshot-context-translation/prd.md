# Implement generic screenshot context translation

## Goal

Replace the Sunday Webry-specific right-click adapter with a generic screenshot-based translation flow that works for pages where manga/comic content is rendered through canvas, CSS backgrounds, overlays, or other non-`img` DOM surfaces.

## User Value

Users can right-click a page, choose a screenshot translation entry, draw a region directly in the webpage, and get the translated result overlaid back on the selected area. This avoids per-site DOM/metadata reverse engineering for pages that do not expose a useful image element.

## Confirmed Facts

- The current extension already has a Chrome context menu item named `翻译图片`, limited to native image contexts.
- The existing image context menu flow only works when the browser provides an `HTMLImageElement` target.
- A previous Sunday Webry-specific implementation added `sundayWebryAdapter`, a site-scoped custom context menu target resolver, and adapter-specific overlay logic.
- The new request explicitly replaces that site-specific approach with screenshot translation.
- `public/manifest.json` already includes `tabs` permission and `<all_urls>` host permissions, which are the expected permissions for capturing the visible tab.
- Content scripts must stay imperative DOM-only, use `mt-x-` CSS class prefixes, lazy-load the translation pipeline only after user action, and keep user-facing strings in Chinese.

## Requirements

- Add one more Chrome right-click menu item for screenshot translation, separate from the existing `翻译图片` image item.
- When the screenshot menu item is clicked, the content script enters an in-page region selection mode.
- The user can drag a rectangle over the visible webpage to choose the screenshot area.
- The selection UI must support canceling before capture, including an obvious close/cancel control and keyboard cancel where practical.
- After selection, capture the visible tab, crop the chosen rectangle, run the existing translation pipeline on the cropped PNG, and display progress in Chinese.
- Overlay the translated result at the original selected position.
- The translated overlay must be draggable.
- The translated overlay must include an `x` close button in the top-right corner.
- Closing the translated overlay removes it and releases object URLs associated with that screenshot result.
- Remove the Sunday Webry-specific right-click adapter path and do not keep a site-specific custom target resolver for this task.
- Keep existing Twitter/X, Pixiv, e-hentai, and native image context menu behavior working.

## Acceptance Criteria

- [ ] Right-clicking a normal page shows a new screenshot translation menu item in addition to the existing image translation item where applicable.
- [ ] Clicking the screenshot translation item shows an in-page rectangular selection overlay.
- [ ] Dragging a valid region captures only that visible selected area, not the full page.
- [ ] The translation pipeline runs from the cropped screenshot file without needing a source image URL.
- [ ] The translated image appears over the selected region at the same initial size and position.
- [ ] The result overlay can be dragged without starting a new selection.
- [ ] The result overlay's top-right `x` closes the overlay and cleans up generated URLs.
- [ ] Canceling selection leaves the page unchanged.
- [ ] Existing `翻译图片` behavior on real `<img>` elements still works.
- [ ] Sunday Webry-specific adapter code is removed or fully disconnected.
- [ ] `npm run build` passes.

## Out Of Scope

- Bypassing every site-level native right-click blocker. This task adds a generic Chrome right-click entry; if a site prevents the browser menu from opening, a later keyboard/toolbar entry can be considered separately.
- Translating regions outside the current visible viewport.
- Full-page or scroll-stitch screenshots.
- Batch translation through screenshot selection.
- Recovering original manga image URLs from site metadata.

## Status

Implementation completed on `codex/screenshot-context-translation`.
