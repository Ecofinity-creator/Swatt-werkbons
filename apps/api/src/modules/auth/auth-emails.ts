import { env } from '../../config/env';
import type { SendEmailParams } from '../email/email.service';

/**
 * Bouwt de link naar het frontend-scherm dat het token verwerkt
 * (`/wachtwoord-instellen?token=...`) — bewust dezelfde pagina voor zowel
 * een uitnodiging als een "wachtwoord vergeten"-reset, want functioneel is
 * het identiek: een geldig token geeft het recht om één nieuw wachtwoord te
 * zetten. Hergebruikt env.CORS_ORIGINS[0] als frontend-basis-URL — zelfde
 * patroon als de Teamleader OAuth-callback-redirect in teamleader.routes.ts.
 */
function buildSetPasswordLink(token: string): string {
  const frontendBase = env.CORS_ORIGINS[0] ?? 'http://localhost:5173';
  return `${frontendBase}/wachtwoord-instellen?token=${encodeURIComponent(token)}`;
}

/** Minimale, zelfstandige HTML-e-mailomslag — geen externe assets/CSS-bestanden (moet ook zonder JS/CSS-laden correct tonen in een mailclient). */
function emailShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="background:#0a0a0a;padding:24px 32px;">
                <span style="color:#f5c542;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">UURIVO</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:20px;color:#0a0a0a;">${title}</h1>
                ${bodyHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Zie PasswordResetService.TOKEN_TTL_MS — 1 uur geldig. */
export function buildPasswordResetEmail(to: string, token: string): SendEmailParams {
  const link = buildSetPasswordLink(token);
  return {
    to,
    subject: 'Wachtwoord opnieuw instellen — Uurivo',
    html: emailShell(
      'Wachtwoord opnieuw instellen',
      `<p style="margin:0 0 16px;color:#404040;font-size:14px;line-height:1.6;">Er werd een wachtwoordreset aangevraagd voor dit e-mailadres. Klik op de knop hieronder om een nieuw wachtwoord in te stellen. Deze link is 1 uur geldig.</p>
       <p style="margin:0 0 24px;"><a href="${link}" style="display:inline-block;background:#f5c542;color:#0a0a0a;padding:12px 24px;border-radius:8px;font-weight:700;text-decoration:none;font-size:14px;">Nieuw wachtwoord instellen</a></p>
       <p style="margin:0;color:#a3a3a3;font-size:12px;">Heb je dit niet aangevraagd? Dan kan je deze e-mail gewoon negeren — er verandert niets aan je account.</p>`,
    ),
  };
}

/**
 * Verlopen uitnodiging? Kan gewoon opnieuw via "Wachtwoord vergeten" op het
 * inlogscherm — dat werkt ook voor een account zonder wachtwoord (zie
 * AuthService.login / auth.routes.ts), dus er is bewust geen apart, langer
 * geldig token-type nodig voor uitnodigingen.
 */
export function buildInviteEmail(to: string, token: string, displayName: string): SendEmailParams {
  const link = buildSetPasswordLink(token);
  return {
    to,
    subject: 'Welkom bij Uurivo — stel je wachtwoord in',
    html: emailShell(
      `Welkom, ${displayName}`,
      `<p style="margin:0 0 16px;color:#404040;font-size:14px;line-height:1.6;">Er werd een Uurivo-account voor je aangemaakt. Klik op de knop hieronder om je wachtwoord in te stellen en in te loggen. Deze link is 1 uur geldig.</p>
       <p style="margin:0 0 24px;"><a href="${link}" style="display:inline-block;background:#f5c542;color:#0a0a0a;padding:12px 24px;border-radius:8px;font-weight:700;text-decoration:none;font-size:14px;">Wachtwoord instellen</a></p>
       <p style="margin:0;color:#a3a3a3;font-size:12px;">Verwachtte je deze e-mail niet? Neem dan contact op met je beheerder. Link verlopen? Vraag gewoon een nieuwe aan via "Wachtwoord vergeten" op het inlogscherm.</p>`,
    ),
  };
}
