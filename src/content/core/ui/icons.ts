export const ICONS = {
  translate: `<svg viewBox="0 0 16 16"><text x="1.5" y="11" font-size="8.5" fill="currentColor" font-family="sans-serif" font-weight="700">文</text><text x="8.5" y="11" font-size="8.5" fill="currentColor" font-family="sans-serif" font-weight="700">A</text></svg>`,
  original: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><circle cx="5" cy="6" r="1.5" fill="currentColor"/><path d="M1.5 11l4-3 2 2 3-2.5 3.5 2.5"/></svg>`,
  translated: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><circle cx="5" cy="6" r="1.5" fill="currentColor"/><path d="M1.5 11l4-3 2 2 3-2.5 3.5 2.5"/><rect x="5" y="5.5" width="7.5" height="4" rx="1" fill="currentColor" opacity="0.75"/></svg>`,
  retry: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8A5 5 0 1 1 8 3"/><path d="M8 3l2.5 2.5"/></svg>`,
  confirm: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
};

export type IconKey = keyof typeof ICONS;
