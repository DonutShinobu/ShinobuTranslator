# 实施计划：快捷键与非线性动画

## 实施清单

1. 更新 Chrome 类型与消息类型
   - 在 `src/shared/chrome.ts` 增加 `commands.getAll`、`commands.onCommand`、`tabs.create` 所需类型覆盖。
   - 在 `src/shared/messages.ts` 增加 `mt:shortcut-translate-hover` 消息和响应类型。

2. 声明浏览器级快捷键
   - 在 `public/manifest.json` 新增 `commands`。
   - `start-screenshot-translate` 默认 `Alt+Q`。
   - `translate-hover-target` 默认 `Alt+W`。

3. 接入 background 命令转发
   - 在 `src/background/index.ts` 初始化时监听 `chrome.commands.onCommand`。
   - 将两个命令转发到触发命令所在 tab。
   - 发送失败时吞掉错误，与右键菜单现有 best-effort 行为一致。

4. 实现悬停目标翻译
   - 在 `src/content/index.ts` 记录最近鼠标位置。
   - 抽出可复用目标收集逻辑，复用右键候选过滤规则。
   - `mt:shortcut-translate-hover` 触发时从当前悬停点生成目标。
   - 图片元素走 `translateImageInFloatingOverlay()`；非图片元素走 `translateScreenshotSelection()`。
   - 找不到有效目标时显示中文轻量提示。

5. 增加 popup 快捷键区域
   - 在 `src/popup/App.tsx` 读取 `chrome.commands.getAll()`。
   - 显示“截图翻译 Alt+Q / 未绑定”和“翻译悬停元素 Alt+W / 未绑定”。
   - 添加“管理快捷键”按钮，打开 `chrome://extensions/shortcuts`。
   - 在 `src/popup/styles.css` 补充紧凑样式，保持现有 popup 信息密度。

6. 增加截图元素候选切换动画
   - 在 `src/content/core/ui.ts` 的样式里给元素模式选区框添加非线性 transition。
   - 确保手动框选、确认态移动和 resize 不启用过渡。

7. 增加浮动译图缩放动画
   - 在 `TranslatorCore.attachScreenshotResultZoom()` 中滚轮时临时添加 zooming 类。
   - 使用计时器在最后一次滚轮后移除类。
   - 清理函数移除事件监听时也清理计时器和类。

8. 测试与验证
   - 更新或补充 `tests/shared/messages.test.ts` 覆盖新消息类型。
   - 视实现拆分情况补充 `tests/content/core/screenshot.test.ts` 或 `tests/content/core/ui.test.ts` 的可测试工具函数。
   - 运行 `npx vitest run tests/shared/messages.test.ts tests/content/core/screenshot.test.ts tests/content/core/ui.test.ts`。
   - 运行 `npm run build`。

## 重点风险文件

- `src/content/index.ts`：右键目标和悬停目标必须分离，避免快捷键消费最近右键目标。
- `src/background/index.ts`：命令监听需要和现有 context menu 初始化共存。
- `src/popup/App.tsx`：popup 自动保存设置已较多，快捷键读取不应触发设置保存。
- `src/content/core/ui.ts`：选区动画不能影响最终截图矩形。
- `src/content/core/TranslatorCore.ts`：缩放动画不能影响拖拽和关闭清理。

## 回滚点

- 如 Chrome commands 触发异常，可只移除 manifest `commands` 和 background `onCommand` 监听，右键菜单与截图菜单不受影响。
- 如动画影响交互手感，可保留快捷键实现，移除新增 transition / zooming 类和相关计时器。

## 验证命令

```bash
npx vitest run tests/shared/messages.test.ts tests/content/core/screenshot.test.ts tests/content/core/ui.test.ts
npm run build
```
