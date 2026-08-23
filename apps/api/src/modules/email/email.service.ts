import { getEmailConfig, isEmailConfigured } from '../../config/env';
import { EmailErrors } from '../../errors';

export interface SendEmailParams {
  to: string;
  subject: string;
  /** Volledige HTML-body — zie auth-emails.ts voor de opgemaakte sjablonen. */
  html: string;
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
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw EmailErrors.sendFailed(detail.length > 0 ? detail : `HTTP ${response.status}`);
    }
  }
}
