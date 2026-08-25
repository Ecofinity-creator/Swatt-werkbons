import type { CompanySettingsResponseBody } from '@swatt/shared-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { companySettingsApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';
import { compressLogoFile } from '../../lib/image';

type FormState = {
  companyName: string;
  addressLine: string;
  vatNumber: string;
  contactEmail: string;
  contactPhone: string;
  workOrderLegalText: string;
};

function toFormState(settings: CompanySettingsResponseBody): FormState {
  return {
    companyName: settings.companyName,
    addressLine: settings.addressLine ?? '',
    vatNumber: settings.vatNumber ?? '',
    contactEmail: settings.contactEmail ?? '',
    contactPhone: settings.contactPhone ?? '',
    workOrderLegalText: settings.workOrderLegalText,
  };
}

/**
 * Admin-instellingenscherm "Bedrijfsgegevens" (secties 7/12: logo, adres,
 * btw-nummer en contactgegevens op de werkbon-PDF-header — "Configureerbaar
 * door administrator"). Zelfde donkere styling/opbouw als
 * TeamleaderSettingsPage.tsx.
 */
export function CompanySettingsPage() {
  const [settings, setSettings] = useState<CompanySettingsResponseBody | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [logoPreviewDataUrl, setLogoPreviewDataUrl] = useState<string | null>(null);
  const [pendingLogo, setPendingLogo] = useState<{ mimeType: 'image/png'; dataBase64: string } | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await companySettingsApi.get();
      setSettings(response);
      setForm(toFormState(response));
      setLogoPreviewDataUrl(response.logoDataUrl);
      setPendingLogo(null);
      setRemoveLogo(false);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiRequestError ? err.message : 'Kon de bedrijfsgegevens niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleLogoFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setLogoError(null);
    try {
      const compressed = await compressLogoFile(file);
      setPendingLogo({ mimeType: compressed.mimeType, dataBase64: compressed.dataBase64 });
      setLogoPreviewDataUrl(compressed.dataUrl);
      setRemoveLogo(false);
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Kon het logo niet verwerken.');
    } finally {
      // Zelfde bestand nogmaals kunnen kiezen (bv. na een vergissing) — anders vuurt onChange niet opnieuw.
      event.target.value = '';
    }
  }

  function handleRemoveLogo() {
    setPendingLogo(null);
    setLogoPreviewDataUrl(null);
    setRemoveLogo(true);
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    setIsSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const response = await companySettingsApi.update({
        companyName: form.companyName.trim(),
        addressLine: form.addressLine.trim() || null,
        vatNumber: form.vatNumber.trim() || null,
        contactEmail: form.contactEmail.trim() || null,
        contactPhone: form.contactPhone.trim() || null,
        workOrderLegalText: form.workOrderLegalText.trim() || undefined,
        ...(pendingLogo ? { logoMimeType: pendingLogo.mimeType, logoDataBase64: pendingLogo.dataBase64 } : {}),
        ...(removeLogo ? { removeLogo: true } : {}),
      });
      setSettings(response);
      setForm(toFormState(response));
      setLogoPreviewDataUrl(response.logoDataUrl);
      setPendingLogo(null);
      setRemoveLogo(false);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof ApiRequestError ? err.message : 'Opslaan van de bedrijfsgegevens is mislukt.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-swatt-black px-6 py-10 text-white">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Bedrijfsgegevens</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">Instellingen</p>
        </div>
        <Link to="/" className="text-sm text-neutral-400 underline">
          Terug
        </Link>
      </header>

      <p className="mb-6 text-sm text-neutral-400">
        Deze gegevens verschijnen bovenaan elke werkbon-PDF (logo, adres, btw-nummer, contactgegevens) en in de
        juridische bevestigingstekst onderaan.
      </p>

      {loadError && (
        <p className="mb-4 rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">{loadError}</p>
      )}

      {!settings || !form ? (
        <p className="text-sm text-neutral-400">Laden...</p>
      ) : (
        <form onSubmit={(event) => void handleSave(event)} className="space-y-6">
          <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
            <p className="mb-3 text-sm text-neutral-400">Logo</p>
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-32 items-center justify-center rounded-lg bg-black/40">
                {logoPreviewDataUrl ? (
                  <img src={logoPreviewDataUrl} alt="Logo-voorbeeld" className="max-h-14 max-w-[7.5rem] object-contain" />
                ) : (
                  <span className="rounded bg-black px-3 py-2 text-sm font-extrabold tracking-widest text-swatt-gold">
                    SWATT
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-lg border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-200 active:bg-neutral-800"
                >
                  Logo kiezen
                </button>
                {logoPreviewDataUrl && (
                  <button type="button" onClick={handleRemoveLogo} className="text-left text-sm text-red-300 underline">
                    Logo verwijderen
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(event) => void handleLogoFileChange(event)}
                />
              </div>
            </div>
            {logoError && <p className="mt-3 text-sm text-red-300">{logoError}</p>}
            {!logoPreviewDataUrl && !logoError && (
              <p className="mt-3 text-xs text-neutral-500">
                Zonder eigen logo gebruikt de PDF automatisch het gestileerde "SWATT"-tekstlogo hierboven.
              </p>
            )}
          </section>

          <section className="space-y-4 rounded-xl border border-neutral-800 bg-neutral-900 p-5">
            <Field label="Bedrijfsnaam" required>
              <input
                type="text"
                value={form.companyName}
                onChange={(event) => setForm({ ...form, companyName: event.target.value })}
                required
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-white outline-none focus:border-swatt-gold"
              />
            </Field>
            <Field label="Adres">
              <input
                type="text"
                value={form.addressLine}
                onChange={(event) => setForm({ ...form, addressLine: event.target.value })}
                placeholder="Straat en nummer, postcode gemeente"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-white outline-none focus:border-swatt-gold"
              />
            </Field>
            <Field label="BTW-nummer">
              <input
                type="text"
                value={form.vatNumber}
                onChange={(event) => setForm({ ...form, vatNumber: event.target.value })}
                placeholder="BE0727.493.862"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-white outline-none focus:border-swatt-gold"
              />
            </Field>
            <Field label="E-mailadres">
              <input
                type="email"
                value={form.contactEmail}
                onChange={(event) => setForm({ ...form, contactEmail: event.target.value })}
                placeholder="sales@swatt.be"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-white outline-none focus:border-swatt-gold"
              />
            </Field>
            <Field label="Telefoonnummer">
              <input
                type="text"
                value={form.contactPhone}
                onChange={(event) => setForm({ ...form, contactPhone: event.target.value })}
                placeholder="051 15 17 77"
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-white outline-none focus:border-swatt-gold"
              />
            </Field>
            <Field label="Juridische bevestigingstekst (onderaan de PDF)">
              <textarea
                value={form.workOrderLegalText}
                onChange={(event) => setForm({ ...form, workOrderLegalText: event.target.value })}
                rows={2}
                className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-4 py-3 text-sm text-white outline-none focus:border-swatt-gold"
              />
            </Field>
          </section>

          {saveError && <p className="text-sm text-red-300">{saveError}</p>}
          {saved && <p className="text-sm text-emerald-300">Bedrijfsgegevens opgeslagen.</p>}

          <button
            type="submit"
            disabled={isSaving}
            className="w-full rounded-lg bg-swatt-gold px-4 py-4 text-center text-base font-semibold text-swatt-black active:opacity-80 disabled:opacity-50"
          >
            {isSaving ? 'Bezig met opslaan...' : 'Opslaan'}
          </button>
        </form>
      )}
    </main>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-neutral-400">
        {label}
        {required && <span className="text-swatt-gold"> *</span>}
      </span>
      {children}
    </label>
  );
}
