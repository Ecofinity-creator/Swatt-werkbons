import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiRequestError, portalApi } from '../../api/client';
import { Logo } from '../../components/Logo';

/**
 * Klantportaal (sectie 30) — inlogscherm voor de eindklant. Magic-link i.p.v.
 * wachtwoord: enkel een e-mailadres invullen, daarna altijd dezelfde neutrale
 * bevestiging tonen (anti-enumeratie, zelfde redenering als
 * ForgotPasswordPage.tsx) — de UI kan dus nooit laten blijken of een
 * e-mailadres wel/niet bij een klant hoort.
 */
export function PortalLoginPage() {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSent, setIsSent] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await portalApi.requestLink(email);
      setIsSent(true);
    } catch (error) {
      setErrorMessage(error instanceof ApiRequestError ? error.message : 'Er ging iets mis. Probeer het opnieuw.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-swatt-black px-6">
      <div className="w-full max-w-sm">
        <div className="mb-10 flex flex-col items-center gap-4">
          <div className="rounded-2xl border-2 border-swatt-gold bg-neutral-50 p-8">
            <Logo size="lg" />
          </div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-neutral-400">Klantportaal</p>
        </div>

        {isSent ? (
          <div className="flex flex-col gap-3 rounded-lg border border-neutral-700 bg-neutral-900 px-5 py-6 text-center">
            <p className="text-lg font-semibold text-white">Check je e-mail</p>
            <p className="text-sm text-neutral-400">
              Als dit e-mailadres bij een klant hoort, is er net een inloglink naartoe gestuurd. De link is 15 minuten
              geldig.
            </p>
            <button
              type="button"
              onClick={() => setIsSent(false)}
              className="mt-2 text-sm text-neutral-400 underline underline-offset-2"
            >
              Ander e-mailadres proberen
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} method="post" className="flex flex-col gap-4">
            <div>
              <label htmlFor="email" className="mb-1 block text-sm text-neutral-300">
                E-mailadres
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
              />
            </div>

            {errorMessage && (
              <p role="alert" className="rounded-lg bg-red-950 px-4 py-3 text-sm text-red-300">
                {errorMessage}
              </p>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-2 rounded-lg bg-swatt-gold px-4 py-4 text-lg font-bold text-swatt-black transition active:bg-swatt-gold-dark disabled:opacity-60"
            >
              {isSubmitting ? 'Bezig...' : 'Stuur inloglink'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
