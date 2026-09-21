import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { savePrivateServiceValue, serviceValue } from './service-vault.ts';

const prefix = 'scrypt-v1';
const derivedLength = 64;

export function ownerPasswordError(password: string) {
  const length = Array.from(password).length;
  if (length < 8) return '密码至少需要 8 个字符';
  if (length > 128) return '密码不能超过 128 个字符';
  return '';
}

export function saveOwnerPassword(password: string) {
  const error = ownerPasswordError(password);
  if (error) throw new Error(error);
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, derivedLength);
  savePrivateServiceValue('OWNER_PASSWORD_HASH', [prefix, salt.toString('base64url'), hash.toString('base64url')].join('.'));
}

export function hasCustomOwnerPassword() {
  return Boolean(serviceValue('OWNER_PASSWORD_HASH'));
}

export function verifyCustomOwnerPassword(password: string) {
  if (!password || Array.from(password).length > 128) return false;
  const [version, saltText, hashText, extra] = serviceValue('OWNER_PASSWORD_HASH').split('.');
  if (version !== prefix || !saltText || !hashText || extra) return false;
  try {
    const expected = Buffer.from(hashText, 'base64url');
    if (expected.length !== derivedLength) return false;
    const actual = scryptSync(password, Buffer.from(saltText, 'base64url'), derivedLength);
    return timingSafeEqual(actual, expected);
  } catch { return false; }
}
