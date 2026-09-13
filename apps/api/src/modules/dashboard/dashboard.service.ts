import type { PrismaClient } from '@prisma/client';
import { WORK_ORDER_STATUSES, type TimeEntryActivityType, type WorkOrderStatus } from '@swatt/shared-types';

/**
 * Klantvraag 13/9/2026 — "Vandaag"-dashboard voor de admin (sectie 19 van de
 * oorspronkelijke projectbrief, nooit gebouwd): "wie is er nu actief aan het
 * werk en bij welk project, hoeveel uur is er vandaag al geregistreerd,
 * hoeveel werkbonnen staan er in concept/ondertekend/met syncfout, hoeveel
 * uur staat er klaar voor facturatie... puur uitlezen van bestaande data —
 * geen nieuwe backend-logica".
 *
 * Bewust een heel dunne, puur-lezende service — geen enkele schrijfactie,
 * geen nieuwe business rule. "Klaar voor facturatie"-uren worden NIET hier
 * opnieuw berekend: dashboard.routes.ts hergebruikt rechtstreeks
 * InvoiceBatchService.listInvoiceable() (dezelfde selectie als het
 * bestaande facturatie-overzicht — invoicingEnabled, nog niet gebatched,
 * ...), zodat deze twee schermen nooit uit de pas kunnen lopen.
 */
export class DashboardService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Iedereen met een RUNNING/PAUSED tijdsregistratie, over alle werknemers heen. Oudste start eerst — wie al langst bezig is valt zo als eerste op (bv. een vergeten timer). */
  async listActiveTimeEntries(): Promise<ActiveTimeEntryRecord[]> {
    const rows = await this.prisma.timeEntry.findMany({
      where: { status: { in: ['RUNNING', 'PAUSED'] } },
      include: {
        employee: { select: { displayName: true } },
        project: { select: { name: true, customer: { select: { name: true } } } },
      },
      orderBy: { startedAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      employeeDisplayName: row.employee.displayName,
      projectName: row.project?.name ?? null,
      customerName: row.project?.customer.name ?? null,
      activityType: row.activityType as TimeEntryActivityType,
      status: row.status as 'RUNNING' | 'PAUSED',
      startedAt: row.startedAt,
      pausedSeconds: row.pausedSeconds,
      currentPauseStartedAt: row.currentPauseStartedAt,
    }));
  }

  /**
   * Som van alle gewerkte tijd waarvan de registratie startte binnen
   * [`from`, `to`) — bedoeld als "vandaag", maar de dagsgrens wordt bewust
   * NIET hier op de server bepaald (zie dashboard.routes.ts: dezelfde les
   * als Fase 19/de lokale-dag-fix van de planningmodule — een Render-server
   * draait in UTC en zou rond middernacht een andere kalenderdag aanwijzen
   * dan de gebruiker in België). Een nog lopende (RUNNING/PAUSED)
   * registratie telt mee tot op het moment van deze aanroep.
   */
  async getTodayTotals(from: Date, to: Date): Promise<{ totalSeconds: number; entryCount: number }> {
    const rows = await this.prisma.timeEntry.findMany({
      where: { startedAt: { gte: from, lt: to } },
      select: { startedAt: true, endedAt: true, pausedSeconds: true, currentPauseStartedAt: true, status: true },
    });
    // Eén gedeeld `now` voor de hele som (i.p.v. `new Date()` per rij) —
    // anders zou een trage query een (verwaarloosbare maar onnodige) drift
    // tussen rijen kunnen geven.
    const now = new Date();
    const totalSeconds = rows.reduce((sum, row) => sum + computeWorkedSecondsAsOf(row, now), 0);
    return { totalSeconds, entryCount: rows.length };
  }

  /** Aantal werkbonnen per status (sectie 20) — alle 7 statussen altijd aanwezig, 0 waar niets van toepassing is (i.p.v. de sleutel gewoon weg te laten). */
  async getWorkOrderStatusCounts(): Promise<Record<WorkOrderStatus, number>> {
    const grouped = await this.prisma.workOrder.groupBy({ by: ['status'], _count: { _all: true } });
    const counts = Object.fromEntries(WORK_ORDER_STATUSES.map((status) => [status, 0])) as Record<WorkOrderStatus, number>;
    for (const row of grouped) {
      counts[row.status as WorkOrderStatus] = row._count._all;
    }
    return counts;
  }
}

export interface ActiveTimeEntryRecord {
  id: string;
  employeeDisplayName: string;
  projectName: string | null;
  customerName: string | null;
  activityType: TimeEntryActivityType;
  status: 'RUNNING' | 'PAUSED';
  startedAt: Date;
  pausedSeconds: number;
  currentPauseStartedAt: Date | null;
}

/**
 * Zelfde formule als elders in deze codebase (bv. ProjectTimerPage.tsx se
 * `computeElapsedSeconds`, invoice-batch.service.ts se
 * `computeWorkedSeconds`) — hier server-side met een expliciet `asOf`-
 * tijdstip i.p.v. impliciet "nu" per rij, zie getTodayTotals() hierboven.
 */
function computeWorkedSecondsAsOf(
  entry: { startedAt: Date; endedAt: Date | null; pausedSeconds: number; currentPauseStartedAt: Date | null; status: string },
  asOf: Date,
): number {
  if (entry.status === 'RUNNING') {
    return Math.max(0, Math.floor((asOf.getTime() - entry.startedAt.getTime()) / 1000) - entry.pausedSeconds);
  }
  if (entry.status === 'PAUSED' && entry.currentPauseStartedAt) {
    return Math.max(0, Math.floor((entry.currentPauseStartedAt.getTime() - entry.startedAt.getTime()) / 1000) - entry.pausedSeconds);
  }
  if (entry.endedAt) {
    return Math.max(0, Math.floor((entry.endedAt.getTime() - entry.startedAt.getTime()) / 1000) - entry.pausedSeconds);
  }
  return 0;
}
