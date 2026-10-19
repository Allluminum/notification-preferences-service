import { DomainError } from './errors.js';

declare const userIdBrand: unique symbol;
/** Identifier of a user in the platform. Opaque for this service. */
export type UserId = string & { readonly [userIdBrand]: true };

const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export const parseUserId = (value: string): UserId => {
  if (!USER_ID_PATTERN.test(value)) {
    throw new DomainError(
      'invalid_user_id',
      'User id must be 1-128 characters: letters, digits and "._:@-", starting with a letter or digit',
    );
  }
  return value as UserId;
};
