import { Link } from 'react-router-dom';

/**
 * "App op smartphone" — toont een QR-code van de eigen app-URL, zodat een
 * technieker die met de telefoon scant meteen de PWA opent (en kan
 * toevoegen aan het startscherm). Bedoeld om te tonen/printen bij het
 * onboarden van nieuwe medewerkers.
 *
 * Gebruikt `window.location.origin` i.p.v. een hardcoded URL, zodat dit
 * automatisch klopt op elke omgeving (productie, een eventueel later
 * custom domein, ...) zonder aparte configuratie.
 *
 * De QR-afbeelding zelf komt van een publieke, gratis QR-generator-service
 * (api.qrserver.com) — dit encodeert enkel de publieke app-URL (geen
 * gevoelige gegevens) en vermijdt een extra npm-dependency + lockfile-
 * wijziging voor iets dat evengoed als afbeelding kan.
 */
export function AppAccessPage() {
  const appUrl = window.location.origin;
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=10&data=${encodeURIComponent(appUrl)}`;

  return (
    <main className="min-h-screen bg-swatt-black px-6 py-10 text-white">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">App op smartphone</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">Toegang</p>
        </div>
        <Link to="/" className="text-sm text-neutral-400 underline">
          Terug
        </Link>
      </header>

      <section className="flex flex-col items-center rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-center">
        <p className="mb-4 text-sm text-neutral-300">
          Scan deze code met de camera-app van je smartphone om Uurivo te openen.
        </p>

        <div className="rounded-lg bg-white p-3">
          <img src={qrCodeUrl} alt={`QR-code naar ${appUrl}`} width={280} height={280} />
        </div>

        <p className="mt-4 break-all text-sm text-neutral-400">{appUrl}</p>

        <p className="mt-6 text-xs text-neutral-500">
          Tip: kies daarna in de browser &ldquo;Toevoegen aan startscherm&rdquo; zodat de app als icoon
          beschikbaar blijft, net zoals een gewone app.
        </p>
      </section>
    </main>
  );
}
