import type { ReadingModeBarUi } from '../types';
import { createTranslationButton } from './translationButton';

export function createReadingModeBarUi(): ReadingModeBarUi {
  const host = document.createElement('div');
  host.className = 'mt-x-reading-bar';
  host.dataset.theme = 'light';

  const actions = document.createElement('div');
  actions.className = 'mt-x-reading-actions';

  const translateCurrentBtn = createTranslationButton('翻译当前页');
  translateCurrentBtn.dataset.theme = 'light';
  actions.appendChild(translateCurrentBtn);

  const translateAllBtn = createTranslationButton('翻译全部');
  translateAllBtn.dataset.theme = 'light';
  actions.appendChild(translateAllBtn);

  const errorLine = document.createElement('div');
  errorLine.className = 'mt-x-detail';
  errorLine.setAttribute('aria-live', 'polite');

  host.appendChild(actions);
  host.appendChild(errorLine);

  return { host, translateCurrentBtn, translateAllBtn, errorLine };
}
