import { getEmailConfig, isEmailConfigured } from '../../config/env';
import { EmailErrors } from '../../errors';

export interface SendEmailParams {
  to: string;
  subject: string;
  /** Volledige HTML-body — zie auth-emails.ts voor de opgemaakte sjablonen. */
  html: string;
  /**
   * Op vraag (3/9/2026): "PDF via een knop naar de klant sturen" — Resend
   * ondersteunt bijlagen als base64-gecodeerde inhoud (max. 40MB per e-mail
   * na base64-codering — geverifieerd via resend.com/docs/api-reference/
   * emails/send-email). Optioneel, want de meeste bestaande e-mails
   * (uitnodiging, wachtwoord-reset) hebben er geen nodig.
   */
  attachments?: Array<{ filename: string; content: string }>;
}

export interface EmailService {
  send(params: SendEmailParams): Promise<void>;
}

/**
 * Resend (resend.com) via hun REST-API rechtstreeks met `fetch` — bewust
 * géén `resend`-npm-package (extra dependency + package-lock-wijziging) voor
 * iets dat neerkomt op één simpele POST-aanroep. Zelfde stijl als
 * teamleader-client.service.ts.
 *
 * Zelfde filosofie als de Teamleader-integratie: als RESEND_API_KEY/
 * EMAIL_FROM_ADDRESS niet gezet zijn, gooit `send()` een duidelijke
 * "niet geconfigureerd"-fout i.p.v. de hele app te laten crashen bij opstart.
 */
export class ResendEmailService implements EmailService {
  async send(params: SendEmailParams): Promise<void> {
    if (!isEmailConfigured()) {
      throw EmailErrors.notConfigured();
    }
    const config = getEmailConfig();

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.fromAddress,
        to: params.to,
        subject: params.subject,
        html: params.html,
        ...(params.attachments ? { attachments: params.attachments } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw EmailErrors.sendFailed(detail.length > 0 ? detail : `HTTP ${response.status}`);
    }
  }
}
