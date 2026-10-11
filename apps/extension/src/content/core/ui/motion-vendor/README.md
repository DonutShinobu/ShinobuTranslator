# Translation button motion

`motion-kit.js` is a self-contained browser ESM built from the official npm releases `morphicons@1.7.1` and `torph@0.1.3`. The content script imports this checked-in file and Vite includes it in the extension's single local IIFE. Normal application builds do not install these packages, import the design prototype, fetch a CDN, or require additional CSP permissions.

The full MIT notices are embedded in the bundle and retained in `LICENSE-morphicons.txt` and `LICENSE-torph.txt`. `manifest.json` records npm tarball URLs, their integrity values, reviewed source commits, inputs, adaptations, and the delivered SHA-256. Public TypeScript declarations in `types/` are copied from those exact npm releases.

## Local adaptations

`build.mjs` applies six exact, asserted replacements to the pinned Torph input without modifying the installed package:

- Preserve computed opacity `0` during active and departing glyph interruption. Upstream's `Number(opacity) || 1` incorrectly made invisible glyphs opaque.
- Keep labels containing Han characters at grapheme granularity, including spaced parallel stages and mixed Latin/Chinese labels. The existing Torph LCS and ID allocator preserve shared glyph nodes in `numbers:false` mode.
- Respect `scale:false` for entering and departing group zoom as well as individual glyphs.

Application timing, fresh-glyph fade/clipping, state icons, glass, and running illumination belong to the button component, not this vendor package.

## Rebuild and verify

Only rebuilding or running this focused vendor check requires the pinned local development inputs:

```sh
npm install --prefix apps/extension/src/content/core/ui/motion-vendor --ignore-scripts --no-audit --no-fund --package-lock=false --omit=peer
node apps/extension/src/content/core/ui/motion-vendor/build.mjs
node apps/extension/src/content/core/ui/motion-vendor/verify.mjs
```

The build validates the installed runtime versions and npm integrity records against `manifest.json` before applying patches. A package upgrade requires deliberately updating those pins and reviewing the patch matches. No ignored prototype files are rebuild inputs.

The verification imports the delivered module, checks SHA-256 and both notices, Chinese/emoji segmentation and IDs, Chinese shared-node reuse across spaced and mixed text, zero-opacity interruption, disabled text, and actual Morphicons interruption/seek/cleanup. Its Happy DOM checks cover engine behavior, not browser compositor timing or final visual quality.

## Runtime API

```ts
import { createMorph, TextMorph } from './motion-kit.js';

const icon = createMorph(pathElement, initialPath, { reducedMotion: 'never' });
icon.morphTo(nextPath, { stiffness: 400, damping: 40 });
// Also: set(path), seek(path, progress), progress, reducedMotion, destroy().

const text = new TextMorph({
  element: labelElement,
  duration: 340,
  ease: 'cubic-bezier(0.19,1,0.22,1)',
  locale: 'zh-CN',
  scale: false,
  numbers: false,
  respectReducedMotion: false,
});
text.update('翻译');
text.update('文字识别中');
// Also: destroy(); completion/cancellation hooks are constructor options.
```

Torph's first update is immediate. The second `update` argument is an optional numeric caret index, not animation options. `destroy()` releases its stylesheet/media listener but does not cancel all descendant animations or remove every glyph; the owning button cleans those up. Torph appends its shared stylesheet to the owner document's head, so its DOM requires matching document styles.
