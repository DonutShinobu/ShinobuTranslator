import {
  translationProviderOptions,
  type TranslationProviderId,
  type UiLocale,
  type WebSettings,
} from '@shinobu/shared-config';
import { Icon } from '../../icons';
import type { AppCopy } from '../../i18n';
import type { ProviderSecretEntry } from '../providers/useProviderSecrets';
import {
  IMAGE_IMPORT_STORAGE_HEADROOM_BYTES,
  formatByteSize,
  type WebStorageSnapshot,
} from '../storage/storageBudget';

type ProviderProfile = WebSettings['providerProfiles'][TranslationProviderId];

type SettingsViewProps = {
  copy: AppCopy;
  settings: WebSettings;
  providerProfile: ProviderProfile;
  providerSecret: ProviderSecretEntry;
  providerValidationError: string | null;
  providerLocked: boolean;
  historyLocked: boolean;
  storageSnapshot: WebStorageSnapshot | null;
  storageChecking: boolean;
  diagnosticBusy: boolean;
  onLocaleChange(locale: UiLocale): void;
  onProviderChange(providerId: TranslationProviderId): void;
  onProviderProfileChange(patch: Partial<ProviderProfile>): void;
  onProviderKeyChange(value: string): void;
  onSetRememberDevice(remember: boolean): void;
  onDeleteProviderConfiguration(): void;
  onRefreshStorage(): void;
  onManageHistory(): void;
  onExportDiagnostics(): void;
};

