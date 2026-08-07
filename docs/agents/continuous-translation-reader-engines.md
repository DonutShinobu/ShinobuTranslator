# 连续翻译模式：阅读器引擎框架与 ComiciViewer 适配设计

- 状态：已确认，可进入实现拆分
- 确认日期：2026-08-07
- 首个回归页面：<https://bibibi-comic.com/episodes/7e06f5b186c99>

本文是后续实现的规范来源。实现者应先读根目录 [`CONTEXT.md`](../../CONTEXT.md)，沿用其中的“连续翻译模式”“连续翻译显示模式”“图片翻译执行活动”等术语。

## 1. 交付结果

实现一个独立于现有 `SiteAdapter` 的阅读器引擎框架，并用 ComiciViewer 验证完整链路：

```text
引擎检测
→ 创建当前 document 的阅读会话
→ 等待当前可见跨页稳定
→ 按逻辑单页冻结页面快照
→ 写入扩展域临时快照存储
→ 按 FIFO 发起本地图片流水线执行
→ 将译图投影回当前匹配的页面 revision
→ 翻页后继续
```

框架必须能承载后续 GigaViewer、PUBLUS、CLIP STUDIO READER 和 BinB 适配器；首版不实现这些引擎。

### 完成标准

只有同时满足以下条件，首版才算完成：

1. 强指纹检测到 ComiciViewer 后，页面出现固定、紧凑、与 Pixiv 阅读栏同一视觉语言的连续翻译控件。
2. 用户开启后，当前可见正文页分别进入 FIFO；快速翻过的稳定页面仍按进入顺序完成。
3. Canvas 可导出和截图降级两条采集路径都通过自动化测试。
4. 回翻、缩放、全屏和单双页切换不会把旧译图投影到错误页面。
5. 刷新或进入同源下一话时保留标签页开关，但清除旧 document 的队列、快照和结果。
6. Chromium 与 Firefox 都通过快照存储能力探针；不支持扩展域 OPFS 的目标必须有经过测试的扩展域二进制存储适配器，否则该目标明确禁用连续翻译模式。
7. `npm run typecheck:extension`、`npm run typecheck:tests`、相关 Vitest，以及 Chromium/Firefox 扩展构建通过。

## 2. 已确认的产品范围

### 范围内

- 通用框架面向明确识别出的阅读器引擎，不负责未知网站的启发式漫画识别。
- ComiciViewer 按引擎指纹适配，不绑定 `bibibi-comic.com` 域名。
- 只采集用户当前可见的正文页面；一旦页面在可见时冻结为快照，其图片翻译执行可以在页面翻走后继续。
- 双页展开中的每个逻辑页面分别翻译；同一跨页内按逻辑页码升序进入队列，这也是 ComiciViewer RTL 阅读顺序。
- 连续翻译模式首版只允许本地图片流水线执行。
- 标签页开关只存于浏览器会话：同源刷新延续，跨域结束，关闭标签页后消失。

### 范围外

- 解析阅读器私有 API、CDN 协议或隐藏页面资源。
- 预取尚未显示的 Canvas、整章翻译或后台翻页。
- 修改 Canvas 渲染方法、注入 `drawImage` hook 或替换阅读器内部 Canvas。
- Nano Banana 整图翻译或其他会随 FIFO 自动产生云端整图调用的执行类型。
- 把 Pixiv、Twitter、E-Hentai 迁移到新框架。
- 申请 `unlimitedStorage` 权限。
- 把无上限 FIFO 的页面快照长期留在内容脚本内存中。

## 3. 现有 seam

实现前重新用 CodeGraph 核对这些符号；工作树可能已有并行改动，不要按本文复制旧源码。

