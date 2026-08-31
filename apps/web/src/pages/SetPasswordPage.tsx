import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { authApi } from '../api/client';
import { ApiRequestError } from '../auth/AuthContext';
import { Logo } from '../components/Logo';

/**
 * Publieke pagina (geen RequireAuth) — bedient zowel de "nieuwe gebruiker
 * stelt zelf een wachtwoord in"-flow (uitnodigingsmail) als de "wachtwoord
 * vergeten"-flow: beide sturen de gebruiker hierheen met `?token=...` in de
 * URL, en voor deze pagina zijn ze functioneel identiek — bezit van een
 * geldig, ongebruikt, niet-verlopen token geeft het recht om één nieuw
 * wachtwoord in te stellen (zie password-reset.service.ts). Vandaar bewust
 * geen aparte "InvitePage".
 */
export function SetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;

    if (password.length < 8) {
      setErrorMessage('Wachtwoord moet minstens 8 tekens zijn.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage('De wachtwoorden komen niet overeen.');
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await authApi.resetPassword(token, password);
      setIsSuccess(true);
    } catch (error) {
      setErrorMessage(
        error instanceof ApiRequestError ? error.message : 'Er ging iets mis. Probeer het opnieuw.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-swatt-black px-6">
      <div className="w-full max-w-sm">
        <Logo size="lg" className="mx-auto mb-4" />
        <p className="mb-10 text-center text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">
          Wachtwoord instellen
        </p>

        {!token ? (
          <p className="rounded-lg bg-red-950 px-4 py-3 text-center text-sm text-red-300">
            Deze link is ongeldig. Vraag een nieuwe link aan via{' '}
            <Link to="/wachtwoord-vergeten" className="underline">
              wachtwoord vergeten
            </Link>
            .
          </p>
        ) : isSuccess ? (
          <div className="flex flex-col gap-4">
            <p className="rounded-lg bg-neutral-900 px-4 py-3 text-sm text-neutral-300">
              Je wachtwoord is ingesteld. Je kan nu inloggen.
            </p>
            <Link
              to="/login"
              className="rounded-lg bg-swatt-gold px-4 py-4 text-center text-lg font-bold text-swatt-black transition active:bg-swatt-gold-dark"
            >
              Naar inloggen
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} method="post" className="flex flex-col gap-4">
            <div>
              <label htmlFor="password" className="mb-1 block text-sm text-neutral-300">
                Nieuw wachtwoord
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-base text-white outline-none focus:border-swatt-gold"
              />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="mb-1 block text-sm text-neutral-300">
                Bevestig wachtwoord
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
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
              {isSubmitting ? 'Bezig met opslaan...' : 'Wachtwoord instellen'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
