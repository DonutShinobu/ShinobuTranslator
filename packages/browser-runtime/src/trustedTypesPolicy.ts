type TrustedScriptUrlPolicy = {
  createScriptURL(value: string): unknown;
};

type TrustedTypesFactory = {
  createPolicy(
    name: string,
    rules: { createScriptURL(value: string): string },
  ): TrustedScriptUrlPolicy;
};

type TrustedTypesGlobal = typeof globalThis & {
  trustedTypes?: TrustedTypesFactory;
  __shinobuTrustedTypesDefaultPolicy?: TrustedScriptUrlPolicy;
};

export function assertTrustedScriptUrl(value: string): string {
  if (!globalThis.location) {
    throw new TypeError('Trusted Script URL 校验缺少页面来源');
  }
  const url = new URL(value, globalThis.location.href);
  const allowedProtocol = url.protocol === 'http:'
    || url.protocol === 'https:'
    || url.protocol === 'blob:';
  if (allowedProtocol && url.origin === globalThis.location.origin) return value;
  throw new TypeError(`Script URL 必须与应用同源: ${url.origin}`);
}

export function installTrustedTypesPolicy(): void {
  const root = globalThis as TrustedTypesGlobal;
  if (!root.trustedTypes || root.__shinobuTrustedTypesDefaultPolicy) return;
  root.__shinobuTrustedTypesDefaultPolicy = root.trustedTypes.createPolicy(
    'default',
    { createScriptURL: assertTrustedScriptUrl },
  );
}
