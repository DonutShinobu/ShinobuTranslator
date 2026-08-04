import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const legacyDist = resolve(import.meta.dirname, '../dist');
rmSync(legacyDist, { recursive: true, force: true });
