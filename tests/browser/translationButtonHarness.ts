import { createInitialPhotoState } from '../../apps/extension/src/content/core/state/photoStateStore';
import { createUiElements, renderUi } from '../../apps/extension/src/content/core/ui/imageControls';
import { createReadingModeBarUi } from '../../apps/extension/src/content/core/ui/readingModeBar';
import { createTranslationButton, destroyTranslationButton, updateTranslationButton } from '../../apps/extension/src/content/core/ui/translationButton';
import { injectStyles } from '../../apps/extension/src/content/core/ui/styles';
import type { ExtensionBrowserApi } from '../../apps/extension/src/shared/extensionRuntime';

(globalThis as typeof globalThis & { chrome: ExtensionBrowserApi }).chrome = {
  runtime: { getURL: path => `/${path}` },
};
injectStyles();

const stages = [
  '准备中', '获取图片中', '排队中', '加载图片中', '加载模型中', '文本检测中', '文字识别中',
  '大模型误识别过滤中', '翻译中 | 去字中', '翻译中 | 细化遮罩中', '翻译完成 | 去字中',
  '翻译中 | 去字完成', '文字排版中', 'Gemini 3.1 Flash Image Preview 全图翻译中',
];
const panels = ['light', 'dark'].map(theme => {
  const ui = createUiElements();
  ui.host.className = 'button-host';
  ui.overlay.dataset.theme = theme;
  document.getElementById(`${theme}-scene`)!.appendChild(ui.host);
  const state = createInitialPhotoState('/assets/readme/translated1.png');
  renderUi(ui, state);
  return { ui, state };
});
const themeCases = [
  { theme: 'dark', id: 'dark', ink: 'light', caption: '深色锚点黑背景' },
  { theme: 'light', id: 'light', ink: 'light', caption: '浅色锚点黑背景' },
  { theme: 'light', id: 'white', ink: 'dark', caption: '白背景' },
  { theme: 'light', id: 'gray', ink: undefined, caption: '中灰背景' },
  { theme: 'light', id: 'color', ink: 'light', caption: '饱和蓝背景' },
].map(config => {
  const ui = createUiElements();
  const anchor = document.createElement('div');
  anchor.className = 'button-host';
  anchor.dataset.theme = config.theme;
  anchor.appendChild(ui.host);
  document.getElementById(`${config.id}-anchor-case`)!.appendChild(anchor);
  const state = createInitialPhotoState('');
  state.status = 'running'; state.stageText = '文字识别中';
  renderUi(ui, state);
  return { ...config, ui, anchor };
});
const plainAnchor = document.createElement('div');
plainAnchor.className = 'button-host';
plainAnchor.dataset.theme = 'light';
const plainButton = createTranslationButton('翻译当前页');
plainAnchor.appendChild(plainButton);
document.getElementById('plain-button-case')!.appendChild(plainAnchor);
updateTranslationButton(plainButton, '翻译当前页', 'languages', false);
const reading = createReadingModeBarUi();
document.getElementById('reading-slot')!.appendChild(reading.host);
updateTranslationButton(reading.translateCurrentBtn, '翻译当前页', 'languages', false);
updateTranslationButton(reading.translateAllBtn, '翻译全部', 'languages', false);
const buttons = [...panels.map(panel => panel.ui.button), ...themeCases.map(panel => panel.ui.button), plainButton, reading.translateCurrentBtn, reading.translateAllBtn];
const result = document.getElementById('result')!;
const stageSelect = document.getElementById('stage') as HTMLSelectElement;
stageSelect.add(new Option('选择一个阶段', ''));
for (const text of stages) stageSelect.add(new Option(text, text));
let run = 0;
let disposed = false;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function renderStage(text: string, indices = [0, 1]) {
  if (disposed) return;
  for (const index of indices) {
    const panel = panels[index];
    panel.state.status = 'running';
    panel.state.stageText = text;
    renderUi(panel.ui, panel.state);
  }
  reading.translateCurrentBtn.dataset.status = 'running';
  updateTranslationButton(reading.translateCurrentBtn, text);
}

