import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const legacyDist = resolve(import.meta.dirname, '../apps/extension/dist');
rmSync(legacyDist, { recursive: true, force: true });
