/** Gedeelde weergave-constantes tussen meerdere schermen (Home, Medewerkers, ...). */
export const ROLE_LABELS: Record<string, string> = {
  EMPLOYEE: 'Werknemer',
  SUPERVISOR: 'Supervisor',
  ADMIN: 'Administrator',
};

/** Werknemer vs. Onderaannemer op de medewerkerskaart (zie EmploymentType) — los van de rol hierboven. */
export const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  EMPLOYEE: 'Werknemer',
  SUBCONTRACTOR: 'Onderaannemer',
};