function reset() {
  run++;
  if (disposed) { location.reload(); return; }
  for (const { ui, state } of panels) {
    Object.assign(state, createInitialPhotoState(state.originalUrl));
    renderUi(ui, state);
  }
  reading.translateCurrentBtn.dataset.status = 'idle';
  updateTranslationButton(reading.translateCurrentBtn, '翻译当前页', 'languages', false);
  stageSelect.value = '';
}

function complete() {
  if (disposed) return;
  for (const { ui, state } of panels) {
    state.status = 'translated'; state.mode = 'translated'; state.elapsedText = '耗时 0.8s';
    renderUi(ui, state);
  }
  reading.translateCurrentBtn.dataset.status = 'idle';
  updateTranslationButton(reading.translateCurrentBtn, '翻译当前页', 'languages', false);
}

async function play() {
  if (disposed) return;
  const token = ++run;
  for (const text of ['准备中', '文本检测中', '文字识别中', '翻译中 | 去字中', '文字排版中']) {
    if (token !== run) return;
    renderStage(text);
    await wait(145);
  }
  if (token === run) complete();
}

function error() {
  run++;
  if (disposed) return;
  for (const { ui, state } of panels) {
    state.status = 'error'; state.errorText = '示例网络错误'; renderUi(ui, state);
  }
}

function destroy() {
  run++; disposed = true;
  for (const button of buttons) destroyTranslationButton(button);
  for (const { ui } of panels) ui.host.remove();
  for (const { anchor } of themeCases) anchor.remove();
  plainAnchor.remove();
  reading.host.remove();
  result.textContent = '控件已销毁。重置可重新载入。';
}

for (const { ui, state } of panels) ui.button.addEventListener('click', () => {
  if (state.status === 'translated' || state.status === 'showingOriginal') {
    state.mode = state.mode === 'translated' ? 'original' : 'translated';
    state.status = state.mode === 'translated' ? 'translated' : 'showingOriginal';
    renderUi(ui, state);
  } else void play();
});
reading.translateCurrentBtn.addEventListener('click', () => void play());
reading.translateAllBtn.addEventListener('click', () => void play());
document.getElementById('play')!.addEventListener('click', () => void play());
document.getElementById('complete')!.addEventListener('click', () => { run++; complete(); });
document.getElementById('error')!.addEventListener('click', error);
document.getElementById('reset')!.addEventListener('click', reset);
document.getElementById('destroy')!.addEventListener('click', destroy);
stageSelect.addEventListener('change', () => { run++; if (stageSelect.value) renderStage(stageSelect.value); });

// Finish the browser's real effects; checks do not depend on background rAF timing.
function finishAnimations() {
  for (const button of buttons) for (const animation of button.getAnimations({ subtree: true })) {
    try { animation.finish(); } catch { /* Infinite effects are not completion feedback. */ }
  }
}
async function finishEffects() {
  finishAnimations();
  await frames();
  // Layout/ResizeObserver can retarget the glass after the first effects finish.
  finishAnimations();
}

