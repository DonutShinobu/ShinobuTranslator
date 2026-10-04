import { test, expect, type Page } from '@playwright/test';
import type { LayerEditingState } from '../../apps/extension/src/content/core/editing/layerEditingState';

declare global {
  interface Window {
    layerFixture: {
      state: { layerEditing: LayerEditingState; translatedUrl: string };
      image: HTMLImageElement;
      ui: { host: HTMLElement };
      setEditing(enabled: boolean): Promise<void>;
      hitPoints(): Promise<{ ink: { x: number; y: number }; empty: { x: number; y: number }; gap: { x: number; y: number } }>;
      rebind(): void;
      dispose(): void;
      pixel(x: number, y: number): Promise<number[]>;
      renderedDirections(): Promise<number[]>;
      pauseComposition(): void;
      compositionPaused(): boolean;
      releaseComposition(): void;
      pauseTextEncoding(): void;
      textEncodingPaused(): boolean;
      releaseTextEncoding(): void;
    };
  }
}

async function expectSameImage(page: Page, first: Buffer, second: Buffer): Promise<void> {
  if (first.equals(second)) return;
  const difference = await page.evaluate(async ([a, b]) => {
    const pixels = await Promise.all([a, b].map(async (bytes) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    }));
    let count = 0, max = 0;
    for (let i = 0; i < pixels[0].length; i += 4) {
      const delta = Math.max(...[0, 1, 2, 3].map((channel) => Math.abs(pixels[0][i + channel] - pixels[1][i + channel])));
      if (delta) count++; max = Math.max(max, delta);
    }
    return { count, max };
  }, [[...first], [...second]]);
  // Chromium can round a handful of rotated edge channels differently when adding a transparent input surface.
  expect(difference.max).toBeLessThanOrEqual(1); expect(difference.count).toBeLessThanOrEqual(8);
}

