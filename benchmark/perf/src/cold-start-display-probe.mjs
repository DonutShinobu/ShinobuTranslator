// Optional diagnostics for an already-running Playwright page/context.
// This never launches a browser, invokes models, or modifies the product bundle.
export async function installColdStartDisplayProbe(page, selector = '.mt-x-screenshot-result[data-image="translated"] img') {
  await page.evaluate(`(() => {
    globalThis.__shinobuColdStartDisplayDispose?.();
    const selector = ${JSON.stringify(selector)};
    const records = [];
    globalThis.__shinobuColdStartDisplayRecords = records;
    const byImage = new WeakMap(), cleanup = [];
    const epoch = () => performance.timeOrigin + performance.now();
    const capture = (image) => {
      if (!(image instanceof HTMLImageElement) || !image.matches(selector) || !image.getAttribute('src')) return null;
      let record = byImage.get(image);
      if (record?.url === image.src) return record;
      record = { url: image.src, srcEpochMs: epoch(), completeAtSrcObservation: image.complete, decodeCalls: 0 };
      records.push(record); byImage.set(image, record);
      const noteLoad = () => { if (image.src === record.url) record.loadEpochMs ??= epoch(); };
      const noteError = () => { if (image.src === record.url) record.error = 'image-load-error'; };
      image.addEventListener('load', noteLoad, { once: true });
      image.addEventListener('error', noteError, { once: true });
      cleanup.push(() => { image.removeEventListener('load', noteLoad); image.removeEventListener('error', noteError); });
      return record;
    };
    const observer = new MutationObserver(() => {
      for (const image of document.querySelectorAll(selector)) capture(image);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true,
      attributes: true, attributeFilter: ['src', 'data-image'] });
    const nativeDecode = HTMLImageElement.prototype.decode;
    const wrappedDecode = function (...args) {
      const record = capture(this);
      if (record) { record.decodeCalls++; record.decodeStartedEpochMs ??= epoch(); }
      const promise = Reflect.apply(nativeDecode, this, args);
      // Observe the existing decode promise; preserve its identity and initiate no new decode.
      if (record) void promise.then(() => {
        if (record.decodedEpochMs !== undefined || this.src !== record.url) return;
        record.decodedEpochMs = epoch();
        requestAnimationFrame(() => {
          record.frameEpochMs = epoch();
          const style = getComputedStyle(this);
          record.finalComputedStyle = { filter: style.filter, opacity: style.opacity,
            objectFit: style.objectFit, transitionDuration: style.transitionDuration };
        });
      }, () => { record.error = 'image-decode-error'; });
      return promise;
    };
    HTMLImageElement.prototype.decode = wrappedDecode;
    globalThis.__shinobuColdStartDisplayDispose = () => {
      observer.disconnect(); cleanup.forEach(dispose => dispose());
      if (HTMLImageElement.prototype.decode === wrappedDecode) HTMLImageElement.prototype.decode = nativeDecode;
      delete globalThis.__shinobuColdStartDisplayDispose;
    };
  })()`);
}

export async function readColdStartDisplayProbe(page) {
  return page.evaluate(`(globalThis.__shinobuColdStartDisplayRecords ?? []).map(record => ({
    ...record,
    srcToLoadMs: record.loadEpochMs === undefined ? undefined : record.loadEpochMs - record.srcEpochMs,
    srcToDecodeMs: record.decodedEpochMs === undefined ? undefined : record.decodedEpochMs - record.srcEpochMs,
    decodePromiseMs: record.decodedEpochMs === undefined ? undefined : record.decodedEpochMs - record.decodeStartedEpochMs,
    decodeToRafMs: record.frameEpochMs === undefined ? undefined : record.frameEpochMs - record.decodedEpochMs,
  }))`);
}

export async function disposeColdStartDisplayProbe(page) {
  await page.evaluate('globalThis.__shinobuColdStartDisplayDispose?.()');
}

export async function checkResultBlobAfterOffscreenClose(page, worker,
  selector = '.mt-x-screenshot-result[data-image="translated"] img') {
  // Run after the timing/strict pipeline gate; hashing/readback is deliberately outside the cold budget.
  const snapshot = async (knownUrl) => page.evaluate(`(async () => {
    const image = document.querySelector(${JSON.stringify(selector)});
    const url = ${JSON.stringify(knownUrl ?? null)} ?? image?.src;
    if (!url?.startsWith('blob:')) throw new Error('Expected the content-owned result Blob URL');
    const response = await fetch(url);
    if (!response.ok) throw new Error('Content Blob URL fetch failed');
    const blob = await response.blob();
    if (blob.type !== 'image/png') throw new Error('Expected completed PNG');
    const hex = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      value => value.toString(16).padStart(2, '0')).join('');
    const pngHash = await hex(await blob.arrayBuffer());
    // A fresh URL/element avoids merely inspecting the already-decoded on-screen img.
    const freshUrl = URL.createObjectURL(blob), freshImage = new Image();
    try {
      freshImage.src = freshUrl;
      await freshImage.decode();
      const canvas = document.createElement('canvas');
      canvas.width = freshImage.naturalWidth; canvas.height = freshImage.naturalHeight;
      try {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(freshImage, 0, 0);
        const rgbaHash = await hex(context.getImageData(0, 0, canvas.width, canvas.height).data);
        return { url, type: blob.type, bytes: blob.size, pngHash, rgbaHash, width: canvas.width, height: canvas.height };
      } finally { canvas.width = 0; canvas.height = 0; }
    } finally { URL.revokeObjectURL(freshUrl); }
  })()`);
  const before = await snapshot();
  const host = await worker.evaluate(`(async () => {
    const query = { contextTypes: ['OFFSCREEN_DOCUMENT'] };
    const before = await chrome.runtime.getContexts(query);
    if (before.length !== 1) throw new Error('Expected one live offscreen host before the lifetime check');
    await chrome.offscreen.closeDocument();
    const after = await chrome.runtime.getContexts(query);
    if (after.length !== 0) throw new Error('Offscreen host did not close');
    return { beforeCount: before.length, afterCount: after.length };
  })()`);
  const after = await snapshot(before.url);
  for (const field of ['url', 'type', 'bytes', 'pngHash', 'rgbaHash', 'width', 'height']) {
    if (after[field] !== before[field]) throw new Error(`Result changed after host close: ${field}`);
  }
  return { result: 'content-PNG-and-decoded-RGBA-identical-after-host-close', host, before, after };
}
