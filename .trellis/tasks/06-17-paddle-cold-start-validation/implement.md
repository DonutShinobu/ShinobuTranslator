# Paddle 冷启动验证实施计划

## Checklist

1. [x] 读取相关开发规范，确认 benchmark/frontend 层约束。
2. [x] 检查当前 benchmark 参数，找最小扩展点。
3. [x] 增加 Paddle prepare helper 和 benchmark-only OCR model override。
4. [x] 增加 small candidate 的 benchmark 路径，不恢复用户可见选项。
5. [x] 增加 WebGPU warmup/graph-capture 实验开关；当前 graph capture 因外部 GPU buffer 要求失败，记录为不进入产品化。
6. [x] 运行类型检查和必要单测。
7. [x] 运行 baseline 与候选 cold-start benchmark。
8. [x] 汇总 report 数据，给出是否进入产品实现的建议。

## Validation Commands

```bash
npm run models:check-paddle-ocr -- public/models/PP-OCRv6_medium_rec.onnx public/models/paddleocr_v6_dict.txt
npm run models:check-paddle-ocr -- public/models/PP-OCRv6_small_rec.onnx public/models/paddleocr_v6_dict.txt
npx tsc --noEmit --pretty false
npm run build
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3
```

已执行的 benchmark 命令：

```bash
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-prepare
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-model=small
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-model=small --paddle-prepare
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-fixed-width=320 --paddle-serial --paddle-warmup
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-fixed-width=320 --paddle-serial
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-model=small --paddle-fixed-width=320 --paddle-serial
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=1 --paddle-fixed-width=320 --paddle-serial --paddle-graph-capture
```

已通过：

- `npm run models:check-paddle-ocr -- public/models/PP-OCRv6_medium_rec.onnx public/models/paddleocr_v6_dict.txt`
- `npm run models:check-paddle-ocr -- public/models/PP-OCRv6_small_rec.onnx public/models/paddleocr_v6_dict.txt`
- `git diff --check`
- `npm run test`
- `npx tsc --noEmit --pretty false`
- `npm run test -- tests/shared/config.test.ts tests/pipeline/ocr/paddleocrDecode.test.ts`
- `npm run build`
- `node --check dist/content.js`
- `node --check dist/background.js`
- `node --check dist/chunks/orchestrator.js`
- `node --check dist/chunks/onnxWorkerBridge.js`
- `node --check dist/onnxWorker.js`

## Risky Files

- `src/pipeline/orchestrator.ts`：若触碰默认 runtime probe，必须保证 48px OCR 和 Paddle OCR 都能正确报告 runtime stage。
- `src/pipeline/ocr/paddleocrProvider.ts`：small/medium 复用 provider 时，避免恢复用户可见多选项。
- `src/runtime/modelRegistry.ts` / `public/models/models.json`：新增 small 注册时不得改变现有 medium 默认。
- `src/workers/onnx-worker.ts`：session options 实验必须隔离在 benchmark flag 下。
- `benchmark/perf/src/run-browser-x-compare.ts`：新增参数要保持现有报告兼容。

## Review Gate

进入实现前确认：

- 本任务只做验证/spike，默认产品行为保持 medium。
- 不做页面加载时预加载。
- 不改 detector。

## Implementation Notes

- 新增 `src/runtime/onnxSessionOptions.ts`，把 benchmark-only ONNX session 选项串到 worker session cache key。
- `paddleocrProvider` 支持 benchmark 全局 flag：model override、runtime prepare/warmup、固定输入宽度和 session options。默认产品路径仍是 `paddleocr_v6_medium_rec`。
- `orchestrator` 的 Paddle runtime probe 新增 `legacy | prepare | warmup` 三档；默认仍为 `legacy`，只有 benchmark 注入 flag 时使用 Paddle prepare/warmup。
- `run-browser-x-compare.ts` 新增 `--paddle-model`、`--paddle-runtime-probe`、`--paddle-prepare`、`--paddle-warmup`、`--paddle-fixed-width`、`--paddle-graph-capture`。

## Benchmark Results

Fixture: `benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png`

