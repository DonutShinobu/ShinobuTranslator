# Chromium 着色器缓存预编译：实现与验证

已在模型 Worker 接入磁盘 WGSL 描述缓存和 4 路异步管线预编译。设备创建立即返回，预编译与模型加载重叠；ORT 的同步管线创建和推理代码不变。没有调整模型驻留时间或推理并发度。

## 实现范围

- `packages/model-runtime/src/workers/shaderWarmup.ts`：仅 Chromium 模型 Worker 安装钩子，捕获自动布局的同步管线描述，使用原生 CacheStorage 持久化，不发网络请求。
- 缓存匹配 ORT 版本、完整浏览器 UA、GPU 信息、设备功能和限制。缓存只保存当前设备的一份描述，最多 256 个着色器、约 2 MiB 文本预算；500 ms 合并写入。
- 原生 GPU 管线只保留至本次设备失效/Worker 结束，持久化的是源码，不是模型或 GPU 对象。推理仍通过 ORT 创建实际管线，缓存内容不会替换计算结果。
- 存储拒绝、格式错误、编译失败、设备丢失均不阻断正常推理。不支持的浏览器和显式布局走原有路径。
- 首次安装、浏览器/ORT/GPU 配置变化和缓存清除后，没有描述可供预编译。未记录的新形状仍同步编译。模型变化但 ORT 未变时，旧描述可能产生多余预编译，但不会替代新模型生成的着色器。

## 实验设计

Chromium 145.0.7632.6，RTX 5070 Ti。同一默认图片、erase 模式、真实扩展快捷键链路。先正常执行一次以生成磁盘描述缓存，随后每轮完全关闭并重启浏览器，保留同一个独立测试 profile。对照使用改动前的 Worker，优化组使用生产构建的 Worker，不注入实验着色器。

正式三轮采用原版→优化、优化→原版、原版→优化的顺序。使用 `--disable-gpu-shader-disk-cache` 排除 Chromium 自身磁盘缓存命中的影响，保留我们实现的描述缓存，测试需要重新编译的场景。没有清理驱动/系统缓存。正式六次测量期间不并行运行构建或单元测试。先行测量有一次与测试进程重叠，整组先行数据不用于下表。

| 指标（三轮中位数） | 原版 | 优化版 |
|---|---:|---:|
| 首图总耗时 | 4794.8 ms | 3730.2 ms（减少 22.2%） |
| Worker 动画心跳最大间隔 | 118.8 ms | 50.0 ms |
| 超过 50 ms 的心跳间隔次数 | 9 | 0 |
| 检测模型预加载 | 565.9 ms | 580.7 ms |

原版三轮总耗时：4794.8 / 4773.9 / 4857.7 ms；优化：3847.7 / 3730.2 / 3575.5 ms。预加载子阶段增加 14.8 ms（2.6%），首图端到端更快，不能声称每个子阶段均零开销。心跳指标代表浏览器响应代理指标，不等价于整台 Windows 的响应时延。

首轮 trace：同步管线创建仍为 124 次，累计耗时 **1254.9 → 20.0 ms**；新增 108 次异步创建。DXC 编译仍为 111 次，其中 **108 次从 CrGpuMain 转到 ThreadPoolForegroundWorker**，剩余 3 次仍在 CrGpuMain。收益来自移动/重叠编译，非减少模型计算。

另外保持浏览器默认磁盘缓存，重启后各测一次：原版 3449.4 ms，优化 3511.6 ms（+1.8%）；两者均没有 DXC 编译。该单次对照不能判定统计显著差异，也说明原生缓存已命中时没有同等收益，不能承诺所有冷启动条件都加速。

八次正式/原生缓存对照的输出像素 SHA-256 全部一致：
`b7b8b16fca83417705d69257f3a72b0e346f01c4eebf7ed6204f18beac5c5be1`。

逐次结果、阶段指标和 trace 统计见 [机器可读结果](./chromium-shader-warmup-validation-2026-09-16.json)。原始大体积 trace 保存在本机被忽略的 `benchmark/perf/reports/`，JSON 内记录路径。

## 复现与检查

```powershell
npm run build:extension:chromium
# 首次运行生成源码缓存；之后使用相同 profile-key 再运行即为浏览器重启对照。
npx tsx benchmark/perf/src/run-browser-ui-jank-smoke.ts --profile-key=shader-validation --probe-port=19284 --runs=1
npx tsx benchmark/perf/src/run-browser-ui-jank-smoke.ts --profile-key=shader-validation --probe-port=19284 --runs=1 --trace --disable-gpu-shader-disk-cache
```

原版对照需换回修改前构建的 `onnxWorker.js`，保留相同 profile；测量结束恢复优化构建。测试浏览器配置与日常 Chrome 分离。

检查已通过：全量 161 个测试文件、1287 项测试；全部 workspace 类型检查；tests/benchmark 类型检查；Chromium 构建与发布边界检查；架构边界检查。新增测试验证 4 路并发、非阻塞同步推理、描述去重持久化、版本不匹配/损坏缓存以及存储和编译失败回退。

技术原理和前期方案对照见 [前期实验](./chromium-cold-start-experiments-2026-09-16.md)。异步创建行为依据 [WebGPU 管线创建规范](https://gpuweb.github.io/gpuweb/#pipeline-creation)；具体 Dawn 缓存复用和线程迁移以上述本机 trace 为证，属于实现行为而非跨浏览器保证。
