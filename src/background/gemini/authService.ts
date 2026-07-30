import type {
  AuthenticationTabLifecycle,
} from '../../../apps/extension/src/capabilities/contracts';
import type { ExtensionSettings } from '../../shared/config';
import { getGeminiAppAuthStatus } from '../geminiAppClient';

export const geminiAppUrl = 'https://gemini.google.com/app';
export type GeminiAppAuthStatus = Awaited<ReturnType<typeof getGeminiAppAuthStatus>>;

export async function openGeminiAppAuthTab(
  authenticationTabs: AuthenticationTabLifecycle,
): Promise<void> {
  const result = await authenticationTabs.open(geminiAppUrl);
  if (result.status === 'unavailable') {
    throw new Error(
      '当前浏览器不支持打开 Gemini 登录页，请确认扩展已授予 tabs 权限',
    );
  }
}

export async function readGeminiAppAuthStatus(
  settings: ExtensionSettings,
): Promise<GeminiAppAuthStatus> {
  return getGeminiAppAuthStatus(settings);
}

export async function loginGeminiApp(
  settings: ExtensionSettings,
  authenticationTabs: AuthenticationTabLifecycle,
): Promise<GeminiAppAuthStatus> {
  const status = await getGeminiAppAuthStatus(settings);
  if (status.authenticated) return status;
  await openGeminiAppAuthTab(authenticationTabs);
  return { authenticated: false, pending: true };
}