- [`SiteAdapter`](../../apps/extension/src/content/core/types.ts) 的 `ImageTarget.element` 是 `HTMLImageElement`。它继续负责普通图片和现有站点适配。
- [`ReadingModeController`](../../apps/extension/src/content/core/reading/readingModeController.ts) 的完整页发现建立在远程图片 URL 上。首版不把 Canvas 语义塞进该控制器。
- [`ScreenshotController`](../../apps/extension/src/content/core/screenshot/screenshotController.ts) 已有 `captureVisibleTab`、视口矩形换算和截图裁剪，但这些能力目前嵌在显式截图产品流程中。实现时抽出无 UI 的可见标签页采集模块，再由原控制器和连续翻译模式共同调用。
- [`ImageTranslationExecutionRequest`](../../apps/extension/src/content/core/translation/imageTranslationExecution.ts) 已支持 `prepared-file`，页面快照直接使用该输入类型。
- [`ImageTranslationExecutionArbiter`](../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter.ts) 已声明 `continuous` 拥有者。连续翻译控制器必须遵守仲裁语义：自动活动不能替代显式活动；被显式活动替代后停止交付并请求取消，开关本身保持开启，待显式活动结束后重新申请活动。
- [`contentSessionId`](../../apps/extension/src/shared/contentSession.ts) 和内容会话 Port 是绑定快照消息、页面生命周期与清理责任的现有身份，不再创建平行的 tab nonce 体系。

## 4. 模块与 seam

建议文件布局：

```text
apps/extension/src/content/core/continuous/
├─ contracts.ts
├─ continuousTranslationController.ts
├─ readerEngineRegistry.ts
├─ stableSpreadMonitor.ts
├─ pageSourceResolver.ts
├─ pageProjectionController.ts
└─ continuousTranslationBar.ts

apps/extension/src/content/readerEngines/
└─ comici.ts

apps/extension/src/background/continuous/
├─ continuousSessionStore.ts
├─ pageArtifactStore.ts
└─ pageArtifactService.ts
```

依赖方向：

```text
readerEngines/comici
        ↓ implements
continuous/contracts
        ↑ consumed by
continuousTranslationController
   ├─ stableSpreadMonitor
   ├─ pageSourceResolver ── message ── pageArtifactService
   ├─ 图片翻译执行仲裁器
   ├─ pageProjectionController
   └─ continuousTranslationBar
```

`readerEngines/*` 只描述引擎事实：如何识别、枚举逻辑页、判断可见表面、监听结构信号和选择投影锚点。稳定判定、快照、FIFO、图片翻译执行、显示模式和 UI 状态属于通用层。

### 外部 interface

content 入口只认识一个深模块：

```ts
export interface ContinuousTranslationModule {
  start(): void;
  dispose(): void;
}
```

`start()` 隐藏引擎检测、标签页状态恢复、稳定判定、快照、FIFO、执行活动、投影和控件的全部顺序约束。删除该模块会迫使这些状态机散回 content 入口，因而该 interface 具备足够 Depth。

稳定器、源解析器、投影控制器、控件和 FIFO 都是该模块的内部 seam。调用方和大多数测试不直接编排它们；需要独立验证的纯算法仍可保留函数级测试。

### 真实 seam

| 依赖 | 类别 | seam | Adapter |
| --- | --- | --- | --- |
| 阅读器 DOM 差异 | in-process variation | `ReaderEngineAdapter` | Comici Adapter、测试 fake；后续增加其他引擎 Adapter |
| 扩展来源二进制存储 | remote but owned | `PageArtifactPort` | runtime-message Adapter、测试用 in-memory Adapter |
| 活动标签页截图 | remote but owned | `VisibleTabCapturePort` | background message Adapter、测试 fake |
| 图片翻译执行 | existing owned module | 现有图片翻译执行仲裁器与活动 interface | 生产实现、测试 fake |

`PageArtifactPort` 和 `VisibleTabCapturePort` 的 transport 留在 Adapter 内；连续翻译模块拥有产品逻辑。没有第二个 Adapter 的内部细节不提升为外部 seam。

## 5. 核心契约

以下是语义草案，不要求逐字采用字段名；实现必须保持这些所有权规则。

