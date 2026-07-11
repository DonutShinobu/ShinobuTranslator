# 拆分 Content Core 与原生 DOM UI

## Goal

将页面生命周期、图片状态、翻译运行、阅读模式、截图控制器和原生 DOM UI 分离，降低 `TranslatorCore.ts` 与 `ui.ts` 的耦合，同时保持所有可见交互和动画行为。

## Requirements

- `TranslatorCore` 保持现有外部类入口，但只协调适配器、状态和 feature controllers。
- 图片状态缓存/URL 回收、Pipeline/Nano Banana 运行、阅读模式、截图/悬停翻译分别归属独立模块。
- `ui.ts` 按样式、图片控件、耗时/错误卡、阅读模式栏和截图浮层拆分。
- Content Script 继续使用原生 DOM，CSS class 保持 `mt-x-` 前缀。
- 保持图片/译图切换、翻译全部、截图拖放缩放、进度胶囊和调试下载行为。
- 保持 pipeline 动态 import 和点击后懒加载。

## Acceptance Criteria

- [x] `TranslatorCore` 不再直接实现下载、pipeline/cloud runner、截图几何和 UI 细节。
- [x] UI 子模块职责单一且不引入 React。
- [x] fake adapter/DOM 测试覆盖状态切换、URL 释放、重复点击、失败恢复和阅读模式。
- [x] 截图、UI、utils 既有测试继续通过，并新增控制器级行为测试。
- [x] 浏览器 UI jank smoke 无明显退化，完整 typecheck/test/build 通过。

## Dependencies

- 必须先完成 `07-11-engineering-quality-gates`。
- 与 Background 子任务通过稳定 `mt:*` 消息契约解耦。

## Out of Scope

- UI 视觉重设计。
- 将 Content Script 改为 React。
- 改变站点适配器接口或新增站点。

## Notes

- 拆分必须保持当前动画和可见交互，不以“功能仍能用”替代行为一致性验证。
