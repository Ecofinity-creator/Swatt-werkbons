import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '../api/client';
import { Logo } from '../components/Logo';

/**
 * Publieke pagina (geen RequireAuth) — "Wachtwoord vergeten" vanaf de
 * loginpagina. Toont bewust ALTIJD dezelfde neutrale bevestiging na
 * versturen, ongeacht of het e-mailadres effectief bestaat: de backend
 * (`POST /auth/forgot-password`) geeft dat zelf ook nooit prijs (voorkomt
 * account-enumeratie, zie auth.routes.ts). Een netwerk-/serverfout is hier
 * wel zichtbaar als fout — dat lekt geen informatie over een specifiek
 * account, enkel dat de aanvraag zelf niet aankwam.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await authApi.forgotPassword(email);
      setIsSubmitted(true);
    } catch {
      setErrorMessage('Er ging iets mis bij het versturen van de aanvraag. Probeer het later opnieuw.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-swatt-black px-6">
      <div className="w-full max-w-sm">
        <Logo size="lg" className="mx-auto mb-4" />
        <p className="mb-10 text-center text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">
          Wachtwoord vergeten
        </p>

        {isSubmitted ? (
          <div className="flex flex-col gap-4">
            <p className="rounded-lg bg-neutral-900 px-4 py-3 text-sm text-neutral-300">
              Als dit e-mailadres bij ons bekend is, ontvang je binnen enkele minuten een e-mail met een
              link om een nieuw wachtwoord in te stellen.
            </p>
            <Link
              to="/login"
              className="text-center text-sm text-swatt-gold underline underline-offset-2"
            >
              Terug naar inloggen
            </Link>
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
                autoComplete="username"
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
              {isSubmitting ? 'Bezig met versturen...' : 'Verstuur link'}
            </button>

            <Link
              to="/login"
              className="text-center text-sm text-neutral-400 underline underline-offset-2"
            >
              Terug naar inloggen
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}