async function selfCheck() {
  if (disposed) throw new Error('Reload the harness after destroy before running checks.');
  await document.fonts.ready;
  const checks: string[] = [];
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };
  reset(); await finishEffects();
  const a = panels[0].ui, b = panels[1].ui;
  assert(buttons.every(button => button.classList.contains('mt-x-liquid')), '图片与阅读模式均使用实际液态按钮');
  plainButton.scrollIntoView({ block: 'center', behavior: 'instant' });
  await frames();
  const pressBounds = plainButton.getBoundingClientRect();
  const pressX = pressBounds.left + pressBounds.width / 2, pressY = pressBounds.top + pressBounds.height / 2;
  const pointer = (target: EventTarget, type: string, x = pressX, y = pressY) => target.dispatchEvent(new PointerEvent(type,
    { bubbles: true, pointerId: 91, pointerType: 'mouse', button: 0, clientX: x, clientY: y }));
  const rimSignature = () => [...plainButton.querySelectorAll('.mt-x-glass-overlay > image, .mt-x-glass-activity > image')].map(image => image.getAttribute('href')).join('|');
  const fixedRim = rimSignature();
  pointer(plainButton, 'pointerleave');
  pointer(plainButton, 'pointerdown'); await wait(140);
  assert(plainButton.dataset.glassPressed === '' && parseFloat(plainButton.style.scale) > 1
    && Number(plainButton.style.getPropertyValue('--lg-glow')) > .8
    && getComputedStyle(plainButton.querySelector('.mt-x-glass-material')!, '::before').backgroundImage.includes('radial-gradient'),
    '按住按钮弹性膨胀并呈现源码的局部白光');
  pointer(window, 'pointermove', pressX + 150, pressY + 80); await wait(140);
  const dragScale = plainButton.style.scale.split(' ').map(Number);
  assert(Math.abs(parseFloat(plainButton.style.translate)) > 1 && Math.abs(dragScale[0] - dragScale[1]) > .01
    && rimSignature() === fixedRim, '拖出时保留弹性拉伸与固定45度边缘光');
  pointer(window, 'pointercancel'); await wait(1400);
  assert(plainButton.dataset.glassPressed === undefined && !plainButton.style.scale && !plainButton.style.translate,
    '取消按压后回弹归位且不留下变换');
  plainButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(120);
  assert(plainButton.dataset.glassPressed === '' && parseFloat(plainButton.style.scale) > 1,
    '键盘Enter使用同一弹性按压反馈');
  plainButton.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  plainButton.disabled = true; await frames();
  assert(parseFloat(plainButton.style.scale) > 1, '点击后立即禁用仍保留松开回弹');
  await wait(1400); plainButton.disabled = false;
  assert(!plainButton.style.scale && !plainButton.style.translate, '回弹结束恢复原始按钮姿态');
  const plainMaterial = plainButton.querySelector<HTMLElement>('.mt-x-glass-material')!;
  const activity = plainButton.querySelector<SVGGElement>('.mt-x-glass-activity')!;
  const projection = plainButton.querySelector<SVGFEColorMatrixElement>("feColorMatrix[data-glass-light='pink']")!;
  const lightColor = plainButton.querySelector<SVGFEFloodElement>('.mt-x-glass-light-color')!;
  const lightBase = plainButton.querySelector<SVGRectElement>('.mt-x-glass-light-base')!;
  const lightHead = plainButton.querySelector<SVGCircleElement>("circle[data-glass-light='head']")!;
  const oppositeHead = plainButton.querySelector<SVGCircleElement>("circle[data-glass-light='opposite-head']")!;
  assert(activity && projection && Number(getComputedStyle(activity).opacity) === 1
    && getComputedStyle(lightColor).floodColor === 'rgb(255, 255, 255)' && Number(getComputedStyle(lightBase).opacity) === 1
    && getComputedStyle(plainMaterial, '::after').content === 'none',
    '闲置保留原始45度白光和完整高光范围');
  updateTranslationButton(plainButton, '翻译当前页', 'languages', true);
  assert(projection.getAttribute('values')!.split(' ').map(Number).slice(15, 17).every(value => Math.abs(value + Math.SQRT1_2) < .000001),
    '每轮翻译从45度主光的位置开始变粉移动');
  await wait(40);
  const intermediateColor = getComputedStyle(lightColor).floodColor;
  assert(intermediateColor !== 'rgb(255, 255, 255)' && intermediateColor !== 'rgb(241, 141, 198)',
    '同一层主光连续由白转粉，没有透明度交叉淡入');
  await wait(300);
  const lightPose = lightHead.getAttribute('transform');
  await wait(140);
  assert(Number(getComputedStyle(activity).opacity) === 1 && lightHead.getAttribute('transform') !== lightPose
    && getComputedStyle(lightColor).floodColor === 'rgb(241, 141, 198)' && rimSignature() === fixedRim,
    '运行时白主光切换为移动粉光，保留原始玻璃边缘几何');
  const angularTables = [...projection.parentElement!.querySelectorAll<SVGFEFuncAElement>(
    'feComponentTransfer[result="specular-direction"] feFuncA, feComponentTransfer[result="diffuse-direction"] feFuncA')]
    .map(table => table.getAttribute('tableValues')!.split(' ').map(Number));
  const headMatrix = lightHead.transform.baseVal.consolidate()!.matrix;
  const oppositeMatrix = oppositeHead.transform.baseVal.consolidate()!.matrix;
  assert(Number(getComputedStyle(lightBase).opacity) === 0 && angularTables.length === 2
    && angularTables.every(table => table[0] === 1 && table[128] === 0 && table[256] === 1
      && table.every((value, index) => value === table[256 - index]))
    && Math.abs(headMatrix.e + oppositeMatrix.e - plainButton.offsetWidth - 4) < .001
    && Math.abs(headMatrix.f + oppositeMatrix.f - plainButton.offsetHeight - 4) < .001,
    '运行时去掉整边底光，两处局部高光相隔半周同步移动');
  const straightPositions: number[] = [];
  let sampleFrame = 0;
  const sampleHead = () => {
    const normal = projection.getAttribute('values')!.split(' ').map(Number).slice(15, 17);
    if (normal[0] === 0 && normal[1] === -1) straightPositions.push(lightHead.transform.baseVal.consolidate()!.matrix.e);
    sampleFrame = requestAnimationFrame(sampleHead);
  };
  sampleFrame = requestAnimationFrame(sampleHead);
  await wait(2850); cancelAnimationFrame(sampleFrame);
  assert(straightPositions.length > 2 && Math.max(...straightPositions) - Math.min(...straightPositions) > 20,
    '上直边的法线不变时亮度峰仍沿边缘推进');
  const movingPose = lightHead.getAttribute('transform');
  updateTranslationButton(plainButton, '翻译当前页', 'languages', false);
  assert(lightHead.getAttribute('transform') === movingPose && Number(getComputedStyle(lightBase).opacity) === 0,
    '完成当帧保留当前光点位置，不瞬跳或提前铺亮整条直边');
  await wait(70);
  const returningPose = lightHead.getAttribute('transform');
  assert(returningPose !== movingPose, '完成后两处高光继续沿轮廓滑动归位');
  updateTranslationButton(plainButton, '翻译当前页', 'languages', true);
  assert(lightHead.getAttribute('transform') === returningPose && lightBase.style.opacity === '0',
    '新任务打断归位时从当前位置继续，不重新跳回45度');
  await wait(100);
  updateTranslationButton(plainButton, '翻译当前页', 'languages', false);
  await wait(640);
  const stoppedPose = lightHead.getAttribute('transform');
  await wait(60);
  assert(getComputedStyle(lightColor).floodColor === 'rgb(255, 255, 255)' && Number(getComputedStyle(lightBase).opacity) === 1
    && projection.getAttribute('values')!.split(' ').map(Number).slice(15, 17).every(value => Math.abs(Math.abs(value) - Math.SQRT1_2) < .000001)
    && lightHead.getAttribute('transform') === stoppedPose, '归位完成后恢复45度双白光和原范围，动画停止');
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext('2d')!;
  const foregroundsOf = (button: HTMLButtonElement) => [...button.querySelectorAll(
    '.mt-x-label-slot, .mt-x-label, .mt-x-icon, .mt-x-icon svg, [torph-item]')];
  const hasUniformForeground = (button: HTMLButtonElement) => {
    const color = getComputedStyle(button).color;
    return foregroundsOf(button).every(element => getComputedStyle(element).color === color)
      && [...button.querySelectorAll('.mt-x-icon path')].every(path => getComputedStyle(path).stroke === color);
  };
  const materialAppearance = (button: HTMLButtonElement) => {
    const css = getComputedStyle(button.querySelector('.mt-x-glass-material')!);
    const colorAlpha = (color: string) => {
      const rgba = color.match(/^rgba\([^)]*,\s*([\d.]+)\)$/u);
      const slash = color.match(/\/\s*([\d.]+)\s*\)$/u);
      return color === 'transparent' ? 0 : Number(rgba?.[1] ?? slash?.[1] ?? 1);
    };
    const backdropFilter = button.querySelector('filter[id^="mt-x-lens-"]');
    const flood = backdropFilter?.querySelector('feFlood');
    const floodCss = flood && getComputedStyle(flood);
    const floodAlpha = floodCss ? colorAlpha(floodCss.floodColor) * Number(floodCss.floodOpacity) : 0;
    return { tint: css.backgroundColor, tintVar: getComputedStyle(button).getPropertyValue('--mt-glass-tint'),
      flood: floodCss?.floodColor, floodOpacity: floodCss?.floodOpacity,
      tone: backdropFilter?.querySelector('feFuncR')?.getAttribute('tableValues')?.split(' ').map(Number),
      alpha: 1 - (1 - colorAlpha(css.backgroundColor)) * (1 - floodAlpha), filter: css.backdropFilter, shadow: css.boxShadow };
  };
  const colorCases = [...themeCases.map(({ caption, ink, ui }) => ({ button: ui.button, ink, sampled: true,
    message: `${caption}按真实背景选择实心文字与图标颜色` })),
  { button: plainButton, ink: 'dark', sampled: false, message: '普通阅读按钮继承最近浅色锚点的深色实心字与图标' }];
  for (const { button, ink, sampled, message } of colorCases) {
    button.scrollIntoView({ block: 'center', behavior: 'instant' });
    await finishEffects();
    const color = getComputedStyle(button).color;
    colorContext.fillStyle = color; colorContext.fillRect(0, 0, 1, 1);
    const rgba = colorContext.getImageData(0, 0, 1, 1).data;
    const brightness = (rgba[0] + rgba[1] + rgba[2]) / (255 * 3);
    const foregrounds = foregroundsOf(button);
    const actualInk = sampled ? button.dataset.ink : ink;
    const hasExpectedMark = sampled ? button.dataset.contrast === 'sampled'
      && (actualInk === 'light' || actualInk === 'dark' || (!ink && actualInk === 'balanced')) && (!ink || ink === actualInk)
      : !button.dataset.ink && !button.dataset.contrast;
    const hasExpectedBrightness = actualInk === 'light' ? brightness > .7
      : actualInk === 'balanced' ? brightness >= .35 && brightness <= .7 : brightness < .35;
    assert(hasExpectedMark && hasExpectedBrightness
      && hasUniformForeground(button), message);
    assert(getComputedStyle(button).textShadow === 'none'
      && foregrounds.every(element => getComputedStyle(element).textShadow === 'none')
      && getComputedStyle(button.querySelector('.mt-x-icon svg')!).filter === 'none', `${message}没有文字阴影或图标阴影`);
  }
  document.getElementById('light-scene')!.scrollIntoView({ block: 'center', behavior: 'instant' });
  await finishEffects();
  const backdrop = document.querySelector<HTMLImageElement>('#light-scene > img')!;
  const originalSource = backdrop.getAttribute('src')!;
  const originalFilter = backdrop.style.filter;
  let samplingFilter: SVGSVGElement | undefined;
  const loadBackdrop = (src: string) => new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      backdrop.removeEventListener('load', loaded); backdrop.removeEventListener('error', failed);
      if (error) reject(error); else resolve();
    };
    const loaded = () => finish();
    const failed = () => finish(new Error('示例背景未能载入'));
    const timeout = setTimeout(() => finish(new Error('示例背景载入超时')), 3000);
    backdrop.addEventListener('load', loaded); backdrop.addEventListener('error', failed);
    backdrop.src = src;
  });
  let followsBackdropLoad = false;
  let fixedTransparentMaterial = false;
  let transparentFallback = false;
  let materialSignature = '';
  try {
    colorContext.fillStyle = '#fff'; colorContext.fillRect(0, 0, 1, 1);
    await loadBackdrop(colorCanvas.toDataURL()); await finishEffects();
    const whiteInk = a.button.dataset.ink;
    const whiteMaterial = materialAppearance(a.button);
    materialSignature = JSON.stringify(whiteMaterial);
    colorContext.fillStyle = '#000'; colorContext.fillRect(0, 0, 1, 1);
    await loadBackdrop(colorCanvas.toDataURL()); await finishEffects();
    const blackMaterial = materialAppearance(a.button);
    followsBackdropLoad = whiteInk === 'dark' && a.button.dataset.ink === 'light'
      && a.button.dataset.contrast === 'sampled' && hasUniformForeground(a.button);
    fixedTransparentMaterial = JSON.stringify(whiteMaterial) === JSON.stringify(blackMaterial)
      && whiteMaterial.alpha <= .1 && whiteMaterial.tone?.length === 33
      && Math.abs(whiteMaterial.tone[0] - .1848) < .00001 && whiteMaterial.tone[32] === 1
      && !/\b(?:contrast|brightness)\(/u.test(whiteMaterial.filter);

    // An SVG source filter is visible but cannot be reproduced by canvas sampling.
    // Use a local identity filter to exercise the real unreadable-source fallback without a network request.
    const ns = 'http://www.w3.org/2000/svg';
    samplingFilter = document.createElementNS(ns, 'svg');
    samplingFilter.setAttribute('style', 'position:absolute;width:0;height:0;pointer-events:none');
    const defs = document.createElementNS(ns, 'defs');
    const identity = document.createElementNS(ns, 'filter');
    identity.id = 'harness-unsampleable-image';
    const matrix = document.createElementNS(ns, 'feColorMatrix');
    matrix.setAttribute('type', 'saturate'); matrix.setAttribute('values', '1');
    identity.appendChild(matrix); defs.appendChild(identity); samplingFilter.appendChild(defs);
    document.body.appendChild(samplingFilter);
    const previousInk = a.button.dataset.ink;
    backdrop.style.filter = `url(#${identity.id})`;
    colorContext.fillStyle = '#fff'; colorContext.fillRect(0, 0, 1, 1);
    await loadBackdrop(colorCanvas.toDataURL()); await finishEffects();
    transparentFallback = a.button.dataset.contrast === 'fallback' && a.button.dataset.ink === previousInk
      && hasUniformForeground(a.button) && JSON.stringify(materialAppearance(a.button)) === JSON.stringify(blackMaterial);
  } finally {
    finishAnimations();
    if (originalFilter) backdrop.style.filter = originalFilter; else backdrop.style.removeProperty('filter');
    samplingFilter?.remove();
    await loadBackdrop(originalSource); await finishEffects();
  }
  assert(followsBackdropLoad, '图片重新载入后自动按白黑背景切换整颗墨色');
  assert(fixedTransparentMaterial && materialSignature === JSON.stringify(materialAppearance(a.button)),
    '白黑与漫画背景仅改变整颗墨色，Clear透光曲线与滤镜阴影保持一致');
  assert(transparentFallback, '无法取样的图片保留上次统一墨色与通透材质');
  renderStage('文字识别中'); await finishEffects();
  const shared = [...a.buttonLabel.querySelectorAll('[torph-item]:not([torph-exiting])')].filter(node => node.textContent === '中' || node.textContent === '字');
  assert(shared.length === 2, '中文文案按字素创建');
  renderStage('翻译中 | 去字中', [1]);
  const otherAnimations = b.buttonLabel.getAnimations({ subtree: true });
  renderStage('翻译中 | 去字中', [0]);
  const current = new Set(a.buttonLabel.querySelectorAll('[torph-item]:not([torph-exiting])'));
  assert(shared.every(node => current.has(node)), '共有中文字沿用原节点');
  assert(otherAnimations.every(animation => animation.playState !== 'idle'), '两个图片按钮更新互不取消');
  let consistentDuringSwitch = true;
  for (const text of ['翻译中 | 细化遮罩中', '文字排版中', '翻译中 | 去字完成']) {
    renderStage(text);
    consistentDuringSwitch &&= panels.every(({ ui }) => hasUniformForeground(ui.button));
  }
  await finishEffects();
  assert(consistentDuringSwitch && panels.every(({ ui }) => hasUniformForeground(ui.button)),
    '复杂漫画背景上的图标与全部文字在切换前后始终整体同色');
  assert(buttons.every(button => !button.querySelector('[torph-exiting]')), '快速连续切换后没有出场文字残留');
  assert(panels.every(({ ui }) => ui.button.disabled && ui.button.getAttribute('aria-busy') === 'true'), '运行态禁用点击并保留忙碌语义');
  assert(buttons.every(button => !button.querySelector('.mt-x-spinner')), '图标旁没有旋转加载圈');
  complete();
  assert(panels.every(({ ui }) => ui.button.dataset.phase === 'confirm'), '翻译完成立即呈现独立确认图标');
  finishAnimations();
  assert(panels.every(({ ui }) => hasUniformForeground(ui.button) && [ui.button, ui.buttonIcon, ui.buttonLabel,
    ...ui.buttonLabel.querySelectorAll('[torph-item]:not([torph-exiting])')].every(element => {
    colorContext.fillStyle = getComputedStyle(element).color; colorContext.fillRect(0, 0, 1, 1);
    const rgba = colorContext.getImageData(0, 0, 1, 1).data;
    return !(rgba[1] > rgba[0] && rgba[1] > rgba[2]);
  })), '完成反馈继续使用自适应实心墨色，不变成绿色');
  const completionWidths = panels.map(({ ui }) => ui.button.getBoundingClientRect().width);
  assert(completionWidths.every(width => width < 90), '完成文案自然缩窄');
  assert(panels.every(({ ui }) => parseFloat(getComputedStyle(ui.button).minWidth) === 0), '按钮没有固定最小宽度');
  a.button.click(); await finishEffects();
  assert(panels[0].state.status === 'showingOriginal' && a.button.getAttribute('aria-label') === '显示译图', '完成反馈期间点击可立即切换原图');
  error(); await finishEffects();
  assert(panels.every(({ ui }) => ui.button.dataset.phase === 'retry' && !ui.button.disabled), '失败可重试且图标独立');
  const disposable = createUiElements();
  disposable.overlay.dataset.theme = 'light';
  document.getElementById('light-scene')!.appendChild(disposable.host);
  const disposableState = createInitialPhotoState('');
  disposableState.status = 'running'; disposableState.stageText = '文字识别中';
  renderUi(disposable, disposableState); await frames();
  const material = disposable.button.querySelector<HTMLElement>('.mt-x-glass-material')!;
  const disposableProjection = disposable.button.querySelector<SVGFEColorMatrixElement>("feColorMatrix[data-glass-light='pink']")!;
  const disposableLight = disposable.button.querySelector<SVGFEFloodElement>('.mt-x-glass-light-color')!;
  destroyTranslationButton(disposable.button);
  const lastPose = disposableProjection.getAttribute('values');
  await wait(80);
  assert(!material.isConnected && disposableLight.style.floodColor === 'rgb(255, 255, 255)'
    && disposableProjection.getAttribute('values') === lastPose, '销毁控件后光照停止且材质移除');
  const remaining = disposable.button.getAnimations({ subtree: true });
  assert(remaining.length === 0, `销毁控件后没有动画残留${remaining.length ? `：${remaining.map(animation =>
    `${animation.constructor.name}/${'transitionProperty' in animation ? animation.transitionProperty : 'WAAPI'}`).join(', ')}` : ''}`);
  disposable.host.remove();
  window.scrollTo({ top: 0, behavior: 'instant' });
  reset(); await finishEffects();
  result.textContent = `${checks.length} 项检查通过`;
  return { passed: checks.length, checks, completionWidths };
}

document.getElementById('check')!.addEventListener('click', () => {
  void selfCheck().catch(error => { result.textContent = String(error); throw error; });
});
Object.assign(window, { translationButtonHarness: { panels, themeCases, plainButton, reading, buttons, stages, play, renderStage, reset, complete, error, destroy, selfCheck } });
