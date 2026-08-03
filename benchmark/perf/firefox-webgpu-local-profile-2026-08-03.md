# Firefox WebGPU 本机细粒度耗时分析（2026-08-03）

## 结论

本次只使用本机运行、项目源码、随项目安装的 ONNX Runtime Web 1.24.1 和用户提供的诊断日志，没有使用网络资料。

Firefox 的长耗时不是一个单点问题，而是三个已经被本机实验区分开的层次：

1. **扩展任务之间会丢失内存态的 PipelineHost、Worker 和 ONNX Session。** Firefox 的宿主当前创建在非持久 background event page 内。event page 被浏览器卸载后，代码中的“五分钟空闲释放”计时器也随上下文一起消失，下一次任务重新走完整冷启动。
2. **冷启动主要慢在各模型第一次 `run()` 的 WebGPU pipeline/shader 编译及完成等待，而不是模型下载或 Session 创建。** 同一张图中，Firefox 首次执行约 19.45 秒，Chromium 约 4.56 秒；Firefox 的 Session 创建只解释其中一小部分，第一次执行解释绝大部分差距。
3. **Session 保持存活后的热路径，主要慢在每次 GPU→CPU 输出回读的固定等待。** OCR 的 GPU kernel 本身合计约 85 ms，但八次推理的墙钟时间约 806–816 ms。约 720 ms 消耗在 kernel 之外的队列完成、buffer copy、`mapAsync()` 完成通知及相关浏览器/驱动调度。

所以，Firefox 确实在使用 WebGPU；长耗时不能用“实际回退到了 WASM”解释。

## 测试条件

- 输入页面：`https://x.com/ganaishoten/status/2084120226925629443/photo/1`
- 原图：900 × 1300，597,040 bytes
- 模型输出：两端均为 17 个区域、151 个字符
- 浏览器：项目 Playwright Chromium 145、Firefox 146
- 正式浏览器对照日志：Firefox 153，扩展 0.8.1
- Provider：强制 WebGPU
- 处理模式：`erase`
- 热路径比较使用相同临时探针、相同构建、同一台机器、同一张图

## 热路径：阶段级结果

同一浏览器进程、同一 Worker、同一批 Session 的第二次运行：

| 阶段 | Firefox | Chromium | Firefox / Chromium |
|---|---:|---:|---:|
| 总计 | 1817.38 ms | 547.69 ms | 3.32× |
| 检测 | 395.28 ms | 135.92 ms | 2.91× |
| 气泡检测 | 187.66 ms | 56.25 ms | 3.34× |
| OCR | 882.42 ms | 177.31 ms | 4.98× |
| 排序 | 97.76 ms | 64.62 ms | 1.51× |
| 遮罩细化 | 44.86 ms | 33.05 ms | 1.36× |
| 去字 | 193.10 ms | 77.19 ms | 2.50× |

模型边界额外耗时约 1.23 秒，解释了两端热路径总差距的约 97%。CPU 预处理、CTC 解码、排序和遮罩细化不是主要矛盾。

## 热路径：GPU kernel 与墙钟时间分离

通过 ORT WebGPU timestamp profiling，把 GPU 执行时间与 JavaScript 观察到的等待时间分开：

| 模型 | Firefox GPU 时间 | Firefox 墙钟时间 | Chromium GPU 时间 | Chromium 墙钟时间 |
|---|---:|---:|---:|---:|
| detector | 67.34 ms | 约 331 ms | 51.05 ms | 约 65 ms |
| bubble | 7.26 ms | 约 180 ms | 4.14 ms | 约 16 ms |
| OCR（8 次合计） | 约 85.10 ms | 约 806 ms | 约 40.01 ms | 约 85 ms |
| inpaint | 76.55 ms | 约 123 ms | 33.13 ms | 约 39 ms |

Firefox 的纯 kernel 仍比 Chromium 慢约 1.3–2.3 倍，但这不足以解释 OCR 约 9.5 倍的模型调用墙钟差距。OCR 中约 721 ms 是 kernel 之外的等待。

## OCR 输出回读证据

这张图经过 width bucket 后产生 8 次 OCR 推理，总输出 54.53 MiB。各次结果必须回到 CPU 才能执行 CTC 解码。

| 输出大小 | Firefox | Chromium |
|---:|---:|---:|
| 8.56 MiB | 79.04 ms | 13.03 ms |
| 11.42 MiB | 109.22 ms | 12.93 ms |
| 9.14 MiB | 100.94 ms | 13.19 ms |
| 14.27 MiB | 106.70 ms | 15.35 ms |
| 4.00 MiB | 94.74 ms | 8.75 ms |
| 0.86 MiB | 104.92 ms | 7.73 ms |
| 1.14 MiB | 108.64 ms | 7.25 ms |
| 5.14 MiB | 111.52 ms | 9.47 ms |

