function trimLeadingSlash(path: string): string {
  return path.replace(/^\/+/, '');
}

export function resolveAssetUrl(path: string): string {
  const cleanedPath = trimLeadingSlash(path);
  const runtime = getExtensionRuntime();
  if (runtime) return runtime.getURL(cleanedPath);
  return `/${cleanedPath}`;
}
import { getExtensionRuntime } from './extensionRuntime';
