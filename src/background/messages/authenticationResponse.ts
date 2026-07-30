import type {
  AuthenticationPermissionRequired,
} from '../../../apps/extension/src/capabilities/authentication';
import type {
  RuntimeErrorResponse,
  RuntimeMessage,
} from '../../shared/messages';

export type RuntimePermissionRequiredResponse<
  T extends RuntimeMessage['type'],
> = RuntimeErrorResponse & {
  type: T;
  permission: AuthenticationPermissionRequired;
};

export function authenticationPermissionRequiredResponse<
  T extends RuntimeMessage['type'],
>(
  type: T,
  permission: AuthenticationPermissionRequired,
): RuntimePermissionRequiredResponse<T> {
  return {
    ok: false,
    type,
    error: 'Credential authorization is required',
    permission,
  };
}
