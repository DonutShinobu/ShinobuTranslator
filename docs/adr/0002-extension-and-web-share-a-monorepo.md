---
status: accepted
---

# 扩展与 Web 共用一个 monorepo

现有 `DonutShinobu/ShinobuTranslator` 仓库将成为扩展、Web 工作台、模型网关与共享核心的唯一正式仓库，并使用 npm workspaces 做增量迁移。相比复制出独立 Web 仓库，这会增加初期重构成本，但能保留 Git 历史、让两种宿主共享同一套流水线与配置迁移规则，并避免算法修复在两个仓库中长期分叉。

`apps/extension`、`apps/web` 与 `apps/model-gateway` 分别拥有自己的 package、构建入口、版本和发布产物。增量迁移期间，尚未归位的实现可以暂留根 `src`，但根 `src` 只是临时迁移源，不是跨 workspace 的正式 seam，也不允许继续新增依赖其内部路径的跨 workspace 深相对 import。目标态是宿主无关的流水线与配置进入 `packages/*`，各应用只拥有宿主 adapter、入口和发布产物，根 package 只负责 workspace 编排。

## 受控临时迁移边

2026-07-30 在父规格 [#33](https://github.com/DonutShinobu/ShinobuTranslator/issues/33) 的 [#43](https://github.com/DonutShinobu/ShinobuTranslator/issues/43) 实施裁决中，允许把 Vite 原先从 `apps/extension` 构建直接指向根 background/content 入口的隐式可达关系，临时显式化为且仅为以下两条源码边：

- `apps/extension/src/background.ts -> ../../../src/background/index`
- `apps/extension/src/content.ts -> ../../../src/content/index`

这两条边只服务于入口所有权迁移，不是正式跨 workspace seam，也不构成新增 app→root 依赖的一般性先例。现有 workspace import boundary 检查直接锁定它们的 source、target 和各自出现次数恰好为 1；它们不进入普通 baseline，任何第三条 app→root 相对 import 仍会作为新增边失败。裁决前已在普通 baseline 中登记的 benchmark、offscreen 与 popup 遗留边不被重新归类为此次冻结边，仍由原有 baseline 的“不得增加且迁移后必须删除”规则约束。

#43 不引入面向临时根 `src` 目录结构的通用 JavaScript 静态架构解释器。待根 `src` closure 迁入稳定的 `packages/*` 边界后，再基于最终 package graph 建立正式架构门；该后续工作不属于 #43 的关闭条件。

当 background/content 的 reachable closure 已迁入 `apps/extension`，或已通过正式 `packages/*` 公共边界供入口消费时，对应临时 import、上述冻结记录与最小边界断言必须一并删除。冻结边不能作为无限期保留根 `src` 实现的理由。
