import { env } from '../../config/env';
import type { SendEmailParams } from '../email/email.service';

/** Zelfde patroon als buildSetPasswordLink() in auth/auth-emails.ts — env.CORS_ORIGINS[0] als frontend-basis-URL. */
function buildPortalVerifyLink(token: string): string {
  const frontendBase = env.CORS_ORIGINS[0] ?? 'http://localhost:5173';
  return `${frontendBase}/klantportaal/verify?token=${encodeURIComponent(token)}`;
}

/** Zelfde minimale, zelfstandige HTML-e-mailomslag als auth-emails.ts — bewust hier gedupliceerd i.p.v. geïmporteerd (geen gedeelde helper tussen de twee auth-domeinen, zie de toelichting bij CustomerPortalAuthService). */
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

/** Zie CustomerPortalAuthService.TOKEN_TTL_MS — 15 minuten geldig, eenmalig bruikbaar. */
export function buildCustomerPortalLoginEmail(to: string, token: string): SendEmailParams {
  const link = buildPortalVerifyLink(token);
  return {
    to,
    subject: 'Inloglink klantportaal — Uurivo',
    html: emailShell(
      'Inloggen op het klantenportaal',
      `<p style="margin:0 0 16px;color:#404040;font-size:14px;line-height:1.6;">Klik op de knop hieronder om in te loggen en je werkbonnen en facturatiestatus te bekijken. Deze link is 15 minuten geldig en kan maar één keer gebruikt worden.</p>
       <p style="margin:0 0 24px;"><a href="${link}" style="display:inline-block;background:#f5c542;color:#0a0a0a;padding:12px 24px;border-radius:8px;font-weight:700;text-decoration:none;font-size:14px;">Inloggen</a></p>
       <p style="margin:0;color:#a3a3a3;font-size:12px;">Heb je dit niet aangevraagd? Dan kan je deze e-mail gewoon negeren.</p>`,
    ),
  };
}
