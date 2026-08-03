import { resolve } from 'node:path';
import { createNodeModelRuntime } from '@shinobu/model-runtime/node';

const modelRoot = resolve(process.cwd(), 'public', 'models');

export const benchmarkModelRuntime = createNodeModelRuntime({
  manifestRoot: modelRoot,
  modelRoot,
});
