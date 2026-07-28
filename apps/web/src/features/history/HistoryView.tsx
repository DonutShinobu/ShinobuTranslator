import { useRef, type ChangeEvent } from 'react';
import type { AppCopy } from '../../i18n';
import { Icon } from '../../icons';
import type {
  LocalHistoryAsset,
  LocalHistoryBatch,
  LocalHistoryInspection,
  LocalHistoryItemStatus,
} from './localHistory';

type HistoryViewProps = {
  copy: AppCopy;
  locale: 'zh-CN' | 'zh-TW';
  entries: LocalHistoryInspection[];
  loading: boolean;
  busy: boolean;
  error?: string;
  onRefresh(): void;
  onResume(batch: LocalHistoryBatch): void;
  onClone(batch: LocalHistoryBatch): void;
  onDownload(reference: LocalHistoryAsset): void;
  onExportResults(inspection: LocalHistoryInspection): void;
  onExportProject(inspection: LocalHistoryInspection): void;
  onImportProject(file: File): void;
  onKeepResults(batch: LocalHistoryBatch): void;
  onDelete(batch: LocalHistoryBatch): void;
};

function itemStatus(copy: AppCopy, status: LocalHistoryItemStatus): string {
  if (status === 'queued') return copy.statusQueued;
  if (status === 'running') return copy.statusRunning;
  if (status === 'done') return copy.statusDone;
  if (status === 'failed') return copy.statusFailed;
  return copy.statusCancelled;
}

export function HistoryView({
  copy,
  locale,
  entries,
  loading,
  busy,
  error,
  onRefresh,
  onResume,
  onClone,
  onDownload,
  onExportResults,
  onExportProject,
  onImportProject,
  onKeepResults,
  onDelete,
}: HistoryViewProps) {
  const importInputRef = useRef<HTMLInputElement>(null);
  const handleImport = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) onImportProject(file);
  };

  return (
    <main className="history-page">
      <div className="history-heading">
        <h1>{copy.historyTitle}</h1>
        <div className="history-heading-actions">
          <input
            ref={importInputRef}
            className="visually-hidden"
            type="file"
            accept=".shinobu.zip,application/zip"
            onChange={handleImport}
          />
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => importInputRef.current?.click()}
          >
            <Icon name="upload" />
            {copy.historyImportProject}
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={loading || busy}
            onClick={onRefresh}
          >
            <Icon name="refresh" />
            {copy.historyRefresh}
          </button>
        </div>
      </div>

      {error && (
        <div className="history-error" role="alert">
          <strong>{copy.historyStorageError}</strong>
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="history-empty">{copy.historyLoading}</div>
      ) : entries.length === 0 ? (
        <div className="history-empty">
          <div className="preview-empty-symbol"><Icon name="clock" /></div>
          <h2>{copy.historyEmptyTitle}</h2>
          <p>{copy.historyEmptyBody}</p>
        </div>
      ) : (
        <div className="history-list">
          {entries.map((inspection) => {
            const { batch, integrity } = inspection;
            const completed = batch.items.filter((item) => item.status === 'done').length;
            const canResume = (
              batch.rerunnable
              && integrity === 'complete'
              && batch.items.some((item) => item.status !== 'done')
            );
            return (
              <details className="history-batch" key={batch.id}>
                <summary>
                  <div>
                    <strong>{copy.historyBatchImages(batch.items.length)}</strong>
                    <span>
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(batch.updatedAt))}
                    </span>
                  </div>
                  <div className="history-badges">
                    <span data-history-status={batch.status}>
                      {copy.historyBatchStatus(batch.status)}
                    </span>
                    <span>{completed} / {batch.items.length}</span>
                    {integrity === 'partial' && (
                      <span data-history-integrity="partial">{copy.historyPartial}</span>
                    )}
                    <Icon className="history-chevron" name="chevron-down" />
                  </div>
                </summary>

                <div className="history-batch-body">
                  <div className="history-config">
                    <span>{copy.processMode}: <strong>{batch.settings.processMode}</strong></span>
                    <span>{copy.targetLanguage}: <strong>{batch.settings.targetLanguage}</strong></span>
                    <span>{copy.provider}: <strong>{batch.settings.translationProviderId}</strong></span>
                    <span>{copy.historyModelVersion}: <strong>{batch.versions.model}</strong></span>
                  </div>

                  <div className="history-items">
                    {batch.items.map((item) => (
                      <div className="history-item" key={item.id}>
                        <div>
                          <strong>{item.original?.fileName ?? `#${item.order + 1}`}</strong>
                          <span>
                            {item.width} × {item.height} · {itemStatus(copy, item.status)}
                          </span>
                          {item.error && <small role="alert">{item.error}</small>}
                        </div>
                        {item.result ? (
                          <button
                            className="button button-secondary button-compact"
                            type="button"
                            onClick={() => onDownload(item.result!)}
                          >
                            <Icon name="download" />
                            {copy.historyDownloadResult}
                          </button>
                        ) : (
                          <span className="history-no-result">{copy.historyNoResult}</span>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="history-actions">
                    {canResume && (
                      <button
                        className="button button-primary"
                        type="button"
                        disabled={busy}
                        onClick={() => onResume(batch)}
                      >
                        <Icon name="play" weight="bold" />
                        {copy.historyResume}
                      </button>
                    )}
                    <button
                      className={`button ${canResume ? 'button-secondary' : 'button-primary'}`}
                      type="button"
                      disabled={busy || !batch.rerunnable || integrity === 'partial'}
                      onClick={() => onClone(batch)}
                    >
                      <Icon name="copy" />
                      {copy.historyClone}
                    </button>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={busy || completed === 0}
                      onClick={() => onExportResults(inspection)}
                    >
                      <Icon name="download" />
                      {copy.historyExportResults}
                    </button>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={busy || integrity === 'partial'}
                      onClick={() => onExportProject(inspection)}
                    >
                      <Icon name="archive" />
                      {copy.historyExportProject}
                    </button>
                    {batch.rerunnable && completed > 0 && (
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => onKeepResults(batch)}
                      >
                        <Icon name="archive" />
                        {copy.historyKeepResults}
                      </button>
                    )}
                    <button
                      className="delete-config"
                      type="button"
                      disabled={busy}
                      onClick={() => onDelete(batch)}
                    >
                      <Icon name="trash" />
                      {copy.historyDelete}
                    </button>
                    {!batch.rerunnable && <span>{copy.historyResultsOnly}</span>}
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      )}
    </main>
  );
}