输出大小与单次耗时的 Pearson 相关系数：

- Firefox：**-0.069**
- Chromium：**0.976**

Firefox 中 0.86 MiB 与 14.27 MiB 都落在约 95–112 ms，说明瓶颈不是显存复制吞吐，而是每次回读的固定完成/调度延迟。Chromium 的耗时则随输出量正常增长。

本地 ORT 1.24.1 源码中的实际链路为：

1. 输出在 CPU 时，WASM bridge 调用 WebGPU backend 的 `download()`。
2. backend 创建 `MAP_READ | COPY_DST` staging buffer。
3. `copyBufferToBuffer()` 后立即 `queue.submit()`。
4. 等待 `gpuReadBuffer.mapAsync(GPUMapMode.READ)`。
5. 映射成功后才把数据写回 WASM heap，`session.run()` 才能完成。

相关实现位于：

- `node_modules/onnxruntime-web/lib/wasm/jsep/init.ts:234`
- `node_modules/onnxruntime-web/lib/wasm/jsep/webgpu/gpu-data-manager.ts:149`
- `node_modules/onnxruntime-web/lib/wasm/jsep/backend-webgpu.ts:333`

把 OCR 输出改成 `preferredOutputLocation: "gpu-buffer"` 后，等待从 `session.run()` 移到了后续 `tensor.getData()`，总耗时没有实质变化；文本、区域数和字符数保持一致。这排除了“只调整 ORT 输出位置即可消除等待”的假设。

## 冷路径

相同探针下的首次运行：

| 浏览器 | 总耗时 | preload | detect | bubble | OCR | inpaint |
|---|---:|---:|---:|---:|---:|---:|
| Firefox | 19.45 s | 2.92 s | 5.43 s | 4.04 s | 5.21 s | 1.64 s |
| Chromium | 4.56 s | 1.45 s | 1.31 s | 0.60 s | 0.74 s | 0.23 s |

无 timestamp profiling 的细探针显示，Firefox 各模型第一次执行远慢于第二次；打开 timestamp profiling 后，kernel 时间仍只有几十毫秒，而第一次 `run()` 的墙钟时间达到数秒。profiling 会扰动绝对值，因此这里只用来确认耗时归属，不把带 profiling 的冷启动绝对值当作基准。

用同一个 Firefox 用户 profile 完全退出并独立启动两次：

| 启动 | 总耗时 | Session 创建合计 | detect 首次完成 | bubble 首次完成 | OCR | inpaint 首次完成 |
|---|---:|---:|---:|---:|---:|---:|
| 第一次 | 20.78 s | 约 5.76 s | 约 5.27 s | 3.35 s | 5.27 s | 1.61 s |
| 第二次 | 27.84 s | 约 5.50 s | 约 7.78 s | 4.81 s | 7.57 s | 2.37 s |

第二次没有变快，因此本机上没有观察到可依赖的跨进程 WebGPU pipeline/shader 磁盘缓存收益。Firefox 冷路径本身还存在明显抖动（约 19–30 秒），但方向稳定。

## 扩展宿主生命周期证据

正式 Firefox 153 日志中，两次任务间隔约 2 分 19 秒，远小于代码声明的 5 分钟空闲期限，但两次都呈现完整冷启动：

| 阶段 | 第一次 | 第二次 |
|---|---:|---:|
| preload | 1433 ms | 786 ms |
| detect | 14087 ms | 12952 ms |
| bubble | 8586 ms | 8395 ms |
| OCR | 11712 ms | 11559 ms |
| inpaint | 3799 ms | 3729 ms |

而静态 benchmark 页在同一 Worker 中立即执行第二次只需约 1.82 秒。这说明正式扩展的第二次任务没有复用第一次的 Worker/Session。

当前 Firefox 架构把 `FirefoxPipelineHostLifecycle`、`PipelineHost`、`ImagePipelineRuntime` 和 dedicated Worker 全部放在 non-persistent background page 的内存里。代码只在任务空闲 5 分钟后主动 `disposeAllModelSessions()`，没有在任务完成时主动释放；因此 2 分 19 秒内再次冷启动不是业务代码的五分钟策略触发，而是 background event page 被 Firefox 卸载后整个内存宿主一并消失。

相关位置：

- `apps/extension/src/background-firefox.ts`
- `src/background/localPipeline/firefoxPipelineHostLifecycle.ts:24`
- `src/offscreen/pipelineHost.ts:714`
- `src/shared/localPipelineProtocol.ts:22`

