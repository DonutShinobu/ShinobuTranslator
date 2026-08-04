import { useRef, type ChangeEvent } from 'react';
import type { AppCopy } from '../../i18n';
import { Icon } from '../../icons';
import type { WebWorkbenchHistoryEntry } from '../workbench/webWorkbench';

type HistoryViewProps = {
  copy: AppCopy;
  locale: 'zh-CN' | 'zh-TW';
  entries: readonly WebWorkbenchHistoryEntry[];
  loading: boolean;
  busy: boolean;
  error?: string;
  onRefresh(): void;
  onResume(batchId: string): void;
  onClone(batchId: string): void;
  onDownload(batchId: string, itemId: string): void;
  onExportResults(batchId: string): void;
  onExportProject(batchId: string): void;
  onImportProject(file: File): void;
  onKeepResults(batchId: string): void;
  onDelete(batchId: string): void;
};

function itemStatus(
  copy: AppCopy,
  status: WebWorkbenchHistoryEntry['items'][number]['status'],
): string {
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
          {entries.map((entry) => {
            const {
              id,
              updatedAt,
              status,
              rerunnable,
              itemCount,
              completedCount,
              processing,
              items,
              actions,
              integrity,
            } = entry;
            const canResume = actions.resume.status === 'available';
            return (
              <details className="history-batch" key={id}>
                <summary>
                  <div>
                    <strong>{copy.historyBatchImages(itemCount)}</strong>
                    <span>
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }).format(new Date(updatedAt))}
                    </span>
                  </div>
                  <div className="history-badges">
                    <span data-history-status={status}>
                      {copy.historyBatchStatus(status)}
                    </span>
                    <span>{completedCount} / {itemCount}</span>
                    {integrity === 'partial' && (
                      <span data-history-integrity="partial">{copy.historyPartial}</span>
                    )}
                    <Icon className="history-chevron" name="chevron-down" />
                  </div>
                </summary>

                <div className="history-batch-body">
                  <div className="history-config">
                    <span>{copy.processMode}: <strong>{processing.processMode}</strong></span>
                    <span>{copy.targetLanguage}: <strong>{processing.targetLanguage}</strong></span>
                    <span>{copy.provider}: <strong>{processing.providerId}</strong></span>
                    <span>{copy.historyModelVersion}: <strong>{processing.modelVersion}</strong></span>
                  </div>

                  <div className="history-items">
                    {items.map((item) => (
                      <div className="history-item" key={item.id}>
                        <div>
                          <strong>{item.fileName ?? `#${item.order + 1}`}</strong>
                          <span>
                            {item.width} × {item.height} · {itemStatus(copy, item.status)}
                          </span>
                          {item.error && <small role="alert">{item.error}</small>}
                        </div>
                        {item.hasResult ? (
                          <button
                            className="button button-secondary button-compact"
                            type="button"
                            onClick={() => onDownload(id, item.id)}
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
                        disabled={busy || actions.resume.status === 'blocked'}
                        onClick={() => onResume(id)}
                      >
                        <Icon name="play" weight="bold" />
                        {copy.historyResume}
                      </button>
                    )}
                    <button
                      className={`button ${canResume ? 'button-secondary' : 'button-primary'}`}
                      type="button"
                      disabled={
                        busy
                        || actions.clone.status === 'blocked'
                      }
                      onClick={() => onClone(id)}
                    >
                      <Icon name="copy" />
                      {copy.historyClone}
                    </button>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={busy || actions.exportResults.status === 'blocked'}
                      onClick={() => onExportResults(id)}
                    >
                      <Icon name="download" />
                      {copy.historyExportResults}
                    </button>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={busy || actions.exportProject.status === 'blocked'}
                      onClick={() => onExportProject(id)}
                    >
                      <Icon name="archive" />
                      {copy.historyExportProject}
                    </button>
                    {rerunnable && completedCount > 0 && (
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={busy || actions.keepResultsOnly.status === 'blocked'}
                        onClick={() => onKeepResults(id)}
                      >
                        <Icon name="archive" />
                        {copy.historyKeepResults}
                      </button>
                    )}
                    <button
                      className="delete-config"
                      type="button"
                      disabled={busy || actions.delete.status === 'blocked'}
                      onClick={() => onDelete(id)}
                    >
                      <Icon name="trash" />
                      {copy.historyDelete}
                    </button>
                    {!rerunnable && <span>{copy.historyResultsOnly}</span>}
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
