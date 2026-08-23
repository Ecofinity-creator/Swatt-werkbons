import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/modules/auth/password.service';

/**
 * Integratietest tegen een echte (test-)Postgres-database. Seedt Customer/
 * Project rechtstreeks via Prisma (in plaats van via ProjectSyncService) —
 * de daadwerkelijke Teamleader-synchronisatielogica (module-detectie, mapping
 * van API-velden) hoort thuis in een aparte unit test voor
 * project-sync.service.ts; deze test dekt onze eigen routes: het
 * acceptatiecriterium "elke gebruiker kan enkel de projecten selecteren die
 * aan hem gekoppeld zijn" (Stap 3 van de projectbrief).
 */

let app: FastifyInstance;
let prisma: PrismaClient;

beforeAll(async () => {
  app = await buildApp();
  prisma = app.prisma;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.projectAssignment.deleteMany();
  await prisma.project.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.session.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.user.deleteMany();
});

async function createUser(overrides: {
  email: string;
  password: string;
  role: 'EMPLOYEE' | 'SUPERVISOR' | 'ADMIN';
}) {
  return prisma.user.create({
    data: {
      email: overrides.email,
      passwordHash: await hashPassword(overrides.password),
      role: overrides.role,
      employee: { create: { displayName: overrides.email.split('@')[0] ?? 'Test' } },
    },
    include: { employee: true },
  });
}

async function createProject(overrides: {
  teamleaderId: string;
  name: string;
  customerName: string;
  isArchivedInTl?: boolean;
}) {
  const customer = await prisma.customer.create({
    data: {
      teamleaderId: `cust-${overrides.teamleaderId}`,
      teamleaderType: 'company',
      name: overrides.customerName,
      address: 'Dok Noord 3A, 9000 Gent',
      lastSyncedAt: new Date(),
    },
  });
  return prisma.project.create({
    data: {
      teamleaderId: overrides.teamleaderId,
      teamleaderModule: 'PROJECTS_V2',
      customerId: customer.id,
      projectNumber: '123',
      name: overrides.name,
      status: 'open',
      isArchivedInTl: overrides.isArchivedInTl ?? false,
      lastSyncedAt: new Date(),
    },
  });
}

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('Geen set-cookie header ontvangen — kan sessie niet doortesten.');
  return raw.split(';')[0] ?? '';
}

async function loginAs(email: string, password: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  return extractSessionCookie(response.headers['set-cookie']);
}

describe('Projecten + werknemer↔project-koppeling', () => {
  it('GET /projects/mine toont enkel projecten die aan de ingelogde werknemer gekoppeld zijn', async () => {
    const admin = await createUser({ email: 'admin@swatt.be', password: 'Str0ngPassw0rd!', role: 'ADMIN' });
    const peter = await createUser({ email: 'peter@swatt.be', password: 'werfwachtwoord1', role: 'EMPLOYEE' });
    await createUser({ email: 'wannes@swatt.be', password: 'werfwachtwoord2', role: 'EMPLOYEE' });

    const gekoppeld = await createProject({ teamleaderId: 'proj-1', name: 'Onderhoud warmtepomp', customerName: 'Janssens BV' });
    await createProject({ teamleaderId: 'proj-2', name: 'Service HVAC', customerName: 'De Smet NV' });

    await prisma.projectAssignment.create({
      data: { projectId: gekoppeld.id, employeeId: peter.employee!.id, assignedByUserId: admin.id },
    });

    const peterCookie = await loginAs('peter@swatt.be', 'werfwachtwoord1');
    const peterProjects = await app.inject({ method: 'GET', url: '/projects/mine',