## 被排除或降级的假设

- **Firefox 实际没有走 WebGPU：排除。** runtime provider、GPU timestamp 和 WebGPU 输出位置均能直接证明 provider 为 WebGPU。
- **CPU 预处理/CTC 解码是主因：排除。** 它们只有几十毫秒，无法解释约 1.27 秒热路径差距。
- **显存回读带宽不足：降级。** Firefox 单次耗时与输出大小没有相关性，固定等待远大于数据量效应。
- **只保留同一个 Firefox profile 就能复用冷启动缓存：本机未成立。** 第二次独立启动没有改善。
- **统一固定 OCR 宽度 320 可以无损解决：不成立。** 它把 8 次回读合成 1 次，Firefox 总耗时从约 1.90 秒降到约 1.27 秒，但 OCR 标点从 `どう思う?` 变成 `どう思う？`，没有达到严格输出一致。
- **只设置 GPU output 能解决：排除。** 只是把等待位置从 `run()` 移到 `getData()`。

## 后续方案的约束（本次不实施）

后续方案至少要分别处理两个问题，不能把它们混为一个优化：

1. 让 Firefox 的模型宿主存在于可预测的长生命周期扩展上下文中，避免每个用户任务重做 19–30 秒冷启动。
2. 减少 OCR 的 GPU→CPU 同步次数或把 CTC reduction 留在 GPU 上，同时保持 OCR 文本完全一致；仅调 batch 宽度会改变结果，不能直接采用。

纯 kernel 的 1.3–2.3 倍差距属于浏览器 WebGPU backend/驱动层的剩余差异。在前两个固定成本解决前，它不是首要优化目标。

## Firefox 专属 `validationMode` A-B-A 对照

为避免修改公共 pipeline，只在 ONNX Worker 的 Firefox WebGPU execution provider 上临时把 ORT 默认的 `validationMode: "basic"` 改为 `"wgpuOnly"`。每次均使用全新 Firefox 上下文、Worker 和 Session，输入与配置不变。

| 顺序 | 配置 | 总耗时 | OCR |
|---|---|---:|---:|
| A1 | 默认 `basic` | 28.116 s | 6.969 s |
| A2 | 默认 `basic` | 29.140 s | 7.900 s |
| A3 | 默认 `basic` | 28.359 s | 7.175 s |
| B1 | Firefox `wgpuOnly` | 21.107 s | 5.229 s |
| B2 | Firefox `wgpuOnly` | 19.983 s | 5.231 s |
| B3 | Firefox `wgpuOnly` | 28.818 s | 7.754 s |
| A4 | 撤掉参数，恢复 `basic` | 20.919 s | 5.226 s |

如果只看前三个 A 与三个 B 的中位数，会得到 `28.359 s → 21.107 s` 的表面改善；但恢复默认配置后的 A4 同样进入约 21 秒快态，而且其 detect、bubble、OCR、inpaint 与 B1/B2 几乎逐项相同。A-B-A 反证说明快态不是 `validationMode` 造成，而是 Firefox/驱动冷启动存在约 20–21 秒与 28–29 秒的双峰状态。

六个 A/B 样本的 OCR 全文、文本框和气泡框完全一致，但由于没有可归因的性能收益，`wgpuOnly` 不应合入。临时代码已经撤回，Worker 重新构建为默认配置。

## 可复现命令与产物

热路径红线命令（当前 Firefox 会以非零退出）：

```powershell
npx tsx benchmark/perf/src/run-browser-paddle-profile.ts --browser=firefox --url='https://x.com/ganaishoten/status/2084120226925629443/photo/1' --image-url='https://pbs.twimg.com/media/HOxIKbvbYAAmF-l?format=jpg&name=orig' --runs=2 --paddle-provider=webgpu --process-mode=erase --max-warm-ocr-ms=500
```

关键报告：

- Firefox 细探针：`benchmark/perf/reports/paddle-profile-2026-08-03T07-50-04-848Z.json`
- Chromium 细探针：`benchmark/perf/reports/paddle-profile-2026-08-03T07-50-32-126Z.json`
- Firefox 同 profile 第一次：`benchmark/perf/reports/paddle-profile-2026-08-03T08-02-42-172Z.json`
- Firefox 同 profile 第二次：`benchmark/perf/reports/paddle-profile-2026-08-03T08-03-32-211Z.json`
- 正式 Firefox 日志：`D:/Downloads/shinobu-diagnostic-log-2026-08-03T06-27-58-468Z.log`

生产 Worker 中用于采样的临时探针已全部移除，并重新构建了 `apps/extension/dist-chromium/onnxWorker.js`。
