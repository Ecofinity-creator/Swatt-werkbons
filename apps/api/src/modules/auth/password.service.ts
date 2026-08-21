import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Wachtwoord-hashing via Node's ingebouwde `crypto.scrypt` — bewust géén
 * externe dependency (argon2/bcrypt) met native bindings, om build-problemen
 * op uiteenlopende hostingplatformen (Render, CI) te vermijden. scrypt is
 * een erkend memory-hard KDF en ruim voldoende voor deze toepassing.
 *
 * Opgeslagen formaat: "<salt-hex>:<hash-hex>" — zelfbeschrijvend, zodat de
 * parameters later aangepast kunnen worden zonder bestaande hashes te breken.
 */
export async function hashPassword(plainTextPassword: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = (await scryptAsync(plainTextPassword, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(
  plainTextPassword: string,
  storedHash: string,
): Promise<boolean> {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) {
    // Onverwacht/corrupt formaat — nooit een exception laten lekken naar de caller,
    // gewoon behandelen als "komt niet overeen".
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expectedHash = Buffer.from(hashHex, 'hex');
  const actualHash = (await scryptAsync(plainTextPassword, salt, KEY_LENGTH)) as Buffer;

  if (actualHash.length !== expectedHash.length) {
    return false;
  }

  return timingSafeEqual(actualHash, expectedHash);
}
