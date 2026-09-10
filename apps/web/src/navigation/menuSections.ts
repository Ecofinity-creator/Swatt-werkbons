import type { ComponentType, SVGProps } from 'react';
import type { UserRole } from '@swatt/shared-types';
import { roleAtLeast } from '@swatt/shared-types';
import {
  AlertTriangleIcon,
  BuildingIcon,
  CalendarIcon,
  ClipboardCheckIcon,
  DownloadIcon,
  EuroIcon,
  FolderIcon,
  LinkIcon,
  QrCodeIcon,
  ShieldCheckIcon,
  UsersIcon,
  WalletIcon,
} from '../components/icons';

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export interface NavItem {
  to: string;
  label: string;
  icon: IconComponent;
}

export interface MenuSectionConfig {
  /** URL-segment voor `/menu/:sectionId` — stabiel houden, wordt niet aan de gebruiker getoond. */
  id: string;
  title: string;
  icon: IconComponent;
  items: NavItem[];
}

/**
 * Klantvraag 10/9/2026 (herzien): "grote knoppen met tekst en icoon erop, als
 * je erop klikt krijg je dan het submenu te zien" — i.p.v. een inklapbare
 * accordeon op HomePage.tsx zelf, is dit nu een echt tweetrapsmenu:
 *
 * 1) HomePage.tsx toont per groep één grote knop (icoon + titel + aantal
 *    items).
 * 2) Een klik navigeert naar `/menu/:sectionId` (SubmenuPage.tsx), die de
 *    onderliggende items toont — eveneens als grote knoppen.
 *
 * Deze config is gedeeld tussen HomePage en SubmenuPage zodat de indeling
 * op precies één plaats staat. Groepen volgen de procesvolgorde uit de
 * projectbrief (zie eerdere toelichting in git-historie):
 *
 * - "Planning & team" (sectie 4/5 — vóór de uitvoering: wie werkt waar).
 * - "Werkbonnen beheren" (sectie 20/13/9 — controle/opvolging ná uitvoering).
 * - "Facturatie & rapportage" (sectie 17/19/26 — de maandafsluiting).
 * - "Instellingen" (sectie 3/7 — configuratie, geen dagelijkse workflow-stap).
 *
 * "Mijn werk" (project kiezen -> tijd registreren -> werkbon, sectie 21)
 * blijft bewust BUITEN deze config: dat is de primaire, dagelijkse flow en
 * staat als losse grote knoppen direct op HomePage, niet achter een
 * submenu-klik verstopt.
 *
 * Een groep zonder zichtbare items voor de huidige rol wordt hier al
 * weggefilterd, zodat een werknemer enkel "Instellingen" (met alleen de
 * QR-code-optie) te zien krijgt.
 */
export function getMenuSections(role: UserRole): MenuSectionConfig[] {
  const isSupervisorPlus = roleAtLeast(role, 'SUPERVISOR');
  const isAdmin = roleAtLeast(role, 'ADMIN');

  const sections: MenuSectionConfig[] = [
    {
      id: 'planning',
      title: 'Planning & team',
      icon: CalendarIcon,
      items: isSupervisorPlus
        ? [
            { to: '/backoffice/planning', label: 'Planningsbord', icon: CalendarIcon },
            { to: '/backoffice/medewerkers', label: 'Medewerkers', icon: UsersIcon },
            { to: '/backoffice/projecten', label: 'Projecten', icon: FolderIcon },
          ]
        : [],
    },
    {
      id: 'werkbonnen-beheren',
      title: 'Werkbonnen beheren',
      icon: ClipboardCheckIcon,
      items: isSupervisorPlus
        ? [
            { to: '/backoffice/werkbonnen', label: 'Werkbonnenoverzicht', icon: ClipboardCheckIcon },
            { to: '/backoffice/sync-fouten', label: 'Synchronisatiefouten', icon: AlertTriangleIcon },
          ]
        : [],
    },
    {
      id: 'facturatie',
      title: 'Facturatie & rapportage',
      icon: EuroIcon,
      items: isAdmin
        ? [
            { to: '/backoffice/facturatie', label: 'Facturatie', icon: EuroIcon },
            { to: '/backoffice/uren-export', label: 'Uren-export', icon: DownloadIcon },
            { to: '/backoffice/personeelsuitbetaling', label: 'Personeelsuitbetaling', icon: WalletIcon },
            { to: '/backoffice/auditlog', label: 'Auditlog', icon: ShieldCheckIcon },
          ]
        : [],
    },
    {
      id: 'instellingen',
      title: 'Instellingen',
      icon: BuildingIcon,
      items: [
        { to: '/app-toegang', label: 'App op smartphone (QR-code)', icon: QrCodeIcon },
        ...(isAdmin
          ? [
              { to: '/instellingen/teamleader', label: 'Teamleader-integratie', icon: LinkIcon },
              { to: '/instellingen/bedrijf', label: 'Bedrijfsgegevens', icon: BuildingIcon },
            ]
          : []),
      ],
    },
  ];

  return sections.filter((section) => section.items.length > 0);
}
