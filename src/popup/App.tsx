import { useEffect, useRef, useState } from 'react';
import {
  defaultExtensionSettings,
  llmBuiltInProviderDefinitions,
  llmProviderOptions,
  normalizeSettings,
  type LlmProviderProfile,
  type LlmProvider,
  type ExtensionSettings,
} from '../shared/config';
import { sendRuntimeMessage } from '../shared/messages';

type SaveStatus = {
  kind: 'idle' | 'saving' | 'success' | 'error';
  message: string;
};

const IconGitHub = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.603-3.369-1.342-3.369-1.342-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
  </svg>
);

const IconTranslate = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 8 6 6" />
    <path d="m4 14 6-6 2-3" />
    <path d="M2 5h12" />
    <path d="m22 22-5-10-5 10" />
    <path d="M14 18h6" />
  </svg>
);

const IconOCR = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7V5a2 2 0 0 1 2-2h2" />
    <path d="M17 3h2a2 2 0 0 1 2 2v2" />
    <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
    <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
    <path d="M7 8h8" />
    <path d="M7 12h10" />
    <path d="M7 16h6" />
  </svg>
);

const IconLLM = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </svg>
);

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(defaultExtensionSettings);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle', message: '' });
  const [showDebugOptions, setShowDebugOptions] = useState(false);
  const hasHydratedRef = useRef(false);
  const saveRequestIdRef = useRef(0);

  useEffect(() => {
    async function loadSettings(): Promise<void> {
      try {
        const response = await sendRuntimeMessage({ type: 'mt:get-settings' });
        if (!response.ok || response.type !== 'mt:get-settings') {
          throw new Error(response.ok ? '读取配置失败' : response.error);
        }
        setSettings(normalizeSettings(response.settings));
      } catch (error) {
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setLoading(false);
      }
    }
    void loadSettings();
  }, []);

  function updateField<K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]): void {
    setSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  function updateElapsedTime(checked: boolean): void {
    setSettings((prev) => ({
      ...prev,
      showElapsedTime: checked,
      showStageTimingDetails: checked ? prev.showStageTimingDetails : false,
    }));
  }

  function updateActiveLlmProfile(patch: Partial<LlmProviderProfile>): void {
    setSettings((prev) => ({
      ...prev,
      llmProfiles: {
        ...prev.llmProfiles,
        [prev.llmProvider]: {
          ...prev.llmProfiles[prev.llmProvider],
          ...patch,
        },
      },
    }));
  }

  function updateTranslator(translator: ExtensionSettings['translator']): void {
    updateField('translator', translator);
  }

  function updateLlmProvider(provider: LlmProvider): void {
    updateField('llmProvider', provider);
  }

  function updateUseCustomModel(checked: boolean): void {
    updateActiveLlmProfile({ useCustomModel: checked });
  }

  function updateTemperatureInput(value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      updateActiveLlmProfile({ temperature: 1 });
      return;
    }
    updateActiveLlmProfile({ temperature: Math.max(0, Math.min(parsed, 2)) });
  }

  const currentProfile = settings.llmProfiles[settings.llmProvider];
  const currentProviderModels =
    settings.llmProvider === 'custom' ? [] : llmBuiltInProviderDefinitions[settings.llmProvider].models;
  const builtInCustomModelPlaceholder = currentProviderModels[0] ?? currentProfile.modelPreset;

  async function persistSettings(nextSettings: ExtensionSettings): Promise<void> {
    const requestId = saveRequestIdRef.current + 1;
    saveRequestIdRef.current = requestId;
    setStatus({ kind: 'saving', message: '正在自动保存...' });
    try {
      const response = await sendRuntimeMessage({
        type: 'mt:set-settings',
        settings: nextSettings,
      });
      if (!response.ok || response.type !== 'mt:set-settings') {
        throw new Error(response.ok ? '自动保存失败' : response.error);
      }
      if (saveRequestIdRef.current === requestId) {
        setStatus({ kind: 'success', message: '已自动保存' });
      }
    } catch (error) {
      if (saveRequestIdRef.current === requestId) {
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  useEffect(() => {
    if (loading) {
      return;
    }
    if (!hasHydratedRef.current) {
      hasHydratedRef.current = true;
      return;
    }

    void persistSettings(settings);
  }, [loading, settings]);

  return (
    <main className="popup">
      {status.message ? (
        <div className={`status-bubble status-${status.kind}`}>{status.message}</div>
      ) : null}
      <header className="popup-header">
        <div className="popup-header-text">
          <h1>ShinobuTranslator</h1>
          <p className="subtitle">漫画图片翻译助手</p>
        </div>
        <a
          className="popup-header-github"
          href="https://github.com/DonutShinobu/ShinobuTranslator"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub"
        >
          <IconGitHub />
        </a>
      </header>

      <div className="popup-body">
        {loading ? (
          <p className="loading-text">正在读取配置…</p>
        ) : (
          <>
            <section className="panel">
              <div className="panel-title">
                <IconTranslate />
                翻译设置
              </div>
              <div className="field-row">
                <label className="field">
                  <span className="field-label">翻译服务</span>
                  <select
                  value={settings.translator}
                  onChange={(event) => updateTranslator(event.target.value as ExtensionSettings['translator'])}
                  disabled={loading}
                >
                  <option value="google_web">Google 翻译</option>
                  <option value="llm">大模型翻译</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">目标语言</span>
                <select
                  value={settings.targetLang}
                  onChange={(event) => updateField('targetLang', event.target.value)}
                  disabled={loading}
                >
                  <option value="zh-CHS">简体中文</option>
                  <option value="zh-CHT">繁体中文</option>
                </select>
              </label>
              </div>
              <button
                className={`debug-toggle${showDebugOptions ? ' debug-toggle-open' : ''}`}
                onClick={() => setShowDebugOptions((v) => !v)}
                type="button"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="5" />
                  <path d="M8 5v3M8 10.5v0" />
                </svg>
                调试选项
                <svg className="debug-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 4l4 4l-4 4" />
                </svg>
              </button>
              {showDebugOptions && (
                <div className="debug-row">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.showElapsedTime}
                      onChange={(event) => updateElapsedTime(event.target.checked)}
                      disabled={loading}
                    />
                    <span className="checkbox-label">显示耗时</span>
                  </label>
                  <label className={`checkbox-row${!settings.showElapsedTime ? ' checkbox-disabled' : ''}`}>
                    <input
                      type="checkbox"
                      checked={settings.showStageTimingDetails}
                      onChange={(event) => updateField('showStageTimingDetails', event.target.checked)}
                      disabled={loading || !settings.showElapsedTime}
                    />
                    <span className="checkbox-label">阶段明细</span>
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.showTypesetDebug}
                      onChange={(event) => updateField('showTypesetDebug', event.target.checked)}
                      disabled={loading}
                    />
                    <span className="checkbox-label">排版调试</span>
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.ortDebugMode}
                      onChange={(event) => updateField('ortDebugMode', event.target.checked)}
                      disabled={loading}
                    />
                    <span className="checkbox-label">ORT 调试</span>
                  </label>
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-title">
                <IconOCR />
                OCR 引擎
              </div>
              <div className="radio-group">
                <label className={`radio-row${settings.ocrEngine === 'builtin' ? ' radio-selected' : ''}${loading ? ' radio-disabled' : ''}`}>
                  <input
                    type="radio"
                    name="ocrEngine"
                    value="builtin"
                    checked={settings.ocrEngine === 'builtin'}
                    onChange={() => updateField('ocrEngine', 'builtin' as ExtensionSettings['ocrEngine'])}
                    disabled={loading}
                  />
                  <span className="radio-label">内置模型</span>
                </label>
                <label className={`radio-row${settings.ocrEngine === 'paddleocr' ? ' radio-selected' : ''}${loading ? ' radio-disabled' : ''}`}>
                  <input
                    type="radio"
                    name="ocrEngine"
                    value="paddleocr"
                    checked={settings.ocrEngine === 'paddleocr'}
                    onChange={() => updateField('ocrEngine', 'paddleocr' as ExtensionSettings['ocrEngine'])}
                    disabled={loading}
                  />
                  <span className="radio-label">PaddleOCR</span>
                </label>
              </div>
            </section>

            {settings.translator === 'llm' ? (
              <section className="panel panel-llm">
                <div className="panel-title">
                  <IconLLM />
                  大模型配置
                </div>
                <label className="field">
                  <span className="field-label">LLM 提供商</span>
                  <select
                    value={settings.llmProvider}
                    onChange={(event) => updateLlmProvider(event.target.value as LlmProvider)}
                    disabled={loading}
                  >
                    {llmProviderOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                {settings.llmProvider === 'custom' ? (
                  <>
                    <label className="field">
                      <span className="field-label">Base URL</span>
                      <input
                        type="text"
                        value={currentProfile.customBaseUrl}
                        onChange={(event) => updateActiveLlmProfile({ customBaseUrl: event.target.value })}
                        disabled={loading}
                        placeholder="https://api.example.com/v1"
                      />
                    </label>
                    <div className="field-row">
                      <label className="field">
                        <span className="field-label">模型名称</span>
                        <input
                          type="text"
                          value={currentProfile.modelCustom}
                          onChange={(event) => updateActiveLlmProfile({ modelCustom: event.target.value })}
                          disabled={loading}
                          placeholder="例如：your-model-name"
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">温度</span>
                        <input
                          type="number"
                          min={0}
                          max={2}
                          step={0.1}
                          value={currentProfile.temperature}
                          onChange={(event) => updateTemperatureInput(event.target.value)}
                          disabled={loading}
                        />
                      </label>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span className="field-label">模型名称</span>
                      {currentProfile.useCustomModel ? (
                        <input
                          type="text"
                          value={currentProfile.modelCustom}
                          onChange={(event) => updateActiveLlmProfile({ modelCustom: event.target.value })}
                          disabled={loading}
                          placeholder={builtInCustomModelPlaceholder}
                        />
                      ) : (
                        <select
                          value={currentProfile.modelPreset}
                          onChange={(event) => updateActiveLlmProfile({ modelPreset: event.target.value })}
                          disabled={loading}
                        >
                          {currentProviderModels.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                      )}
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={currentProfile.useCustomModel}
                        onChange={(event) => updateUseCustomModel(event.target.checked)}
                        disabled={loading}
                      />
                      <span className="checkbox-label">自定义模型</span>
                    </label>
                    <div className="field-row">
                      <label className="field">
                        <span className="field-label">API Key</span>
                        <input
                          type="password"
                          value={currentProfile.apiKey}
                          onChange={(event) => updateActiveLlmProfile({ apiKey: event.target.value })}
                          disabled={loading}
                          placeholder="sk-..."
                        />
                      </label>
                      <label className="field">
                        <span className="field-label">温度</span>
                        <input
                          type="number"
                          min={0}
                          max={2}
                          step={0.1}
                          value={currentProfile.temperature}
                          onChange={(event) => updateTemperatureInput(event.target.value)}
                          disabled={loading}
                        />
                      </label>
                    </div>
                  </>
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
