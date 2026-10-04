import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, firefox, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { getLlmThinkingControl, llmThinkingCapabilityKey } from '@shinobu/text-translation';
import { optimizedGeminiAppPromptTemplate } from '../../apps/extension/src/shared/config';
import type {} from './fixtures/popupPreview';

// Run with: npm run check:popup-ui [-- --browser=chromium|firefox]
// Browser binaries: npx playwright install chromium firefox
const requestedBrowser = process.argv.find((arg) => arg.startsWith('--browser='))?.slice(10);
const availableBrowsers = { chromium, firefox };
if (requestedBrowser && requestedBrowser !== 'chromium' && requestedBrowser !== 'firefox') {
  throw new Error('Use --browser=chromium or --browser=firefox');
}
const browserNames: Array<keyof typeof availableBrowsers> = requestedBrowser
  ? [requestedBrowser as keyof typeof availableBrowsers]
  : ['chromium', 'firefox'];
const outputDirectory = resolve('artifacts/popup-shadcn');
await mkdir(outputDirectory, { recursive: true });

const server = await createServer({
  configFile: false,
  root: resolve('.'),
  publicDir: resolve('public'),
  plugins: [react(), tailwindcss()],
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, watch: null },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('Preview server did not start');
const origin = `http://127.0.0.1:${address.port}`;

async function projection(page: Page) {
  return page.evaluate(() => window.__popupPreview.getProjection());
}

async function selectOption(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function openPreview(page: Page, state: string, expanded = true) {
  await page.goto(
    `${origin}/tests/extension/fixtures/popupPreview.html?state=${state}&debug=${expanded ? 1 : 0}`,
  );
  await expect(page.getByRole('radiogroup', { name: '服务', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function checkInteractions(page: Page) {
  await openPreview(page, 'deepseek');
  const language = page.getByRole('radiogroup', { name: '语言', exact: true });
  await language.getByRole('radio', { name: '繁体中文' }).click();
  await expect.poll(async () => (await projection(page)).settings.targetLang).toBe('zh-CHT');
  await language.getByRole('radio', { name: '繁体中文' }).click();
  await expect(language.getByRole('radio', { name: '繁体中文' })).toBeChecked();
  const mode = page.getByRole('radiogroup', { name: '模式', exact: true });
  for (const [label, value] of [
    ['原文', 'original'],
    ['去字', 'erase'],
    ['翻译', 'translate'],
  ]) {
    await mode.getByRole('radio', { name: label, exact: true }).click();
    await expect.poll(async () => (await projection(page)).settings.processMode).toBe(value);
  }

  const modeOptions = page.getByRole('button', { name: '模式选项', exact: true });
  const imageEditing = page.getByRole('switch', { name: '直接编辑图片', exact: true });
  const modeBox = await mode.boundingBox();
  const popupBox = await page.locator('.popup').boundingBox();
  const browserName = page.context().browser()!.browserType().name();
  await expect(imageEditing).toHaveCount(0);
  await modeOptions.hover();
  await page.screenshot({
    path: resolve(outputDirectory, `${browserName}-mode-options-label-hover.png`),
    animations: 'disabled',
  });
  await page.locator('.mode-options-affordance').hover();
  await page.screenshot({
    path: resolve(outputDirectory, `${browserName}-mode-options-hover.png`),
    animations: 'disabled',
  });
  await modeOptions.click();
  await expect(imageEditing).toHaveAttribute('aria-checked', 'false');
  await expect(imageEditing).toBeFocused();
  const modeMenu = page.getByRole('dialog', { name: '模式选项', exact: true });
  expect(await modeMenu.evaluate((el) => getComputedStyle(el).animationName)).toContain('enter');
  const modeMenuBox = await modeMenu.boundingBox();
  expect(modeMenuBox!.y).toBeGreaterThanOrEqual(0);
  expect(modeMenuBox!.y + modeMenuBox!.height).toBeLessThanOrEqual(600);
  expect(await page.locator('.option-panel .seg-control').boundingBox()).toEqual(modeBox);
  expect(await page.locator('.popup').boundingBox()).toEqual(popupBox);
  await page.screenshot({
    path: resolve(outputDirectory, `${browserName}-image-editing-menu-off.png`),
    animations: 'disabled',
  });
  await modeMenu.getByText('直接编辑图片', { exact: true }).click();
  await expect.poll(async () => (await projection(page)).settings.enableImageEditing).toBe(true);
  await expect(imageEditing).toHaveAttribute('aria-checked', 'true');
  await expect(modeMenu).toBeVisible();
  expect(await mode.boundingBox()).toEqual(modeBox);
  expect(await page.locator('.popup').boundingBox()).toEqual(popupBox);
  await page.screenshot({
    path: resolve(outputDirectory, `${browserName}-image-editing-menu.png`),
    animations: 'disabled',
  });
  await imageEditing.press('Space');
  await expect.poll(async () => (await projection(page)).settings.enableImageEditing).toBe(false);
  await expect(imageEditing).toHaveAttribute('aria-checked', 'false');
  await expect(modeMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(imageEditing).toHaveCount(0);
  await expect(modeOptions).toBeFocused();
  await modeOptions.press('Enter');
  await expect(imageEditing).toHaveAttribute('aria-checked', 'false');
  await expect(imageEditing).toBeFocused();
  await imageEditing.press('Enter');
  await expect.poll(async () => (await projection(page)).settings.enableImageEditing).toBe(true);
  await imageEditing.press('Space');
  await expect.poll(async () => (await projection(page)).settings.enableImageEditing).toBe(false);
  await page.keyboard.press('Escape');
  await expect(imageEditing).toHaveCount(0);
  await expect(modeOptions).toBeFocused();
  await modeOptions.click();
  await expect(imageEditing).toBeVisible();
  await page.locator('.popup-header-brand').click();
  await expect(imageEditing).toHaveCount(0);
  expect((await projection(page)).settings.enableImageEditing).toBe(false);
  expect((await projection(page)).settings.processMode).toBe('translate');

  const slider = page.getByRole('slider', { name: '思考强度' });
  await slider.focus();
  await slider.press('End');
  const settings = (await projection(page)).settings;
  const control = getLlmThinkingControl(
    settings.llmProvider,
    settings.llmProfiles.deepseek.modelPreset,
  );
  if (control?.kind !== 'slider') throw new Error('DeepSeek fixture needs its thinking slider');
  const capabilityKey = llmThinkingCapabilityKey(
    settings.llmProvider,
    settings.llmProfiles.deepseek.modelPreset,
  );
  await expect
    .poll(async () => (await projection(page)).settings.llmThinkingByModel[capabilityKey])
    .toBe(control.options.at(-1)?.value);
  await expect(slider).toHaveAttribute('aria-valuetext', control.options.at(-1)!.label);
  await slider.press('Home');
  await expect
    .poll(async () => (await projection(page)).settings.llmThinkingByModel[capabilityKey])
    .toBe(control.options[0].value);
  const rail = await page.locator('.thinking-slider').boundingBox();
  if (!rail) throw new Error('Missing slider geometry');
  await page.mouse.move(rail.x + 11, rail.y + rail.height / 2);
  await page.mouse.down();
  await page.mouse.move(rail.x + rail.width - 11, rail.y + rail.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuenow', String(control.options.length - 1));

  await page.getByRole('checkbox', { name: '自定义模型' }).check();
  await expect(page.getByRole('slider', { name: '思考强度' })).toHaveCount(0);
  await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('test-custom-model');
  await expect
    .poll(async () => (await projection(page)).settings.llmProfiles.deepseek.modelCustom)
    .toBe('test-custom-model');
  await page.getByRole('checkbox', { name: '自定义模型' }).uncheck();
  await expect(page.getByRole('slider', { name: '思考强度' })).toBeVisible();

  await page.getByRole('checkbox', { name: '显示耗时', exact: true }).uncheck();
  await expect(page.getByRole('checkbox', { name: '阶段明细' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: '阶段明细' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: '日志记录' }).uncheck();
  await expect(page.getByRole('button', { name: '下载日志' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: '日志记录' }).check();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载日志' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^popup-test-log-.*\.log$/);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '清空日志' }).click();
  await expect.poll(() => page.evaluate(() => window.__popupPreview.logClears)).toBe(1);
  await page.getByRole('button', { name: '调试选项', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '显示耗时' })).not.toBeVisible();
  await expect.poll(async () => (await projection(page)).settings.debugOptionsExpanded).toBe(false);
  await page.getByRole('button', { name: '调试选项', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '显示耗时' })).toBeVisible();
  await page.getByRole('button', { name: '管理扩展命令' }).click();
  await expect.poll(() => page.evaluate(() => window.__popupPreview.shortcutOpens)).toBe(1);

  const service = page.getByRole('radiogroup', { name: '服务', exact: true });
  await service.getByRole('radio', { name: '谷歌翻译' }).click();
  await expect.poll(async () => (await projection(page)).settings.translator).toBe('google_web');
  await expect(modeOptions).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'LLM 提供商' })).toHaveCount(0);
  await service.getByRole('radio', { name: '大模型' }).click();
  const provider = page.getByRole('combobox', { name: 'LLM 提供商' });
  await provider.click();
  await expect(page.getByRole('option', { name: 'DeepSeek', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const menu = page.getByRole('listbox');
  const menuBox = await menu.boundingBox();
  expect(menuBox!.y).toBeGreaterThanOrEqual(0);
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(600);
  expect(await menu.evaluate((el) => getComputedStyle(el).animationName)).toContain('enter');
  await page.keyboard.press('Escape');
  await expect(provider).toBeFocused();
  await provider.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'DeepSeek', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: '自定义提供商', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await projection(page)).settings.llmProvider).toBe('custom');
  await page
    .getByRole('textbox', { name: 'Base URL', exact: true })
    .fill('https://api.example.com/test');
  await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('test-model');
  await expect
    .poll(async () => (await projection(page)).settings.llmProfiles.custom.customBaseUrl)
    .toBe('https://api.example.com/test');
  await expect
    .poll(async () => (await projection(page)).settings.llmProfiles.custom.modelCustom)
    .toBe('test-model');
  const apiKey = page.getByLabel('API Key', { exact: true });
  await apiKey.fill('fixture-key-only');
  await expect
    .poll(() => page.evaluate(() => window.__popupPreview.apiKeys.custom))
    .toBe('fixture-key-only');
  await expect(apiKey).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: '显示 API Key' }).click();
  await expect(apiKey).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '隐藏 API Key' }).click();
  await apiKey.fill('');
  await expect.poll(() => page.evaluate(() => window.__popupPreview.apiKeys.custom)).toBe('');

  await selectOption(page, 'LLM 提供商', 'OpenAI');
  await page.getByRole('button', { name: '登录 OpenAI' }).click();
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible();
  const auth = page.getByRole('radiogroup', { name: '认证方式' });
  await auth.getByRole('radio', { name: 'API Key', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toBeEnabled();
  await auth.getByRole('radio', { name: 'OpenAI 登录' }).click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '登录 OpenAI' })).toBeVisible();
  await page.getByRole('combobox', { name: '模型名称' }).click();
  const modelMenuBox = await page.getByRole('listbox').boundingBox();
  expect(modelMenuBox!.y).toBeGreaterThanOrEqual(0);
  expect(modelMenuBox!.y + modelMenuBox!.height).toBeLessThanOrEqual(600);
  await page.keyboard.press('Escape');

  for (const [providerLabel, providerId, modelName, kind] of [
    ['GLM (智谱)', 'glm', 'glm-5.1', 'toggle'],
    ['Kimi (月之暗面)', 'kimi', 'kimi-k3', 'fixed'],
    ['Kimi (月之暗面)', 'kimi', 'kimi-k2.6', 'toggle'],
    ['MiniMax', 'minimax', 'MiniMax-M2.7', 'fixed'],
    ['MiniMax', 'minimax', 'MiniMax-M3', 'toggle'],
    ['MiMo (小米)', 'mimo', 'mimo-v2.5-pro', 'toggle'],
  ]) {
    await selectOption(page, 'LLM 提供商', providerLabel);
    await selectOption(page, '模型名称', modelName);
    if (kind === 'fixed') {
      await expect(page.getByText('该模型不支持关闭思考模式')).toBeVisible();
      await expect(page.getByRole('radiogroup', { name: '思考强度' })).toHaveCount(0);
    } else {
      const thinking = page.getByRole('radiogroup', { name: '思考强度' });
      await thinking.getByRole('radio', { name: '开启', exact: true }).click();
      await expect
        .poll(
          async () =>
            (await projection(page)).settings.llmThinkingByModel[`${providerId}/${modelName}`],
        )
        .toBe('on');
      await thinking.getByRole('radio', { name: '关闭', exact: true }).click();
      await expect
        .poll(
          async () =>
            (await projection(page)).settings.llmThinkingByModel[`${providerId}/${modelName}`],
        )
        .toBe('off');
    }
  }

  await selectOption(page, 'LLM 提供商', 'Nano Banana');
  await expect(page.getByRole('radiogroup', { name: '模式', exact: true })).toHaveCount(0);
  await expect(modeOptions).toHaveCount(0);
  for (const name of ['阶段明细', '排版调试', '去字调试', '关后处理']) {
    await expect(page.getByRole('checkbox', { name })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name })).not.toBeChecked();
  }
  const prompt = page.getByRole('textbox', { name: '提示词', exact: true });
  await page
    .getByRole('radiogroup', { name: '模型', exact: true })
    .getByRole('radio', { name: 'Nano Banana Pro', exact: true })
    .click();
  await expect
    .poll(async () => (await projection(page)).settings.geminiAppModel)
    .toBe('nano_banana_pro');
  await prompt.fill('test prompt {targetLang}');
  await expect
    .poll(async () => (await projection(page)).settings.geminiAppPromptTemplate)
    .toBe('test prompt {targetLang}');
  await page.getByRole('button', { name: '重置提示词' }).click();
  await expect(prompt).toHaveValue(optimizedGeminiAppPromptTemplate);
  await expect(page.getByRole('status')).toContainText('已自动保存');
  await auth.getByRole('radio', { name: 'API Key', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute(
    'placeholder',
    'AIza...',
  );
  await auth.getByRole('radio', { name: 'Gemini 登录' }).click();
  await expect(page.getByRole('button', { name: '检查状态' })).toBeVisible();

  await page.evaluate(() => {
    window.__popupPreview.failNextSave = true;
  });
  await prompt.fill('failed save example');
  await expect(page.getByRole('alert')).toContainText('测试保存失败');
  await prompt.fill('retry saves');
  await expect
    .poll(async () => (await projection(page)).settings.geminiAppPromptTemplate)
    .toBe('retry saves');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await provider.click();
  const reducedDuration = await page
    .getByRole('listbox')
    .evaluate((el) => getComputedStyle(el).animationDuration);
  expect(parseFloat(reducedDuration)).toBeLessThanOrEqual(0.001);
  await page.keyboard.press('Escape');
  await selectOption(page, 'LLM 提供商', 'DeepSeek');
  await modeOptions.click();
  const reducedMenuDuration = await modeMenu.evaluate((el) => getComputedStyle(el).animationDuration);
  expect(parseFloat(reducedMenuDuration)).toBeLessThanOrEqual(0.001);
  await page.keyboard.press('Escape');
}

try {
  for (const browserName of browserNames) {
    const browser = await availableBrowsers[browserName].launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 380, height: 600 },
        deviceScaleFactor: 1,
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      const layouts: Record<string, unknown> = {};
      for (const state of ['deepseek', 'openai', 'gemini', 'custom', 'google']) {
        await openPreview(page, state, state !== 'deepseek' && state !== 'google');
        await expect
          .poll(() =>
            page.locator('.popup-header-logo').evaluate((el: HTMLImageElement) => el.naturalWidth),
          )
          .toBeGreaterThan(0);
        await page
          .locator('.popup')
          .screenshot({
            path: resolve(outputDirectory, `${browserName}-${state}.png`),
            animations: 'disabled',
          });
        layouts[state] = await page.evaluate(() => {
          const selectors = [
            '.popup',
            '.popup-header',
            '.panel',
            '.field',
            '.seg-control',
            '.seg-option',
            '.select-trigger',
            '.model-control',
            '.thinking-slider-control',
            '.api-key-control',
            'textarea',
            '.debug-footer',
            '.debug-toggle',
            '.debug-row',
            '.debug-actions',
          ];
          return Object.fromEntries(
            selectors.map((selector) => [
              selector,
              Array.from(document.querySelectorAll(selector), (el) => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                  color: style.color,
                  background: style.backgroundColor,
                  fontSize: style.fontSize,
                  lineHeight: style.lineHeight,
                };
              }),
            ]),
          );
        });
        const popup = await page.locator('.popup').boundingBox();
        expect(popup!.width).toBe(380);
        expect(popup!.height).toBeLessThanOrEqual(600);
      }
      await writeFile(
        resolve(outputDirectory, `${browserName}-layout.json`),
        JSON.stringify(layouts, null, 2),
      );
      await checkInteractions(page);
      expect(errors, `${browserName} browser errors`).toEqual([]);
      console.log(`${browserName}: five layouts and popup interaction regression passed.`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
