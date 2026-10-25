import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8').replaceAll('\r\n', '\n');

function job(name: string): string {
  const section = workflow.split(`\n  ${name}:\n`)[1];
  expect(section, `Missing job ${name}`).toBeDefined();
  return section?.split(/\n  [a-z_]+:\n/)[0] ?? '';
}

function buildStep(name: string): string {
  const section = job('build').split(`      - name: ${name}\n`)[1];
  expect(section, `Missing build step ${name}`).toBeDefined();
  return section?.split('\n      - name: ')[0] ?? '';
}

describe('extension store release workflow', () => {
  it('only submits stable extension releases', () => {
    expect(workflow).toContain("startsWith(github.event.release.tag_name, 'v')");
    expect(workflow).toContain("!startsWith(github.event.release.tag_name, 'models-')");
    expect(workflow).toContain('github.event.release.prerelease == false');
    expect(workflow).toContain('github.event.release.draft == false');
  });

  it('publishes the Chrome store variant and the full Firefox package from separate artifacts', () => {
    const chromeUpload = buildStep('Share Chrome Web Store submission artifact');
    expect(chromeUpload).toContain('name: chrome-store-submission');
    expect(chromeUpload).toContain('path: artifacts/chrome-store/ShinobuTranslator-chrome-v*.zip');
    expect(chromeUpload).not.toContain('source-');
    const chromeJob = job('publish_chrome');
    expect(chromeJob).toContain('needs: build');
    expect(chromeJob).toContain('name: chrome-store-submission');
    expect(chromeJob).toContain('PACKAGE="store-artifacts/ShinobuTranslator-chrome-v${VERSION}.zip"');
    expect(chromeJob).toContain('test -f "$PACKAGE"');
    expect(chromeJob).not.toContain('name: firefox-store-submission');

    const firefoxUpload = buildStep('Share Firefox submission artifacts');
    expect(firefoxUpload).toContain('name: firefox-store-submission');
    expect(firefoxUpload).toContain('artifacts/ShinobuTranslator-firefox-v*.zip');
    expect(firefoxUpload).toContain('artifacts/ShinobuTranslator-source-*.zip');
    expect(firefoxUpload).not.toContain('chrome-store/');
    const firefoxJob = job('publish_firefox');
    expect(firefoxJob).toContain('needs: build');
    expect(firefoxJob).toContain('name: firefox-store-submission');
    expect(firefoxJob).toContain('FIREFOX_ARCHIVE="store-artifacts/ShinobuTranslator-firefox-v${VERSION}.zip"');
    expect(firefoxJob).toContain('SOURCE_ARCHIVE="store-artifacts/ShinobuTranslator-source-v${VERSION}.zip"');
    expect(firefoxJob).not.toContain('name: chrome-store-submission');
  });

  it('builds the store variant after full quality gates and keeps ordinary dual-target parity', () => {
    const build = job('build');
    expect(build.indexOf('run: npm run check')).toBeLessThan(build.indexOf('run: npm run build:extension:chrome-store'));
    expect(buildStep('Build Chrome Web Store variant')).toContain('run: npm run build:extension:chrome-store');
    expect(buildStep('Generate parity report')).toContain('--chromium "$EXTENSION_CHROMIUM_DIST"');
    expect(buildStep('Generate parity report')).not.toContain('EXTENSION_CHROME_STORE_DIST');
    expect(buildStep('Package reproducible artifacts and enforce budgets')).toContain('--chromium "$EXTENSION_CHROMIUM_DIST"');
    expect(buildStep('Package Chrome Web Store artifact')).toContain('--chromium "$EXTENSION_CHROME_STORE_DIST"');
    expect(buildStep('Package Chrome Web Store artifact')).toContain('--artifacts artifacts/chrome-store');
    expect(buildStep('Verify tag and all extension versions')).toContain('test "$TAG_VERSION" = "$CHROME_STORE_VERSION"');
  });

  it('attaches only the two full browser packages to the GitHub Release', () => {
    const upload = buildStep('Upload browser release packages');
    expect(upload).toContain('gh release upload');
    expect(upload.match(/artifacts\/[^\s]+/g)).toEqual([
      'artifacts/ShinobuTranslator-chrome-v*.zip',
      'artifacts/ShinobuTranslator-firefox-v*.zip',
    ]);
    const verification = buildStep('Retain internal release verification');
    expect(verification).toContain('uses: actions/upload-artifact@v4');
    expect(verification).toContain('artifacts/SHA256SUMS.txt');
    expect(verification).toContain('artifacts/chrome-store/SHA256SUMS.txt');
    expect(verification).toContain('artifacts/extension-parity-report.json');
    expect(workflow).not.toContain('ShinobuTranslator-chromium-');
  });

  it('uses automatic publication and short-lived Chrome credentials', () => {
    expect(workflow).toContain('google-github-actions/auth@v3');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('scripts/publish-chrome-web-store.mjs');
    expect(workflow).toContain('--channel listed');
    expect(workflow).toContain('--approval-timeout 0');
  });

  it('submits only version metadata without overwriting the Firefox listing', () => {
    expect(workflow).toContain("jq '{version: .version}' apps/extension/amo/metadata.json");
    expect(workflow).toContain('--amo-metadata "$RUNNER_TEMP/amo-version-metadata.json"');
    expect(workflow).not.toContain('--amo-metadata apps/extension/amo/metadata.json');
    expect(workflow).toContain('--upload-source-code "${{ steps.firefox-package.outputs.source-archive }}"');
  });

  it('syncs media and release notes after Firefox submission and supports a manual run', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('listing_tag:');
    expect(workflow).toMatch(/sync_firefox_listing:[\s\S]*?needs: publish_firefox/);
    expect(workflow).toContain("needs.publish_firefox.result == 'success'");
    expect(workflow).toContain('scripts/sync-firefox-listing.ts');
    expect(workflow).toContain('gh release view "$RELEASE_TAG"');
  });
});
