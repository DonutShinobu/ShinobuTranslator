# Content Core 与原生 DOM UI 拆分设计

## 1. 核心原则

`TranslatorCore` 保持页面级协调器身份，但不再实现资源下载、pipeline/cloud 执行、PhotoState 生命周期细节和各 UI 组件 DOM 构建。

## 2. 目标结构

```text
content/core/
├─ TranslatorCore.ts
├─ types.ts
├─ state/photoStateStore.ts
├─ translation/translationRunner.ts
├─ reading/readingModeController.ts
├─ screenshot/screenshotController.ts
├─ screenshot/overlayInteraction.ts
└─ ui/
   ├─ styles.ts
   ├─ imageControls.ts
   ├─ timingCard.ts
   ├─ errorCard.ts
   ├─ readingModeBar.ts
   └─ screenshotOverlay.ts
```

实际文件数以职责是否独立为准，避免把每个小函数都拆成文件。

## 3. 数据流

- Adapter observer -> TranslatorCore sync -> PhotoStateStore -> ImageControls render。
- UI action -> TranslatorCore/controller -> TranslationRunner -> runtime message/local dynamic pipeline -> state update -> render。
- Reading mode 和 screenshot controller 使用同一 TranslationRunner，但拥有独立 UI 生命周期。

## 4. 生命周期契约

- PhotoStateStore 负责 object URL 替换/释放、cache trim 和 dispose。
- Controller 负责 listener/timer/observer 的注册与 teardown。
- TranslationRunner 负责设置加载、图片下载、Nano Banana/local pipeline、progress/artifacts；不直接操作宿主 DOM。
- UI renderer 只根据 state 创建/更新 DOM，并维持 `mt-x-` class。

## 5. 兼容与性能

- 保持 pipeline 仅在用户动作后动态 import。
- 保持进度 animation/jank instrumentation、耗时卡和错误卡数据。
- 不改变 adapter 接口、截图坐标算法或可见文案。
- DOM 拆分不得增加全页 observer 或重复 render 频率。

## 6. 测试/回滚

使用 fake SiteAdapter、fake runtime message 和可控 URL API 测试状态机；UI 继续使用轻量 DOM 测试。按 state -> runner -> controllers -> UI -> core 收敛顺序提交。