for (const route of ['/inline', '/screenshot']) {
  test(`${route}: the popup option activates existing results without an image edit button`, async ({ page }) => {
    await page.goto(`${route}?disabled=1`); await page.waitForFunction(() => Boolean(window.layerFixture));
    await expect(page.locator('.mt-x-layer-editor')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '图层编辑', exact: true })).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const initial = await page.evaluate(() => window.layerFixture.pixel(150, 150));
    const pill = page.getByRole('button', { name: '显示原图', exact: true });
    const initialPosition = await pill.boundingBox();
    const expectOriginalPosition = async () => {
      await expect.poll(async () => {
        const current = await pill.boundingBox();
        return Math.max(...(['x', 'y', 'width', 'height'] as const).map((key) => Math.abs(current![key] - initialPosition![key])));
      }).toBeLessThan(0.01);
    };
    await page.evaluate(() => window.layerFixture.setEditing(true));
    await expect(page.locator('.mt-x-layer-editor')).toBeVisible();
    await expect(page.getByRole('combobox', { name: '选择图层类型' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
    await expectOriginalPosition();
    await pill.click(); await expect(page.locator('.mt-x-layer-editor')).toHaveCount(0);
    await page.getByRole('button', { name: '显示译图', exact: true }).click();
    await expect(page.locator('.mt-x-layer-editor')).toBeVisible();
    await expectOriginalPosition();
    await page.evaluate(() => window.layerFixture.setEditing(false));
    await expect(page.locator('.mt-x-layer-editor')).toHaveCount(0);
    expect(await page.evaluate(() => window.layerFixture.pixel(150, 150))).toEqual(initial);
  });

  test(`${route}: transparent text pixels pass through to the repair mask and highlight stays shaped`, async ({ page }) => {
    await page.goto(`${route}?real=1`); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    const { ink, empty } = await page.evaluate(() => window.layerFixture.hitPoints());
    const hover = page.locator('.mt-x-layer-highlight:not([data-selected])');
    await page.mouse.move(ink.x, ink.y); await expect(hover).toHaveAttribute('data-kind', 'text');
    const alphas = await hover.evaluate(async (element) => {
      const img = element as HTMLImageElement; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return [data.some((value, i) => i % 4 === 3 && value === 0), data.some((value, i) => i % 4 === 3 && value === 255)];
    });
    expect(alphas).toEqual([true, true]);
    const textColor = await hover.evaluate(async (element) => {
      const img = element as HTMLImageElement; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const index = pixels.findIndex((value, i) => i % 4 === 3 && value === 255);
      return [...pixels.slice(index - 3, index)];
    });
    await page.mouse.move(10, 10); await page.mouse.move(empty.x, empty.y); await expect(hover).toHaveAttribute('data-kind', 'erase');
    const eraseColor = await hover.evaluate(async (element) => {
      const img = element as HTMLImageElement; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });
    expect(textColor).not.toEqual(eraseColor);
    expect(textColor[0]).toBeGreaterThan(textColor[1]); expect(eraseColor[1]).toBeGreaterThan(eraseColor[0]);
    await page.mouse.click(empty.x, empty.y); await page.keyboard.press('Delete');
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers.map((layer) => layer.deleted))).toEqual([true, false]);
    await page.evaluate(() => window.layerFixture.setEditing(false));
    expect(await page.evaluate(() => window.layerFixture.pixel(105, 105))).toEqual([184, 44, 58, 255]);
  });

  for (const direction of ['h', 'v']) {
    test(`${route}: edits ${direction} rotated text with native text, caret, selection and undo`, async ({ page, browserName }) => {
      await page.goto(`${route}?real=1&rotated=1&direction=${direction}`); await page.waitForFunction(() => Boolean(window.layerFixture));
      await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
      const original = await page.locator('[data-layer-id="text:r1"].mt-x-layer-raster').getAttribute('src');
      const { ink } = await page.evaluate(() => window.layerFixture.hitPoints()); await page.mouse.dblclick(ink.x, ink.y);
      const input = page.getByRole('textbox', { name: '编辑文字' }); await expect(input).toHaveText('译文');
      expect(await page.locator('[data-layer-id="text:r1"].mt-x-layer-raster').getAttribute('src')).toBe(original);
      const style = await input.evaluate((element) => {
        const css = getComputedStyle(element), content = window.layerFixture.state.layerEditing.layers[1].content;
        return { font: css.fontSize, expected: content.kind === 'text' ? `${content.layout?.fontSize}px` : '',
          writingMode: css.writingMode, background: css.backgroundColor, border: css.borderTopWidth, color: css.color, caret: css.caretColor,
          transform: css.transform, rasterTransform: getComputedStyle(document.querySelector('[data-layer-id="text:r1"].mt-x-layer-raster')!).transform };
      });
      expect(Number.parseFloat(style.font)).toBeCloseTo(Number.parseFloat(style.expected));
      expect(style.writingMode).toBe(direction === 'v' ? 'vertical-rl' : 'horizontal-tb');
      expect(style.background).toBe('rgba(0, 0, 0, 0)'); expect(style.border).toBe('0px'); expect(style.transform).toBe(style.rasterTransform);
      expect(style.color).toBe('rgba(0, 0, 0, 0)'); expect(style.caret).not.toBe(style.color);
      await expect(page.locator('.mt-x-layer-caret')).toHaveCount(0);
      await expect(page.locator('[data-layer-id="text:r1"].mt-x-layer-raster')).toBeVisible();
      // Firefox's drawSnapshot screenshot API omits the native caret; Chromium paints it.
      if (browserName === 'chromium') {
        const first = await input.screenshot({ caret: 'initial', animations: 'disabled' });
        await expect.poll(async () => first.equals(await input.screenshot({ caret: 'initial', animations: 'disabled' }))).toBe(false);
      }
      const points = await input.evaluate((element) => {
        const layer = window.layerFixture.state.layerEditing.layers[1].content;
        if (layer.kind !== 'text') throw new Error('Expected text');
        const { glyphs, fontSize, direction } = layer.layout!, first = glyphs[0], last = glyphs.at(-1)!;
        const stage = element.parentElement!.getBoundingClientRect(), matrix = new DOMMatrix(getComputedStyle(element).transform);
        const point = (x: number, y: number) => {
          const p = new DOMPoint(x, y).matrixTransform(matrix);
          return { x: stage.left + p.x * stage.width / 800, y: stage.top + p.y * stage.height / 480 };
        };
        return { start: point(first.x - (direction === 'h' ? fontSize / 2 : 0), first.y - (direction === 'v' ? fontSize / 2 : 0)),
          end: point(last.x + (direction === 'h' ? fontSize / 2 : 0), last.y + (direction === 'v' ? fontSize / 2 : 0)) };
      });
      await page.mouse.move(points.start.x, points.start.y); await page.mouse.down();
      await page.mouse.move(points.end.x, points.end.y, { steps: 5 }); await page.mouse.up();
      expect(await input.evaluate(() => window.getSelection()?.toString().length)).toBe(2);
      expect(await page.evaluate(() => {
        const session = window.layerFixture.state.layerEditing, layer = session.layers[1];
        return [layer.offsetX, layer.offsetY, session.revision];
      })).toEqual([0, 0, 0]);
      await input.fill('临时预览');
      await input.press('Control+A');
      expect(await input.evaluate(() => window.getSelection()?.toString().length)).toBe(4);
      await page.keyboard.insertText('替换'); await input.press('Control+z'); await expect(input).toHaveText('临时预览');
      expect(await page.evaluate(() => {
        const content = window.layerFixture.state.layerEditing.layers[1].content;
        return content.kind === 'text' ? content.region.translatedText : '';
      })).toBe('译文');
      await input.press('Escape');
      expect(await page.locator('[data-layer-id="text:r1"].mt-x-layer-raster').getAttribute('src')).toBe(original);
      await page.mouse.dblclick(ink.x, ink.y); await input.fill('第一行'); await input.press('Enter'); await input.pressSequentially('第二行');
      expect(await input.textContent()).toBe('第一行\n第二行'); await input.press('Control+Enter');
      await expect.poll(() => page.evaluate(() => {
        const content = window.layerFixture.state.layerEditing.layers[1].content;
        return content.kind === 'text' ? content.region.translatedText : '';
      })).toBe('第一行\n第二行');
      if (route === '/screenshot') expect(await page.evaluate(() => window.layerFixture.ui.host.style.left)).toBe('30px');
    });
  }

  test(`${route}: composition blur waits for the committed Chinese value`, async ({ page }) => {
    await page.goto(`${route}?real=1`); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    const { ink } = await page.evaluate(() => window.layerFixture.hitPoints()); await page.mouse.dblclick(ink.x, ink.y);
    const input = page.getByRole('textbox', { name: '编辑文字' });
    await input.evaluate((element) => {
      const field = element as HTMLElement;
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      field.textContent = 'zhong'; field.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      field.dispatchEvent(new FocusEvent('blur'));
    });
    await expect(input).toBeVisible();
    await input.evaluate((element) => {
      const field = element as HTMLElement;
      field.textContent = '中文'; field.dispatchEvent(new InputEvent('input', { bubbles: true }));
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    });
    await expect(input).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const content = window.layerFixture.state.layerEditing.layers[1].content;
      return content.kind === 'text' ? content.region.translatedText : '';
    })).toBe('中文');
  });

  test(`${route}: plain multiline paste, empty preview and undo remain native`, async ({ page }) => {
    await page.goto(`${route}?real=1`); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    const { ink } = await page.evaluate(() => window.layerFixture.hitPoints()); await page.mouse.dblclick(ink.x, ink.y);
    const input = page.getByRole('textbox', { name: '编辑文字' }); await input.press('Control+A');
    await input.evaluate((element) => {
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      // Firefox protects the DataTransfer attached to an untrusted ClipboardEvent.
      Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => type === 'text/plain' ? '保留 ABC 12!\r\n\r\n末行🙂' : '<strong>无关格式</strong>', types: ['text/plain', 'text/html'] } });
      element.dispatchEvent(event);
    });
    await expect(input).toHaveAttribute('data-rendered-text', '保留 ABC 12!\n\n末行🙂');
    await input.press('Control+A'); await input.press('Backspace');
    await expect(input).toHaveAttribute('data-rendered-text', '');
    await expect(page.locator('.mt-x-layer-raster[data-layer-id="text:r1"]')).toBeHidden();
    await input.press('Control+z'); await expect(input).toHaveAttribute('data-rendered-text', '保留 ABC 12!\n\n末行🙂');
    await expect(page.locator('.mt-x-layer-raster[data-layer-id="text:r1"]')).toBeVisible();
    await input.press('Escape');
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers[1].deleted)).toBe(false);
  });

  test(`${route}: a slow older text preview cannot overwrite the latest input`, async ({ page }) => {
    await page.goto(`${route}?real=1`); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    const { ink } = await page.evaluate(() => window.layerFixture.hitPoints()); await page.mouse.dblclick(ink.x, ink.y);
    const input = page.getByRole('textbox', { name: '编辑文字' });
    await page.evaluate(() => window.layerFixture.pauseTextEncoding()); await input.fill('较早的输入');
    await page.waitForFunction(() => window.layerFixture.textEncodingPaused());
    await input.fill('最新的输入'); await expect(input).toHaveAttribute('data-rendered-text', '最新的输入');
    const raster = page.locator('.mt-x-layer-raster[data-layer-id="text:r1"]'), latest = await raster.getAttribute('src');
    await page.evaluate(() => window.layerFixture.releaseTextEncoding());
    // Let the older raster finish encoding and attempt publication.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(input).toHaveAttribute('data-rendered-text', '最新的输入'); expect(await raster.getAttribute('src')).toBe(latest);
    await input.press('Control+Enter');
    await expect.poll(() => page.evaluate(() => {
      const layer = window.layerFixture.state.layerEditing.layers[1].content;
      return layer.kind === 'text' ? layer.region.translatedText : '';
    })).toBe('最新的输入');
  });

  for (const direction of ['h', 'v']) {
    test(`${route}: ${direction} irregular layout preserves image pixels while editing and commits its live preview`, async ({ page }, testInfo) => {
      await page.goto(`${route}?real=1&profile=1&rotated=1&direction=${direction}`);
      await page.waitForFunction(() => Boolean(window.layerFixture));
      await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
      const stage = page.locator('.mt-x-layer-editor'), raster = page.locator('.mt-x-layer-raster[data-layer-id="text:r1"]');
      const before = await stage.screenshot({ caret: 'hide', path: testInfo.outputPath('before.png') });
      const { ink } = await page.evaluate(() => window.layerFixture.hitPoints()); await page.mouse.dblclick(ink.x, ink.y);
      const input = page.getByRole('textbox', { name: '编辑文字' }); await expect(input).toBeFocused();
      await page.mouse.move(10, 10);
      await expectSameImage(page, before, await stage.screenshot({ caret: 'hide', path: testInfo.outputPath('editing.png') }));
      const glyphs = await input.evaluate((element) => {
        const layer = window.layerFixture.state.layerEditing.layers[1].content;
        if (layer.kind !== 'text') throw new Error('Expected text');
        const stage = element.parentElement!.getBoundingClientRect(), matrix = new DOMMatrix(element.style.transform);
        return layer.layout!.glyphs.filter((_, index) => index % 3 === 0).map((glyph) => {
          const point = new DOMPoint(glyph.x, glyph.y).matrixTransform(matrix);
          return { start: glyph.start, end: glyph.end, x: stage.left + point.x * stage.width / 800, y: stage.top + point.y * stage.height / 480 };
        });
      });
      for (const glyph of glyphs) {
        await page.mouse.click(glyph.x, glyph.y);
        const position = await input.evaluate((element) => {
          const selection = window.getSelection()!; if (!element.contains(selection.anchorNode)) return -1;
          const range = document.createRange(); range.selectNodeContents(element); range.setEnd(selection.anchorNode!, selection.anchorOffset);
          return range.toString().length;
        });
        expect(position).toBeGreaterThanOrEqual(glyph.start); expect(position).toBeLessThanOrEqual(glyph.end);
      }
      const value = '修改之后，ABC 12!\n分栏依然清晰！\n最后一行🙂';
      await input.fill('修改之后，ABC 12!'); await input.press('Enter'); await page.keyboard.insertText('分栏依然清晰！');
      await input.press('Enter'); await page.keyboard.insertText('最后一行🙂');
      await expect(input).toHaveAttribute('data-rendered-text', value);
      const stamp = await raster.evaluate(async (element) => {
        const img = element as HTMLImageElement; await img.decode();
        const hash = await crypto.subtle.digest('SHA-256', await (await fetch(img.src)).arrayBuffer());
        return { hash: [...new Uint8Array(hash)], transform: img.style.transform, width: img.style.width, height: img.style.height };
      });
      expect(await stage.evaluate((element) => [element.scrollLeft, element.scrollTop])).toEqual([0, 0]);
      await page.mouse.move(10, 10); const preview = await stage.screenshot({ caret: 'hide', path: testInfo.outputPath('preview.png') });
      await input.press('Control+Enter');
      await expect.poll(() => page.evaluate(() => {
        const content = window.layerFixture.state.layerEditing.layers[1].content;
        return content.kind === 'text' ? content.region.translatedText : '';
      })).toBe(value);
      await page.mouse.click(31, 101); await page.mouse.move(10, 10);
      await expectSameImage(page, preview, await stage.screenshot({ caret: 'hide', path: testInfo.outputPath('committed.png') }));
      await page.evaluate(() => window.layerFixture.setEditing(false)); await page.evaluate(() => window.layerFixture.setEditing(true));
      const saved = await raster.evaluate(async (element) => {
        const img = element as HTMLImageElement; await img.decode();
        const hash = await crypto.subtle.digest('SHA-256', await (await fetch(img.src)).arrayBuffer());
        return { hash: [...new Uint8Array(hash)], transform: img.style.transform, width: img.style.width, height: img.style.height };
      });
      expect(saved).toEqual(stamp);
      await expectSameImage(page, preview, await stage.screenshot({ caret: 'hide' }));
    });
  }

  test(`${route}: hover stays on text across transparent gaps at different scales and clicks agree`, async ({ page }) => {
    await page.goto(`${route}?real=1`); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    const hover = page.locator('.mt-x-layer-highlight:not([data-selected])');
    for (const scale of [.25, .75]) {
      await page.evaluate(({ scale, route }) => {
        const element = route === '/inline' ? window.layerFixture.image : window.layerFixture.ui.host;
        element.style.width = `${800 * scale}px`; element.style.height = `${480 * scale}px`;
      }, { scale, route });
      await expect.poll(() => page.locator('.mt-x-layer-stage').evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(800 * scale);
      const { ink, gap } = await page.evaluate(() => window.layerFixture.hitPoints());
      await page.mouse.move(ink.x, ink.y); await expect(hover).toHaveAttribute('data-kind', 'text');
      for (let i = 0; i < 6; i++) {
        await page.mouse.move(gap.x, gap.y); await expect(hover).toHaveAttribute('data-kind', 'text');
        await page.mouse.move(ink.x, ink.y); await expect(hover).toHaveAttribute('data-kind', 'text');
      }
      await page.mouse.move(gap.x, gap.y); await page.mouse.click(gap.x, gap.y);
      await expect(page.locator('.mt-x-layer-highlight[data-selected]')).toHaveAttribute('data-kind', 'text');
      await page.keyboard.press('Escape');
      await page.mouse.move(10, 10); await expect(hover).toBeHidden();
    }
    // Cancelling a pending exit also cancels its timer when the surface is disposed.
    const { ink } = await page.evaluate(() => window.layerFixture.hitPoints());
    await page.mouse.move(ink.x, ink.y); await page.mouse.move(500, 300);
    await page.evaluate(() => window.layerFixture.dispose());
    await expect(page.locator('.mt-x-layer-editor')).toHaveCount(0);
  });

  test(`${route}: editing adds no menu and screenshot sprites have no inherited shadows`, async ({ page }) => {
    await page.goto(route); await page.waitForFunction(() => Boolean(window.layerFixture));
    await expect(page.locator('.mt-x-layer-tools')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '显示原图', exact: true })).toBeVisible();
    expect(await page.locator('.mt-x-layer-stage > img').evaluateAll((images) => images.every((image) => getComputedStyle(image).boxShadow === 'none'))).toBe(true);
    await page.evaluate(() => window.layerFixture.dispose());
    await expect(page.locator('.mt-x-layer-control-portal')).toHaveCount(0);
  });
}

