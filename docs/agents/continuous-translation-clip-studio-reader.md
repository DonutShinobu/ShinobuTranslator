# CLIP STUDIO READER 适配边界

- 状态：已实现
- 最近确认日期：2026-08-09
- 引擎 ID：`clip-studio-reader`

## 强指纹

适配器不绑定客户域名。只有以下证据同时成立才返回 strong detection：

- 页面加载 `csr-web-core.js`、`csr-web-player-hybrid.js` 或 `csrh-standard-viewer.js` 之一；
- 存在 `#stage > #screen_layer` 与至少一个 Canvas；
- 存在 `#menu_nombre_current` 和 `#menu_nombre_total`；
- Performance Resource Timing 中已观察到同一当前会话的 HTTPS diazepam 请求，至少包含 `mode` 与 `file` 参数。

上下文键由阅读器地址和已观察端点的规范化地址做非敏感摘要得到。`time` 等纯缓存参数不进入身份，授权参数不原样写入键、日志或文档。

## 页面模型与全量发现

当前实现只支持固定版式 `ContentType=3`：

1. 从当前会话已观察端点读取 `mode=7&file=face.xml`；
2. 解析物理页数、内容尺寸、Binding、StartPage、DoublePagesMap、BlankPagesMap 与扰码网格；
3. 按 CSR Web 的 single-page/spread 规则生成完整跨页列表；
4. 当前计数器映射到跨页，活动双缓冲 Canvas 作为当前页源；
5. “翻译全部”以跨页为逻辑目标，避免把同一 Canvas 错拆成两个不可独立导出的源。

当前页 XML 必须是单 Part。多 Part、非固定版式、无效排列或超过页数上限时明确返回/抛出 unsupported 或 invalid response，不退化为猜测页 URL。

## 页面准备

- 页 XML：`mode=8&file=NNNN.xml`
- 页二进制：`mode=1&file=NNNN_PPPP.bin`
- 所有请求沿用当前已授权 HTTPS 端点，只允许端点所在目录，不允许重定向。
- 二进制先交给现有受限图片下载器；恢复仅在内存 Canvas 中完成。
- CSR 扰码表按“目标格索引 → 来源格索引”移动，格宽高向下对齐 8 像素，边缘余量保留原图。
- 翻译输入只使用 `face.xml` 的固有内容尺寸：普通跨页合成为两个固有页单元，单独跨页合成为一个固有页单元；它不绑定准备时的活动 Canvas 或窗口尺寸。Binding 决定左右物理页，普通跨页分别向书脊中线对齐并保留外侧透明边距。
- 译图按比例 contain 到活动 Canvas 的实际绘制页框。Canvas DOM 外框覆盖阅读器视口，但 CSR 会在其内部按当前缩放级别、居中位置、单双页布局和菜单状态绘制非透明页面；适配器读取这一区域的 alpha 边界作为投影矩形，而不是把 Canvas DOM 外框或菜单元素位置当作页框。Canvas 像素不可读或尚未绘制时才回退到完整 Canvas 外框。几何变化只更新投影，不重新翻译。
- 每个译图投影记录所属跨页 key。原生页码发生变化时，CLIP observer 先移除与当前跨页不一致的投影，外层对 `navigation-state-changed` 立即同步当前页缓存译图或原图；结构、几何与渲染稳定信号仍保持防抖。
- `#screen_loading_spinner_layer` 进入公开的 `onstage` 加载状态时，原生页码仍可能停在旧页。适配器会立即撤下并暂停译图投影，让 CSR 加载动画保持可见；加载状态退出后再按公开页码恢复对应缓存译图。
- CSR 的原生 Canvas 可能先于公开页码切换，因此已翻译页面切换时仍可能短暂露出目标页原图。适配器不预测翻页方向，避免错误译图在未确认的目标页上持续重叠；公开页码更新后立即恢复正确投影。
- 不保存作品像素到仓库或测试夹具。

## 硬边界

- 不读取 CSR 私有 JavaScript 全局；
- 不注入页面脚本，不 Hook Canvas，不模拟翻页；
- 不扩大扩展权限；
- 缩放/平移由阅读器重绘时，observer 只负责重新协调几何和当前 revision，不能修改阅读器内部渲染方法。

## 2026-08-09 真实站点回归

- DREコミックス：<https://drecom-media.jp/drecomics/product/46>（固定 viewer 路径 `/viewer/p/46`）
- フランス書院：<https://www.france.jp/comics/92471>（免费第 1 话进入 CSR Hybrid）
- ComicFesta：<https://comic.iowl.jp/titles/219286>（免费试读进入 CSR Hybrid）

三个站点均确认：顶层 document、CSR 脚本、双缓冲 Canvas、当前/总页计数器、官方 face/page/bin 请求。自动测试只使用合成 XML 和排列，不包含作品图像。
