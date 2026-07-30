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

这两条边只服务于入口所有权迁移，不是正式跨 workspace seam，也不构成新增 app→root 依赖的一般性先例。它们不得进入普通 workspace import baseline；架构策略必须 fail-closed 地锁定 source、target 与数量恰好为 2，并拒绝第三条新增的 app→root 源码边、目标漂移，以及用 alias、virtual module、global bridge 或 dynamic import 隐藏同一依赖。裁决前已在普通 baseline 中登记的 benchmark、offscreen 与 popup 遗留边不被重新归类为此次冻结边，仍由原有 baseline 的“不得增加且迁移后必须删除”规则约束。

架构策略采用有意保守的静态证明：共享实现中的原生 API、全局对象与动态代码生成能力不得通过对象、数组、返回值、动态属性或不透明调用逃逸分析；扩展构建中的路径与 URL 则必须在别名、零参数 helper 及对象/数组容器传播后仍可静态求值，从已知锚点拼接动态片段时直接 fail-closed。即使某个局部函数当前看似安全，只要其 identity 已经被别名、容器、返回值或不透明只读调用暴露，策略也会撤销对 `.constructor` 等间接能力的安全证明；调用方应改为可静态验证的局部写法，而不是增加白名单。这个约束用于防止隐藏第三条 app→root 构建边或绕开 adapter，并不扩展上述两条冻结边的范围。

当 background/content 的 reachable closure 已迁入 `apps/extension`，或已通过正式 `packages/*` 公共边界供入口消费时，对应临时边必须立即删除，同时删除架构策略中的冻结记录与对应架构测试。冻结边不能作为无限期保留根 `src` 实现的理由。
