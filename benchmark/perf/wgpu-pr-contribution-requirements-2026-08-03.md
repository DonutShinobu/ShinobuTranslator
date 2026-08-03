# wgpu / Naga HLSL 修复的上游 PR 要求（2026-08-03）

> 核对基线：`gfx-rs/wgpu` `trunk` 提交 [`b991e6025d58b84df003e23102acea8440369131`](https://github.com/gfx-rs/wgpu/tree/b991e6025d58b84df003e23102acea8440369131)。本文只引用该仓库及其 issue/PR 的一手资料。

## 结论

针对 Naga HLSL 后端中“嵌套 `var<workgroup>` 数组被输出为整数组合零初始化，导致 DXC 编译极慢”的修复，最容易被上游接受的形态是一个单一问题、行为保持、带最小 WGSL 回归样例和 HLSL snapshot 的小 PR。PR 应直接 `Fixes #7443`，并解释它和较宽泛的 `#4592`、已关闭且未合并的 `#5521` 有何不同；不能把 `#5521` 当成已经落地的修复。

提交前的实用门槛是：`cargo fmt`、`cargo clippy --tests`、Naga snapshot、DXC 与 FXC 对生成 HLSL 的验证、完整 `cargo xtask test`，以及 Windows/DX12 的 CTS。用户可见的显著性能修复应写入根 `CHANGELOG.md`。当前仓库没有记录 CLA、DCO 或 `Signed-off-by` 硬性要求；项目代码以 `MIT OR Apache-2.0` 双许可证发布。

## 1. 先把 PR 范围收窄

- 上游明确反对未经维护者确认的大型改造，并建议耗时方案先在 Matrix/Discord 或 issue 中确认；作者必须能够理解、证明和解释所有改动。AI 生成代码允许提交，但责任完全在提交者。[CONTRIBUTING.md](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/CONTRIBUTING.md)
- 对本问题，建议只修改 Naga HLSL backend 的默认初始化输出策略及相应测试，不同时重构通用初始化框架、其它后端或 wgpu-hal 缓存。
- [`#7443`](https://github.com/gfx-rs/wgpu/issues/7443) 是当前应关闭的直接问题。PR 的 `Connections` 建议写：

  ```text
  Fixes #7443
  Related to #4592 and #5521
  ```

- [`#4592`](https://github.com/gfx-rs/wgpu/issues/4592) 讨论的是跨后端并行化 workgroup memory zeroing 的更宽问题；[`#5521`](https://github.com/gfx-rs/wgpu/pull/5521) 尝试覆盖 SPIR-V、GLSL 和 HLSL，但已关闭、未合并。新 PR 应明确：这次只修复会触发 DXC 病态 alias analysis 的 HLSL 生成形态，并覆盖嵌套数组；不要声称续接一项已经落地的方案。
- 仓库评审清单特别要求 Naga backend 新生成的标识符避免和用户标识符冲突，必要时使用 `Namer`、注册保留字或保留前缀。若修复生成循环变量，这一点必须显式处理。[Naga review checklist](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/docs/review-checklist.md#backend-changes)

## 2. 开发环境与版本约束

- 使用仓库固定的 Rust `1.93`，包含 `rustfmt`、`clippy` 和 `wasm32-unknown-unknown` target；用 `rustup` 时进入仓库运行 Cargo 会读取该配置。[rust-toolchain.toml](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/rust-toolchain.toml)
- Naga、wgpu-core、wgpu-hal 和 wgpu-types 的 MSRV 是 `1.87`，整个开发/测试工作区的 MSRV 是 `1.93`。修复不能无意使用高于 1.87 的 Naga 代码特性。[README MSRV policy](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/README.md#msrv-policy)、[naga/Cargo.toml](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/naga/Cargo.toml)
- 完整测试要求 `cargo-nextest`，部分测试还要求 Vulkan SDK；HLSL 验证则需要可执行的 DXC/FXC。[docs/testing.md](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/docs/testing.md#requirements)、[Shaders workflow](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/workflows/shaders.yml)

## 3. Naga HLSL 回归测试与 golden 更新

建议增加一个最小输入，例如 `naga/tests/in/wgsl/workgroup-nested-array-init.wgsl`，只保留能复现以下差异的内容：

- 嵌套 workgroup 数组；
- WebGPU 所要求的零初始化语义；
- 旧输出中的整数组合赋值；
- 新输出中的分布式/循环初始化；
- 至少一个后续读取，避免样例被当成无意义代码。

Snapshot 的规范流程是：

1. 在根目录运行 `cargo nextest run --test naga snapshots`。该测试从 `naga/tests/in` 读取输入，并向 `naga/tests/out` 生成各后端 golden；WGSL 输入通常按 “butterfly” 方式覆盖所有相关后端。[docs/testing.md：Naga snapshot tests](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/docs/testing.md#naga-snapshot-tests)
2. 审查并提交预期的 `naga/tests/out/hlsl/*.hlsl` 和对应 `.ron` 变化，同时确认没有无关 backend golden 漂移。Snapshot harness 会根据 HLSL reflection 生成供编译器验证的 entry-point/profile 配置。[snapshot harness](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/naga/tests/naga/snapshots.rs)、[hlsl-snapshots config](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/naga/hlsl-snapshots/src/lib.rs)
3. 在 `naga` 目录验证生成物：

   ```powershell
   cargo xtask validate hlsl dxc
   cargo xtask validate hlsl fxc
   ```

   当前 Windows shader CI 同时运行这两个命令；不能只证明文本 snapshot 改了，还要证明 DXC/FXC 接受新 HLSL。[Shaders workflow](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/workflows/shaders.yml#L24-L69)、[Naga xtask CLI](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/naga/xtask/src/cli.rs)
4. 为性能修复附上固定 shader、DXC 版本、目标 profile、冷/热运行方式和多次样本，报告修改前后的编译耗时。性能数字不是 golden 的替代品，而是证明 `#7443` 已被解决的关键证据。

CI 会先删除整个 `naga/tests/out`，再运行完整测试，最后执行 `git add . && git diff --exit-code HEAD naga/tests/out`。因此漏提交、遗留或多余 snapshot 都会失败。[CI snapshot check](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/workflows/ci.yml#L711-L728)

## 4. 提交前命令清单

按“快反馈 → 完整验证”顺序运行：

```powershell
# 仓库根目录
cargo fmt
cargo clippy --tests
cargo nextest run --test naga snapshots

# HLSL golden 编译验证
Set-Location naga
cargo xtask validate hlsl dxc
cargo xtask validate hlsl fxc
Set-Location ..

# 全量仓库测试和 Windows/DX12 CTS
cargo xtask test
cargo xtask cts --backend dx12
```

这些是仓库 `AGENTS.md` 对格式、lint、全量测试及平台 CTS 的明确工作流；Windows backend 为 `dx12`。[AGENTS.md](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/AGENTS.md#workflow) 完整测试范围和各测试命令见 [docs/testing.md](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/docs/testing.md)。

注意：仓库 CI 使用 `RUSTFLAGS=-D warnings` / `RUSTDOCFLAGS=-D warnings`，并在多平台、多 feature、MSRV 配置上运行比上述本地最小命令更广的 Clippy/build 检查。[CI workflow](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/workflows/ci.yml)

## 5. Changelog 要求

`AGENTS.md` 要求用户可见的公开 API 变化、显著 bug fix 或新功能进入 changelog；PR 模板也把 user-facing changelog 列为检查项。这个修复直接改变 Windows 上可见的首次 shader 编译性能，建议加入根 `CHANGELOG.md`：

```markdown
### Performance

#### naga

- Avoid pathological DXC compile times when zero-initializing nested workgroup arrays in HLSL. By @YOUR_GITHUB_NAME in [#PR](https://github.com/gfx-rs/wgpu/pull/PR).
```

格式、顶层分类（含 `Performance`）和底层分类（含 `naga`）定义在 [CHANGELOG.md 顶部说明](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/CHANGELOG.md#L3-L41)。独立 changelog workflow 会校验变更。[changelog workflow](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/workflows/changelog.yml)

## 6. PR 描述与 commit 组织

按当前 [PR template](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/pull_request_template.md) 填写：

- **Connections**：`Fixes #7443`，列出 `Related to #4592 and #5521`；若依赖另一个未合并 PR，在描述顶部写 `Depends on #NNNN`。
- **Description**：给出旧 Naga HLSL、Chrome/Tint 风格或手工循环版本、DXC alias-analysis 耗时差异，以及新 lowering 为何保持 WGSL 零初始化语义。
- **Testing**：列出 snapshot、DXC、FXC、全量测试、DX12 CTS 和性能复测的命令与结果。
- **Squash or Rebase?**：多 commit 时明确请求 squash，或声明 commit 已可逐个 rebase；选择后者时每个 commit 都必须通过 CI，以保持 `trunk` 可 bisect。
- 勾选作者理解、自审、行为影响、测试、changelog、最小范围及 commit 可审查性等适用项。

草稿 PR 不进入每周 triage；准备好正式评审后应转为 Ready。处理 review 后要显式 re-request review。[CONTRIBUTING.md：Pull requests](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/CONTRIBUTING.md#pull-requests)、[PR template](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/pull_request_template.md)

## 7. CLA、DCO、签名与许可证

- 在本次核对的仓库树、`CONTRIBUTING.md`、`AGENTS.md` 和 PR template 中，没有 CLA、DCO、`Signed-off-by` 或 GPG/SSH commit 签名的提交要求；不要把这些写成既定门槛。若 GitHub 实际提交页出现组织级外部检查，再按该检查处理。[仓库树](https://github.com/gfx-rs/wgpu/tree/b991e6025d58b84df003e23102acea8440369131)、[CONTRIBUTING.md](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/CONTRIBUTING.md)、[PR template](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/pull_request_template.md)
- 工作区声明 `MIT OR Apache-2.0`，仓库同时包含 [MIT](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/LICENSE.MIT) 与 [Apache-2.0](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/LICENSE.APACHE)；不要引入许可证不兼容的复制代码。[Cargo.toml](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/Cargo.toml)
- CI 的 `cargo-deny` 会检查依赖 bans、licenses 和 sources；advisories 单独运行且明确不作为阻塞，但许可证/来源检查是正常 CI job。[CI cargo-deny jobs](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/workflows/ci.yml#L904-L938)
- `AGENTS.md` 还要求自动化 agent 不自行创建 commit。若由 agent 准备补丁，应把 working tree 交给人类/仓库操作者完成 commit 和 PR；这和 PR template 对 commit 质量的要求并不冲突。[AGENTS.md](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/AGENTS.md#workflow)

## 8. 预计会出现的 CI checks

PR/merge queue 当前会覆盖：

- 多平台/多 target/多 feature Clippy、build、docs，以及 `wgpu`/core MSRV 与 minimal-version 检查；
- Linux、macOS、Windows GPU test，全量 `cargo xtask test`，并重建核对 Naga snapshots；
- doctest、有限 Miri、Rust/Markdown/TOML 格式、typos；
- `cargo-deny`；
- 独立的 CTS matrix；
- 独立 shader validation，其中 Windows 同时跑 DXC 与 FXC。

对应的一手配置是 [CI](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/workflows/ci.yml)、[CTS](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/workflows/cts.yml)、[Shaders](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/workflows/shaders.yml) 和 [Changelog](https://github.com/gfx-rs/wgpu/blob/b991e6025d58b84df003e23102acea8440369131/.github/workflows/changelog.yml) workflows。

## 可直接复制的 PR 骨架

```markdown
**Connections**

Fixes #7443
Related to #4592 and #5521

**Description**

Naga emitted aggregate zero initialization for nested workgroup arrays. On
DXC this caused pathological alias-analysis time. Emit semantically equivalent
distributed/loop initialization for this HLSL shape instead.

This PR is intentionally limited to Naga's HLSL backend and nested arrays; it
does not revive the cross-backend design from #5521.

**Testing**

- Added a minimal WGSL snapshot reproducer and reviewed generated HLSL golden.
- `cargo nextest run --test naga snapshots`
- `(cd naga && cargo xtask validate hlsl dxc)`
- `(cd naga && cargo xtask validate hlsl fxc)`
- `cargo xtask test`
- `cargo xtask cts --backend dx12`
- DXC cold-compile benchmark: before …; after …; DXC version …; profile …

**Squash or Rebase?**

Ready to squash. / Each commit is independently CI-clean and ready to rebase.
```
