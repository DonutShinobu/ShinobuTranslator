# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This project is a Chrome Manifest V3 browser extension for translating manga/comics on Twitter (x.com) and Pixiv. It has three runtime contexts: content script (imperative DOM), background service worker, and popup UI (React). All spec files below document actual code patterns.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Filled |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | Filled |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | Filled |
| [State Management](./state-management.md) | Local state, global state, server state | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Filled |
| [Type Safety](./type-safety.md) | Type patterns, validation | Filled |

---

## Key Architecture Facts

- **React is only in the popup** — content scripts use imperative DOM (`document.createElement`)
- **No external state library** — `useState` in popup, `Map` in content script, `storage.local` in background
- **Pipeline is lazy-loaded** — `import('../../pipeline/orchestrator')` only when user clicks translate
- **Three separate entry points** — content.js, background.js, popup.js (Vite rollup)
- **Custom Vite plugin** bridges ES module output to Chrome's classic script injection for content scripts

---

**Language**: All documentation written in **English**.