import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');

describe('extension store release workflow', () => {
  it('only submits stable extension releases', () => {
    expect(workflow).toContain("startsWith(github.event.release.tag_name, 'v')");
    expect(workflow).toContain("!startsWith(github.event.release.tag_name, 'models-')");
    expect(workflow).toContain('github.event.release.prerelease == false');
    expect(workflow).toContain('github.event.release.draft == false');
  });

  it('publishes both stores from the same verified artifact', () => {
    expect(workflow).toContain('name: extension-store-submission');
    expect(workflow).toMatch(/publish_chrome:[\s\S]*?needs: build/);
    expect(workflow).toMatch(/publish_firefox:[\s\S]*?needs: build/);
    expect(workflow.match(/name: extension-store-submission/g)).toHaveLength(3);
  });

  it('uses automatic publication and short-lived Chrome credentials', () => {
    expect(workflow).toContain('google-github-actions/auth@v3');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('scripts/publish-chrome-web-store.mjs');
    expect(workflow).toContain('--channel listed');
    expect(workflow).toContain('--approval-timeout 0');
  });
});
