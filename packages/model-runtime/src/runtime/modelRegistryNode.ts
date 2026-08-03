import type { ManifestData } from './modelRegistry';

export async function loadManifestNode(manifestRoot: string): Promise<ManifestData> {
  const [{ readFile }, path] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
  ]);
  const raw = await readFile(path.resolve(manifestRoot, 'models.json'), 'utf8');
  return JSON.parse(raw) as ManifestData;
}

export async function resolveModelFilePath(
  modelUrl: string,
  modelRoot: string,
): Promise<string> {
  if (modelUrl.startsWith('file:')) {
    const { fileURLToPath } = await import('node:url');
    return fileURLToPath(modelUrl);
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/u.test(modelUrl)) {
    return modelUrl;
  }
  const path = await import('node:path');
  const relativePath = modelUrl
    .replace(/^[/\\]+/u, '')
    .replace(/^models[/\\]/u, '');
  return path.resolve(modelRoot, relativePath);
}
