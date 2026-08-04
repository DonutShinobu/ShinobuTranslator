import type { ExtensionSettings } from '../../shared/config';
import { getExtensionApi } from '../../shared/extensionRuntime';
import {
  AUTHENTICATION_INFO_PERMISSION,
  createExtensionPermissions,
  GEMINI_COOKIE_PERMISSION,
} from '../../shared/extensionPermissions';
import { getGeminiAppAuthStatus } from '../geminiAppClient';

export const geminiAppUrl = 'https://gemini.google.com/app';
export type GeminiAppAuthStatus = Awaited<ReturnType<typeof getGeminiAppAuthStatus>>;

export function openGeminiAppAuthTab(): Promise<void> {
  const chromeApi = getExtensionApi();
  if (!chromeApi?.tabs?.create) {
    return Promise.reject(new Error('当前浏览器不支持打开 Gemini 登录页'));
  }

  return new Promise((resolve, reject) => {
    chromeApi.tabs?.create?.({ url: geminiAppUrl, active: true }, () => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function readGeminiAppAuthStatus(
  settings: ExtensionSettings,
): Promise<GeminiAppAuthStatus> {
  const permissions = createExtensionPermissions();
  if (!await permissions.contains(AUTHENTICATION_INFO_PERMISSION)) {
    return {
      authenticated: false,
      error: '认证信息权限未授予或已撤销，请点击登录重新授权',
    };
  }
  if (settings.geminiAppAuthMode === 'cookies_permission') {
    const granted = await permissions.contains(GEMINI_COOKIE_PERMISSION);
    if (!granted) {
      return {
        authenticated: false,
        error: 'Gemini Cookie 权限未授予或已撤销，请点击登录重新授权',
      };
    }
  }
  return getGeminiAppAuthStatus(settings);
}

export async function loginGeminiApp(
  settings: ExtensionSettings,
): Promise<GeminiAppAuthStatus> {
  const permissions = createExtensionPermissions();
  if (settings.geminiAppAuthMode === 'cookies_permission') {
    await permissions.assertGranted(GEMINI_COOKIE_PERMISSION);
  } else {
    await permissions.assertGranted(AUTHENTICATION_INFO_PERMISSION);
  }
  const status = await getGeminiAppAuthStatus(settings);
  if (status.authenticated) return status;
  await openGeminiAppAuthTab();
  return { authenticated: false, pending: true };
}
