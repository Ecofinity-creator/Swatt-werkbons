import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getTeamleaderConfig } from '../../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // aanbevolen IV-lengte voor GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Symmetrische encryptie voor de Teamleader access/refresh tokens die we
 * lokaal moeten bewaren ("veilige encrypted token storage", sectie 3 en 25
 * van de projectbrief). AES-256-GCM via Node's ingebouwde `crypto` — zelfde
 * bewuste keuze als password.service.ts (scrypt): geen externe dependency
 * met native bindings die op een hostingplatform kan mislukken.
 *
 * De sleutel zelf (TEAMLEADER_TOKEN_ENCRYPTION_KEY) leeft uitsluitend als
 * environment variable (Render secret), nooit in de database of in git —
 * de eenvoudigste vorm van de "envelope encryption met een KMS-sleutel" uit
 * de oorspronkelijke Stap 4-schets. Rotatie van deze sleutel betekent wel dat
 * de bestaande Teamleader-koppeling opnieuw gelegd moet worden (bewuste
 * MVP-beperking — vermeld bij een eventuele sleutelrotatie-procedure).
 *
 * Opgeslagen formaat: iv (12 bytes) || authTag (16 bytes) || ciphertext.
 * Zelfbeschrijvend genoeg om later evt. van GCM-parameters te wisselen
 * zonder bestaande rijen te breken (net als het "<salt>:<hash>"-formaat
 * in password.service.ts).
 */
export function encryptToken(plainText: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptToken(encrypted: Buffer | Uint8Array): string {
  const buffer = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
  const iv = buffer.subarray(0, IV_LENGTH);
  const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  const plainText = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plainText.toString('utf8');
}

function getEncryptionKey(): Buffer {
  // getTeamleaderConfig() gooit zelf een duidelijke fout als de Teamleader-
  // integratie niet geconfigureerd is — encrypt/decryptToken worden alleen
  // aangeroepen door TeamleaderAuthService, die dat altijd al vooraf checkt
  // (assertConfigured()), dus dit is hier geen dubbele UX-fout, enkel een
  // laatste vangnet.
  return Buffer.from(getTeamleaderConfig().tokenEncryptionKey, 'base64');
}
