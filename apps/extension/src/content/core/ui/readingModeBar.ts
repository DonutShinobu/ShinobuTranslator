import type { ReadingModeBarUi } from '../types';
import { createIcon, replaceIcon } from './icons';

export function createReadingModeBarUi(): ReadingModeBarUi {
  const host = document.createElement('div');
  host.className = 'mt-x-reading-bar';
  host.dataset.theme = 'light';

  const actions = document.createElement('div');
  actions.className = 'mt-x-reading-actions';

  const translateCurrentBtn = document.createElement('button');
  translateCurrentBtn.className = 'mt-x-control';
  translateCurrentBtn.type = 'button';
  translateCurrentBtn.dataset.theme = 'light';
  const currentIcon = document.createElement('span');
  currentIcon.className = 'mt-x-icon';
  replaceIcon(currentIcon, 'translate');
  const currentSpinner = document.createElement('span');
  currentSpinner.className = 'mt-x-spinner';
  currentSpinner.appendChild(createIcon('spinner'));
  const currentLabel = document.createElement('span');
  currentLabel.className = 'mt-x-label';
  currentLabel.textContent = '翻译当前页';
  translateCurrentBtn.appendChild(currentIcon);
  translateCurrentBtn.appendChild(currentSpinner);
  translateCurrentBtn.appendChild(currentLabel);
  actions.appendChild(translateCurrentBtn);

  const translateAllBtn = document.createElement('button');
  translateAllBtn.className = 'mt-x-control';
  translateAllBtn.type = 'button';
  translateAllBtn.dataset.theme = 'light';
  const allIcon = document.createElement('span');
  allIcon.className = 'mt-x-icon';
  replaceIcon(allIcon, 'translate');
  const allSpinner = document.createElement('span');
  allSpinner.className = 'mt-x-spinner';
  allSpinner.appendChild(createIcon('spinner'));
  const allLabel = document.createElement('span');
  allLabel.className = 'mt-x-label';
  allLabel.textContent = '翻译全部';
  translateAllBtn.appendChild(allIcon);
  translateAllBtn.appendChild(allSpinner);
  translateAllBtn.appendChild(allLabel);
  actions.appendChild(translateAllBtn);

  const errorLine = document.createElement('div');
  errorLine.className = 'mt-x-detail';
  errorLine.setAttribute('aria-live', 'polite');

  host.appendChild(actions);
  host.appendChild(errorLine);

  return { host, translateCurrentBtn, translateAllBtn, errorLine };
}