export function SettingsView({
  copy,
  settings,
  providerProfile,
  providerSecret,
  providerValidationError,
  providerLocked,
  historyLocked,
  storageSnapshot,
  storageChecking,
  diagnosticBusy,
  onLocaleChange,
  onProviderChange,
  onProviderProfileChange,
  onProviderKeyChange,
  onSetRememberDevice,
  onDeleteProviderConfiguration,
  onRefreshStorage,
  onManageHistory,
  onExportDiagnostics,
}: SettingsViewProps) {
  const storageReady = storageSnapshot?.status === 'ready' ? storageSnapshot : null;
  const storageLow = (
    storageReady !== null
    && storageReady.availableBytes < IMAGE_IMPORT_STORAGE_HEADROOM_BYTES
  );

  return (
    <main className="settings-page">
      <header className="settings-page-heading">
        <div>
          <span className="section-kicker">Shinobu Web</span>
          <h1>{copy.settingsTitle}</h1>
          <p>{copy.settingsSubtitle}</p>
        </div>
        {providerLocked && (
          <div className="settings-lock-notice" role="status">
            <Icon name="clock" />
            <span>{copy.settingsLocked}</span>
          </div>
        )}
      </header>

      <div className="settings-layout">
        <section className="settings-panel settings-provider-panel">
          <div className="settings-panel-heading">
            <div>
              <span className="settings-panel-icon"><Icon name="settings" /></span>
              <div>
                <h2>{copy.providerSettingsTitle}</h2>
                <p>{copy.providerSettingsDetail}</p>
              </div>
            </div>
          </div>

          <form
            className="settings-form"
            onSubmit={(event) => event.preventDefault()}
          >
            <label className="field">
              <span>{copy.provider}</span>
              <select
                id="settings-provider"
                name="translation-provider"
                value={settings.translationProviderId}
                disabled={providerLocked}
                onChange={(event) =>
                  onProviderChange(event.target.value as TranslationProviderId)}
              >
                {translationProviderOptions.map((provider) => (
                  <option value={provider.id} key={provider.id}>{provider.label}</option>
                ))}
              </select>
              <small>{copy.providerHint}</small>
            </label>

            <div className="settings-field-grid">
              <label className="field">
                <span>{copy.baseUrl}</span>
                <input
                  id="settings-provider-base-url"
                  name="provider-base-url"
                  type="url"
                  value={providerProfile.baseUrl}
                  disabled={providerLocked}
                  spellCheck={false}
                  onChange={(event) => onProviderProfileChange({ baseUrl: event.target.value })}
                />
              </label>
              <label className="field">
                <span>{copy.model}</span>
                <input
                  id="settings-provider-model"
                  name="provider-model"
                  type="text"
                  value={providerProfile.model}
                  disabled={providerLocked}
                  spellCheck={false}
                  onChange={(event) => onProviderProfileChange({ model: event.target.value })}
                />
              </label>
            </div>

            <label className="field">
              <span>{copy.apiKey}</span>
              <input
                id="settings-provider-api-key"
                name="provider-api-key"
                type="password"
                value={providerSecret.value}
                disabled={providerLocked || providerSecret.busy}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => onProviderKeyChange(event.target.value)}
              />
              <small>
                {providerSecret.persistence === 'device'
                  ? copy.deviceKeyHint
                  : copy.sessionKeyHint}
              </small>
              {providerSecret.restoreStatus === 'restoring' && (
                <small>{copy.deviceKeyRestoring}</small>
              )}
              {providerSecret.restoreStatus === 'target-mismatch' && (
                <small className="field-error" role="alert">
                  {copy.deviceKeyTargetMismatch}
                </small>
              )}
              {providerSecret.restoreStatus === 'corrupt' && (
                <small className="field-error" role="alert">
                  {copy.deviceKeyCorrupt}
                </small>
              )}
              {providerSecret.error && (
                <small className="field-error" role="alert">
                  {providerSecret.error}
                </small>
              )}
            </label>

            <div className="provider-config-actions">
              <label className="remember-control">
                <input
                  id="settings-remember-device"
                  name="remember-provider-key"
                  type="checkbox"
                  checked={providerSecret.persistence === 'device'}
                  disabled={
                    providerLocked
                    || providerSecret.busy
                    || !providerSecret.value.trim()
                  }
                  onChange={(event) => onSetRememberDevice(event.target.checked)}
                />
                <span>{copy.rememberDevice}</span>
              </label>
              <button
                className="delete-config"
                type="button"
                disabled={providerLocked}
                onClick={onDeleteProviderConfiguration}
              >
                {copy.deleteProviderConfig}
              </button>
            </div>

            <div
              className="settings-status"
              data-state={providerValidationError === null ? 'ready' : 'error'}
              role="status"
            >
              <Icon name={providerValidationError === null ? 'check' : 'warning'} />
              <span>
                {providerValidationError === null
                  ? copy.providerReady
                  : providerValidationError}
              </span>
            </div>
          </form>
        </section>

        <aside className="settings-sidebar">
          <section className="settings-panel">
            <div className="settings-panel-heading">
              <div>
                <span className="settings-panel-icon"><Icon name="image" /></span>
                <div>
                  <h2>{copy.storageTitle}</h2>
                  <p>{copy.storageDetail}</p>
                </div>
              </div>
            </div>
            <div className="settings-panel-body storage-panel">
              {storageChecking && storageSnapshot === null ? (
                <p className="storage-state">{copy.storageChecking}</p>
              ) : storageReady ? (
                <>
                  <div className="storage-summary">
                    <strong>
                      {copy.storageUsage(
                        formatByteSize(storageReady.usageBytes),
                        formatByteSize(storageReady.quotaBytes),
                      )}
                    </strong>
                    <span>{copy.storageAvailable(formatByteSize(storageReady.availableBytes))}</span>
                  </div>
                  <progress
                    className="storage-meter"
                    max={Math.max(1, storageReady.quotaBytes)}
                    value={storageReady.usageBytes}
                    aria-label={copy.storageUsage(
                      formatByteSize(storageReady.usageBytes),
                      formatByteSize(storageReady.quotaBytes),
                    )}
                  />
                  <p className="storage-state" data-state={storageReady.persisted ? 'ready' : 'warning'}>
                    <Icon name={storageReady.persisted ? 'check' : 'warning'} />
                    <span>
                      {storageReady.persisted
                        ? copy.storagePersistent
                        : copy.storageTemporary}
                    </span>
                  </p>
                  {storageLow && (
                    <p className="storage-state" data-state="error" role="alert">
                      <Icon name="warning" />
                      <span>{copy.storageLow(formatByteSize(storageReady.availableBytes))}</span>
                    </p>
                  )}
                </>
              ) : (
                <p className="storage-state" data-state="error" role="alert">
                  <Icon name="warning" />
                  <span>{copy.storageUnavailable}</span>
                </p>
              )}
              <p className="settings-detail">{copy.storageManageHint}</p>
              <div className="settings-actions">
                <button
                  className="button button-secondary button-compact"
                  type="button"
                  disabled={storageChecking}
                  onClick={onRefreshStorage}
                >
                  {storageChecking ? copy.storageChecking : copy.storageRefresh}
                </button>
                <button
                  className="button button-secondary button-compact"
                  type="button"
                  disabled={historyLocked}
                  onClick={onManageHistory}
                >
                  {copy.storageManageHistory}
                </button>
              </div>
            </div>
          </section>

          <section className="settings-panel">
            <div className="settings-panel-heading">
              <div>
                <span className="settings-panel-icon"><Icon name="shield" /></span>
                <div>
                  <h2>{copy.interfaceLanguage}</h2>
                  <p>{copy.localMode}</p>
                </div>
              </div>
            </div>
            <div className="settings-panel-body">
              <div
                className="segmented-control locale-settings-control"
                role="radiogroup"
                aria-label={copy.interfaceLanguage}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.uiLocale === 'zh-CN'}
                  data-active={settings.uiLocale === 'zh-CN'}
                  onClick={() => onLocaleChange('zh-CN')}
                >
                  简体中文
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={settings.uiLocale === 'zh-TW'}
                  data-active={settings.uiLocale === 'zh-TW'}
                  onClick={() => onLocaleChange('zh-TW')}
                >
                  繁體中文
                </button>
              </div>
            </div>
          </section>

          <section className="settings-panel legal-section">
            <div className="settings-panel-heading">
              <div>
                <span className="settings-panel-icon"><Icon name="shield" /></span>
                <div>
                  <h2>{copy.legal}</h2>
                  <p>{copy.diagnosticsDetail}</p>
                </div>
              </div>
            </div>
            <div className="settings-panel-body">
              <nav aria-label={copy.legal}>
                <a href="/PRIVACY_POLICY.md" target="_blank" rel="noreferrer">
                  {copy.privacyPolicy}
                </a>
                <a href="/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">
                  {copy.thirdPartyNotices}
                </a>
                <a href="/WEB_TROUBLESHOOTING.md" target="_blank" rel="noreferrer">
                  {copy.troubleshooting}
                </a>
                <a
                  href="https://github.com/DonutShinobu/ShinobuTranslator"
                  target="_blank"
                  rel="noreferrer"
                >
                  {copy.sourceCode}
                </a>
              </nav>
              <div className="diagnostic-export">
                <strong>{copy.modelSources}</strong>
                <nav aria-label={copy.modelSources}>
                  <a
                    href="https://github.com/DonutShinobu/ShinobuTranslator/releases/tag/models-v0.7.0"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Shinobu models-v0.7.0 · GitHub Release
                  </a>
                  <a
                    href="https://github.com/zyddnys/manga-image-translator/releases/tag/beta-0.3"
                    target="_blank"
                    rel="noreferrer"
                  >
                    detector.onnx / aot_inpaint_512.onnx · manga-image-translator
                  </a>
                  <a
                    href="https://huggingface.co/huyvux3005/manga109-segmentation-bubble/tree/f9a4108c4955136a810e5e92207972f3fb3a65fd"
                    target="_blank"
                    rel="noreferrer"
                  >
                    bubble.onnx · manga109-segmentation-bubble
                  </a>
                  <a
                    href="https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx/tree/50c7eacafc52fa7bcf4194e8cd08e46f8558504b"
                    target="_blank"
                    rel="noreferrer"
                  >
                    PP-OCRv6_medium_rec.onnx / paddleocr_v6_dict.txt · PaddlePaddle
                  </a>
                </nav>
              </div>
              <div className="diagnostic-export">
                <strong>{copy.diagnostics}</strong>
                <p>{copy.diagnosticsDetail}</p>
                <button
                  className="inline-action"
                  type="button"
                  disabled={diagnosticBusy}
                  onClick={onExportDiagnostics}
                >
                  {diagnosticBusy ? copy.diagnosticsPreparing : copy.diagnosticsExport}
                </button>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