```ts
export interface ReaderEngineAdapter {
  readonly engineId: string;
  detect(): ReaderEngineDetection | null;
  createSession(detection: ReaderEngineDetection): ReaderEngineSession;
}

export type ReaderEngineDetection = {
  confidence: 'strong';
  root: HTMLElement;
  evidence: readonly string[];
};

export interface ReaderEngineSession {
  readonly engineId: string;
  readonly contextKey: string;
  readVisibleSpread(): ReaderVisibleSpread;
  observe(onSignal: (signal: ReaderSessionSignal) => void): () => void;
  dispose(): void;
}

export type ReaderPageIdentity = {
  engineId: string;
  contextKey: string;
  pageIndex: number;
};

export type ReaderVisibleSpread = {
  pages: readonly ReaderPageSurface[];
};

export type ReaderPageSurface = {
  identity: ReaderPageIdentity;
  slot: HTMLElement;
  source:
    | { kind: 'canvas'; element: HTMLCanvasElement }
    | { kind: 'image'; element: HTMLImageElement }
    | { kind: 'viewport-region' };
  viewportRect: ScreenshotRect;
  projectionAnchor: HTMLElement;
};

export type ReaderSessionSignal =
  | { kind: 'structure-changed' }
  | { kind: 'navigation-state-changed' }
  | { kind: 'geometry-changed' }
  | { kind: 'render-settled' };
```

### 身份与 revision

`ReaderPageIdentity` 是逻辑身份，页面快照的感知哈希是内容 revision：

```text
逻辑主键 = engineId + contextKey + pageIndex
结果键   = 逻辑主键 + contentFingerprint
```

- `contextKey` 必须在同一个作品章节内稳定，章节变化时改变。
- 几何、缩放、全屏、设备像素比和单双页布局不进入逻辑主键。
- 快照统一缩放到低分辨率灰度图后计算 64-bit dHash；首版把汉明距离 `<= 4` 视作同一内容。阈值必须集中为一个常量并由缩放、压缩和不同页面夹具覆盖。
- 同一个逻辑页出现不同指纹时，两次图片翻译执行都可以按 FIFO 完成；投影层只显示与当前指纹匹配的结果。
- 已排队、运行或完成的同一“逻辑主键 + 指纹”不得重复入队。

## 6. 会话状态机

### 连续翻译页面会话

```text
UNDETECTED
  └─ strong detection → DETECTED_OFF

DETECTED_OFF
  └─ 用户开启 → STARTING

STARTING
  ├─ 快照存储可用 + 获得自动活动 → WATCHING
  └─ 能力/存储失败 → PAUSED_ERROR

WATCHING
  ├─ 阅读器 DOM 暂时消失 → SUSPENDED
  ├─ document hidden → HIDDEN
  ├─ 流水线运行环境故障 → PAUSED_ERROR
  ├─ 显式活动替代 → ARBITRATION_PAUSED
  ├─ 用户关闭 → STOPPING
  └─ contextKey 改变或 document 终止 → DISPOSING

SUSPENDED
  ├─ 同一 contextKey 恢复 → WATCHING
  └─ contextKey 改变 → DISPOSING

HIDDEN
  ├─ 已冻结 FIFO 继续运行
  └─ document visible → WATCHING + reconcile

ARBITRATION_PAUSED
  └─ 显式活动结束 → 重新申请自动活动 → WATCHING

STOPPING
  └─ 取消活动、清空待处理快照、隐藏投影 → DETECTED_OFF
```

`SUSPENDED` 与 `HIDDEN` 只停止新页面采集和投影同步；已经冻结的 FIFO 继续。`ARBITRATION_PAUSED` 停止该拥有者的图片翻译执行，保留 FIFO 和开关。

### 单页状态

```text
UNSEEN
→ STABILIZING
→ CAPTURING
→ QUEUED
→ RUNNING
→ COMPLETED

CAPTURING → CAPTURE_RETRY_WAIT → CAPTURING
CAPTURING → CAPTURE_FAILED
RUNNING   → IMAGE_FAILED
RUNNING   → RUNTIME_PAUSED
```

- 捕获失败在页面仍可见时指数退避重试，最多三次。
- 图片局部故障记录为 `IMAGE_FAILED`，保留快照以供手动重试，FIFO 继续。
- 流水线运行环境故障进入 `RUNTIME_PAUSED`，停止领取新任务，等待用户修复运行条件后重试。
- “无可翻译文本”是成功结果，进入 `COMPLETED`。

## 7. 稳定判定与 FIFO

### 稳定判定

适配器信号只触发重新评估，不直接代表翻页完成。通用稳定器按以下顺序工作：

