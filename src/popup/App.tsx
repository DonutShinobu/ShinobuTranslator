import { useEffect, useState } from 'react';
import {
  defaultExtensionSettings,
  llmBuiltInProviderDefinitions,
  llmProviderOptions,
  normalizeSettings,
  validateSettings,
  type LlmProvider,
  type ExtensionSettings,
} from '../shared/config';
import { sendRuntimeMessage } from '../shared/messages';

type SaveStatus = {
  kind: 'idle' | 'success' | 'error';
  message: string;
};

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(defaultExtensionSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle', message: '' });

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

  function updateTranslator(translator: ExtensionSettings['translator']): void {
    updateField('translator', translator);
  }

  function updateLlmProvider(provider: LlmProvider): void {
    setSettings((prev) => {
      const next: ExtensionSettings = {
        ...prev,
        llmProvider: provider,
      };
      if (provider !== 'custom') {
        const models = llmBuiltInProviderDefinitions[provider].models;
        if (!models.includes(next.llmModelPreset)) {
          next.llmModelPreset = models[0] ?? '';
        }
        next.llmUseCustomModel = false;
      } else {
        next.llmModelPreset = '';
        next.llmUseCustomModel = true;
      }
      return next;
    });
  }

  function updateUseCustomModel(checked: boolean): void {
    setSettings((prev) => ({
      ...prev,
      llmUseCustomModel: checked,
    }));
  }

  const currentProviderModels =
    settings.llmProvider === 'custom' ? [] : llmBuiltInProviderDefinitions[settings.llmProvider].models;
  const builtInCustomModelPlaceholder = currentProviderModels[0] ?? '';

  async function onSave(): Promise<void> {
    setStatus({ kind: 'idle', message: '' });
    const validationError = validateSettings(settings);
    if (validationError) {
      setStatus({ kind: 'error', message: validationError });
      return;
    }

    setSaving(true);
    try {
      const response = await sendRuntimeMessage({
        type: 'mt:set-settings',
        settings,
      });
      if (!response.ok || response.type !== 'mt:set-settings') {
        throw new Error(response.ok ? '保存配置失败' : response.error);
      }
      setSettings(normalizeSettings(response.settings));
      setStatus({ kind: 'success', message: '配置已保存' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="popup">
      <h1>Manga Translate X</h1>
      {loading ? <p className="status">正在读取配置...</p> : null}

      <section className="panel">
        <label>
          <span>翻译服务</span>
          <select
            value={settings.translator}
            onChange={(event) => updateTranslator(event.target.value as ExtensionSettings['translator'])}
            disabled={loading || saving}
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
            disabled={loading || saving}
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
              disabled={loading || saving}
            />
            <span className="checkbox-label">显示耗时</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.showStageTimingDetails}
              onChange={(event) => updateField('showStageTimingDetails', event.target.checked)}
              disabled={loading || saving || !settings.showElapsedTime}
            />
            <span className="checkbox-label">显示阶段明细</span>
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
              disabled={loading || saving}
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
                  value={settings.llmCustomBaseUrl}
                  onChange={(event) => updateField('llmCustomBaseUrl', event.target.value)}
                  disabled={loading || saving}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label>
                <span>模型名称</span>
                <input
                  value={settings.llmModelCustom}
                  onChange={(event) => updateField('llmModelCustom', event.target.value)}
                  disabled={loading || saving}
                  placeholder="例如：your-model-name"
                />
              </label>
            </>
          ) : (
            <>
              <label>
                <span>模型名称</span>
                {settings.llmUseCustomModel ? (
                  <input
                    value={settings.llmModelCustom}
                    onChange={(event) => updateField('llmModelCustom', event.target.value)}
                    disabled={loading || saving}
                    placeholder={builtInCustomModelPlaceholder}
                  />
                ) : (
                  <select
                    value={settings.llmModelPreset}
                    onChange={(event) => updateField('llmModelPreset', event.target.value)}
                    disabled={loading || saving}
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
                  checked={settings.llmUseCustomModel}
                  onChange={(event) => updateUseCustomModel(event.target.checked)}
                  disabled={loading || saving}
                />
                <span className="checkbox-label">自定义模型</span>
              </label>
            </>
          )}

          <label>
            <span>LLM API Key</span>
            <input
              type="password"
              value={settings.llmApiKey}
              onChange={(event) => updateField('llmApiKey', event.target.value)}
              disabled={loading || saving}
              placeholder="sk-..."
            />
          </label>
        </section>
      ) : null}

      <button className="save-btn" onClick={() => void onSave()} disabled={loading || saving}>
        {saving ? '保存中...' : '保存配置'}
      </button>

      {status.message ? <p className={`status status-${status.kind}`}>{status.message}</p> : null}
    </main>
  );
}
