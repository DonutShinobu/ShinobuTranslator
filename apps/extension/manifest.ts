export type ExtensionTarget = 'chromium' | 'firefox';

type Manifest = Record<string, unknown>;

const COMMON_PERMISSIONS = [
  'storage',
  'contextMenus',
  'declarativeNetRequest',
  'webRequest',
  'cookies',
];

export function createExtensionManifest(target: ExtensionTarget, version: string): Manifest {
  const common: Manifest = {
    manifest_version: 3,
    name: 'ShinobuTranslator',
    version,
    description: '用于 X / Pixiv 的漫画翻译器（支持谷歌翻译和大模型翻译）',
    action: {
      default_title: 'ShinobuTranslator',
      default_popup: 'popup.html',
      default_icon: {
        16: 'icons/icon16.png',
        32: 'icons/icon32.png',
        48: 'icons/icon48.png',
        128: 'icons/icon128.png',
      },
    },
    icons: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
    permissions: [...COMMON_PERMISSIONS],
    host_permissions: ['<all_urls>'],
    commands: {
      'start-screenshot-translate': {
        suggested_key: {
          default: 'Alt+Q',
        },
        description: '截图翻译',
      },
      'translate-hover-target': {
        suggested_key: {
          default: 'Alt+W',
        },
        description: '翻译悬停元素',
      },
    },
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['content.js'],
        run_at: 'document_idle',
      },
    ],
    web_accessible_resources: [
      {
        resources: [
          'fonts/*',
        ],
        matches: ['<all_urls>'],
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self';",
    },
  };

  if (target === 'chromium') {
    return {
      ...common,
      minimum_chrome_version: '109',
      background: {
        service_worker: 'background-chromium.js',
        type: 'module',
      },
      permissions: [...COMMON_PERMISSIONS, 'offscreen'],
    };
  }

  return {
    ...common,
    background: {
      page: 'background-firefox.html',
      persistent: false,
    },
    browser_specific_settings: {
      gecko: {
        id: 'shinobu-translator@donutshinobu',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['websiteContent', 'authenticationInfo'],
        },
      },
    },
  };
}
