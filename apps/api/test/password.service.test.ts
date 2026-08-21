import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.service';

describe('password.service (scrypt-gebaseerde hashing)', () => {
  it('slaat nooit het platte wachtwoord op in de hash', async () => {
    const hash = await hashPassword('mijn-geheime-wachtwoord');
    expect(hash).not.toContain('mijn-geheime-wachtwoord');
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('accepteert het juiste wachtwoord', async () => {
    const hash = await hashPassword('correct-paardenbatterij-nietje');
    await expect(verifyPassword('correct-paardenbatterij-nietje', hash)).resolves.toBe(true);
  });

  it('weigert een fout wachtwoord', async () => {
    const hash = await hashPassword('correct-paardenbatterij-nietje');
    await expect(verifyPassword('fout-wachtwoord', hash)).resolves.toBe(false);
  });

  it('geeft twee verschillende hashes voor hetzelfde wachtwoord (unieke salt per hash)', async () => {
    const hashA = await hashPassword('zelfde-wachtwoord');
    const hashB = await hashPassword('zelfde-wachtwoord');
    expect(hashA).not.toBe(hashB);
    await expect(verifyPassword('zelfde-wachtwoord', hashA)).resolves.toBe(true);
    await expect(verifyPassword('zelfde-wachtwoord', hashB)).resolves.toBe(true);
  });

  it('geeft false (niet een exception) bij een corrupt hash-formaat', async () => {
    await expect(verifyPassword('wachtwoord', 'niet-het-juiste-formaat')).resolves.toBe(false);
  });
});
