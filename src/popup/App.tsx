import { useEffect, useRef, useState } from 'react';
import {
  defaultExtensionSettings,
  llmBuiltInProviderDefinitions,
  llmProviderOptions,
  normalizeSettings,
  type LlmAuthMode,
  type LlmProviderProfile,
  type LlmProvider,
  type ExtensionSettings,
} from '../shared/config';
import { sendRuntimeMessage } from '../shared/messages';

type SaveStatus = {
  kind: 'idle' | 'saving' | 'success' | 'error';
  message: string;
};

type OpenAiOAuthViewState = {
  loading: boolean;
  busy: boolean;
  authenticated: boolean;
  pending: boolean;
  email?: string;
  planType?: string;
  error: string;
};

type PersistSettingsOptions = {
  silent?: boolean;
};

type SettingsUpdateOptions = {
  showSaveStatus?: boolean;
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

const IconMode = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 4h-7" />
    <path d="M10 4H3" />
    <path d="M21 12h-9" />
    <path d="M8 12H3" />
    <path d="M21 20h-5" />
    <path d="M12 20H3" />
    <circle cx="12" cy="4" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="14" cy="20" r="2" />
  </svg>
);

const IconDebug = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.5-3.5a6 6 0 0 1-7.9 7.9l-6.6 6.6a2.1 2.1 0 0 1-3-3l6.6-6.6a6 6 0 0 1 7.9-7.9l-3.5 3.5z" />
  </svg>
);

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const count = options.length;
  return (
    <div className={`seg-control${disabled ? ' seg-disabled' : ''}`}>
      <div
        className="seg-pill"
        style={{
          width: `calc(${100 / count}% - ${6 / count}px)`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          className={`seg-option${i === selectedIndex ? ' seg-active' : ''}`}
          onClick={() => onChange(option.value)}
          disabled={disabled}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(defaultExtensionSettings);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle', message: '' });
  const [openAiStatus, setOpenAiStatus] = useState<OpenAiOAuthViewState>({
    loading: false,
    busy: false,
    authenticated: false,
    pending: false,
    error: '',
  });
  const hasHydratedRef = useRef(false);
  const nextSaveShowsStatusRef = useRef(false);
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

  function queueSaveStatus(options: SettingsUpdateOptions = {}): void {
    nextSaveShowsStatusRef.current = nextSaveShowsStatusRef.current || options.showSaveStatus === true;
  }

  function updateField<K extends keyof ExtensionSettings>(
    key: K,
    value: ExtensionSettings[K],
    options?: SettingsUpdateOptions,
  ): void {
    queueSaveStatus(options);
    setSettings((prev) => ({
      ...prev,
      [key]: value,
    }));
  }

  function updateElapsedTime(checked: boolean, options?: SettingsUpdateOptions): void {
    queueSaveStatus(options);
    setSettings((prev) => ({
      ...prev,
      showElapsedTime: checked,
      showStageTimingDetails: checked ? prev.showStageTimingDetails : false,
    }));
  }

  function updateActiveLlmProfile(patch: Partial<LlmProviderProfile>, options?: SettingsUpdateOptions): void {
    queueSaveStatus(options);
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

  function applyOpenAiStatus(next: {
    authenticated: boolean;
    pending?: boolean;
    email?: string;
    planType?: string;
    error?: string;
  }): void {
    setOpenAiStatus({
      loading: false,
      busy: false,
      authenticated: next.authenticated,
      pending: next.pending ?? false,
      email: next.email,
      planType: next.planType,
      error: next.error ?? '',
    });
  }

  async function refreshOpenAiOAuthStatus(): Promise<void> {
    setOpenAiStatus((prev) => ({ ...prev, loading: true, error: '' }));
    try {
      const response = await sendRuntimeMessage({ type: 'mt:openai-oauth-status' });
      if (!response.ok || response.type !== 'mt:openai-oauth-status') {
        throw new Error(response.ok ? '读取 OpenAI 登录状态失败' : response.error);
      }
      applyOpenAiStatus(response.status);
    } catch (error) {
      setOpenAiStatus({
        loading: false,
        busy: false,
        authenticated: false,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function loginOpenAiOAuth(): Promise<void> {
    setOpenAiStatus((prev) => ({ ...prev, busy: true, error: '' }));
    try {
      const response = await sendRuntimeMessage({ type: 'mt:openai-oauth-login' });
      if (!response.ok || response.type !== 'mt:openai-oauth-login') {
        throw new Error(response.ok ? 'OpenAI 登录失败' : response.error);
      }
      applyOpenAiStatus(response.status);
      setStatus({
        kind: 'success',
        message: response.status.authenticated ? 'OpenAI 已登录' : 'OpenAI 登录页已打开，请在新标签页完成授权',
      });
    } catch (error) {
      setOpenAiStatus((prev) => ({
        ...prev,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async function logoutOpenAiOAuth(): Promise<void> {
    setOpenAiStatus((prev) => ({ ...prev, busy: true, error: '' }));
    try {
      const response = await sendRuntimeMessage({ type: 'mt:openai-oauth-logout' });
      if (!response.ok || response.type !== 'mt:openai-oauth-logout') {
        throw new Error(response.ok ? 'OpenAI 退出登录失败' : response.error);
      }
      applyOpenAiStatus(response.status);
      setStatus({ kind: 'success', message: 'OpenAI 已退出登录' });
    } catch (error) {
      setOpenAiStatus((prev) => ({
        ...prev,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const currentProfile = settings.llmProfiles[settings.llmProvider];
  const currentProviderModels =
    settings.llmProvider === 'custom' ? [] : llmBuiltInProviderDefinitions[settings.llmProvider].models;
  const builtInCustomModelPlaceholder = currentProviderModels[0] ?? currentProfile.modelPreset;
  const usesOpenAiOAuth = settings.llmProvider === 'openai' && currentProfile.authMode === 'openai_oauth';
  const openAiStatusLabel = openAiStatus.loading
    ? '正在检查 OpenAI 登录'
    : openAiStatus.authenticated
      ? openAiStatus.email ?? '已登录 OpenAI'
      : openAiStatus.error
        ? openAiStatus.error
        : openAiStatus.pending
          ? '等待 OpenAI 授权完成'
          : '未登录 OpenAI';

  async function persistSettings(nextSettings: ExtensionSettings, options: PersistSettingsOptions = {}): Promise<void> {
    const requestId = saveRequestIdRef.current + 1;
    saveRequestIdRef.current = requestId;
    if (options.silent) {
      setStatus((prev) => (prev.kind === 'saving' || prev.kind === 'success' ? { kind: 'idle', message: '' } : prev));
    } else {
      setStatus({ kind: 'saving', message: '正在自动保存...' });
    }
    try {
      const response = await sendRuntimeMessage({
        type: 'mt:set-settings',
        settings: nextSettings,
      });
      if (!response.ok || response.type !== 'mt:set-settings') {
        throw new Error(response.ok ? '自动保存失败' : response.error);
      }
      if (!options.silent && saveRequestIdRef.current === requestId) {
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

    const showSaveStatus = nextSaveShowsStatusRef.current;
    nextSaveShowsStatusRef.current = false;
    void persistSettings(settings, { silent: !showSaveStatus });
  }, [loading, settings]);

  useEffect(() => {
    if (loading || !usesOpenAiOAuth) {
      return;
    }
    void refreshOpenAiOAuthStatus();
  }, [loading, usesOpenAiOAuth]);

  useEffect(() => {
    if (!usesOpenAiOAuth || !openAiStatus.pending) {
      return;
    }
    const intervalId = window.setInterval(() => {
      if (!openAiStatus.loading && !openAiStatus.busy) {
        void refreshOpenAiOAuthStatus();
      }
    }, 2_000);
    return () => window.clearInterval(intervalId);
  }, [usesOpenAiOAuth, openAiStatus.pending, openAiStatus.loading, openAiStatus.busy]);

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
              <div className="settings-stack">
                <div className="setting-row">
                  <span className="field-label">服务</span>
                  <SegmentedControl
                    options={[
                      { value: 'google_web', label: '谷歌翻译' },
                      { value: 'llm', label: '大模型' },
                    ]}
                    value={settings.translator}
                    onChange={(value) => updateTranslator(value as ExtensionSettings['translator'])}
                    disabled={loading}
                  />
                </div>
                <div className="setting-row">
                  <span className="field-label">语言</span>
                  <SegmentedControl
                    options={[
                      { value: 'zh-CHS', label: '简体中文' },
                      { value: 'zh-CHT', label: '繁体中文' },
                    ]}
                    value={settings.targetLang}
                    onChange={(value) => updateField('targetLang', value)}
                    disabled={loading}
                  />
                </div>
              </div>
            </section>

            <section className="panel option-panel">
              <div className="panel-title">
                <IconOCR />
                OCR 引擎
              </div>
              <SegmentedControl
                options={[
                  { value: 'builtin', label: 'MangaOCR' },
                  { value: 'paddleocr', label: 'PaddleOCR' },
                ]}
                value={settings.ocrEngine}
                onChange={(v) => updateField('ocrEngine', v as ExtensionSettings['ocrEngine'])}
                disabled={loading}
              />
            </section>

            <section className="panel option-panel">
              <div className="panel-title">
                <IconMode />
                模式
              </div>
              <SegmentedControl
                options={[
                  { value: 'translate', label: '翻译' },
                  { value: 'original', label: '原文' },
                  { value: 'erase', label: '去字' },
                ]}
                value={settings.processMode}
                onChange={(v) => updateField('processMode', v as ExtensionSettings['processMode'])}
                disabled={loading}
              />
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
                        onChange={(event) =>
                          updateActiveLlmProfile({ customBaseUrl: event.target.value }, { showSaveStatus: true })
                        }
                        disabled={loading}
                        placeholder="https://api.example.com/v1"
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">模型名称</span>
                      <input
                        type="text"
                        value={currentProfile.modelCustom}
                        onChange={(event) =>
                          updateActiveLlmProfile({ modelCustom: event.target.value }, { showSaveStatus: true })
                        }
                        disabled={loading}
                        placeholder="例如：your-model-name"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    {settings.llmProvider === 'openai' ? (
                      <div className="auth-mode-field">
                        <span className="field-label">认证方式</span>
                        <SegmentedControl<LlmAuthMode>
                          options={[
                            { value: 'openai_oauth', label: 'OpenAI 登录' },
                            { value: 'api_key', label: 'API Key' },
                          ]}
                          value={currentProfile.authMode}
                          onChange={(value) => updateActiveLlmProfile({ authMode: value })}
                          disabled={loading}
                        />
                      </div>
                    ) : null}
                    {usesOpenAiOAuth ? (
                      <div className="auth-status-row">
                        <span className="field-label">登录状态</span>
                        <div className="auth-status-control">
                          <div className="oauth-copy">
                            <span className={`oauth-dot${openAiStatus.authenticated ? ' oauth-dot-authed' : ''}`} />
                            <div className="oauth-title">{openAiStatusLabel}</div>
                          </div>
                          <button
                            className="oauth-action"
                            type="button"
                            onClick={() => {
                              void (
                                openAiStatus.authenticated
                                  ? logoutOpenAiOAuth()
                                  : openAiStatus.pending
                                    ? refreshOpenAiOAuthStatus()
                                    : loginOpenAiOAuth()
                              );
                            }}
                            disabled={loading || openAiStatus.loading || openAiStatus.busy}
                          >
                            {openAiStatus.busy
                              ? '处理中...'
                              : openAiStatus.authenticated
                                ? '退出登录'
                                : openAiStatus.pending
                                  ? '检查状态'
                                  : '登录 OpenAI'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    <div className="field model-field">
                      <span className="field-label">模型名称</span>
                      <div className="model-control">
                        {currentProfile.useCustomModel ? (
                          <input
                            type="text"
                            value={currentProfile.modelCustom}
                            onChange={(event) =>
                              updateActiveLlmProfile({ modelCustom: event.target.value }, { showSaveStatus: true })
                            }
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
                        <label className={`custom-model-toggle${loading ? ' custom-model-toggle-disabled' : ''}`}>
                          <input
                            type="checkbox"
                            checked={currentProfile.useCustomModel}
                            onChange={(event) => updateUseCustomModel(event.target.checked)}
                            disabled={loading}
                          />
                          <span>自定义</span>
                        </label>
                      </div>
                    </div>
                    {!usesOpenAiOAuth ? (
                      <label className="field">
                        <span className="field-label">API Key</span>
                        <input
                          type="password"
                          value={currentProfile.apiKey}
                          onChange={(event) =>
                            updateActiveLlmProfile({ apiKey: event.target.value }, { showSaveStatus: true })
                          }
                          disabled={loading}
                          placeholder="sk-..."
                        />
                      </label>
                    ) : null}
                  </>
                )}
              </section>
            ) : null}

            <div className="debug-footer">
              <div className="debug-compact">
                <button
                  className={`debug-toggle${settings.debugOptionsExpanded ? ' debug-toggle-open' : ''}`}
                  onClick={() => updateField('debugOptionsExpanded', !settings.debugOptionsExpanded)}
                  type="button"
                >
                  <IconDebug />
                  调试选项
                  <svg className="debug-chevron" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 1L5 5L9 1" />
                  </svg>
                </button>
                {settings.debugOptionsExpanded && (
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
                        checked={settings.showEraseDebug}
                        onChange={(event) => updateField('showEraseDebug', event.target.checked)}
                        disabled={loading}
                      />
                      <span className="checkbox-label">去字调试</span>
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={settings.enableDebugLog}
                        onChange={(event) => updateField('enableDebugLog', event.target.checked)}
                        disabled={loading}
                      />
                      <span className="checkbox-label">日志记录</span>
                    </label>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
