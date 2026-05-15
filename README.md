# ShinobuTranslator

浏览器中的漫画翻译扩展——在 X/Twitter 和 Pixiv 上一键翻译漫画图片。

全部流程在本地完成：文本检测 → OCR → 翻译 → 去字 → 排版，无需自建服务器，支持原图/译图切换。

## 效果图

<table>
<thead>
<tr>
<th align="center" width="50%">原始图片</th>
<th align="center" width="50%">翻译后图片</th>
</tr>
</thead>
<tbody>
<tr>
<td align="center" width="50%"><a href="https://user-images.githubusercontent.com/31543482/232265329-6a560438-e887-4f7f-b6a1-a61b8648f781.png"><img src="https://user-images.githubusercontent.com/31543482/232265329-6a560438-e887-4f7f-b6a1-a61b8648f781.png"></a><br>(<a href="https://twitter.com/09ra_19ra/status/1647079591109103617/photo/1">Source @09ra_19ra</a>)</td>
<td align="center" width="50%"><a href="docs/translated1.png"><img src="docs/translated1.png"></a><br>译图</td>
</tr>
<tr>
<td align="center" width="50%"><a href="https://user-images.githubusercontent.com/31543482/232265794-5ea8a0cb-42fe-4438-80b7-3bf7eaf0ff2c.png"><img src="https://user-images.githubusercontent.com/31543482/232265794-5ea8a0cb-42fe-4438-80b7-3bf7eaf0ff2c.png"></a><br>(<a href="https://twitter.com/rikak/status/1642727617886556160/photo/1">Source @rikak</a>)</td>
<td align="center" width="50%"><a href="docs/translated4.png"><img src="docs/translated4.png"></a><br>译图</td>
</tr>
</tbody>
</table>

## 使用方式

### 安装（Chrome / Edge）

1. 前往 [Releases](../../releases) 下载压缩包并解压到本地文件夹
2. 打开浏览器扩展管理页，启用**开发者模式**
3. 选择「加载已解压的扩展程序」，目录指向解压出来的文件夹
4. 打开 X/Twitter 或 Pixiv 图片大图页面，点击翻译按钮即可

### 翻译设置

扩展弹出页面提供以下配置：

- **翻译服务**：Google 翻译（大模型翻译有做过优化，效果更好一些）或大模型翻译
- **大模型提供商**：DeepSeek / GLM / Kimi / MiniMax / MiMo / 自定义
- **目标语言**：简体中文 / 繁体中文

使用大模型翻译时，需在设置中填写对应提供商的 API Key。

## 碎碎念

本项目灵感源于 https://github.com/zyddnys/manga-image-translator 和 https://greasyfork.org/scripts/437569

其中的油猴脚本似乎因为服务器问题无法继续使用，于是决定在不依赖个人服务器的情况下实现一个效果类似的拓展

## 许可证与第三方声明

- 本项目许可证：`GPL-3.0`（见根目录 `LICENSE`）
- 第三方模型与脚本处理说明：见 `THIRD_PARTY_NOTICES.md`