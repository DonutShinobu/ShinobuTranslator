import type {
  BackgroundExtensionCapabilities,
  PopupExtensionCapabilities,
} from './contracts';

export interface ExtensionCompatibilityCapabilities {
  background(): Pick<
    BackgroundExtensionCapabilities,
    | 'permissions'
    | 'cookies'
    | 'referrerPolicies'
    | 'requestHeaderOverride'
  >;
  popup(): Pick<PopupExtensionCapabilities, 'permissions'>;
}