1. 在一次 reconcile 中读取可见逻辑页集合、Canvas 节点、Canvas backing size 和视口矩形。
2. 等待至少两个 `requestAnimationFrame`，并满足 300–500ms 无新结构/几何信号。
3. 再次读取；逻辑页集合相同、节点仍连接、矩形变化在容差内、Canvas 已具备非零 backing size，才生成稳定跨页。
4. 捕获后计算内容指纹；与已知指纹相同时只恢复缓存或更新投影，不重复入队。

稳定窗口常量集中配置。测试使用可控时钟，不以真实 sleep 验证。

### FIFO 语义

- FIFO 顺序取决于快照写入完成时间；同一稳定跨页内按 `pageIndex` 升序写入。
- 队列不设业务页数或字节上限，不删除旧任务，也不让新可见页插队。
- 页面翻走后，已经排队和运行的项目继续；新页面等待之前所有项目。
- 页面必须先完成源快照写入才算进入 FIFO。队列只持有 artifact ref，不持有大 Blob。
- 图片翻译执行成功后把译图 Blob 写为完成结果 artifact，再删除输入快照；`IMAGE_FAILED` 保留输入快照供重试。
- 完成结果 artifact 保留到当前 document 销毁；页面只为当前投影创建 object URL，离开可见集合后撤销。用户关闭连续翻译模式时保留完成结果、删除全部未完成快照。
- 浏览器配额写满时停止新捕获并显示存储错误；已有 FIFO 继续并在完成后释放空间。释放成功后重新检查当前可见页，恢复采集。

## 8. 页面产物存储

### 所有权

内容脚本中的 Web Storage/IndexedDB/OPFS 属于宿主页面来源，不能用于扩展的跨站快照队列。快照必须通过经过 sender、tab、document/content session 身份校验的消息交给扩展来源存储。

源快照与完成译图使用同一个扩展来源 artifact store，避免把无上限结果缓存留作 content object URL。存储契约：

```ts
export interface PageArtifactPort {
  probe(): Promise<{ available: true } | { available: false; reason: string }>;
  put(input: PutPageArtifactInput): Promise<PageArtifactRef>;
  read(ref: PageArtifactRef): Promise<File>;
  delete(ref: PageArtifactRef): Promise<void>;
  clearContentSession(contentSessionId: string): Promise<void>;
}

export type PageArtifactKind = 'source-snapshot' | 'translated-result';
```

### 实现要求

- 主实现使用扩展来源 OPFS，目录按 `continuous/<tabId>/<contentSessionId>/` 隔离。
- port Adapter 只接受当前 sender 所属 tab/document/content session 的目录，拒绝页面传入任意路径。
- 写入先使用临时名，完整关闭 writable 后再提交索引；索引不得引用半写文件。
- 使用 `navigator.storage.estimate()` 投影可用空间；配额只是提示，实际写入失败仍是权威结果。
- 不请求 `unlimitedStorage`。可以 best-effort 调用 `navigator.storage.persist()`，失败不阻止启动。
- Chromium 和 Firefox 构建各运行一次真实能力探针。若某目标的扩展来源 OPFS 不可用，先实现同一契约的扩展来源 IndexedDB Blob 适配器；无经过测试的适配器时对该目标返回“快照存储不可用”，不降级为无上限内存。
- background/service worker 重启不能丢失清理责任。活动 content session 记录放 `storage.session`；新 document 注册、tab 关闭和 content session 终止都清理旧目录。冷启动清理索引中不存在活动 session 的孤儿目录。
- 图片翻译执行完成时先尝试写入 `translated-result`，成功后删除对应 `source-snapshot`。若因配额失败，先删除已消费的 source 后重试一次结果写入；再次失败则进入结果存储故障、暂停领取新项目并释放瞬时结果 Blob，不能用 content 内存冒充已缓存结果。
- 完成结果索引只保存 artifact ref、页面身份、内容指纹和状态。投影挂载时读取 `translated-result` 并创建短生命周期 object URL；隐藏、revision 失配或销毁时立即撤销。

参考：Chrome 说明扩展来源存储在 service worker、扩展页和 offscreen document 之间共享，而内容脚本的 Web Storage 属于宿主页面；扩展默认仍受正常配额与回收约束。[Chrome extension storage](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) OPFS 通过 `navigator.storage.getDirectory()` 访问，并受来源配额约束。[MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)

## 9. 页面采集

### Canvas 优先

对于 `{ kind: 'canvas' }`：

