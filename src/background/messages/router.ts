import type { ExtensionSettings } from '../../shared/config';
import type {
  ExtensionMessageSource,
} from '../../../apps/extension/src/capabilities/contracts';
import {
  requireTabDocumentSource,
  type TabDocumentSource,
} from '../../../apps/extension/src/capabilities/guards';
import type {
  RuntimeMessage,
  RuntimeResponse,
} from '../../shared/messages';
import {
  isAuthenticationPermissionRequired,
  type AuthenticationPermissionRequired,
} from '../../../apps/extension/src/capabilities/authentication';
import type { ImageDownloadRequest } from '../images/imageDownloader';
import {
  authenticationPermissionRequiredResponse,
  type RuntimePermissionRequiredResponse,
} from './authenticationResponse';

type MessageOf<T extends RuntimeMessage['type']> = Extract<RuntimeMessage, { type: T }>;
type SuccessOf<T extends RuntimeResponse['type']> = Extract<RuntimeResponse, { ok: true; type: T }>;
type PayloadOf<T extends RuntimeResponse['type']> = Omit<SuccessOf<T>, 'ok' | 'type'>;
type AuthenticationServiceResult<T> = T | AuthenticationPermissionRequired;
type ResponseOf<T extends RuntimeMessage['type']> =
  | SuccessOf<T>
  | RuntimePermissionRequiredResponse<T>;

export type BackgroundServices = {
  settings: {
    get(): Promise<ExtensionSettings>;
    set(settings: ExtensionSettings): Promise<ExtensionSettings>;
  };
  diagnostics: {
    record(event: MessageOf<'mt:diagnostic-log-event'>['event']): Promise<void>;
    export(): Promise<PayloadOf<'mt:diagnostic-log-export'>['log']>;
    clear(): Promise<void>;
  };
  images: {
    download(
      request: ImageDownloadRequest,
      sender: TabDocumentSource,
    ): Promise<PayloadOf<'mt:download-image'>>;
    capture(sender: TabDocumentSource): Promise<PayloadOf<'mt:capture-visible-tab'>>;
  };
  openAi: {
    status(): Promise<AuthenticationServiceResult<PayloadOf<'mt:openai-oauth-status'>['status']>>;
    login(): Promise<AuthenticationServiceResult<PayloadOf<'mt:openai-oauth-login'>['status']>>;
    logout(): Promise<PayloadOf<'mt:openai-oauth-logout'>['status']>;
  };
  geminiAuth: {
    status(settings: ExtensionSettings): Promise<AuthenticationServiceResult<PayloadOf<'mt:gemini-app-auth-status'>['status']>>;
    login(settings: ExtensionSettings): Promise<AuthenticationServiceResult<PayloadOf<'mt:gemini-app-auth-login'>['status']>>;
  };
  providers: {
    llm(message: MessageOf<'mt:llm-chat-completions'>): Promise<ResponseOf<'mt:llm-chat-completions'>>;
    geminiAppImage(message: MessageOf<'mt:gemini-app-image-translate'>): Promise<ResponseOf<'mt:gemini-app-image-translate'>>;
    geminiApiImage(message: MessageOf<'mt:gemini-api-image-translate'>): Promise<ResponseOf<'mt:gemini-api-image-translate'>>;
  };
};

export async function routeBackgroundMessage(
  message: RuntimeMessage,
  sender: ExtensionMessageSource,
  services: BackgroundServices,
): Promise<RuntimeResponse> {
  if (message.type === 'mt:diagnostic-log-event') {
    try {
      const settings = await services.settings.get();
      if (settings.enableDebugLog) await services.diagnostics.record(message.event);
    } catch {
      // Diagnostic writes are best-effort and must not affect callers.
    }
    return { ok: true, type: 'mt:diagnostic-log-event' };
  }
  if (message.type === 'mt:diagnostic-log-export') {
    return {
      ok: true,
      type: 'mt:diagnostic-log-export',
      log: await services.diagnostics.export(),
    };
  }
  if (message.type === 'mt:diagnostic-log-clear') {
    await services.diagnostics.clear();
    return { ok: true, type: 'mt:diagnostic-log-clear' };
  }
  if (message.type === 'mt:get-settings') {
    return { ok: true, type: 'mt:get-settings', settings: await services.settings.get() };
  }
  if (message.type === 'mt:set-settings') {
    return {
      ok: true,
      type: 'mt:set-settings',
      settings: await services.settings.set(message.settings),
    };
  }
  if (message.type === 'mt:download-image') {
    const documentSource = requireTabDocumentSource(sender, {
      capability: 'runtime-request',
      operation: 'request',
    });
    const request: ImageDownloadRequest = {
      imageUrl: message.imageUrl,
      ...(message.referrerPolicy !== undefined
        ? { referrerPolicy: message.referrerPolicy }
        : {}),
    };
    return {
      ok: true,
      type: 'mt:download-image',
      ...await services.images.download(request, documentSource),
    };
  }
  if (message.type === 'mt:capture-visible-tab') {
    const documentSource = requireTabDocumentSource(sender, {
      capability: 'visible-tab-capture',
      operation: 'capturePng',
    });
    return {
      ok: true,
      type: 'mt:capture-visible-tab',
      ...await services.images.capture(documentSource),
    };
  }
  if (message.type === 'mt:openai-oauth-status') {
    const status = await services.openAi.status();
    return isAuthenticationPermissionRequired(status)
      ? authenticationPermissionRequiredResponse(message.type, status)
      : { ok: true, type: 'mt:openai-oauth-status', status };
  }
  if (message.type === 'mt:openai-oauth-login') {
    const status = await services.openAi.login();
    return isAuthenticationPermissionRequired(status)
      ? authenticationPermissionRequiredResponse(message.type, status)
      : { ok: true, type: 'mt:openai-oauth-login', status };
  }
  if (message.type === 'mt:openai-oauth-logout') {
    return { ok: true, type: 'mt:openai-oauth-logout', status: await services.openAi.logout() };
  }
  if (message.type === 'mt:gemini-app-auth-status') {
    const settings = await services.settings.get();
    const status = await services.geminiAuth.status(settings);
    return isAuthenticationPermissionRequired(status)
      ? authenticationPermissionRequiredResponse(message.type, status)
      : {
          ok: true,
          type: 'mt:gemini-app-auth-status',
          status,
        };
  }
  if (message.type === 'mt:gemini-app-auth-login') {
    const settings = await services.settings.get();
    const status = await services.geminiAuth.login(settings);
    return isAuthenticationPermissionRequired(status)
      ? authenticationPermissionRequiredResponse(message.type, status)
      : {
          ok: true,
          type: 'mt:gemini-app-auth-login',
          status,
        };
  }
  if (message.type === 'mt:llm-chat-completions') {
    return services.providers.llm(message);
  }
  if (message.type === 'mt:gemini-app-image-translate') {
    return services.providers.geminiAppImage(message);
  }
  if (message.type === 'mt:gemini-api-image-translate') {
    return services.providers.geminiApiImage(message);
  }
  return { ok: false, type: message.type, error: '不支持的消息类型' };
}
