import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiRequestError, useAuth } from '../auth/AuthContext';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (error) {
      // Mensentaal-boodschap komt rechtstreeks van de API (sectie 27 van de brief).
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
        <h1 className="mb-1 text-center text-3xl font-extrabold tracking-tight text-white">
          SWATT
        </h1>
        <p className="mb-10 text-center text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">
          Technical Support Team
        </p>

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

          <div>
            <label htmlFor="password" className="mb-1 block text-sm text-neutral-300">
              Wachtwoord
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
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
            {isSubmitting ? 'Bezig met inloggen...' : 'Inloggen'}
          </button>

          <Link
            to="/wachtwoord-vergeten"
            className="text-center text-sm text-neutral-400 underline underline-offset-2"
          >
            Wachtwoord vergeten?
          </Link>
        </form>
      </div>
    </main>
  );
}
