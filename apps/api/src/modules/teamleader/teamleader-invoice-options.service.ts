import { TeamleaderErrors } from '../../errors';
import { TeamleaderApiError, type TeamleaderClient } from './teamleader-client.service';

interface DepartmentRow {
  id: string;
  name: string;
}

interface TaxRateRow {
  id: string;
  description: string;
  /** Decimale fractie (bv. 0.21 voor 21%) volgens het officiële blueprint's TaxRate-datatype. */
  rate: number;
}

interface PaymentTermRow {
  type: string;
  days: number;
  /** Niet in elke Teamleader-account-configuratie aanwezig — enkel de standaardtermijn draagt dit, zie paymentTerms.list in het blueprint. */
  meta?: { default?: boolean };
}

export interface TeamleaderInvoiceDepartmentOptionRecord {
  id: string;
  name: string;
}

export interface TeamleaderInvoiceTaxRateOptionRecord {
  id: string;
  label: string;
}

export interface TeamleaderInvoicePaymentTermOptionRecord {
  type: string;
  days: number;
  label: string;
  isDefault: boolean;
}

/** Mensentaal-labels voor de bekende `payment_term.type`-waarden uit het officiële blueprint. Onbekende types vallen terug op een generiek label i.p.v. te crashen. */
const PAYMENT_TERM_TYPE_LABELS: Record<string, string> = {
  CASH: 'Contant',
  END_OF_MONTH: 'Einde van de maand',
  AFTER_INVOICE_DATE: 'Dagen na factuurdatum',
};

/**
 * Phase 10b — live opvraging van de drie vaste keuzes die `invoices.draft`
 * verplicht vraagt (department_id/tax_rate_id/payment_term — zie
 * claude/phase10-facturatie-onderzoek.md). Zelfde bewuste keuze als
 * TeamleaderUserService: GEEN lokale cache/tabel — dit zijn kleine, traag
 * veranderende lijsten die enkel op het Teamleader-instellingenscherm zelf
 * opgevraagd worden (niet bij elke conceptfactuur-aanmaak).
 *
 * BELANGRIJK — niet live geverifieerd tegen een echt Teamleader-account
 * (zelfde beperking als file-sync.service.ts): de exacte veldnamen van
 * `taxRates.list` (`rate` als decimale fractie) en `paymentTerms.list`
 * (`meta.default`) komen uit het officiële blueprint, maar nooit live
 * getest. Bij een afwijkende respons geeft dit een duidelijke
 * TEAMLEADER_SYNC_FAILED-fout i.p.v. stil verkeerde data te tonen.
 */
export class TeamleaderInvoiceOptionsService {
  constructor(private readonly client: TeamleaderClient) {}

  async listDepartments(): Promise<TeamleaderInvoiceDepartmentOptionRecord[]> {
    const rows = await this.callList<DepartmentRow>('departments.list');
    return rows.map((row) => ({ id: row.id, name: row.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listTaxRates(departmentId: string): Promise<TeamleaderInvoiceTaxRateOptionRecord[]> {
    const rows = await this.callList<TaxRateRow>('taxRates.list', { filter: { department_id: departmentId } });
    return rows
      .map((row) => ({
        id: row.id,
        label: `${formatRatePercentage(row.rate)} (${row.description})`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async listPaymentTerms(): Promise<TeamleaderInvoicePaymentTermOptionRecord[]> {
    const rows = await this.callList<PaymentTermRow>('paymentTerms.list');
    return rows.map((row) => ({
      type: row.type,
      days: row.days,
      label: formatPaymentTermLabel(row.type, row.days),
      isDefault: row.meta?.default ?? false,
    }));
  }

  private async callList<TRow>(endpoint: string, body?: Record<string, unknown>): Promise<TRow[]> {
    try {
      return await this.client.listAll<TRow>(endpoint, body);
    } catch (err) {
      throw err instanceof TeamleaderApiError ? TeamleaderErrors.syncFailed(err.message) : err;
    }
  }
}

function formatRatePercentage(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatPaymentTermLabel(type: string, days: number): string {
  const typeLabel = PAYMENT_TERM_TYPE_LABELS[type] ?? type;
  if (type === 'CASH') return typeLabel;
  if (type === 'END_OF_MONTH') return days > 0 ? `${typeLabel} + ${days} dagen` : typeLabel;
  return `${days} dagen (${typeLabel})`;
}