1. 验证 Canvas 仍连接、当前可见且 backing size 非零。
2. 使用 `toBlob('image/png')` 生成无损页面快照。
3. `SecurityError`、`null` Blob、上下文不可读或节点在导出期间失效时，整个稳定跨页切换到截图降级。

不依据 2D/WebGL 上下文类型分支；可导出即使用，失败即降级。

### 一次截图、分别裁剪

截图降级只在 document 可见且目标 tab 是活动标签页时运行：

1. 保存连续翻译控件和所有译图投影的可见状态。
2. 隐藏这些扩展 UI，等待下一次 paint。
3. 调用一次 `captureVisibleTab`。
4. 使用同一帧与稳定跨页中的每个 `viewportRect` 分别裁剪页面 `File`。
5. 恢复扩展 UI。
6. 将各页按逻辑顺序写入快照存储。

任何一步失败都恢复 UI。双页不能分别调用两次截图；Chrome 对 `captureVisibleTab` 有频率上限，这条约束也是保持同一稳定帧的必要条件。[Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#property-MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)

截图裁剪必须复用 [`screenshot.ts`](../../apps/extension/src/content/core/screenshot.ts) 的视口与截图像素换算，不自行假定 `devicePixelRatio`。

## 10. 图片翻译执行调度

连续翻译控制器是一个图片翻译执行拥有者：

```ts
arbiter.begin({ owner: 'continuous', origin: 'automatic' });
```

一个已获得准入的图片翻译执行活动顺序消费 FIFO，每个页面使用：

```ts
{
  source: { kind: 'prepared-file', file },
  allowedKinds: ['local-pipeline'],
}
```

规则：

- 同一拥有者内部严格串行；不依靠本地流水线准入协调器表达页面顺序。
- 发起执行时读取当时的扩展翻译默认配置，由现有准备阶段生成扩展执行配置快照；排队时不提前锁定配置。
- 显式截图、单图按钮或其他显式活动具有更高产品优先级。连续翻译活动被撤销后不接收迟到结果；尚未开始的 FIFO 保留，之后重新申请新的活动。
- 图片局部故障继续下一页；流水线运行环境故障暂停领取。
- 结果投影前同时校验 content session、contextKey、页面身份和内容指纹。
- 连续翻译控制器不能把 [`PhotoStateStore`](../../apps/extension/src/content/core/state/photoStateStore.ts) 中的 object URL 当作无上限完成结果存储；它只可投影当前可见结果和短生命周期 UI 状态。

## 11. 投影与连续翻译显示模式

每个完成结果由通用投影控制器管理：

- 在 `projectionAnchor` 下创建独立 `<img data-mt-continuous-projection>`。
- 覆盖层使用绝对定位、`pointer-events: none`，不替换或修改原 Canvas。
- 覆盖层矩形取目标 Canvas 相对于投影锚点的局部坐标。
- `ResizeObserver`、全屏变化和引擎几何信号只更新矩形，不触发重新翻译。
- 当前页面指纹与结果指纹不匹配时立即隐藏旧覆盖层。
- 页面暂时卸载时移除 DOM 投影，但保留当前 document 内的完成结果；同一页面重新出现且指纹匹配时重新挂载。
- 扩展生成的节点都有 `data-mt-*` 标记，适配器和通用 observer 必须过滤它们。

连续翻译显示模式独立于队列：

- `translated`：有匹配结果的当前页显示译图，无结果页继续显示原 Canvas。
- `original`：全部显示原 Canvas，采集和 FIFO 继续。
- 用户关闭连续翻译模式时取消活动、清空待处理快照并隐藏投影；当前 document 已完成的结果保留，再次开启可复用。

## 12. 紧凑控件

控件使用现有 [`ReadingModeBarUi`](../../apps/extension/src/content/core/ui/readingModeBar.ts) 的视觉语言，但属于连续翻译模式，不复用 Pixiv 的“翻译当前/翻译全部”语义。

首版为固定、紧凑、不可拖动的按钮条：

- 连续翻译模式开关。
- 原图/译图显示切换。
- 失败重试入口，仅在存在可重试页面时出现。
- 一个短状态标签或错误行，用于“等待页面”“截图中”“队列 N”“第 N 页处理中”“失败 N”“存储空间不足”等状态。

长错误通过现有错误卡或短 toast 展开，不在页面上常驻仪表盘。进入全屏时将同一个 Shadow DOM 控件 host 迁入 `document.fullscreenElement`，退出后移回页面根；迁移不能重建控制器或丢失事件监听。

## 13. 引擎专用规范

实现 ComiciViewer 的检测、页面枚举、observer、结构夹具或真实页面回归时，必须继续阅读 [`continuous-translation-comici.md`](./continuous-translation-comici.md)。该文件是 Comici 结构事实的单一来源；通用层不得反向依赖其中的 selector 或 class。

## 14. 生命周期与清理

### 标签页开关

使用 `storage.session` 保存最小记录：

```ts
type ContinuousTranslationTabState = {
  tabId: number;
  origin: string;
  enabled: boolean;
};
```

`storage.session` 只在浏览器会话内存中保存，浏览器重启后清除，适合这项标签页级状态；content 不直接开放该区域，由 background 读写。[Chrome storage.session](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session) [Firefox storage.session](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session)

- 同一 tab、同一 origin 的新 document 读取该状态，因此刷新和进入同站下一话仍为开启。
- 新 document 创建全新的阅读会话；旧 document 的 FIFO、快照和完成结果全部清理。
- tab 导航到不同 origin 时删除记录；tab 关闭时删除记录和所有临时目录。
- 不写入 `storage.local` 或扩展翻译默认配置。

### 清理责任

- `ContinuousTranslationController.dispose()`：停止 observer、结束活动、移除控件和投影、请求清空 content session 快照。
- background：以 sender `documentId`、tabId 和 contentSessionId 校验清理请求。
- 新 content session 注册到同一 tab 时，background 先撤销旧 session 再接受新 session。
- service worker 冷启动执行孤儿目录清扫；清扫以活动 session 索引为准，不依靠进程内 Map。

## 15. 错误分类与 UI 行为

| 故障 | 队列行为 | UI | 恢复 |
| --- | --- | --- | --- |
| Canvas 导出失败 | 同一稳定跨页切到截图 | 短阶段文案 | 自动 |
| 截图/裁剪临时失败 | 当前页最多重试三次，其他已排队项目继续 | 页级失败数 | 页面仍可见时退避重试 |
| 图片局部故障 | 记录失败，继续下一页 | “失败 N”与重试入口 | 手动重试，复用快照 |
| 流水线运行环境故障 | 暂停领取新项目 | 显示现有可操作错误 | 修复设置后恢复 |
| 源快照配额不足 | 暂停新捕获，已有 FIFO 继续 | 存储空间不足 | 队列释放空间后重新评估 |
| 完成结果写入失败 | 暂停领取新项目，瞬时结果不冒充缓存 | 结果存储失败 | 释放空间后重新执行该页 |
| 快照存储不可用 | 不启动连续翻译模式 | 明确能力错误 | 更换受支持构建/实现适配器 |
| 阅读器 DOM 暂时消失 | 新捕获与投影暂停，FIFO 继续 | 等待阅读器 | 同一 contextKey 恢复 |
| contextKey/document 改变 | 销毁旧会话 | 新页面重新检测 | 自动创建新会话 |
| 显式活动取得仲裁 | 自动活动停止交付并取消 | 保持开关开启 | 显式活动结束后重新申请 |

## 16. 实施与验证入口

排期、拆任务、选择测试或开始任一代码切片时，必须继续阅读 [`continuous-translation-implementation-plan.md`](./continuous-translation-implementation-plan.md)。该文件是实施顺序、完成条件和验证矩阵的单一来源。

## 17. 实现时的硬约束

- 复用现有内容会话身份、图片翻译执行仲裁器、执行模块和截图坐标工具。
- 以 `prepared-file` 作为连续翻译输入；页面 URL 和内部 CDN URL不进入该产品链路。
- 自动活动遵守显式活动优先级；结果投影必须进行完整身份校验。
- FIFO 与完成结果可以无限增长，artifact store 不能无限占用内容脚本内存；无扩展来源存储能力时明确停用。
- 每个清理路径都撤销 object URL、删除快照并移除 observer/DOM。
- 生产判断只使用结构与状态，不写死样本页数、Canvas 像素或客户域名。
- 测试夹具不包含作品图像。
