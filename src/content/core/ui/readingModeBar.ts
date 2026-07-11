import type { ReadingModeBarUi } from '../types';
import { ICONS } from './icons';

export function createReadingModeBarUi(): ReadingModeBarUi {
  const host = document.createElement('div');
  host.className = 'mt-x-reading-bar';
  host.dataset.theme = 'light';

  const translateCurrentBtn = document.createElement('button');
  translateCurrentBtn.className = 'mt-x-control';
  translateCurrentBtn.type = 'button';
  translateCurrentBtn.dataset.theme = 'light';
  const currentIcon = document.createElement('span');
  currentIcon.className = 'mt-x-icon';
  currentIcon.innerHTML = ICONS.translate;
  const currentSpinner = document.createElement('span');
  currentSpinner.className = 'mt-x-spinner';
  currentSpinner.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>';
  const currentLabel = document.createElement('span');
  currentLabel.className = 'mt-x-label';
  currentLabel.textContent = '翻译当前页';
  translateCurrentBtn.appendChild(currentIcon);
  translateCurrentBtn.appendChild(currentSpinner);
  translateCurrentBtn.appendChild(currentLabel);
  host.appendChild(translateCurrentBtn);

  const translateAllBtn = document.createElement('button');
  translateAllBtn.className = 'mt-x-control';
  translateAllBtn.type = 'button';
  translateAllBtn.dataset.theme = 'light';
  const allIcon = document.createElement('span');
  allIcon.className = 'mt-x-icon';
  allIcon.innerHTML = ICONS.translate;
  const allSpinner = document.createElement('span');
  allSpinner.className = 'mt-x-spinner';
  allSpinner.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>';
  const allLabel = document.createElement('span');
  allLabel.className = 'mt-x-label';
  allLabel.textContent = '翻译全部';
  translateAllBtn.appendChild(allIcon);
  translateAllBtn.appendChild(allSpinner);
  translateAllBtn.appendChild(allLabel);
  host.appendChild(translateAllBtn);

  return { host, translateCurrentBtn, translateAllBtn };
}
