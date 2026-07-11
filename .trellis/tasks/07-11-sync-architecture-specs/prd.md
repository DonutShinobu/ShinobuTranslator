# 同步架构规范与项目说明

## Goal

在全部实现型子任务完成后，使 AGENTS、Trellis 目录规范、模型事实源、Worker 构建和测试布局说明与真实代码一致。

## Requirements

- 更新 `AGENTS.md` 中错误的模型清单路径。
- 更新 `.trellis/spec/frontend/directory-structure.md` 的实际目录、E-Hentai、Paddle OCR、独立 Worker 构建和集中式 tests 说明。
- 记录最终 Typeset、Background、Content、benchmark entry 和 OCR/Worker 边界。
- 记录当前只支持 Paddle OCR runtime，并说明历史 AR 转换脚本位于 `scripts/legacy/`、不属于生产构建。
- 仅记录已实现且已验证的约定，不提前描述计划中的未来结构。

## Acceptance Criteria

- [x] 文档列出的关键路径全部存在，入口和命令可执行。
- [x] 不再引用 `public/models/manifest.json`、旧 OCR 主路径或错误 Worker 构建方式。
- [x] 规范与最终代码/测试布局一致。
- [x] 文档变更通过 `git diff --check`。

## Dependencies

- 依赖所有实现型子任务完成；必须最后执行。

## Out of Scope

- 重写历史 Trellis 归档任务或旧 Superpowers 设计文档。

## Notes

- 本任务为轻量文档同步任务，可保留 PRD-only。
