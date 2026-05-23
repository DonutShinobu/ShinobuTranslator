---
name: use-translator-plugin
description: Use the ShinobuTranslator browser extension to translate manga/comic images on web pages (e.g. x.com posts). Covers how to trigger the plugin, wait for completion, and check results.
allowed-tools: Bash(agent-browser:*)
---

# Use ShinobuTranslator Browser Plugin

The manga translation browser extension is installed in the `D:\ChromeDebug` Chrome profile.
It injects overlay controls on image lightbox views.

**Prerequisite**: Browser must be connected first — see `connect-browser` skill.

## Workflow

### 1. Open the target image in lightbox mode

On x.com, click the image in a post to open the lightbox viewer:

```bash
# Find and click the image link in the post
agent-browser snapshot -i -s "article"
agent-browser click @eN   # the image link element
```

### 2. Click the translate button

The plugin injects a button in the lightbox overlay. It is NOT visible in
accessibility snapshots — use JS to find and click it:

```bash
# The plugin button lives under .mt-x-actions
agent-browser eval "document.querySelector('.mt-x-actions button:nth-child(1)')?.click()"
```

The button selector path (for reference):
```
#layers .mt-x-overlay-fallback .mt-x-actions > button:nth-child(1)
```

### 3. Wait for translation to complete

Translation runs through multiple stages (detection → OCR → translation → inpainting).
Total time is typically 30-90 seconds depending on image complexity.

```bash
# Poll status until complete
agent-browser eval "document.querySelector('.mt-x-status-text')?.textContent"
```

Status progression:
- `翻译中 | 去字完成` — still processing
- `翻译完成\n总耗时：XXs\n...` — done

### 4. Check results

```bash
agent-browser screenshot /tmp/translated_result.png
```

## Key selectors

| Element | Selector |
|---------|----------|
| Translate button | `.mt-x-actions button:nth-child(1)` |
| Status text | `.mt-x-status-text` |
| Plugin overlay | `.mt-x-overlay-fallback` |
| Spinner running | `.mt-x-status-spinner[data-running="true"]` |
| Download log button | `.mt-x-actions button:nth-child(2)` |

## Notes

- The plugin uses WebGPU for acceleration (detection, OCR, inpainting)
- Plugin controls are injected into the DOM but not the accessibility tree — always use `agent-browser eval` with CSS selectors, not snapshot refs
- The translate button shows "翻译" when ready, "翻译中..." when processing (disabled)
