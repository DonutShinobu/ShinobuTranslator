import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const metadataPath = resolve(root, 'apps/extension/amo/metadata.json');
const reviewerNotesPath = resolve(root, 'apps/extension/amo/reviewer-notes.md');
const releaseChecklistPath = resolve(root, 'apps/extension/amo/release-candidate-checklist.md');
const privacyPath = resolve(root, 'PRIVACY_POLICY.md');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));

function requireTranslations(field) {
  if (!metadata[field]?.['en-US'] || !metadata[field]?.['zh-CN']) {
    throw new Error(`AMO metadata.${field} must contain en-US and zh-CN`);
  }
}

for (const field of ['name', 'summary', 'description', 'homepage', 'support_url']) {
  requireTranslations(field);
}
if (metadata.default_locale !== 'en-US') {
  throw new Error('AMO metadata default_locale must be en-US');
}
if (!metadata.categories?.firefox?.includes('photos-media')) {
  throw new Error('AMO metadata must declare the Firefox photos-media category');
}
if (metadata.version?.license !== 'GPL-3.0-only') {
  throw new Error('AMO version license must use the case-sensitive GPL-3.0-only slug');
}
if (!metadata.version?.approval_notes) {
  throw new Error('AMO version approval_notes are required');
}
for (const requiredUrl of [
  'https://github.com/DonutShinobu/ShinobuTranslator',
  'https://github.com/DonutShinobu/ShinobuTranslator/issues',
  'https://github.com/DonutShinobu/ShinobuTranslator/blob/main/PRIVACY_POLICY.md',
]) {
  if (!JSON.stringify(metadata).includes(requiredUrl)) {
    throw new Error(`AMO metadata is missing required link: ${requiredUrl}`);
  }
}
if (!existsSync(reviewerNotesPath) || !readFileSync(reviewerNotesPath, 'utf8').includes('npm run build-for-amo')) {
  throw new Error('AMO reviewer notes are missing reproducible build instructions');
}
if (!existsSync(releaseChecklistPath) || !readFileSync(releaseChecklistPath, 'utf8').includes('SSIM `>= 0.995`')) {
  throw new Error('Dual-target release candidate checklist is missing visual parity gates');
}
if (!existsSync(privacyPath)) throw new Error('AMO privacy policy is missing');

console.log('AMO listing metadata and reviewer instructions verified.');
