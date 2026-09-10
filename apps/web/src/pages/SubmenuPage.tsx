import { Link, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ArrowLeftIcon } from '../components/icons';
import { getMenuSections } from '../navigation/menuSections';

/**
 * Klantvraag 10/9/2026 (herzien) — tweede scherm van het tweetrapsmenu: na
 * een klik op een grote groepsknop op HomePage.tsx komt de gebruiker hier
 * terecht en ziet de onderliggende items, eveneens als grote knoppen.
 *
 * `sectionId` komt uit de URL (`/menu/:sectionId`). Bestaat de groep niet
 * (verkeerde/verouderde link) of heeft de huidige rol er geen toegang toe
 * (items leeg, al gefilterd in getMenuSections) -> terug naar het hoofdmenu
 * i.p.v. een lege/kapotte pagina tonen.
 */
export function SubmenuPage() {
  const { user } = useAuth();
  const { sectionId } = useParams<{ sectionId: string }>();

  if (!user) return null;

  const section = getMenuSections(user.role).find((candidate) => candidate.id === sectionId);
  if (!section) return <Navigate to="/" replace />;

  return (
    <main className="flex min-h-screen flex-col items-center bg-swatt-black px-6 py-10 text-white">
      {/* Zelfde gecentreerde `max-w-sm`-kolom als HomePage.tsx/LoginPage.tsx. */}
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <Link
            to="/"
            aria-label="Terug naar menu"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 active:bg-neutral-800"
          >
            <ArrowLeftIcon className="h-5 w-5 text-neutral-300" />
          </Link>
          <div className="flex items-center gap-2">
            <section.icon className="h-5 w-5 shrink-0 text-swatt-gold" />
            <h1 className="text-lg font-semibold">{section.title}</h1>
          </div>
        </div>

        <nav aria-label={section.title} className="flex flex-col gap-3">
          {section.items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-base font-semibold text-neutral-200 active:bg-neutral-800"
            >
              <item.icon className="h-5 w-5 shrink-0 text-swatt-gold" />
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </main>
  );
}
