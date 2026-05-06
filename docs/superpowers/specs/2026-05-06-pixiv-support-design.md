# Pixiv 支持设计文档

## 概述

将 ShinobuTranslator 从 Twitter/X 专用扩展到支持 Pixiv 作品页翻译。采用接口驱动的适配器架构，抽取公共逻辑层，各站点实现独立的适配器。

## 架构

### 目录结构

```
src/content/
  index.ts                 -- 入口：根据 URL 选择适配器，启动 TranslatorCore
  core/
    types.ts               -- SiteAdapter 接口、ImageTarget、PhotoState 等类型
    TranslatorCore.ts      -- 公共逻辑：状态管理、pipeline 调用、UI 渲染、图片切换
    ui.ts                  -- 翻译按钮 + 状态栏 DOM 创建与更新
    utils.ts               -- base64ToBlob、canvasToBlob、formatDuration 等工具函数
  adapters/
    twitter.ts             -- Twitter/X 适配器（从现有 XOverlayTranslator 提取）
    pixiv.ts               -- Pixiv 适配器
```

### 核心接口

```ts
interface ImageTarget {
  element: HTMLImageElement;
  key: string;              // 唯一标识，用于状态缓存
  originalUrl: string;      // 高清原图 URL（用于下载翻译）
}

interface SiteAdapter {
  match(): boolean;
  findImages(): ImageTarget[];
  createUiAnchor(target: ImageTarget): HTMLElement;
  applyImage(target: ImageTarget, url: string): void;
  observe(onChange: () => void): () => void;
}
```

### TranslatorCore 职责

- 持有 `Map<string, PhotoState>` 状态缓存（含 LRU 淘汰）
- 通过 adapter.observe() 监听页面变化
- 调用 adapter.findImages() 发现图片
- 为每张图片在 adapter.createUiAnchor() 返回的容器中挂载 UI
- 点击翻译时：background 下载图片 → pipeline → adapter.applyImage() 更新显示
- 处理原图/译图切换、进度显示、错误处理

### 入口逻辑

```ts
// src/content/index.ts
import { twitterAdapter } from './adapters/twitter';
import { pixivAdapter } from './adapters/pixiv';
import { TranslatorCore } from './core/TranslatorCore';

const adapters = [twitterAdapter, pixivAdapter];
const adapter = adapters.find(a => a.match());
if (adapter) {
  const core = new TranslatorCore(adapter);
  core.start();
}
```

## Pixiv 适配器

### 页面结构（已验证）

在 `pixiv.net/artworks/xxx` 页面：

- 作品图片容器：`div.sc-fddeba56-0`（position: static）
- 图片链接：`a.gtm-expand-full-size-illust`（href = 原图 URL）
- 图片元素：`a.gtm-expand-full-size-illust > img`（src = 缩略版 `_master1200.jpg`）
- 原图 URL 示例：`https://i.pximg.net/img-original/img/2026/05/06/17/43/39/144443654_p0.png`

### 适配器实现

```ts
const pixivAdapter: SiteAdapter = {
  match() {
    return location.hostname === 'www.pixiv.net'
      && location.pathname.startsWith('/artworks/');
  },

  findImages() {
    const links = document.querySelectorAll<HTMLAnchorElement>('a.gtm-expand-full-size-illust');
    const targets: ImageTarget[] = [];
    for (const link of links) {
      const img = link.querySelector('img');
      if (!img || !link.href.includes('i.pximg.net')) continue;
      const key = extractPixivImageKey(link.href); // e.g. "144443654_p0"
      targets.push({ element: img, key, originalUrl: link.href });
    }
    return targets;
  },

  createUiAnchor(target) {
    const wrapper = target.element.closest('.sc-fddeba56-0') as HTMLElement;
    if (wrapper) {
      wrapper.style.position = 'relative';
    }
    const anchor = document.createElement('div');
    anchor.style.cssText = 'position:absolute; right:12px; top:12px; z-index:10;';
    (wrapper || target.element.parentElement!).appendChild(anchor);
    return anchor;
  },

  applyImage(target, url) {
    target.element.src = url;
  },

  observe(onChange) {
    // Pixiv 是 Next.js SPA，监听路由变化和 DOM 变化
    const observer = new MutationObserver(() => onChange());
    const root = document.querySelector('#root') || document.body;
    observer.observe(root, { childList: true, subtree: true });

    // 监听 SPA 路由
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = (...args) => { origPush.apply(history, args); onChange(); };
    history.replaceState = (...args) => { origReplace.apply(history, args); onChange(); };
    window.addEventListener('popstate', onChange);

    return () => {
      observer.disconnect();
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener('popstate', onChange);
    };
  }
};
```

