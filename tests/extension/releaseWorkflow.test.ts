import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const workflowPath = resolve(root, '.github/workflows/release.yml');
const qualityGateWorkflowPath = resolve(root, '.github/workflows/ci.yml');
const extensionBuilderPath = resolve(
  root,
  'apps/extension/scripts/build.mjs',
);

describe('Chrome extension release workflow', () => {
  it('materializes the canonical model inventory before the quality gate', () => {
    const workflow = readFileSync(qualityGateWorkflowPath, 'utf8');
    const downloadModels = workflow.indexOf(
      'npm run models:download -- latest --force',
    );
    const runQualityGate = workflow.indexOf('npm run check');

    expect(downloadModels).toBeGreaterThan(-1);
    expect(runQualityGate).toBeGreaterThan(downloadModels);
  });

  it('publishes the declared Chrome build directory through one workflow variable', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).not.toContain('apps/extension/dist');
    expect(workflow).toContain(
      'EXTENSION_DIST=$(node apps/extension/scripts/build.mjs '
        + '--print-target-out-dir chrome)',
    );
    expect(workflow).toContain(
      'echo "EXTENSION_DIST=$EXTENSION_DIST" >> "$GITHUB_ENV"',
    );

    const declaredChromeDirectory = execFileSync(
      process.execPath,
      [
        extensionBuilderPath,
        '--print-target-out-dir',
        'chrome',
      ],
      {
        cwd: root,
        encoding: 'utf8',
      },
    ).trim();
    expect(declaredChromeDirectory).toBe('apps/extension/dist/chrome');

    for (const releaseConsumer of [
      'jq -r .version "$EXTENSION_DIST/manifest.json"',
      'find "$EXTENSION_DIST/models"',
      'const dist = process.env.EXTENSION_DIST;',
      'cd "$EXTENSION_DIST"',
      'zip -r "$GITHUB_WORKSPACE/ShinobuTranslator.zip" .',
      'gh release upload ${{ github.event.release.tag_name }}',
      'ShinobuTranslator.zip',
    ]) {
      expect(workflow, releaseConsumer).toContain(releaseConsumer);
    }
  });
});
