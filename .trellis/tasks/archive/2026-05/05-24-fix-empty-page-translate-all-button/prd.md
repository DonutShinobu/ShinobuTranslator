# 修复无内容页面导致翻译全部按钮不切换

## 问题

Pixiv 阅读模式翻译全部页面时，若某页未检测到文本（"未找到文本"），pipeline 抛出异常，`translatePageByUrl` 将其标记为 `error` 状态且不设置 `translatedUrl`。`renderReadingModeBar` 检查 `allPageUrls.every(u => s?.translatedUrl)` 因此失败，按钮永远显示"翻译全部"，不会切换为"显示原图/显示译图"。

## 修复

在 `translatePageByUrl` 中，当错误消息为"未找到文本"时，将原图 URL 作为 `translatedUrl`，标记状态为 `translated` 而非 `error`。无内容的页面显示原图即可。
