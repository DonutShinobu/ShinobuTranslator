export function isReferrerPolicy(value: unknown): value is ReferrerPolicy {
  return value === ''
    || value === 'no-referrer'
    || value === 'no-referrer-when-downgrade'
    || value === 'origin'
    || value === 'origin-when-cross-origin'
    || value === 'same-origin'
    || value === 'strict-origin'
    || value === 'strict-origin-when-cross-origin'
    || value === 'unsafe-url';
}
