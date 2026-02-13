import { useEffect, useState } from 'react';
import {
  defaultExtensionSettings,
  normalizeSettings,
  validateSettings,
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
            onChange={(event) => updateField('translator', event.target.value as ExtensionSettings['translator'])}
            disabled={loading || saving}
          >
            <option value="llm">LLM</option>
            <option value="youdao">youdao（占位）</option>
          </select>
        </label>
        <label>
          <span>源语言</span>
          <input
            value={settings.sourceLang}
            onChange={(event) => updateField('sourceLang', event.target.value)}
            disabled={loading || saving}
          />
        </label>
        <label>
          <span>目标语言</span>
          <input
            value={settings.targetLang}
            onChange={(event) => updateField('targetLang', event.target.value)}
            disabled={loading || saving}
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.showElapsedTime}
            onChange={(event) => updateElapsedTime(event.target.checked)}
            disabled={loading || saving}
          />
          <span className="checkbox-label">显示耗时</span>
        </label>
        {settings.showElapsedTime ? (
          <label className="checkbox-row checkbox-row-sub">
            <input
              type="checkbox"
              checked={settings.showStageTimingDetails}
              onChange={(event) => updateField('showStageTimingDetails', event.target.checked)}
              disabled={loading || saving}
            />
            <span className="checkbox-label">显示阶段明细</span>
          </label>
        ) : null}
      </section>

      {settings.translator === 'llm' ? (
        <section className="panel">
          <label>
            <span>LLM Base URL</span>
            <input
              value={settings.llmBaseUrl}
              onChange={(event) => updateField('llmBaseUrl', event.target.value)}
              disabled={loading || saving}
            />
          </label>
          <label>
            <span>LLM Model</span>
            <input
              value={settings.llmModel}
              onChange={(event) => updateField('llmModel', event.target.value)}
              disabled={loading || saving}
            />
          </label>
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
