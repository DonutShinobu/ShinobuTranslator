# Benchmark Development Guidelines

> 测试框架和基准测试的开发指南。

---

## Overview

项目在 `benchmark/` 下有两套基准测试基础设施：

1. **排版基准测试** — `benchmark/typeset/`，竖排排版几何精度回归测试（`run-bench.ts`, `bake-fixtures.ts` 等）
2. **颜色诊断与对比测试** — `benchmark/color/`，OCR 文字前景/背景色识别的诊断 + 量化对比框架（`color-diagnostic.ts`, `color-comparison.ts` 等）

1. **排版基准测试** — 竖排排版几何精度回归测试（`run-bench.ts`, `bake-fixtures.ts` 等）
2. **颜色诊断与对比测试** — OCR 文字前景/背景色识别的诊断 + 量化对比框架（`color-diagnostic.ts`, `color-comparison.ts` 等）

两者都运行在 Node.js 环境下，使用 `@napi-rs/canvas` 模拟 Canvas，`tsx` 作为运行器。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Color Diagnostic Guide](./color-diagnostic-guide.md) | 颜色识别算法诊断与对比框架使用说明 | Filled |

---

## Key Architecture Facts

- **Benchmark 脚本运行在 Node.js** — 不依赖浏览器环境，使用 `@napi-rs/canvas` 替代 DOM Canvas
- **运行方式** — `tsx benchmark/typeset/src/*.ts` / `tsx benchmark/color/src/*.ts`，或通过 `package.json` 中的 npm scripts
- **Fixture 数据** — JSON 注解文件 git 追踪，实际图片文件 gitignore（用户手动添加）
- **报告输出** — `benchmark/reports/` 目录，gitignore，每次运行生成带时间戳的子目录
- **颜色工具函数** — `color-utils.ts` 从 `src/pipeline/typeset/color.ts` 重新导出 `rgbToLab`/`colorDistance`/`resolveColors`，不直接引用浏览器端代码（避免 ONNX Runtime 等浏览器依赖）

---

## Pre-Development Checklist

Before modifying benchmark scripts, verify:

- [ ] `tsx` 可用（`package.json` devDependencies）
- [ ] `@napi-rs/canvas` 已安装（Node.js Canvas 模拟）
- [ ] Fixture 注解格式与 `color-types.ts` 中的类型定义一致
- [ ] 新算法实现不修改浏览器端 `src/pipeline/` 代码（仅建立测试框架）
- [ ] 重复逻辑提取到 `color-utils.ts`（共享工具优于各脚本内复制）
- [ ] 颜色算法脚本放在 `benchmark/color/src/`，排版脚本放在 `benchmark/typeset/src/`

---

## Quality Check

After modifying benchmark scripts, verify:

- [ ] `tsc --noEmit` 通过（TypeScript 类型检查）
- [ ] `vitest run` 全部通过（包括 `tests/benchmark/color-alg-diagnostic.test.ts`）
- [ ] 脚本可端到端运行（即使 fixture 图片缺失，也应优雅处理而非 crash）
- [ ] `import type` 用于类型导入，`type` 用于数据类型定义
- [ ] 无 `any` 类型

---

**Language**: Documentation written in **Chinese** (matching user-facing tool output).