### 多图作品

多图作品在详情页中每张图片都有独立的 `a.gtm-expand-full-size-illust`，`findImages()` 自然返回多个 target，每张图独立翻译。

## Background Script 变更

### 图片下载 Referer 支持

`i.pximg.net` 原图需要 `Referer: https://www.pixiv.net/` header。修改 `mt:download-image` 处理逻辑：

```ts
// src/background/index.ts
// 在 fetch 图片时，根据域名自动添加 Referer
function getRefererForUrl(url: string): string | undefined {
  const hostname = new URL(url).hostname;
  if (hostname === 'i.pximg.net' || hostname.endsWith('.pximg.net')) {
    return 'https://www.pixiv.net/';
  }
  return undefined;
}
```

## Manifest 变更

```json
{
  "host_permissions": [
    "https://x.com/*",
    "https://twitter.com/*",
    "https://pbs.twimg.com/*",
    "https://www.pixiv.net/*",
    "https://i.pximg.net/*",
    "https://translate.googleapis.com/*",
    "https://api.deepseek.com/*",
    "https://api.z.ai/*",
    "https://api.moonshot.ai/*",
    "https://api.minimax.io/*"
  ],
  "content_scripts": [
    {
      "matches": [
        "https://x.com/*",
        "https://twitter.com/*",
        "https://www.pixiv.net/*"
      ],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["chunks/*", "fonts/*", "models/*", "ort/*"],
      "matches": [
        "https://x.com/*",
        "https://twitter.com/*",
        "https://www.pixiv.net/*"
      ]
    }
  ]
}
```

## 从 XOverlayTranslator 重构的范围

需要从现有 `src/content/App.tsx` 中提取到公共层的逻辑：

1. **状态管理** → `core/TranslatorCore.ts`：PhotoState 类型、状态缓存（Map + LRU）、状态转换逻辑
2. **UI 组件** → `core/ui.ts`：按钮创建、状态栏渲染、样式注入、spinner 动画
3. **工具函数** → `core/utils.ts`：`base64ToBlob`、`canvasToBlob`、`formatDuration`、`formatElapsedText`、`inferFileExtension`
4. **Pipeline 调用** → `core/TranslatorCore.ts`：设置读取、图片下载、pipeline 调用、结果处理
5. **runtime 通信** → `core/TranslatorCore.ts`：`sendRuntimeMessage`、`getChromeApi`

保留在 Twitter 适配器中的逻辑：
- Twitter 特有的 DOM 选择器和弹窗检测
- `pbs.twimg.com` URL 识别和归一化
- 图片大图弹窗定位逻辑（referenceButton 锚定）
- `originalSrcAttr` 管理（Twitter 图片 src 会被替换）

## CSS 注入策略

样式从 Twitter 专用改为通用。所有站点共享同一组 CSS class（`mt-x-control`、`mt-x-status` 等），通过 adapter 的 `createUiAnchor()` 控制挂载位置。样式注入逻辑移至 `core/ui.ts`。

## 测试验证

使用 `https://www.pixiv.net/artworks/144443654`（单图漫画作品）验证：
1. 翻译按钮出现在图片右上角
2. 点击翻译后图片被替换为翻译结果
3. 可切换原图/译图
4. SPA 路由切换后按钮正确重新挂载
