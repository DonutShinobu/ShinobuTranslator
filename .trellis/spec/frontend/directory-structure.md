# 目录与模块边界

本文档记录 ShinobuTranslator 当前已经落地的代码组织方式。项目是 Chrome Manifest V3 扩展，支持 Twitter/X、Pixiv 和 E-Hentai；Popup、Content Script、Background Service Worker、ONNX Worker 与 benchmark 页面分别运行在不同上下文中。

## 当前目录

```text
src/
├── background/
│   ├── index.ts                 # composition root：组装 service 并注册 Chrome 事件
│   ├── messages/router.ts       # RuntimeMessage 路由；只依赖 BackgroundServices
│   ├── diagnostics/logStore.ts  # 持久化诊断日志
│   ├── images/imageService.ts   # 截图、下载与 pximg referer 规则
│   ├── menus/registerMenus.ts   # 右键菜单与快捷键
│   ├── settings/settingsStore.ts
│   ├── storage/chromeStorage.ts
│   ├── providers/providerService.ts
│   ├── gemini/authService.ts
│   └── openai/                  # OAuth 与 Responses proxy
├── content/
│   ├── index.ts                 # 站点 adapter 选择和 TranslatorCore 启动
│   ├── adapters/
│   │   ├── twitter.ts
│   │   ├── pixiv.ts
│   │   └── ehentai.ts
│   └── core/
│       ├── TranslatorCore.ts    # 薄编排器：挂载、同步、控制器组合
│       ├── types.ts
│       ├── state/photoStateStore.ts
│       ├── translation/
│       │   ├── translationRunner.ts
│       │   └── imageTranslationController.ts
│       ├── reading/readingModeController.ts
│       ├── screenshot/
│       │   ├── screenshotController.ts
│       │   └── overlayInteraction.ts
│       └── ui/
│           ├── index.ts         # Content UI 公共入口
│           ├── cards.ts
│           ├── cardState.ts
│           ├── imageControls.ts
│           ├── readingModeBar.ts
│           ├── screenshotOverlay.ts
│           ├── styles.ts
│           └── icons.ts
├── pipeline/
│   ├── orchestrator.ts          # 本地翻译 pipeline composition root
│   ├── detect/                  # 文字检测和后处理
│   ├── ocr/                     # PP-OCRv6 medium + CTC +颜色采样
│   ├── typeset/
│   │   ├── index.ts             # 仅导出 drawTypeset 及公共类型
│   │   ├── drawTypeset.ts       # 排版入口
│   │   ├── composite.ts         # 最终合成
│   │   ├── debug.ts             # debug 输出
│   │   ├── fontFit*.ts          # 共享字号拟合与度量
│   │   ├── horizontal*.ts       # 横排拟合、布局和渲染
│   │   ├── vertical*.ts         # 竖排拟合、布局、方向和渲染
│   │   └── sourceGeometry.ts    # 源列几何约束
│   ├── translate.ts
│   ├── inpaint.ts
│   ├── bubbleDetect.ts
│   ├── maskRefinement/
│   └── textlineMerge/
├── runtime/
│   ├── modelRegistry.ts         # 浏览器模型 manifest 与 session 缓存
│   ├── modelRegistryNode.ts     # Node 模型路径适配
│   ├── onnxBridge.ts            # Browser/Node 统一懒加载入口
│   ├── onnxWorkerBridge.ts      # Comlink 浏览器桥
│   ├── onnxNodeBridge.ts        # onnxruntime-node 进程内桥
│   ├── onnxWorkerTypes.ts       # Worker transport/API 契约
│   ├── browserPlatform.ts
│   ├── nodePlatform.ts
│   └── platform.ts
├── workers/
│   ├── onnx-worker.ts           # 独立构建的 ONNX Worker
│   └── gpuPreprocess.ts
├── benchmark/browserEntry.ts    # 仅 benchmark mode 暴露 window API
├── popup/                       # React 设置 UI
├── shared/                      # 配置、Chrome/messages、诊断等跨层契约
├── translators/                 # 文本翻译 provider
└── types.ts                     # pipeline 领域共享类型
```

项目根目录的重要边界：

```text
benchmark.html                   # benchmark mode HTML；Release 不包含
benchmark/
├── typeset/                     # 排版 fixture、render、metrics
├── color/                       # 颜色诊断
└── perf/                        # 浏览器/Node 性能与 smoke；历史报告可保留
tests/                            # 集中式 Vitest，按 src 层级镜像
scripts/
├── build-worker.mjs             # 独立构建 dist/onnxWorker.js
├── check-release-boundaries.mjs # Release/benchmark 产物边界断言
└── legacy/                      # 非生产历史模型转换脚本
public/
├── manifest.json                # Chrome MV3 manifest
└── models/models.json           # 当前模型事实源
vite.config.ts                   # Release 三入口 + 独立 benchmark mode
tsconfig.json                    # 应用代码
tsconfig.tests.json              # tests
tsconfig.benchmark.json          # benchmark
```

