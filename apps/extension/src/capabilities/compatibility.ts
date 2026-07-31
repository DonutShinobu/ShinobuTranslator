import type {
  BackgroundExtensionCapabilities,
  PopupExtensionCapabilities,
} from './contracts';

export interface ExtensionCompatibilityCapabilities {
  background(): Pick<
    BackgroundExtensionCapabilities,
    | 'permissions'
    | 'cookies'
  >;
  popup(): Pick<PopupExtensionCapabilities, 'permissions'>;
}
