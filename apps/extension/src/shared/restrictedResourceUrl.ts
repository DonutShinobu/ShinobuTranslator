export function parseCredentiallessHttpsUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function parseRestrictedResourceBaseUrl(value: string): URL | null {
  const parsed = parseCredentiallessHttpsUrl(value);
  if (!parsed || parsed.search || parsed.hash) return null;
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed;
}

export function isUrlWithinRestrictedResourceBase(target: URL, base: URL): boolean {
  return target.protocol === 'https:'
    && !target.username
    && !target.password
    && base.protocol === 'https:'
    && !base.username
    && !base.password
    && !base.search
    && !base.hash
    && target.origin === base.origin
    && target.pathname.startsWith(base.pathname);
}