## 构建入口

- Release Vite 输入只有 `popup.html`、`src/background/index.ts` 和 `src/content/index.ts`。
- `src/workers/onnx-worker.ts` 不属于主 Vite 输入；`npm run build` 在主构建后调用 `scripts/build-worker.mjs`，单独生成 `dist/onnxWorker.js`。
- `benchmark.html` 和 `src/benchmark/browserEntry.ts` 只由 `vite build --mode benchmark` 使用。生产 Content Script 不得安装 `window.__shinobuBenchmark__` 或 benchmark message bridge。
- `npm run check:artifacts` 必须确认 Release 不含 benchmark entry/bridge，也不含已移除的 legacy OCR Worker API。

## 层级约束

### Background

`src/background/index.ts` 只负责组装 `BackgroundServices`、注册 Chrome listener 和启动初始化。消息分派放在 `messages/router.ts`，Chrome/API 细节放在具名 service。新增消息时同时更新 shared message guard、router 测试和对应 service 测试，避免把业务分支重新堆回入口。

### Content Script

`TranslatorCore` 负责生命周期和控制器组合，不直接承载翻译、截图、阅读模式或大段 UI 实现：

- 状态与 Blob URL 生命周期：`PhotoStateStore`
- pipeline 执行：`TranslationRunner`
- 单图交互：`ImageTranslationController`
- 阅读模式：`ReadingModeController`
- 截图/浮层：`ScreenshotController`
- DOM 创建/渲染：`core/ui/`

Content Script 继续使用 imperative DOM，禁止引入 React。所有 CSS class 使用 `mt-x-` 前缀。

### Typeset

外部模块只从 `src/pipeline/typeset/index.ts` 导入 `drawTypeset` 和公共类型。入口编排、横竖排算法、Canvas 渲染、合成与 debug 分离；不要重新建立顶层 `src/pipeline/typeset.ts` 或把实现聚合回 `fontFit.ts`。

### OCR 与 Worker

产品 OCR 只有 `paddleocr_v6_medium`，识别由 Paddle provider + CTC decode 完成。Worker API 保持通用 session/inference、runtime probe、Paddle graph-capture probe、detector GPU preprocess 和 dispose 能力；AR decode/color 不是 Worker RPC。

### Benchmark

benchmark 可导入生产 pipeline 进行测量，但生产入口不得反向导入 `src/benchmark/` 或 `benchmark/`。保留历史报告不代表恢复历史 runtime。当前 Paddle 浏览器性能入口为 `benchmark/perf/src/run-browser-paddle-profile.ts`。

## 新增代码的放置规则

- 新站点：实现 `SiteAdapter`，放在 `src/content/adapters/<site>.ts`，在 `src/content/index.ts` 注册，并在 `tests/content/adapters/` 增加测试。
- 新 Background 能力：放入具名 service 目录，通过 `BackgroundServices` 注入 router；入口只做 wiring。
- 新 Content 交互：优先放入现有 controller/store/UI 子模块；`TranslatorCore` 只添加编排调用。
- 新复杂 pipeline stage：使用 `src/pipeline/<stage>/index.ts` 作为唯一公共入口，内部按职责拆分。
- 新 Worker 能力：先证明它属于产品通用 runtime，再同步 API type、Browser/Node bridge、Worker expose、契约测试和产物断言；不要把废弃领域算法塞进 Worker。
- 新 benchmark 页面能力：只从 `src/benchmark/browserEntry.ts` 暴露，并验证 Release 产物不含该符号。
- 新测试：放在 `tests/` 下并镜像源码层级；当前 Vitest 不运行 colocated `src/**/*.test.ts`。

## 命名与导入

- 文件使用 camelCase；目录与入口用领域名称和 `index.ts`。
- 数据结构优先 `type`，可扩展契约（例如 `SiteAdapter`、`OnnxWorkerApi`）可使用 `interface`。
- 类型导入使用 `import type`。
- Pipeline 只能通过 `runtime/onnxBridge.ts` 访问 ONNX，不能直接导入 Browser/Node bridge。
- 跨领域工具放 `src/shared/`，pipeline 共享算法放 `src/pipeline/utils.ts`，单模块 helper 留在所属目录。
