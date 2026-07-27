import type { ExtensionSettings } from '../../shared/config';
import type { ChromeMessageSender } from '../../shared/chrome';
import type {
  RuntimeMessage,
  RuntimeResponse,
} from '../../shared/messages';
import type { ImageDownloadRequest } from '../images/imageDownloader';

type MessageOf<T extends RuntimeMessage['type']> = Extract<RuntimeMessage, { type: T }>;
type SuccessOf<T extends RuntimeResponse['type']> = Extract<RuntimeResponse, { ok: true; type: T }>;
type PayloadOf<T extends RuntimeResponse['type']> = Omit<SuccessOf<T>, 'ok' | 'type'>;

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
      sender: ChromeMessageSender,
    ): Promise<PayloadOf<'mt:download-image'>>;
    capture(sender: ChromeMessageSender): Promise<PayloadOf<'mt:capture-visible-tab'>>;
  };
  openAi: {
    status(): Promise<PayloadOf<'mt:openai-oauth-status'>['status']>;
    login(): Promise<PayloadOf<'mt:openai-oauth-login'>['status']>;
    logout(): Promise<PayloadOf<'mt:openai-oauth-logout'>['status']>;
  };
  geminiAuth: {
    status(settings: ExtensionSettings): Promise<PayloadOf<'mt:gemini-app-auth-status'>['status']>;
    login(settings: ExtensionSettings): Promise<PayloadOf<'mt:gemini-app-auth-login'>['status']>;
  };
  providers: {
    llm(message: MessageOf<'mt:llm-chat-completions'>): Promise<SuccessOf<'mt:llm-chat-completions'>>;
    geminiAppImage(message: MessageOf<'mt:gemini-app-image-translate'>): Promise<SuccessOf<'mt:gemini-app-image-translate'>>;
    geminiApiImage(message: MessageOf<'mt:gemini-api-image-translate'>): Promise<SuccessOf<'mt:gemini-api-image-translate'>>;
  };
};

export async function routeBackgroundMessage(
  message: RuntimeMessage,
  sender: ChromeMessageSender,
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
    const request: ImageDownloadRequest = {
      imageUrl: message.imageUrl,
      ...(message.referrerPolicy !== undefined
        ? { referrerPolicy: message.referrerPolicy }
        : {}),
    };
    return {
      ok: true,
      type: 'mt:download-image',
      ...await services.images.download(request, sender),
    };
  }
  if (message.type === 'mt:capture-visible-tab') {
    return { ok: true, type: 'mt:capture-visible-tab', ...await services.images.capture(sender) };
  }
  if (message.type === 'mt:openai-oauth-status') {
    return { ok: true, type: 'mt:openai-oauth-status', status: await services.openAi.status() };
  }
  if (message.type === 'mt:openai-oauth-login') {
    return { ok: true, type: 'mt:openai-oauth-login', status: await services.openAi.login() };
  }
  if (message.type === 'mt:openai-oauth-logout') {
    return { ok: true, type: 'mt:openai-oauth-logout', status: await services.openAi.logout() };
  }
  if (message.type === 'mt:gemini-app-auth-status') {
    const settings = await services.settings.get();
    return {
      ok: true,
      type: 'mt:gemini-app-auth-status',
      status: await services.geminiAuth.status(settings),
    };
  }
  if (message.type === 'mt:gemini-app-auth-login') {
    const settings = await services.settings.get();
    return {
      ok: true,
      type: 'mt:gemini-app-auth-login',
      status: await services.geminiAuth.login(settings),
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
