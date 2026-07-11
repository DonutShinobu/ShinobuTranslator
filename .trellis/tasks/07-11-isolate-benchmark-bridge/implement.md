# Benchmark Bridge 隔离实施计划

## 1. 基线

- [x] 构建 Release，记录 `content.js` 中现有 benchmark 协议字符串（迁移前约 259 KB，包含全部 bake/render 协议）。
- [x] 运行浏览器 pipeline/UI smoke 记录基线；`benchmark/typeset/images/` 只有 `.gitkeep`，因此用仓库内 color fixture 覆盖 bake/render API。
- [x] 添加 Release 产物断言，检查旧协议字符串和 benchmark-only 入口泄漏。

## 2. 受控入口

- [x] 新增 benchmark-only HTML 与 browser entry。
- [x] 增加 benchmark build 命令和条件 Vite input。
- [x] 在扩展页面暴露最小 bake/render API。
- [x] 更新 `chrome-cdp.ts`、bake/render runner 打开扩展页面并直接调用 API。

## 3. 移除生产桥

- [x] 从 `src/content/index.ts` 删除 bake 静态导入、消息 listener、ready 广播和 `__shinobu_bake__` 属性。
- [x] 通过 UI jank smoke 确认正常 Content bundle 仍通过动态加载进入本地流水线。

## 4. 验证

- [x] 普通 `npm run build` 不产出 benchmark page/entry。
- [x] Release `content.js` 不含所有旧协议字符串。
- [x] `bench:browser-pipeline-smoke -- --all-api` 验证 bake、render、render-debug、fixture-debug。
- [x] 517 个测试、`npm run build`、指定构建产物 `node --check` 全部通过。
- [x] `git diff --check` 通过，`benchmark/images/` 保持未跟踪且未暂存。

## 5. 回滚点

- [x] 入口迁移和 Content Bridge 删除保持为清晰、可独立审查的文件级 diff；未在用户未要求时自动提交。
- [x] runner 通过扩展内页调用，失败时可回滚 runner/entry，不需要把公共桥重新加入 Release。
