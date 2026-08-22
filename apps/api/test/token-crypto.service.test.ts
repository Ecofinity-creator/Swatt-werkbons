import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from '../src/modules/teamleader/token-crypto.service';

/**
 * Zuivere crypto-unit-test — geen Fastify/Prisma nodig. Vereist wel dat
 * TEAMLEADER_TOKEN_ENCRYPTION_KEY gezet is (zie README "Tests draaien").
 */
describe('token-crypto.service', () => {
  it('versleutelt en ontsleutelt een token symmetrisch (round-trip)', () => {
    const plainText = 'zeer-geheim-access-token-123';

    const encrypted = encryptToken(plainText);
    expect(Buffer.isBuffer(encrypted)).toBe(true);
    // Nooit de platte tekst zomaar terugvinden in het versleutelde blok.
    expect(encrypted.toString('utf8')).not.toContain(plainText);

    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(plainText);
  });

  it('geeft bij elke aanroep een andere ciphertext voor dezelfde platte tekst (unieke IV)', () => {
    const plainText = 'zelfde-token';
    const first = encryptToken(plainText);
    const second = encryptToken(plainText);

    expect(first.equals(second)).toBe(false);
    expect(decryptToken(first)).toBe(plainText);
    expect(decryptToken(second)).toBe(plainText);
  });

  it('gooit een fout wanneer het versleutelde blok gemanipuleerd is (GCM-integriteitscheck)', () => {
    const encrypted = encryptToken('een-token');
    const tampered = Buffer.from(encrypted);
    // Wijzig één byte in de ciphertext (na iv + authTag) — GCM moet dit detecteren.
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;

    expect(() => decryptToken(tampered)).toThrow();
  });
});
