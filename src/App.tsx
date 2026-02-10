import { useMemo, useState } from "react";
import { PipelineStageError, runPipeline } from "./pipeline/orchestrator";
import { runRuntimeSelfCheck, type RuntimeSelfCheckReport } from "./runtime/selfCheck";
import type { PipelineArtifacts, PipelineConfig, PipelineProgress } from "./types";

const defaultConfig: PipelineConfig = {
  sourceLang: "ja",
  targetLang: "zh-CHS",
  translator: "youdao",
  llmBaseUrl: "https://api.openai.com/v1",
  llmApiKey: "",
  llmModel: "gpt-4o-mini"
};

function CanvasPreview({ canvas, title }: { canvas: HTMLCanvasElement | null; title: string }) {
  const dataUrl = useMemo(() => canvas?.toDataURL("image/png") ?? "", [canvas]);
  if (!canvas) {
    return (
      <section className="panel">
        <h3>{title}</h3>
        <div className="empty">暂无图像</div>
      </section>
    );
  }
  return (
    <section className="panel">
      <h3>{title}</h3>
      <img src={dataUrl} alt={title} className="preview" />
    </section>
  );
}

export function App() {
  const [file, setFile] = useState<File | null>(null);
  const [config, setConfig] = useState<PipelineConfig>(defaultConfig);
  const [progress, setProgress] = useState<PipelineProgress>({ stage: "idle", detail: "等待上传" });
  const [result, setResult] = useState<PipelineArtifacts | null>(null);
  const [error, setError] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [selfCheck, setSelfCheck] = useState<RuntimeSelfCheckReport | null>(null);
  const [selfCheckRunning, setSelfCheckRunning] = useState(false);

  const originalUrl = useMemo(() => (file ? URL.createObjectURL(file) : ""), [file]);

  async function onSelfCheck(): Promise<void> {
    setSelfCheckRunning(true);
    try {
      const report = await runRuntimeSelfCheck();
      setSelfCheck(report);
    } catch (error) {
      setSelfCheck({
        createdAt: new Date().toISOString(),
        env: {
          url: window.location.href,
          secureContext: window.isSecureContext,
          crossOriginIsolated: window.crossOriginIsolated,
          userAgent: navigator.userAgent
        },
        checks: [
          {
            id: "selfcheck.crash",
            title: "运行时自检",
            status: "fail",
            code: "SC001_SELF_CHECK_FAILED",
            message: "自检执行失败",
            detail: error instanceof Error ? error.message : String(error)
          }
        ],
        summary: {
          ok: false,
          effectiveRuntime: "none",
          reason: "自检执行失败"
        }
      });
    } finally {
      setSelfCheckRunning(false);
    }
  }

  function onCopySelfCheck(): void {
    if (!selfCheck) {
      return;
    }
    const text = JSON.stringify(selfCheck, null, 2);
    void navigator.clipboard.writeText(text);
  }

  async function onRun(): Promise<void> {
    if (!file) {
      setError("请先上传图片");
      return;
    }
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const artifacts = await runPipeline(file, config, setProgress);
      setResult(artifacts);
    } catch (e) {
      if (e instanceof PipelineStageError) {
        setResult(e.artifacts);
        setError(e.message);
        return;
      }
      const message = e instanceof Error ? e.message : "未知错误";
      setError(message);
    } finally {
      setRunning(false);
    }
  }

  function onDownload(): void {
    if (!result) {
      return;
    }
    const a = document.createElement("a");
    a.href = result.resultCanvas.toDataURL("image/png");
    a.download = "manga-translated-zh.png";
    a.click();
  }

  return (
    <main className="layout">
      <header className="hero">
        <h1>漫画翻译 Web Demo</h1>
        <p>纯前端流程：文本检测 -&gt; OCR -&gt; 翻译 -&gt; 去字 -&gt; 排版嵌字</p>
      </header>

      <section className="controls panel">
        <label className="field">
          <span>漫画图片</span>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={running}
          />
        </label>

        <div className="grid">
          <label className="field">
            <span>翻译引擎</span>
            <select
              value={config.translator}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  translator: e.target.value as PipelineConfig["translator"]
                }))
              }
            >
              <option value="youdao">占位（原文输出）</option>
              <option value="llm">LLM API</option>
            </select>
          </label>

          <label className="field">
            <span>源语言</span>
            <input
              value={config.sourceLang}
              onChange={(e) => setConfig((prev) => ({ ...prev, sourceLang: e.target.value }))}
              placeholder="ja"
            />
          </label>

          <label className="field">
            <span>目标语言</span>
            <input
              value={config.targetLang}
              onChange={(e) => setConfig((prev) => ({ ...prev, targetLang: e.target.value }))}
              placeholder="zh-CHS"
            />
          </label>
        </div>

        {config.translator === "llm" ? (
          <div className="grid">
            <label className="field">
              <span>LLM Base URL</span>
              <input
                value={config.llmBaseUrl}
                onChange={(e) => setConfig((prev) => ({ ...prev, llmBaseUrl: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>LLM 模型</span>
              <input
                value={config.llmModel}
                onChange={(e) => setConfig((prev) => ({ ...prev, llmModel: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>LLM API Key</span>
              <input
                type="password"
                value={config.llmApiKey}
                onChange={(e) => setConfig((prev) => ({ ...prev, llmApiKey: e.target.value }))}
                placeholder="sk-..."
              />
            </label>
          </div>
        ) : null}

        <div className="actions">
          <button onClick={() => void onRun()} disabled={running || !file}>
            {running ? "处理中..." : "开始翻译"}
          </button>
          <button onClick={onDownload} disabled={!result}>
            下载中文图
          </button>
        </div>

        <div className="status">
          <strong>阶段：</strong>
          <span>{progress.stage}</span>
          <span>{progress.detail}</span>
        </div>
        <div className="selfcheck-box">
          <div className="selfcheck-head">
            <strong>启动自检</strong>
            <div className="actions">
              <button onClick={() => void onSelfCheck()} disabled={selfCheckRunning}>
                {selfCheckRunning ? "自检中..." : selfCheck ? "重新自检" : "开始自检"}
              </button>
              <button onClick={onCopySelfCheck} disabled={!selfCheck}>
                复制报告
              </button>
            </div>
          </div>
          {selfCheck ? (
            <>
              <p className="selfcheck-summary">
                结论：{selfCheck.summary.reason}（当前建议运行时：{selfCheck.summary.effectiveRuntime}）
              </p>
              <div className="selfcheck-grid">
                {selfCheck.checks.map((item) => (
                  <article key={item.id} className="selfcheck-item">
                    <p>
                      <strong>{item.title}</strong>
                      <span className={`badge badge-${item.status}`}>{item.status}</span>
                    </p>
                    <p>{item.message}</p>
                    {item.code ? <p>代码: {item.code}</p> : null}
                    {item.detail ? <p className="selfcheck-detail">{item.detail}</p> : null}
                  </article>
                ))}
              </div>
            </>
          ) : (
            <p className="selfcheck-summary">点击“开始自检”后将显示运行时检测结果。</p>
          )}
        </div>
        {result ? (
          <div className="runtime-box">
            {result.runtimeStages.map((stage) => (
              <p key={stage.model}>
                <strong>{stage.model}</strong>
                <span>
                  {stage.enabled
                    ? `已启用(${stage.provider}${
                        stage.provider === "webnn" ? `/${stage.webnnDeviceType ?? "default"}` : ""
                      })`
                    : "未启用"} - {stage.detail}
                </span>
              </p>
            ))}
          </div>
        ) : null}
        {error ? <div className="error">{error}</div> : null}
      </section>

      <section className="gallery">
        <section className="panel">
          <h3>原图</h3>
          {originalUrl ? <img src={originalUrl} alt="原图" className="preview" /> : <div className="empty">暂无图像</div>}
        </section>
        <CanvasPreview canvas={result?.detectionCanvas ?? null} title="文本检测预览" />
        <CanvasPreview canvas={result?.ocrCanvas ?? null} title="OCR 识别预览" />
        <CanvasPreview canvas={result?.segmentationCanvas ?? null} title="文字分割预览" />
        <CanvasPreview canvas={result?.cleanedCanvas ?? null} title="去字结果" />
        <CanvasPreview canvas={result?.resultCanvas ?? null} title="最终中文图" />
      </section>

      <section className="panel">
        <h3>识别与翻译文本</h3>
        <div className="list">
          {result?.detectedRegions.map((item) => (
            <article key={item.id} className="list-item">
              <p>
                <strong>原文：</strong>
                {item.sourceText || "-"}
              </p>
              <p>
                <strong>译文：</strong>
                {item.translatedText || "-"}
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
