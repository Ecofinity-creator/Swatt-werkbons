import { Prisma, type PrismaClient } from '@prisma/client';
import { ProjectErrors, TimeEntryErrors } from '../../errors';

const WITH_PROJECT = { include: { project: { include: { customer: true } } } } as const;

export interface TimeEntryRecord {
  id: string;
  employeeId: string;
  projectId: string;
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  startedAt: Date;
  endedAt: Date | null;
  pausedSeconds: number;
  currentPauseStartedAt: Date | null;
  description: string | null;
  project: {
    name: string;
    customer: { name: string };
  };
}

export class TimeEntryService {
  constructor(private readonly prisma: PrismaClient) {}

  async getActive(employeeId: string): Promise<TimeEntryRecord | null> {
    return this.prisma.timeEntry.findFirst({
      where: { employeeId, status: { in: ['RUNNING', 'PAUSED'] } },
      ...WITH_PROJECT,
    });
  }

  async start(employeeId: string, projectId: string): Promise<TimeEntryRecord> {
    const active = await this.getActive(employeeId);
    if (active) {
      throw TimeEntryErrors.alreadyActive();
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.isArchivedInTl) {
      throw ProjectErrors.notFound();
    }

    const assignment = await this.prisma.projectAssignment.findUnique({
      where: { projectId_employeeId: { projectId, employeeId } },
    });
    if (!assignment) {
      throw ProjectErrors.notAssigned();
    }

    try {
      return await this.prisma.timeEntry.create({
        data: { employeeId, projectId, status: 'RUNNING', startedAt: new Date() },
        ...WITH_PROJECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw TimeEntryErrors.alreadyActive();
      }
      throw err;
    }
  }

  async pause(employeeId: string, timeEntryId: string): Promise<TimeEntryRecord> {
    const entry = await this.findOwnedEntry(employeeId, timeEntryId);
    if (entry.status !== 'RUNNING') {
      throw TimeEntryErrors.notRunning();
    }
    return this.prisma.timeEntry.update({
      where: { id: timeEntryId },
      data: { status: 'PAUSED', currentPauseStartedAt: new Date() },
      ...WITH_PROJECT,
    });
  }

  async resume(employeeId: string, timeEntryId: string): Promise<TimeEntryRecord> {
    const entry = await this.findOwnedEntry(employeeId, timeEntryId);
    if (entry.status !== 'PAUSED' || !entry.currentPauseStartedAt) {
      throw TimeEntryErrors.notPaused();
    }
    const pausedSecondsToAdd = secondsBetween(entry.currentPauseStartedAt, new Date());
    return this.prisma.timeEntry.update({
      where: { id: timeEntryId },
      data: {
        status: 'RUNNING',
        pausedSeconds: entry.pausedSeconds + pausedSecondsToAdd,
        currentPauseStartedAt: null,
      },
      ...WITH_PROJECT,
    });
  }

  async stop(employeeId: string, timeEntryId: string, description: string | null): Promise<TimeEntryRecord> {
    const entry = await this.findOwnedEntry(employeeId, timeEntryId);
    if (entry.status === 'STOPPED') {
      throw TimeEntryErrors.alreadyStopped();
    }

    const now = new Date();
    const extraPausedSeconds =
      entry.status === 'PAUSED' && entry.currentPauseStartedAt
        ? secondsBetween(entry.currentPauseStartedAt, now)
        : 0;

    return this.prisma.timeEntry.update({
      where: { id: timeEntryId },
      data: {
        status: 'STOPPED',
        endedAt: now,
        pausedSeconds: entry.pausedSeconds + extraPausedSeconds,
        currentPauseStartedAt: null,
        ...(description !== null ? { description } : {}),
      },
      ...WITH_PROJECT,
    });
  }

  private async findOwnedEntry(employeeId: string, timeEntryId: string): Promise<TimeEntryRecord> {
    const entry = await this.prisma.timeEntry.findUnique({ where: { id: timeEntryId }, ...WITH_PROJECT });
    if (!entry || entry.employeeId !== employeeId) {
      throw TimeEntryErrors.notFound();
    }
    return entry;
  }
}

function secondsBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}
