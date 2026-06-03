# 实施计划：优化截图翻译选区与药丸状态

## 检查清单

1. 阅读截图相关代码并确认当前 build 状态。
2. 在 `src/content/core/screenshot.ts` 新增可测试的元素候选工具：
   - 元素矩形转 `ScreenshotRect`
   - 候选过滤和去重
   - 根据滚轮方向切换层级
3. 更新 `tests/content/core/screenshot.test.ts`：
   - 覆盖候选去重/过滤
   - 覆盖向上滚到更大元素、向下滚到更小元素
   - 保留现有裁剪和归一化测试
4. 重构 `src/content/core/ui.ts` 的截图选择 UI：
   - 移除顶部提示和右上角取消按钮 DOM/CSS
   - 支持鼠标移动自动元素选区
   - 支持滚轮层级切换
   - 保留手动拖拽框选和 `Esc` 取消
   - 自动点击和手动松手后进入待确认状态
   - 待确认状态支持 8 向不可见热区调整大小、选区内部拖动、亮色药丸内的 lucide 风格对勾确认、叉号重新框选、双击确认；热区至少覆盖深灰粗描边
   - 确认/重选两个圆形按钮 hover 时圆圈加深
   - 截图框线改为超粗深灰线，无白色外描边，视觉圆角不改变实际矩形
   - 非选中区域遮罩加深
5. 重构截图结果 UI：
   - 移除 `.mt-x-screenshot-status` 中央状态面板
   - 改为药丸控制器 + 药丸右上角小 `x` + 浮动图片
   - 缩小药丸右上角小 `x` 和内部图标占比，并让它更贴近药丸，使用 lucide 风格 SVG，图标为描边深灰，hover 时整颗按钮暗化
   - 截图前显示同尺寸占位，截图前短暂隐藏避免被捕获
   - 裁剪完成后运行/失败期间显示原图，成功后同一 `<img>` 切换为译图
   - 失败状态沿用原药丸按钮的重试与详情语义
   - 成功态仅在存在 `elapsedText` 时显示详情行；未开启耗时/调试选项时不显示“翻译完成”小字
6. 更新 `src/content/core/TranslatorCore.ts`：
   - 抽出 `translateScreenshotSelection(selection)`
   - 将截图 pipeline 进度渲染到药丸
   - 成功后展示浮动译图
   - 关闭时统一移除药丸和图片，释放状态
   - 拖动作用于整个结果组
7. 更新右键“翻译图片”分流：
   - `img` 目标生成 `ScreenshotSelection`，复用截图浮动结果流程
   - 非 `img` 目标生成 `ScreenshotSelection`，复用截图浮动结果流程
   - 移除旧的右键替换原 DOM 图片路径
8. 确认右键菜单仍同时注册“翻译图片”和“截图翻译”。
9. 运行验证命令并修复问题。

## 验证命令

```bash
npx tsc --noEmit
npm run test
npm run build
```

## 风险文件

- `src/content/core/ui.ts`：截图 UI 和原药丸 UI 同文件，改动时要避免影响普通图片翻译、右键图片翻译和 Pixiv 阅读模式底栏。
- `src/content/core/TranslatorCore.ts`：截图生命周期清理和 `PhotoState` 复用在这里，最容易引入 object URL 泄漏或残留 DOM。
- `src/content/index.ts`：右键目标捕获发生在页面事件和后台菜单消息之间，需要保留最近一次右键选区。
- `src/background/index.ts`：右键菜单 context 设置会影响菜单可见性。

## 完成检查

- 手动加载 `dist` 扩展，在截图翻译分支测试至少一个图片元素和一个容器元素。
- 确认关闭后页面没有残留选区、药丸、图片或拖动监听带来的异常。
- 确认普通适配器自动药丸的视觉和交互未回退。
