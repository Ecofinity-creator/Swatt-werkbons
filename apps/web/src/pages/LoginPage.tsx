import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { publicBrandingApi } from '../api/client';
import { ApiRequestError, useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Sectie 21/33 — "app moet gepersonaliseerd aanvoelen": klantlogo (Bedrijfsgegevens)
  // i.p.v. de eerder generieke "Technical Support Team"-tekst. Publieke,
  // niet-geauthenticeerde route (zie company-settings.routes.ts); `null` zolang
  // de klant nog geen eigen logo geüpload heeft, dan tonen we gewoon niets extra.
  const [branding, setBranding] = useState<{ companyName: string; logoDataUrl: string | null } | null>(null);

  useEffect(() => {
    publicBrandingApi
      .get()
      .then(setBranding)
      .catch(() => setBranding(null)); // niet kritiek — het loginscherm werkt ook zonder klantlogo
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await login(email, password, rememberMe);
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
        <div className="mb-10 flex flex-col items-center gap-4">
          {/* Optie 4 uit het ontwerpgesprek: het Uurivo-logo (donkere tekst/pictogram op
              transparante achtergrond) versmelt anders met de zwarte pagina-achtergrond —
              een lichte kaart met een gouden accentrand (bestaande swatt-gold-kleur) lost dat
              op en past bij de rest van de huisstijl (knoppen, "Onthou mij", enz.). */}
          <div className="rounded-2xl border-2 border-swatt-gold bg-neutral-50 p-8">
            <Logo size="lg" />
          </div>
          {branding?.logoDataUrl && (
            <img
              src={branding.logoDataUrl}
              alt={branding.companyName}
              className="h-10 w-auto object-contain"
            />
          )}
        </div>

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

          <label className="flex items-center gap-3 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
              className="h-5 w-5 shrink-0"
            />
            Onthou mij
          </label>

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
