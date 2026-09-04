import type { PrismaClient } from '@prisma/client';
import { isEmailConfigured } from '../../config/env';
import type { EmailService } from '../email/email.service';
import { AuditLogService } from '../audit-log/audit-log.service';

/**
 * Op vraag (3/9/2026): "automatische herinnering bij een 'vergeten' werkbon"
 * — bv. een gestopte timer waarvan de werkbon na een tijdje nog steeds niet
 * ondertekend/verstuurd is. Sluit rechtstreeks aan bij de eerder gebouwde
 * "naar niet-getekende werkbonnen navigeren"-functie (3/9/2026, zelfde dag):
 * dit is de proactieve tegenhanger daarvan.
 *
 * Draait als een periodieke achtergrondtaak binnen het Fastify-process zelf
 * (zie scheduleWorkOrderReminders() in app.ts) — bewust GEEN externe cron-
 * dienst (bv. Render Cron Jobs), want dat vereist handmatige configuratie in
 * Render's dashboard die vanuit hier niet mogelijk is. Nadeel: dit werkt
 * enkel zolang het proces zelf draait (herstart bij elke deploy, en zou niet
 * lopen op een service die inactief mag spinnen-down — voor een always-on
 * Render "Web Service" is dat geen probleem).
 */
export class WorkOrderReminderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Stuurt een herinneringsmail voor elke DRAFT-werkbon die ouder is dan
   * `thresholdHours` en nog geen herinnering kreeg (`reminderSentAt: null`).
   * Geeft het aantal effectief verstuurde herinneringen terug. Eén mislukte
   * verzending (bv. tijdelijk Resend-probleem) mag de andere werkbonnen niet
   * blokkeren — vandaar de try/catch per werkbon i.p.v. rond de hele lus.
   */
  async sendPendingReminders(thresholdHours: number): Promise<number> {
    if (!isEmailConfigured()) {
      return 0;
    }
    const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);
    const pending = await this.prisma.workOrder.findMany({
      where: { status: 'DRAFT', createdAt: { lt: cutoff }, reminderSentAt: null },
      select: {
        id: true,
        workOrderNumber: true,
        createdAt: true,
        project: { select: { name: true, customer: { select: { name: true } } } },
        createdByEmployee: { select: { displayName: true, user: { select: { id: true, email: true } } } },
      },
    });

    let sentCount = 0;
    for (const workOrder of pending as unknown as PendingWorkOrderForReminder[]) {
      try {
        await this.emailService.send({
          to: workOrder.createdByEmployee.user.email,
          subject: `Herinnering: werkbon ${workOrder.workOrderNumber} nog niet afgerond`,
          html: buildReminderEmailHtml(workOrder, thresholdHours),
        });
        await this.prisma.workOrder.update({ where: { id: workOrder.id }, data: { reminderSentAt: new Date() } });
        await this.auditLogService.record({
          actorUserId: null,
          action: 'WORK_ORDER_REMINDER_SENT',
          entityType: 'WorkOrder',
          entityId: workOrder.id,
          metadata: { workOrderNumber: workOrder.workOrderNumber, toUserId: workOrder.createdByEmployee.user.id },
        });
        sentCount += 1;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`WorkOrderReminderService: herinnering voor werkbon ${workOrder.workOrderNumber} mislukt:`, err);
      }
    }
    return sentCount;
  }
}

interface PendingWorkOrderForReminder {
  id: string;
  workOrderNumber: string;
  createdAt: Date;
  project: { name: string; customer: { name: string } };
  createdByEmployee: { displayName: string; user: { id: string; email: string } };
}

function buildReminderEmailHtml(workOrder: PendingWorkOrderForReminder, thresholdHours: number): string {
  const days = Math.floor(thresholdHours / 24);
  const periodLabel = days >= 1 ? `${days} dag${days === 1 ? '' : 'en'}` : `${thresholdHours} uur`;
  return `
    <p>Hallo ${escapeHtml(workOrder.createdByEmployee.displayName)},</p>
    <p>
      Werkbon <strong>${escapeHtml(workOrder.workOrderNumber)}</strong> bij ${escapeHtml(workOrder.project.customer.name)}
      (project "${escapeHtml(workOrder.project.name)}") staat al meer dan ${periodLabel} klaar, maar is nog niet
      ondertekend door de klant.
    </p>
    <p>Open de app en ga naar het project om deze werkbon alsnog te laten tekenen.</p>
  `;
}

/** Zelfde minimale HTML-escaping als elders (auth-emails.ts, work-order.routes.ts). */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
