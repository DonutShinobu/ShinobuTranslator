import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExtensionManifest } from '../../apps/extension/manifest';

const extensionPackage = JSON.parse(
  readFileSync(resolve(process.cwd(), 'apps/extension/package.json'), 'utf8'),
) as { version: string };

describe('dual-target extension manifests', () => {
  it('keeps shared capability intent and version aligned', () => {
    const chromium = createExtensionManifest('chromium', extensionPackage.version);
    const firefox = createExtensionManifest('firefox', extensionPackage.version);

    for (const key of [
      'manifest_version',
      'name',
      'version',
      'action',
      'icons',
      'optional_permissions',
      'host_permissions',
      'commands',
      'content_scripts',
      'web_accessible_resources',
      'content_security_policy',
    ]) {
      expect(firefox[key], key).toEqual(chromium[key]);
    }
    expect(chromium.version).toBe(extensionPackage.version);
    expect(firefox.version).toBe(extensionPackage.version);
    expect(chromium.optional_permissions).toBeUndefined();
    expect(chromium.permissions).toContain('cookies');
    expect(firefox.permissions).toContain('cookies');
    expect(chromium.permissions).not.toContain('tabs');
    expect(firefox.permissions).not.toContain('tabs');
  });

  it('uses only the Chromium service-worker overlay', () => {
    const manifest = createExtensionManifest('chromium', extensionPackage.version);
    expect(manifest.minimum_chrome_version).toBe('109');
    expect(manifest.permissions).toContain('offscreen');
    expect(manifest.background).toEqual({
      service_worker: 'background-chromium.js',
      type: 'module',
    });
    expect(manifest.browser_specific_settings).toBeUndefined();
  });

  it('uses only the Firefox event-page overlay and permanent Gecko id', () => {
    const manifest = createExtensionManifest('firefox', extensionPackage.version);
    expect(manifest.minimum_chrome_version).toBeUndefined();
    expect(manifest.permissions).not.toContain('offscreen');
    expect(manifest.background).toEqual({
      page: 'background-firefox.html',
      persistent: false,
    });
    expect(manifest.browser_specific_settings).toEqual({
      gecko: {
        id: 'shinobu-translator@donutshinobu',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['websiteContent', 'authenticationInfo'],
        },
      },
    });
  });
});
