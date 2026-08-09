# 连续翻译模式：BinB Speed Reader 适配规范

- 状态：已实现
- 确认日期：2026-08-09
- 适用入口：阅读模式中的“翻译当前页 / 翻译全部”

本文是 BinB Speed Reader 适配的结构事实与安全边界来源。通用契约见 [`continuous-translation-reader-engines.md`](./continuous-translation-reader-engines.md)。

## 1. 支持范围

- 支持固定版式 Speed Reader 的 `ServerType` 0（SBC）、1（Direct）和 2（REST）。
- 支持 `ViewMode` 1、2、3；同一份协议夹具覆盖九种组合。
- 支持当前会话清单中的正文图片页；“翻译全部”最多处理 200 页，超过上限时明确失败。
- 不支持 Standard iframe 阅读器、旧式静态 `.ptimg.json`、文字重排版或未知拼图表型。
- 不绕过登录、购买或授权，不枚举会话外清单，不移除水印；仅使用页面当前会话能够正式读取的内容。

## 2. 检测与页面身份

检测必须同时满足 Speed Reader 根结构、当前内容容器、同源内容入口以及 `content-pN` 页面槽位等强指纹，不能仅凭站点域名、单个 class 或脚本版本号命中。

稳定页面身份为：

```text
binb:<cid>:<reader origin + path>:page:<physical ordinal>
```

`cid` 和阅读器 URL 组成 context key，去重后的物理页序号组成页身份。`P`/`L` 标识、DOM id、CDN 文件名和图片 URL 都不是稳定状态身份。

`content-pN` 仅是当前 DOM 槽位到清单物理序号的运行时桥接信息，用于判断可见页和投影目标；它不能单独进入持久状态。在 `P`/`L` 双页条目共用同一 TTX 时只登记第一个 `t-case`，确保同一物理页不重复翻译。

## 3. 内容协议与信任边界

适配器通过扩展后台读取当前会话公开的元数据和内容资源，不读取页面私有全局变量，不 monkey patch 页面函数。

- 元数据、内容和图片地址必须为 HTTPS。
- 每次请求固定在元数据声明的 origin 与 base path 内；初始 URL 和最终 URL 都要校验。
- 受约束请求禁用重定向，跨 origin、越过 base path、非 HTTPS、超时或超限响应均失败关闭。
- 三种后端由独立的类型化 loader 负责请求与响应格式；未知 `ServerType`、`ViewMode`、`ImageClass` 或拼图表型不得猜测降级。

## 4. 图片准备与恢复

内容客户端解析 TTX 页清单和 A/F 拼图表。图片按照阅读器实际选择的质量读取：先匹配当前会话已经加载的资源地址，再以显示尺寸作保守回退。原图下载和 PNG 恢复都只在内存中完成，恢复后的 `File` 通过 `prepared-file` 进入现有图片翻译执行链路。

元数据或内容首次读取失败时只强制刷新一次；图片 token 失效时也只刷新清单一次。刷新后必须确认 context key 未变且目标物理序号仍存在，否则终止旧任务。懒加载重建槽位或修改尺寸后，observer 必须重新同步译图投影，并在切回原图或销毁会话时清理 object URL 与 observer。

## 5. 验证

常规测试不得访问网络，使用合成协议响应和像素矩阵验证：

- 三种后端 × 三种 ViewMode；
- TTX 解析、P/L 去重、200 页上限与页面身份；
- A/F 拼图逐像素精确恢复；
- URL 信任边界、重定向失败关闭、初始读取与图片 token 的单次刷新；
- 当前页/全部、原图/译图、质量跟随、懒加载重投影和会话销毁。

显式真实冒烟由 `BINB_LIVE_SMOKE=1 npm run bench:browser-binb-smoke` 触发，当前矩阵为 Comic Cmoa（SBC）、BookLive（Direct）与讲谈社试读（REST）。冒烟只在内存中读取首张图片并验证清单、尺寸和拼图计划，不保存内容。