| Scenario | Report | Cold total | Cold OCR | Session | Inference | First inference | Warm total median | Warm OCR median | Sample |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| medium legacy | `x-current-2026-06-17T13-07-10-314Z.json` | 27.00s | 14.54s | 1.34s | 13.01s | `1x3x48x234`, 12.56s | 2.92s | 0.22s | `いろはっ! / 壁ドン！して / はあ？` |
| medium prepare | `x-current-2026-06-17T13-07-55-332Z.json` | 19.65s | 1.25s | 0.00s | 1.09s | `1x3x48x234`, 0.67s | 2.93s | 0.25s | `いろはっ! / 壁ドン！して / はあ？` |
| small legacy | `x-current-2026-06-17T13-08-27-200Z.json` | 14.10s | 8.46s | 0.36s | 8.00s | `1x3x48x234`, 0.42s | 1.73s | 0.16s | `いろはっ！ / 壁ドン！して！ / はあ？` |
| small prepare | `x-current-2026-06-17T13-09-03-359Z.json` | 19.36s | 1.13s | 0.00s | 0.98s | `1x3x48x234`, 0.69s | 2.98s | 0.24s | `いろはっ！ / 壁ドン！して！ / はあ？` |
| medium warmup fixed 320 serial | `x-current-2026-06-17T13-11-16-358Z.json` | 20.90s | 0.54s | 0.00s | 0.39s | `1x3x48x320`, 0.02s | 53.91s | 0.47s | `いろはっ! / 壁ドン！して / はあ？` |
| medium fixed 320 serial | `x-current-2026-06-17T13-12-47-229Z.json` | 14.17s | 8.40s | 0.80s | 7.50s | `1x3x48x320`, 7.33s | 1.73s | 0.21s | `いろはっ! / 壁ドン！して / はあ？` |
| small fixed 320 serial | `x-current-2026-06-17T13-13-35-629Z.json` | 14.39s | 8.81s | 0.43s | 8.26s | `1x3x48x320`, 0.34s | 1.83s | 0.22s | `いろはっ！ / 壁ドンーして!! / はあ？` |

Graph capture 结果：

- 命令：`--paddle-fixed-width=320 --paddle-serial --paddle-graph-capture`
- 结果：失败，无 report。
- 错误：`External buffer must be provided for input/output index 0 when enableGraphCapture is true.`
- 结论：当前 Paddle 路径用 CPU `Float32Array` 输入并把 logits 拉回 CPU 做 CTC decode，不满足 ORT WebGPU graph capture 的外部 GPU buffer 合约。除非后续重写 GPU 输入/输出 decode，否则不要产品化。

Warmup 备注：

- `medium warmup fixed 320 serial` 把 cold OCR 降到 0.54s，但 cold total 仍有 20.90s。
- 同组两个 warm run 的 detect 阶段异常变成 52.11s / 40.88s，说明 warmup/固定 shape 会引入明显的 WebGPU/worker 调度风险。该路线不建议进入默认产品路径。

## Recommendation

1. 优先进入产品验证的路线：`PP-OCRv6_small_rec` 作为可选/实验候选，而不是默认直接替换。它把 cold total 从 27.00s 降到 14.10s，warm total median 从 2.92s 降到 1.73s，且样本文本总体可接受。
2. 可以保留并进一步验证的辅助路线：Paddle `prepare`。它能把 cold OCR 从 14.54s 降到 1.25s，但 cold total 仍为 19.65s，说明成本被提前到 detect/bubble 窗口并存在资源争用；若产品化，应只在用户点击翻译后触发，并用更多图片确认净收益。
3. 不推荐产品化：固定 320 + warmup、graph capture。前者 OCR 很快但端到端和 warm detect 抖动差；后者当前架构不满足外部 GPU buffer 要求。

## Follow-up Candidates

- 增加 `small` 的多图片质量回归，覆盖复杂字体、小字、斜排、气泡外文字。
- 若要产品化 prepare，需要单独 benchmark `prepare` 与 detector/bubble 的并发策略，避免单例 ONNX worker 抢占检测。
- 若未来尝试 graph capture，应先设计 GPU external input/output 和 CTC decode/readback 边界，再接 ORT `enableGraphCapture`。
