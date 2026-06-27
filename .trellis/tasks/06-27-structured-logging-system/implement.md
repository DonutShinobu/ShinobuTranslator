# 构建结构化日志系统 - 实施计划

## Checklist

- [x] 定义 `DiagnosticLogEvent`、`DiagnosticLogTextExport`、分类枚举、脱敏工具和大小裁剪工具。
- [x] 实现 `formatDiagnosticReadableLog(events)`：
  - 输出 `[YYYY-MM-DD HH:mm:ss.SSS][LEVEL][context][runId][category] module | message details`
  - 按时间排序
  - 只使用脱敏后的 message / data / error
  - 从同一批结构化事件派生，不维护第二套日志
- [x] 在 shared messages 中新增日志相关 runtime message：
  - `mt:diagnostic-log-event`
  - `mt:diagnostic-log-export`
  - `mt:diagnostic-log-clear`
- [x] 在 background 中实现日志仓库：
  - 最新 2000 条事件持久化到 `chrome.storage.local`
  - 最新 run 持久化到 `chrome.storage.local`
  - export 返回统一 `.log` 文本，不暴露顶层 `events`
  - logging 失败不得影响业务响应
- [x] 在 popup 调试选项加入统一“下载日志”按钮：
  - 从 background 拉取文本日志
  - 使用共享 `downloadText`
  - 显示无日志 / 下载失败的中文状态
  - 在同一按钮组加入“清空日志”，便于验证时移除历史残留
- [x] 收口旧 content 图片 UI 日志下载：
  - 不再直接下载独立 `typeset-debug-log`
  - 将已有 debug artifacts 写入统一日志包
  - 移除默认原图 data URL，改存图片元信息或脱敏引用
  - 失败 run 也保留可导出的日志
- [x] 在 `TranslatorCore` 和 `runPipeline` 接入 run 生命周期：
  - run start / finish / fail
  - stage progress / finish / fail
  - settings snapshot
  - stageTimings / runtimeStages / artifacts summary
- [x] 在 LLM 请求链路接入 `llm.api` 日志：
  - `src/translators/llm.ts` content 直连 fetch
  - background OpenAI OAuth proxy
  - Gemini App / Gemini API image translate
  - DeepSeek `Failed to fetch` 分类和上下文
- [~] 替换或桥接核心 `console.warn/info`：
  - 已接入 progress jank、pipeline artifacts、runtimeStages 汇总
  - ONNX provider fallback / worker fallback 的逐条 console 桥接可作为后续增强
- [x] 加入测试：
  - 脱敏函数不会泄露 API key / token / Authorization
  - 易读日志格式符合 `[2026-06-27 17:28:22.875][INF][content][runId][category] module | message`
  - 原图 data URL 默认不会进入统一日志包
  - prompt / raw response 会被脱敏和截断
  - LLM fetch 失败分类能识别 `Failed to fetch`
  - runtime message schema
- [ ] 手动验证：
  - 勾选“日志记录”后执行一次本地翻译并从 popup 下载日志
  - 模拟 DeepSeek baseUrl 错误，确认日志包含 provider、endpoint、错误分类和耗时
  - 关闭“日志记录”后确认不产生详细日志包
- [x] 运行 `npm run build` 和相关 Vitest。

## Implementation Notes

- 统一日志入口位于 popup 调试选项的按钮组，包含“下载日志”和“清空日志”。
- `enableDebugLog` 现在对 Nano Banana 也生效；仅本地可视化调试项仍在 Nano Banana 下关闭。
- 普通图片下载、content 直连 LLM、OpenAI OAuth background proxy、Gemini App/API 全图翻译都会写入同一个 `runId`。
- background storage 内部保留结构化 `events`，默认导出只返回由同一批事件生成的 `.log` 文本。
- 文本日志每行包含固定前缀和单行紧凑 JSON 详情，方便直接阅读、复制和 grep。
- background 日志写入使用串行队列，避免高频 `pipeline.stage`、`llm.api`、`image.io` 并发写 `chrome.storage.local` 时互相覆盖。
- 旧 content 图片 UI 的独立日志下载入口已隐藏，不再提供散落下载链路。
- 文本日志排序和 run 聚合会归一化 `timestamp`，避免旧缓存或异常事件缺时间戳时触发 `localeCompare` 崩溃。

## Validation Result

- `npx tsc --noEmit --pretty false` 通过。
- `npm run test -- --run` 通过：31 个测试文件，463 个测试。
- `npm run build` 通过；保留项目既有的 onnxruntime eval 和大 chunk 体积警告。

## Risky Areas

- `src/shared/messages.ts`：runtime message union 扩展可能影响类型守卫。
- `src/background/index.ts`：service worker 生命周期与日志持久化。
- `src/content/core/TranslatorCore.ts`：当前失败 catch 会清空 `debugLogData`，需要小心避免破坏 UI 状态。
- `src/translators/llm.ts`：DeepSeek 等 content 直连 fetch 的错误包装要保留原始错误信息。
- `src/workers/onnx-worker.ts`：worker 不能直接使用 Chrome runtime，需要通过 bridge 传出结构化事件。

## Validation Commands

```bash
npm run build
npm run test
```

必要时补充更窄的 Vitest 命令运行新增测试文件。

## Review Gate

隐私范围已确认：默认记录 OCR 原文、大模型 prompt、原始响应全文，但必须脱敏和截断；默认不嵌入原图 data URL。实现前仍需用户确认规划通过，然后执行 `task.py start` 进入实现。
