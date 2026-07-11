# Legacy OCR 调用审计与验证记录

## 结论

当前产品 OCR 路径只有 `paddleocr_v6_medium`：`src/pipeline/ocr/index.ts` 把历史设置值归一化到该 provider，模型清单只注册 `paddleocr_v6_medium_rec`。旧 48px 自回归（AR）OCR 没有产品调用方，也没有可独立运行且仍受支持的 benchmark，因此不建立 legacy Worker，直接从生产 runtime 删除。

## 调用分类

| 能力 | 清理前定义/入口 | 调用分类 | 处理 |
| --- | --- | --- | --- |
| `runOcrBatchDecode` | Unified/Browser/Node Bridge、Worker API/实现 | historical-only | 删除 RPC、transport、实现和测试 |
| `runOcrSplitBatchDecode` | Unified/Browser/Node Bridge、Worker API/实现 | historical-only | 删除 RPC、encoder/decoder 特例和实现 |
| `runOcrSingleDecode` | Unified/Browser/Node Bridge、Worker API/实现 | historical-only | 删除 beam fallback RPC 和实现 |
| `runOcrColorBatch` / `runOcrColorSingle` | Unified/Browser/Node Bridge、Worker API/实现 | historical-only | 删除依赖 AR 输出的颜色 RPC 和实现 |
| `decodeAutoregressive.ts` | 仅被上述旧 RPC、旧测试引用 | historical-only | 删除 |
| `gpuArgmax.ts` | 仅被 AR decode 和占位 benchmark 引用 | historical-only | 删除 |
| `color.ts` / `colorDecodeShared.ts` | 仅服务旧 AR token color head | historical-only | 删除；当前 Paddle 使用 `colorSampling*` |
| `bench:ocr-gpu-argmax` | 三行占位 runner | historical-only | 删除命令和入口 |
| `bench:browser-x-compare` / `bench:browser-x-current` | 旧多模式 compare runner | historical-only | 删除命令和 compare 分支；保留单一路径 `bench:browser-paddle-profile` |
| AR 导出、拆图及旧 Lama patch | 手工模型转换脚本 | historical reference | 移至 `scripts/legacy/`，不接入 npm/Vite/CI |
| Paddle provider、CTC decode、颜色采样 | `paddleocrProvider.ts`、`paddleocrDecode.ts`、`colorSampling*` | product | 保留并通过浏览器/Node 验证 |
| detector GPU preprocess、session lifecycle、runtime self-check | 现有 Worker API | product | 保留，并由 Worker contract 测试固定 |

生产回归保护位于 `tests/runtime/onnxWorkerContract.test.ts` 和 `scripts/check-release-boundaries.mjs`：源码/Release 产物若重新出现旧 RPC、AR decode、旧模型名或旧输出名会直接失败。

## 保留的历史材料

- 历史性能报告继续留在 `benchmark/perf/reports/`，没有改写或删除已有 tracked JSON。
- `benchmark/perf/ocr-cold-start-experiments-2026-06-13.md` 保留。
- `builtin`、`48px`、`paddleocr_v6_small` 等设置兼容 alias 仍归一化到 `paddleocr_v6_medium`；只删除 benchmark CLI 对这些名称的主动支持。
- 三个仍有追溯价值的转换脚本保存在 `scripts/legacy/`，约束见同目录 README。

## Bundle 对比

同一分支、同一依赖环境下执行 Release build：

| 产物 | 清理前 | 清理后 | 变化 |
| --- | ---: | ---: | ---: |
| `dist/onnxWorker.js` | 883,459 B | 855,969 B | -27,490 B（-3.11%） |
| `dist/chunks/onnxWorkerBridge.js` | 约 9.03 kB | 7,167 B | 下降约 1.86 kB |

清理后的 Release 产物中，5 个旧 RPC 名、`decodeAutoregressive`、`gpuArgmax`、`ocr_encoder`、`ocr_decoder` 和 `fg_ind` 的命中数均为 0。

## OCR 验证对比

所有数据来自同一台开发机；耗时受 WebGPU/CPU warm-up 影响，只用于确认没有明显回归，质量与结构结果优先。

| 场景 | 清理前 | 清理后 | 结论 |
| --- | --- | --- | --- |
| 浏览器 OCR smoke | WebGPU；输出 `[1, 40, 18710]`；字典 18,708；检查通过 | 完全相同 | 模型/字典契约未变 |
| 浏览器 Paddle profile | 17 regions / 119 chars；样例 `わたし / 天 / わす`；warm median total 1.40 s、OCR 337 ms、CTC decode 156 ms | 同为 17 / 119、相同样例；warm median total 965 ms、OCR 200 ms、CTC decode 80 ms | 无质量或数量回归；耗时波动方向为改善 |
| Paddle 执行细节 | WebGPU；32 px width bucket；7 inference runs | 完全相同 | provider/batch 策略未变 |
| Node OCR benchmark | CPU；14 detected / 14 OCR；accepted 14、rejected 0；OCR 1,241.90 ms | 数量与前五条文本/颜色完全相同；OCR 1,185.54 ms | 无质量或数量回归 |
| Node 关键分段 | inference 633.70 ms；color 84.28 ms | inference 550.34 ms；color 69.19 ms | 无明显性能回归 |

Node 前五条识别文本在清理前后均为：`いろはっ！`、`して`、`壁ドン!`、`はあ？`、`そんな`。

## 验证命令

- `npm run typecheck`
- `npx vitest run tests/runtime/onnxWorkerContract.test.ts tests/shared/config.test.ts tests/pipeline/ocr/decode.test.ts tests/pipeline/ocr/paddleocrDecode.test.ts tests/pipeline/ocr/provider.test.ts tests/pipeline/ocr/colorSampling.test.ts`
- `npm run build`
- `npm run bench:browser-ocr-smoke`
- `npm run bench:browser-paddle-profile`
- `npm run bench:ocr-debug -- --ocr-engine=paddleocr_v6_medium`
- 最终集成门禁：`npm run check`
