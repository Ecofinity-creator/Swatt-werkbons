import type { AdminUserSummary, UserRole } from '@swatt/shared-types';
import { USER_ROLES } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { usersApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';
import { useAuth } from '../../auth/AuthContext';
import { ROLE_LABELS } from '../../constants';

const emptyForm = { email: '', displayName: '', role: 'EMPLOYEE' as UserRole, phone: '' };

/**
 * Backoffice-scherm "Medewerkers" (Stap 5.2, scherm 2). Eerste scherm met het
 * lichte backoffice-thema uit Stap 5 (i.p.v. de zwarte werknemer-UI) — nu er
 * meerdere backoffice-schermen tegelijk bijkomen (Medewerkers + detail), zie
 * het vooruitwijzende commentaar in TeamleaderSettingsPage.tsx. Een gedeelde
 * layout/sidebar-component is een logische volgende stap zodra er nog meer
 * backoffice-schermen bijkomen (Werkbonnenoverzicht, Facturatie, ...).
 */
export function UsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AdminUserSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inviteWarning, setInviteWarning] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      const response = await usersApi.list();
      setUsers(response.users);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de gebruikerslijst niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setInviteWarning(null);
    setIsSubmitting(true);
    try {
      const response = await usersApi.create({
        email: form.email,
        displayName: form.displayName,
        role: form.role,
        ...(form.phone ? { phone: form.phone } : {}),
      });
      if (!response.inviteEmailSent) {
        setInviteWarning(
          `Gebruiker ${form.displayName} is aangemaakt, maar de uitnodigingsmail kon niet worden verstuurd${
            response.inviteEmailError ? ` (${response.inviteEmailError})` : ''
          }. Laat deze persoon "Wachtwoord vergeten" gebruiken op het inlogscherm zodra dit opgelost is.`,
        );
      }
      setForm(emptyForm);
      setShowCreateForm(false);
      await loadUsers();
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Aanmaken van de gebruiker is mislukt.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const isAdmin = currentUser?.role === 'ADMIN';

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Medewerkers</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold-dark">Backoffice</p>
        </div>
        <Link to="/" className="text-sm text-neutral-500 underline">
          Terug
        </Link>
      </header>

      {errorMessage && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      {inviteWarning && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          {inviteWarning}
        </p>
      )}

      {isAdmin && (
        <div className="mb-6">
          {!showCreateForm ? (
            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              className="rounded-lg bg-swatt-gold px-4 py-3 text-sm font-semibold text-swatt-black"
            >
              + Nieuwe gebruiker
            </button>
          ) : (
            <form
              onSubmit={handleCreate}
              className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Naam">
                  <input
                    required
                    value={form.displayName}
                    onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                    className={inputClass}
                  />
                </Field>
                <Field label="E-mailadres">
                  <input
                    required
                    type="email"
                    autoComplete="off"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className={inputClass}
                  />
                </Field>
                <Field label="Rol">
                  <select
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
                    className={inputClass}
                  >
                    {USER_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Telefoon (optioneel)">
                  <input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className={inputClass}
                  />
                </Field>
              </div>
              <p className="text-xs text-neutral-500">
                Er wordt geen wachtwoord ingesteld — de gebruiker krijgt een e-mail met een link om zelf een
                wachtwoord te kiezen.
              </p>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-lg bg-swatt-gold px-4 py-3 text-sm font-semibold text-swatt-black disabled:opacity-60"
                >
                  {isSubmitting ? 'Bezig...' : 'Aanmaken'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateForm(false);
                    setForm(emptyForm);
                  }}
                  className="rounded-lg border border-neutral-300 px-4 py-3 text-sm font-semibold text-neutral-700"
                >
                  Annuleren
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {!users && !errorMessage && <p className="text-neutral-500">Laden...</p>}

      {users && (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3">Naam</th>
                <th className="px-4 py-3">E-mailadres</th>
                <th className="px-4 py-3">Rol</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-neutral-100 last:border-0">
                  <td className="px-4 py-3 font-medium">{user.employee?.displayName ?? '—'}</td>
                  <td className="px-4 py-3 text-neutral-600">{user.email}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-swatt-gold/20 px-2 py-1 text-xs font-semibold text-swatt-gold-dark">
                      {ROLE_LABELS[user.role] ?? user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {user.isActive ? (
                      <span className="text-emerald-700">Actief</span>
                    ) : (
                      <span className="text-neutral-400">Gedeactiveerd</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/backoffice/medewerkers/${user.id}`} className="text-sm font-medium text-swatt-gold-dark underline">
                      Beheren
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const inputClass =
  'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-swatt-gold';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-neutral-600">{label}</span>
      {children}
    </label>
  );
}
