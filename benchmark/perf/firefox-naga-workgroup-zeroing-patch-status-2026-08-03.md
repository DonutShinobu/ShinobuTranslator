# Firefox / Naga workgroup 清零补丁状态（2026-08-03）

## 结论

截至 2026-08-03，**没有已经合并且可由 Firefox 获得的循环清零修复**。

- 直接记录 DXC 慢编译的 wgpu [#7443](https://github.com/gfx-rs/wgpu/issues/7443) 仍为 open，没有关联 PR、milestone 或关闭提交；最后更新仍是 2026-04-12 对 Naga 整体数组清零的最小归因。
- 通用的“加速 workgroup 内存零初始化”问题 [#4592](https://github.com/gfx-rs/wgpu/issues/4592) 也仍为 open。2026-01-15 的最新维护者评论只表示可能以后处理，并明确不会很快发生。
- 曾有原型 PR [#5521](https://github.com/gfx-rs/wgpu/pull/5521) 为 SPIR-V、GLSL 和 HLSL 分摊零初始化，但它于 2024-11-18 被作者关闭、从未合并，原分支也已删除。作者说明当前架构不足以容易完成，并且在 Vulkan 上观察到整体性能回退。

## 为什么旧 PR 不能视为现成修复

PR #5521 的 HLSL 实现使用 `SV_GroupIndex`，把顶层数组元素分摊给不同 invocation；方向与所需修复相同。但其 helper 只读取顶层数组长度，然后对数组的 base type 调用默认初始化。对于 #7443 的三层嵌套数组，这可能仍留下内层数组整体赋零。由于 PR 早于 #7443 的 2026 年最小复现、没有对该 shader 的编译耗时验证，并且未合并，因此只能视为可参考的原型，不能视为可直接 cherry-pick 的已验证修复。

## 当前主线和 Firefox Nightly 状态

检查当日 wgpu `trunk` 提交 `b991e6025d58b84df003e23102acea8440369131`，HLSL writer 仍在 [`write_workgroup_variables_initialization()`](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/naga/src/back/hlsl/writer.rs#L2009-L2029) 中对整个变量调用 `write_default_init(module, var.ty)`；[`write_default_init()`](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/naga/src/back/hlsl/writer.rs#L4853-L4865) 仍输出类型转换后的整体零值，而不是循环。

Mozilla `mozilla-central` 当前 [`moz.yaml`](https://hg.mozilla.org/mozilla-central/raw-file/tip/gfx/wgpu_bindings/moz.yaml) 固定 wgpu 提交 `f680a2c242ce109d632b1154d72e0e7836e31c67`（2026-07-16）。该提交的 [HLSL writer](https://github.com/gfx-rs/wgpu/blob/f680a2c242ce109d632b1154d72e0e7836e31c67/naga/src/back/hlsl/writer.rs#L2023-L2027) 仍执行相同的整个变量默认初始化。因此当前 Firefox Nightly 也没有该修复。

## 其他相关改动

- [PR #5508](https://github.com/gfx-rs/wgpu/pull/5508) 已合并，允许**原生 wgpu 应用**关闭 workgroup 清零；PR 描述明确写着它“不修复 #4592”。Firefox 实现 WebGPU 时必须保持 workgroup 内存的零初始化语义，网页和扩展也没有这个开关，所以它不是本项目的解决方案。
- 微软最新稳定 [DXC 1.9.2607](https://github.com/microsoft/DirectXShaderCompiler/releases/tag/v1.9.2607) 也没有消除该慢路径。本机用相同最小 HLSL 测得整体赋零中位数 1.978 秒，循环清零 0.029 秒，仍相差 67.4 倍；相比 DXC 1.9.2602 的 2.409 秒只有有限改善。

## 可执行判断

现在不能通过升级 Firefox、wgpu、Naga 或 DXC 获得现成修复。若要主动推动，最现实的上游工作是基于 #5521 的思路重新实现一个 **HLSL-only、递归展开嵌套数组、带 #7443 编译基准** 的小型 PR，避免旧 PR 同时改多个后端和启发式策略造成的范围与性能争议。