for (const route of ['/inline', '/screenshot']) {
  test(`${route}: shaky clicks stay selected and the drag threshold uses screen pixels at every scale`, async ({ page }) => {
    await page.goto(route); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    const position = () => page.evaluate(() => {
      const session = window.layerFixture.state.layerEditing, layer = session.layers[1];
      return { x: layer.offsetX, y: layer.offsetY, revision: session.revision };
    });
    for (const scale of [.25, .75]) {
      await page.evaluate(({ scale, route }) => {
        const element = route === '/inline' ? window.layerFixture.image : window.layerFixture.ui.host;
        element.style.width = `${800 * scale}px`; element.style.height = `${480 * scale}px`;
      }, { scale, route });
      await expect.poll(() => page.locator('.mt-x-layer-stage').evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(800 * scale);
      const bounds = (await page.locator('.mt-x-layer-raster[data-layer-id="text:r1"]').boundingBox())!;
      const point = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
      const before = await position();
      await page.mouse.move(point.x, point.y); await page.mouse.down();
      await expect(page.locator('.mt-x-layer-highlight[data-selected]')).toHaveAttribute('data-kind', 'text');
      await page.mouse.move(point.x + 3, point.y + 4);
      expect(await position()).toEqual(before);
      await page.mouse.move(point.x + 6, point.y);
      expect(await position()).toEqual(before);
      await page.mouse.up();
      expect(await position()).toEqual(before);

      await page.mouse.move(point.x, point.y); await page.mouse.down();
      await page.mouse.move(point.x + 7, point.y);
      const dragged = await position();
      expect(dragged.x).toBeCloseTo(before.x + 7 / scale); expect(dragged.y).toBe(before.y);
      expect(dragged.revision).toBeGreaterThan(before.revision);
      // A real drag continues smoothly even when the pointer returns inside the initial click tolerance.
      await page.mouse.move(point.x + 2, point.y); await page.mouse.up();
      expect((await position()).x).toBeCloseTo(before.x + 2 / scale);
      expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers[0].offsetX)).toBe(0);
      if (route === '/screenshot') {
        expect(await page.evaluate(() => [window.layerFixture.ui.host.style.left, window.layerFixture.ui.host.style.top])).toEqual(['30px', '100px']);
      }
    }
  });

  test(`${route}: double-click jitter opens text editing without moving the layer`, async ({ page }) => {
    await page.goto(route); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    const input = page.getByRole('textbox', { name: '编辑文字' });
    for (const scale of [.25, .75]) {
      await page.evaluate(({ scale, route }) => {
        const element = route === '/inline' ? window.layerFixture.image : window.layerFixture.ui.host;
        element.style.width = `${800 * scale}px`; element.style.height = `${480 * scale}px`;
      }, { scale, route });
      await expect.poll(() => page.locator('.mt-x-layer-stage').evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(800 * scale);
      const bounds = (await page.locator('.mt-x-layer-raster[data-layer-id="text:r1"]').boundingBox())!;
      const point = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
      await page.mouse.move(point.x, point.y); await page.mouse.down({ clickCount: 1 });
      await page.mouse.move(point.x + 2, point.y + 2); await page.mouse.up({ clickCount: 1 });
      await expect(input).toHaveCount(0);
      await page.mouse.move(point.x, point.y); await page.mouse.down({ clickCount: 2 });
      await page.mouse.move(point.x + 2, point.y + 2); await page.mouse.up({ clickCount: 2 });
      await expect(input).toHaveText('译文'); await expect(input).toBeFocused();
      expect(await page.evaluate(() => {
        const session = window.layerFixture.state.layerEditing, layer = session.layers[1];
        return [layer.offsetX, layer.offsetY, session.revision];
      })).toEqual([0, 0, 0]);
      await input.press('Escape'); await expect(input).toHaveCount(0);
    }
  });

  test(`${route}: Enter edits selected text and remains a newline inside the editor`, async ({ page }) => {
    await page.goto(`${route}?real=1&direction=v`); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    const input = page.getByRole('textbox', { name: '编辑文字' });
    const { ink } = await page.evaluate(() => window.layerFixture.hitPoints());
    const original = await page.locator('.mt-x-layer-raster[data-layer-id="text:r1"]').getAttribute('src');
    await page.mouse.click(ink.x, ink.y);
    await page.keyboard.press('Control+Enter'); await expect(input).toHaveCount(0);
    await page.keyboard.press('Enter'); await expect(input).toHaveText('译文'); await expect(input).toBeFocused();
    expect(await input.evaluate((element) => getComputedStyle(element).writingMode)).toBe('vertical-rl');
    expect(await page.locator('.mt-x-layer-raster[data-layer-id="text:r1"]').getAttribute('src')).toBe(original);
    await input.press('Enter'); await page.keyboard.insertText('新增文字');
    expect(await input.textContent()).toBe('译文\n新增文字');
    await input.press('Control+Enter'); await expect(input).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => {
      const content = window.layerFixture.state.layerEditing.layers[1].content;
      return content.kind === 'text' ? content.region.translatedText : '';
    })).toBe('译文\n新增文字');
    expect(await page.evaluate(() => {
      const layer = window.layerFixture.state.layerEditing.layers[1]; return [layer.offsetX, layer.offsetY];
    })).toEqual([0, 0]);
    await page.mouse.click(83, 153);
    await expect(page.locator('.mt-x-layer-highlight[data-selected]')).toHaveAttribute('data-kind', 'erase');
    const revision = await page.evaluate(() => window.layerFixture.state.layerEditing.revision);
    await page.keyboard.press('Enter'); await expect(input).toHaveCount(0);
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.revision)).toBe(revision);
  });

  test(`${route}: includes text entered while an earlier composition is finishing`, async ({ page }) => {
    await page.goto(route); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.evaluate(() => window.layerFixture.setEditing(true));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    await page.mouse.click(83, 153); await page.keyboard.press('Delete');
    await page.evaluate(() => window.layerFixture.pauseComposition());
    await page.evaluate(() => { void window.layerFixture.setEditing(false); });
    await page.waitForFunction(() => window.layerFixture.compositionPaused());
    await page.mouse.dblclick(100, 175);
    await page.getByRole('textbox', { name: '编辑文字' }).fill('合成时追加修改');
    await page.evaluate(() => window.layerFixture.releaseComposition());
    await expect(page.locator('.mt-x-layer-editor')).toHaveCount(0);
    expect(await page.evaluate(() => {
      const session = window.layerFixture.state.layerEditing, text = session.layers[1].content;
      return [text.kind === 'text' ? text.region.translatedText : '', session.appliedRevision === session.revision];
    })).toEqual(['合成时追加修改', true]);
    expect(await page.evaluate(() => window.layerFixture.pixel(105, 105))).toEqual([184, 44, 58, 255]);
  });

  test(`${route}: selects, moves and edits text, and retains edits across mode changes`, async ({ page }) => {
    await page.goto(route); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.evaluate(() => window.layerFixture.setEditing(true));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    const stage = page.locator('.mt-x-layer-editor'); await expect(stage).toBeVisible();
    await page.mouse.move(100, 175); await page.mouse.down(); await page.mouse.move(130, 190, { steps: 3 }); await page.mouse.up();
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers[1].offsetX)).toBeCloseTo(60);
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers[0].offsetX)).toBe(0);
    if (route === '/screenshot') expect(await page.evaluate(() => window.layerFixture.ui.host.style.left)).toBe('30px');
    await page.mouse.dblclick(130, 190);
    const input = page.getByRole('textbox', { name: '编辑文字' }); await expect(input).toHaveText('译文');
    await input.fill('第一行\n第二行'); await input.press('Control+Enter');
    await expect.poll(() => page.evaluate(() => {
      const content = window.layerFixture.state.layerEditing.layers[1].content;
      return content.kind === 'text' ? content.region.translatedText : '';
    })).toBe('第一行\n第二行');
    await page.evaluate(() => window.layerFixture.setEditing(false)); await expect(stage).toHaveCount(0);
    await page.getByRole('button', { name: '显示原图', exact: true }).click();
    await page.getByRole('button', { name: '显示译图', exact: true }).click();
    await page.evaluate(() => window.layerFixture.setEditing(true));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers[1].offsetX)).toBeCloseTo(60);
    await page.evaluate(() => window.layerFixture.rebind()); await expect(stage).toBeVisible();
    const directions = await page.evaluate(() => window.layerFixture.renderedDirections());
    expect(directions.every((count) => count > 0)).toBe(true);
    await page.evaluate(() => window.layerFixture.dispose()); await expect(stage).toHaveCount(0);
  });

  test(`${route}: independently deletes an immovable erase patch and restores source pixels`, async ({ page }) => {
    await page.goto(route); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.evaluate(() => window.layerFixture.setEditing(true));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    await page.mouse.move(83, 153); await page.mouse.down(); await page.mouse.move(140, 190); await page.mouse.up();
    await expect(page.locator('.mt-x-layer-highlight[data-selected="true"]')).toHaveAttribute('data-kind', 'erase');
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers[0].offsetX)).toBe(0);
    await page.keyboard.press('Delete');
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers.map((layer) => layer.deleted))).toEqual([true, false]);
    await page.evaluate(() => window.layerFixture.setEditing(false));
    await expect(page.locator('.mt-x-layer-editor')).toHaveCount(0);
    expect(await page.evaluate(() => window.layerFixture.pixel(105, 105))).toEqual([184, 44, 58, 255]);
    expect(await page.evaluate(() => window.layerFixture.pixel(150, 150))).toEqual([22, 128, 74, 255]);
  });

  test(`${route}: cycles overlapping layers and keeps Delete and IME input inside the text editor`, async ({ page }) => {
    await page.goto(route); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.evaluate(() => window.layerFixture.setEditing(true));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    await page.mouse.click(100, 175);
    await page.keyboard.down('Alt'); await page.mouse.click(100, 175); await page.keyboard.up('Alt');
    await expect(page.locator('.mt-x-layer-highlight[data-selected="true"]')).toHaveAttribute('data-kind', 'erase');
    await page.mouse.dblclick(100, 175);
    const input = page.getByRole('textbox', { name: '编辑文字' });
    await input.fill('取消本次修改'); await input.press('Delete');
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers[1].deleted)).toBe(false);
    await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
    await expect(input).toBeVisible(); await input.press('Escape'); await expect(input).toHaveCount(0);
    expect(await page.evaluate(() => {
      const content = window.layerFixture.state.layerEditing.layers[1].content;
      return content.kind === 'text' ? content.region.translatedText : '';
    })).toBe('译文');
    await page.mouse.click(100, 175); await page.keyboard.press('Backspace');
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers.map((layer) => layer.deleted))).toEqual([false, true]);
    await page.evaluate(() => window.layerFixture.setEditing(false));
    await expect(page.locator('.mt-x-layer-editor')).toHaveCount(0);
    expect(await page.evaluate(() => window.layerFixture.pixel(150, 150))).toEqual([250, 248, 249, 255]);
  });

  test(`${route}: maps fitted, scaled and scrolled images and commits on the original toggle`, async ({ page }) => {
    await page.goto(route); await page.waitForFunction(() => Boolean(window.layerFixture));
    await page.evaluate(() => window.layerFixture.setEditing(true));
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    if (route === '/inline') {
      await page.evaluate(() => {
        const image = window.layerFixture.image;
        Object.assign(image.style, { height: '400px', padding: '7px 11px', border: '3px solid black',
          boxSizing: 'content-box', transform: 'scale(0.8)', transformOrigin: 'top left', objectPosition: '50% 50%' });
        document.body.style.height = '2000px'; window.scrollTo(0, 35);
      });
    } else {
      await page.mouse.move(350, 300); await page.mouse.wheel(0, -100);
      await expect.poll(() => page.evaluate(() => Number.parseFloat(window.layerFixture.ui.host.style.width))).toBeCloseTo(448);
      await expect(page.locator('.mt-x-screenshot-result-zooming')).toHaveCount(0);
    }
    await expect.poll(() => page.locator('.mt-x-layer-stage').evaluate((element) => element.getBoundingClientRect().width))
      .toBeCloseTo(route === '/inline' ? 320 : 448);
    // Convert a known source point via the live stage matrix, including letterboxing.
    const point = await page.locator('.mt-x-layer-stage').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { x: Math.round(box.left + box.width * 140 / 800), y: Math.round(box.top + box.height * 150 / 480),
        dx: Math.round(box.width * 80 / 800), dy: Math.round(box.height * 20 / 480), width: box.width, height: box.height };
    });
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + point.dx, point.y + point.dy, { steps: 3 }); await page.mouse.up();
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers[1].offsetX)).toBeCloseTo(point.dx * 800 / point.width);
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers[1].offsetY)).toBeCloseTo(point.dy * 480 / point.height);
    await page.mouse.dblclick(point.x + point.dx, point.y + point.dy);
    const input = page.getByRole('textbox', { name: '编辑文字' }); await input.fill('直接切换原图');
    await page.getByRole('button', { name: '显示原图', exact: true }).click();
    await expect(page.locator('.mt-x-layer-editor')).toHaveCount(0);
    expect(await page.evaluate(() => {
      const layer = window.layerFixture.state.layerEditing.layers[1].content;
      return layer.kind === 'text' ? layer.region.translatedText : '';
    })).toBe('直接切换原图');
    await page.getByRole('button', { name: '显示译图', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.mt-x-layer-raster')].every((layer) => (layer as HTMLElement).dataset.hitReady === 'true'));
    expect(await page.evaluate(() => window.layerFixture.state.layerEditing.layers[1].offsetX)).toBeCloseTo(point.dx * 800 / point.width);
    await page.mouse.click(point.x + point.dx * 460 / 80, point.y + point.dy * 200 / 20);
    await expect(page.locator('.mt-x-layer-highlight[data-selected="true"]')).toBeHidden();
  });
}
