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

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(defaultExtensionSettings);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle', message: '' });
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
      <h1>ShinobuTranslator</h1>
      {loading ? <p className="status">正在读取配置...</p> : null}

      <section className="panel">
        <label>
          <span>翻译服务</span>
          <select
            value={settings.translator}
            onChange={(event) => updateTranslator(event.target.value as ExtensionSettings['translator'])}
            disabled={loading}
          >
            <option value="google_web">Google 翻译</option>
            <option value="llm">大模型翻译</option>
          </select>
        </label>
        <label>
          <span>目标语言</span>
          <select
            value={settings.targetLang}
            onChange={(event) => updateField('targetLang', event.target.value)}
            disabled={loading}
          >
            <option value="zh-CHS">简体中文</option>
            <option value="zh-CHT">繁体中文</option>
          </select>
        </label>
        <div className="timing-options-row">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.showElapsedTime}
              onChange={(event) => updateElapsedTime(event.target.checked)}
              disabled={loading}
            />
            <span className="checkbox-label">显示耗时</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.showStageTimingDetails}
              onChange={(event) => updateField('showStageTimingDetails', event.target.checked)}
              disabled={loading || !settings.showElapsedTime}
            />
            <span className="checkbox-label">显示阶段明细</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.showTypesetDebug}
              onChange={(event) => updateField('showTypesetDebug', event.target.checked)}
              disabled={loading}
            />
            <span className="checkbox-label">排版调试模式</span>
          </label>
        </div>
      </section>

      {settings.translator === 'llm' ? (
        <section className="panel">
          <label>
            <span>LLM 提供商</span>
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
              <label>
                <span>Base URL</span>
                <input
                  value={currentProfile.customBaseUrl}
                  onChange={(event) => updateActiveLlmProfile({ customBaseUrl: event.target.value })}
                  disabled={loading}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label>
                <span>模型名称</span>
                <input
                  value={currentProfile.modelCustom}
                  onChange={(event) => updateActiveLlmProfile({ modelCustom: event.target.value })}
                  disabled={loading}
                  placeholder="例如：your-model-name"
                />
              </label>
            </>
          ) : (
            <>
              <label>
                <span>模型名称</span>
                {currentProfile.useCustomModel ? (
                  <input
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
            </>
          )}

          <label>
            <span>LLM API Key</span>
            <input
              type="password"
              value={currentProfile.apiKey}
              onChange={(event) => updateActiveLlmProfile({ apiKey: event.target.value })}
              disabled={loading}
              placeholder="sk-..."
            />
          </label>
          <label>
            <span>温度（Temperature）</span>
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
        </section>
      ) : null}

      {status.message ? <p className={`status status-${status.kind}`}>{status.message}</p> : null}
    </main>
  );
}
