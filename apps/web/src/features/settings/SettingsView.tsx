import type { UiLocale, WebSettings } from '@shinobu/shared-config';
import { Icon } from '../../icons';
import type { AppCopy } from '../../i18n';
import {
  IMAGE_IMPORT_STORAGE_HEADROOM_BYTES,
  formatByteSize,
  type WebStorageSnapshot,
} from '../storage/storageBudget';

type SettingsViewProps = {
  copy: AppCopy;
  settings: WebSettings;
  historyLocked: boolean;
  storageSnapshot: WebStorageSnapshot | null;
  storageChecking: boolean;
  diagnosticBusy: boolean;
  onLocaleChange(locale: UiLocale): void;
  onRefreshStorage(): void;
  onManageHistory(): void;
  onExportDiagnostics(): void;
};

export function SettingsView({
  copy,
  settings,
  historyLocked,
  storageSnapshot,
  storageChecking,
  diagnosticBusy,
  onLocaleChange,
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
        <h1>{copy.settingsTitle}</h1>
      </header>

      <div className="settings-layout">
        <section className="settings-panel">
          <div className="settings-panel-heading">
            <div>
              <span className="settings-panel-icon"><Icon name="storage" /></span>
              <h2>{copy.storageTitle}</h2>
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
            <div className="settings-actions">
              <button
                className="button button-secondary button-compact"
                type="button"
                disabled={storageChecking}
                onClick={onRefreshStorage}
              >
                <Icon name="refresh" />
                {storageChecking ? copy.storageChecking : copy.storageRefresh}
              </button>
              <button
                className="button button-secondary button-compact"
                type="button"
                disabled={historyLocked}
                onClick={onManageHistory}
              >
                <Icon name="clock" />
                {copy.storageManageHistory}
              </button>
            </div>
          </div>
        </section>

        <section className="settings-panel">
          <div className="settings-panel-heading">
            <div>
              <span className="settings-panel-icon"><Icon name="language" /></span>
              <h2>{copy.interfaceLanguage}</h2>
            </div>
          </div>
          <div className="settings-panel-body">
            <div
              className="segmented-control locale-settings-control"
              data-mode={settings.uiLocale}
              role="radiogroup"
              aria-label={copy.interfaceLanguage}
            >
              <span
                className="segmented-indicator"
                data-mode={settings.uiLocale}
                aria-hidden="true"
              />
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
              <h2>{copy.legal}</h2>
            </div>
          </div>
          <div className="settings-panel-body legal-panel-body">
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
                  href="https://github.com/DonutShinobu/ShinobuTranslator/releases/tag/models-v0.8.3"
                  target="_blank"
                  rel="noreferrer"
                >
                  Shinobu models-v0.8.3 · GitHub Release
                </a>
                <a
                  href="https://github.com/zyddnys/manga-image-translator/releases/tag/beta-0.3"
                  target="_blank"
                  rel="noreferrer"
                >
                  detector.ort source / aot_inpaint_512.onnx · manga-image-translator
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
            <button
              className="inline-action"
              type="button"
              disabled={diagnosticBusy}
              onClick={onExportDiagnostics}
            >
              <Icon name="download" />
              {diagnosticBusy ? copy.diagnosticsPreparing : copy.diagnosticsExport}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
