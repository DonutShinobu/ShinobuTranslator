# 横排排版重点观察集

这个目录用于单独收集和复现横排排版案例，不与默认竖排 fixture、图片和报告混用。

## 目录

- `images/`：原始漫画图片，仅放需要重点观察横排表现的样本。
- `fixtures/`：由 bake 命令生成的 fixture JSON。
- `reports/`：浏览器渲染图、debug JSON、overlay 和评分报告。
- `baseline.json`：可选的横排观察集基线，由 `bench:baseline` 生成。

图片、fixture 和报告默认只保存在本机；目录中的 `.gitignore` 会阻止这些大文件被误提交。

## 命令

所有排版 benchmark 命令都接受统一的 suite 根目录：

```bash
npm run bench:bake -- --suite-dir benchmark/typeset/horizontal --direction all
npm run bench:bake-node -- --suite-dir benchmark/typeset/horizontal --direction all
npm run bench:audit-fixtures -- --suite-dir benchmark/typeset/horizontal
npm run bench:render -- --suite-dir benchmark/typeset/horizontal
npm run bench -- --suite-dir benchmark/typeset/horizontal
npm run bench:diff -- --suite-dir benchmark/typeset/horizontal
```

`--suite-dir` 自动映射到其下的 `images/`、`fixtures/`、`reports/` 和 `baseline.json`。需要时仍可用 `--images-dir`、`--fixtures-dir`、`--reports-dir` 覆盖单个目录；bake 命令继续兼容 `--out-dir`。

两个 bake 命令都接受 `--direction all|h|v`：

- `all`（默认）：同时保留横排和竖排区域，适合观察混排检测结果。
- `h`：只生成横排区域，适合本目录的横排专项回归。
- `v`：只生成竖排区域，适合与历史竖排 fixture 对照。

参数既支持 `--direction h`，也支持 `--direction=h`。fixture 的 `bakedWith.direction` 会记录本次选择，便于区分报告来源。

当前 `bench:render` 的渲染图、overlay 和 debug log 可直接用于观察横排表现。现有 `bench` 数值评分仍以竖排列几何为主，横排区域会标记为 skipped；在增加横排行盒指标前，不应把其零值当成横排质量结论。
