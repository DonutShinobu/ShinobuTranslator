---
status: accepted
---

# 扩展与 Web 共用一个 monorepo

现有 `DonutShinobu/ShinobuTranslator` 仓库将成为扩展、Web 工作台、模型网关与共享核心的唯一正式仓库，并使用 npm workspaces 做增量迁移。相比复制出独立 Web 仓库，这会增加初期重构成本，但能保留 Git 历史、让两种宿主共享同一套流水线与配置迁移规则，并避免算法修复在两个仓库中长期分叉。

`apps/extension`、`apps/web` 与 `apps/model-gateway` 分别拥有自己的 package、构建入口、版本和发布产物。增量迁移期间，尚未抽入 `packages/*` 的扩展与流水线实现可以继续位于根 `src`，但根 package 只负责 workspace 编排，扩展 manifest、HTML、Vite 配置和 `dist` 不再由根目录拥有。
