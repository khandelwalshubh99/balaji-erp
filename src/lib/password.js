import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(plain) {
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [scheme, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const key = Buffer.from(keyHex, 'hex');
    const test = scryptSync(plain, Buffer.from(saltHex, 'hex'), key.length);
    return timingSafeEqual(key, test);
  } catch {
    return false;
  }
}
