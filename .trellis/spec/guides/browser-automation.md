# Browser Automation with Windows Chrome Profile

> How to use agent-browser with a fixed Windows Chrome profile from WSL2.

---

## Context

This project is a Chrome extension. Browser automation (agent-browser) is needed for:
- Manual testing of the extension in a real browser
- Exploratory testing and QA
- Screenshot capture for UI verification
- Debugging runtime behavior

The development environment is WSL2, so browser automation must connect to a Windows-side Chrome instance rather than launching one inside Linux.

---

## Setup

### 1. Launch Chrome on Windows with Remote Debugging

From WSL2, run:

```bash
cd /mnt/c && /mnt/c/Windows/System32/cmd.exe /c "start chrome.exe --remote-debugging-port=9222 --user-data-dir=D:\ChromeDebug"
```

Key flags:
- `--remote-debugging-port=9222` — opens CDP endpoint for agent-browser
- `--user-data-dir=D:\ChromeDebug` — uses the fixed profile (preserves login state, cookies, extensions)

**Note:** The `cd /mnt/c` prefix is required — `cmd.exe` refuses UNC paths (WSL working directory).

### 2. Connect agent-browser via CDP

```bash
agent-browser --cdp 9222 open https://x.com
agent-browser --cdp 9222 snapshot -i
agent-browser --cdp 9222 screenshot result.png
```

All subsequent commands use `--cdp 9222` to stay connected to the same session.

### 3. Close when done

```bash
agent-browser --cdp 9222 close
```

This closes the agent-browser connection but **does not close Chrome itself**. Close Chrome manually on Windows when finished.

---

## Alternative: Use --profile and --executable-path

agent-browser can also launch Chrome directly with a specific profile:

```bash
agent-browser --executable-path "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
  --profile "/mnt/d/ChromeDebug" \
  open https://x.com
```

This approach is simpler for one-off use but:
- Launches a **new** Chrome instance each time (may conflict if Chrome is already running)
- Does not reuse an existing browser session
- May not load extensions from the profile correctly in some cases

**Prefer CDP connection** when Chrome is already open or when you need the full profile state (extensions, login sessions).

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cmd.exe` UNC path error | Prefix with `cd /mnt/c` before calling `cmd.exe` |
| Chrome not found at default path | Check `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe` |
| CDP connection refused | Ensure Chrome launched with `--remote-debugging-port=9222`; wait 3s after launch |
| Port 9222 already in use | Another Chrome instance has debugging enabled; use `--auto-connect` instead |
| Profile not loading extensions | Use CDP connection to an already-running Chrome with the profile |

---

## Chrome Path on This Machine

```
C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
WSL2: /mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe
```

Profile directory:
```
D:\ChromeDebug
WSL2: /mnt/d/ChromeDebug
```

---

## Security Note

`--remote-debugging-port` exposes full browser control on localhost. Any local process can connect and read cookies, execute JS, etc. Only use on trusted machines and close Chrome when done.