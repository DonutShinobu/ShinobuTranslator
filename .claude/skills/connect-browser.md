---
name: connect-browser
description: Connect to the Windows host Chrome browser for development testing. Use when needing to open, test, or interact with the app in the browser via agent-browser.
allowed-tools: Bash(agent-browser:*), Bash(cd /mnt/c && /mnt/c/Windows/System32/cmd.exe:*)
---

# Connect Windows Chrome for Development

This project runs in WSL2 (mirror network mode). The Windows host Chrome is
used for development testing via agent-browser + CDP.

## Quick connect

```bash
# 1. Launch Chrome on Windows with remote debugging (if not already running)
cd /mnt/c && /mnt/c/Windows/System32/cmd.exe /c "start chrome --remote-debugging-port=9222 --user-data-dir=D:\ChromeDebug"

# 2. Wait a moment for Chrome to start
sleep 3

# 3. Connect from WSL via agent-browser (mirror mode = localhost works)
agent-browser connect http://localhost:9222
```

## Key facts

- **Network mode**: WSL2 mirror — localhost in WSL reaches Windows host directly
- **Chrome profile**: `D:\ChromeDebug` (isolated from user's main profile)
- **CDP port**: 9222
- **Connection**: `agent-browser connect http://localhost:9222`

## After connecting

```bash
agent-browser open http://localhost:3000   # open dev server
agent-browser snapshot -i                  # see interactive elements
agent-browser screenshot output.png        # take screenshot
```

## Troubleshooting

- If connection refused: Chrome may not be running. Re-run step 1.
- If `cmd.exe` complains about UNC paths: must `cd /mnt/c` first.
- Do NOT use `--cdp` flag with a remote address — use `agent-browser connect <url>` instead.
