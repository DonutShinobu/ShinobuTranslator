import { observeContentBooleanPreference } from '../contentPreference';

export { ContentBooleanPreference as ImageEditingPreference } from '../contentPreference';

export function observeImageEditingPreference(listener: (enabled: boolean) => void): () => void {
  return observeContentBooleanPreference('enableImageEditing', listener);
}
