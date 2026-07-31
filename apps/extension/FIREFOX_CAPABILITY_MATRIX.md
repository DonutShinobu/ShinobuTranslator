# Firefox 23 项完整功能等价矩阵

`firefox-capability-matrix.json` 是 23 项 Firefox Desktop 140+ 首版能力的单一机器可读库存。每项能力都绑定用户入口、共享 contract、成功与关键失败场景，以及以下五层证据：

1. Chrome 用户入口库存；
2. Chrome/Firefox 共用的 adapter contract；
3. Firefox 140 打包 XPI；
4. Firefox 当前稳定版的同字节 XPI；
5. Chrome 109 同 commit、版本、lockfile 与模型输入的回归。

矩阵同时逐项记录仓库入口、共享 contract 与自动测试的源码路径。它不会复制 pipeline、配置或 controller，也不会定义另一套 execution contract；本地图片流水线继续以 `@shinobu/image-pipeline` 和真实宿主 conformance 为权威。

## 输出矩阵

```shell
npm run firefox:capability-matrix
```

输出为 JSON，可供浏览器 runner 或后续 `dual-browser-gate` 消费。

## 验证证据并生成人类汇总

```shell
npm run firefox:capability-matrix:verify -- path/to/evidence.json
```

默认输出 Markdown 汇总；在命令后追加 `--json` 可输出机器可读判定。验证时还必须设置 `FIREFOX_CURRENT_STABLE_VERSION`，其值由门外根据 Mozilla 当前稳定通道解析，不能由证据 bundle 自报：

```shell
FIREFOX_CURRENT_STABLE_VERSION=<resolved-version> npm run firefox:capability-matrix:verify -- path/to/evidence.json
```

证据 bundle 只引用五个 runner receipt。每个 receipt 都有自身 SHA-256，并重复绑定完整 commit、扩展版本、lockfile/model 摘要、固定 runner、逐场景通过观察、浏览器精确版本与包路径；判定器会把这些值与当前 checkout 及实际 XPI/ZIP 字节重新计算后对照。缺少 receipt、receipt 被改写、制品字节改变、runner 不匹配或场景只有 coverage 字符串却没有通过观察，都会失败。

receipt 不能手工补写。静态库存与 adapter contract 由实际 Vitest runner 生成：

```shell
npm run firefox:capability-contracts -- --output-dir artifacts/firefox-capability-evidence/contracts
```

这些 contract 测试只产生它们实际覆盖的 layer observations。词法/静态测试不会被提升为七项产品行为禁令的通过证据：contract receipt 会把七项保持为 `fail`，直到 #58 的 Chrome/Firefox 真实入口负向探针分别证明没有隐藏、回落、平行 owner、no-op 或浏览器文案控制流。这样补充性静态 guard 可以尽早报警，但不能让最终矩阵误判为完整。

打包 Firefox runner 只会在 smoke 通过后写出它实际拥有的观察：设置 `FIREFOX_EVIDENCE_LAYER=firefox140Packaged|firefoxCurrentPackaged` 与 `FIREFOX_EVIDENCE_RECEIPT=<output.json>` 后运行 `npm run smoke:firefox-basic`。runner 会重新计算 XPI 摘要、记录真实浏览器版本，并把不属于 basic smoke 的生产 provider／安装提示场景保留在 `missingEvidence`，receipt 状态保持 `fail`，绝不会把一次 broad smoke 自动展开成全部场景通过。#58 的生产 provider runner 必须补齐这些观察后，完整层才能通过。

任何 tracked dirty checkout 会在 receipt 生成或最终判定时失败，避免 receipt 声称的是 HEAD、实测的却是未提交源码。

Firefox 140 和 Firefox 当前稳定版必须运行同一 XPI 字节；权限提示、拒绝、撤销与重新授权只接受持久的 packaged/signed XPI 安装，`temporary` 会直接失败。两版 Firefox 均强制标记为 `packaged-user-entry`，direct Port 探针不能作为能力等价证据。

只有五层证据全部齐全、七项禁止降级检查全部通过、23/23 能力均无缺口时，汇总才输出 `Firefox complete capability parity: PASS (23/23)`。以下任一情况都会输出 `INCOMPLETE` 并以非零状态退出：

- Firefox-only 隐藏入口；
- provider 静默回落；
- 第二套 pipeline、config 或 controller；
- 静默 no-op；
- 使用浏览器错误文案控制共享行为；
- 缺失、失败、版本不符或包摘要不一致的证据。

真实浏览器 runner 与完整 conformance 接入 `dual-browser-gate` 属于 #58；本矩阵只提供它必须消费的 fail-closed 产品证据契约，不在 #52 中复制 CI 或黄金样本门。

## Firefox XPI smoke

`npm run smoke:firefox-basic` 要求 `FIREFOX_XPI` 指向待验证的 packaged/signed XPI，并以持久安装运行。脚本不会接受解包目录，也不会使用临时安装代替权限证据；浏览器重启验证沿用同一 profile 中的同一安装。Firefox 140 与更新版本走同一组 inline/context-menu/screenshot/反馈 UI 用户入口、下载规则和生命周期检查，不存在 140 专用 direct Port 降级。

basic provider smoke 会从打包扩展真实消息入口逐一执行 DeepSeek、GLM、Kimi、MiniMax、MiMo、OpenAI API Key 与自定义 endpoint 的成功和结构化上游失败，并继续执行 Nano Banana/Gemini 的 UI、权限与认证模式路径。Google Web、Gemini 文本、Gemini API/Cookie 整图的生产成功／失败和 `websiteContent` 安装提示明确由 #58 的生产 provider smoke 补齐；在那之前矩阵保持 `INCOMPLETE`，不以“选项存在”冒充执行成功。
