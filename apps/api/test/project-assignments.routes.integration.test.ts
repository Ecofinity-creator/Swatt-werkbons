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
    const peterProjects = await app.inject({ method: 'GET', url: '/projects/mine', headers: { cookie: peterCookie } });
    expect(peterProjects.statusCode).toBe(200);
    expect(peterProjects.json().projects).toHaveLength(1);
    expect(peterProjects.json().projects[0]).toMatchObject({ name: 'Onderhoud warmtepomp', customerName: 'Janssens BV' });

    const wannesCookie = await loginAs('wannes@swatt.be', 'werfwachtwoord2');
    const wannesProjects = await app.inject({ method: 'GET', url: '/projects/mine', headers: { cookie: wannesCookie } });
    expect(wannesProjects.statusCode).toBe(200);
    expect(wannesProjects.json().projects).toHaveLength(0);
  });

  it('GET /projects vereist minstens SUPERVISOR, en ondersteunt zoeken op klant/project/nummer', async () => {
    await createUser({ email: 'peter@swatt.be', password: 'werfwachtwoord1', role: 'EMPLOYEE' });
    const peterCookie = await loginAs('peter@swatt.be', 'werfwachtwoord1');
    const forbidden = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: peterCookie } });
    expect(forbidden.statusCode).toBe(403);

    await createUser({ email: 'supervisor@swatt.be', password: 'wachtwoord123', role: 'SUPERVISOR' });
    const supervisorCookie = await loginAs('supervisor@swatt.be', 'wachtwoord123');

    await createProject({ teamleaderId: 'proj-1', name: 'Onderhoud warmtepomp', customerName: 'Janssens BV' });
    await createProject({ teamleaderId: 'proj-2', name: 'Service HVAC', customerName: 'De Smet NV' });

    const all = await app.inject({ method: 'GET', url: '/projects', headers: { cookie: supervisorCookie } });
    expect(all.json().projects).toHaveLength(2);

    const search = await app.inject({ method: 'GET', url: '/projects?search=janssens', headers: { cookie: supervisorCookie } });
    expect(search.json().projects).toHaveLength(1);
    expect(search.json().projects[0].customerName).toBe('Janssens BV');
  });

  it('een gearchiveerd project verschijnt nooit in /projects of /projects/mine (business rule 8)', async () => {
    const admin = await createUser({ email: 'admin@swatt.be', password: 'Str0ngPassw0rd!', role: 'ADMIN' });
    const peter = await createUser({ email: 'peter@swatt.be', password: 'werfwachtwoord1', role: 'EMPLOYEE' });
    const archived = await createProject({
      teamleaderId: 'proj-archived',
      name: 'Oud project',
      customerName: 'Oude Klant',
      isArchivedInTl: true,
    });
    await prisma.projectAssignment.create({
      data: { projectId: archived.id, employeeId: peter.employee!.id, assignedByUserId: admin.id },
    });

    const peterCookie = await loginAs('peter@swatt.be', 'werfwachtwoord1');
    const mine = await app.inject({ method: 'GET', url: '/projects/mine', headers: { cookie: peterCookie } });
    expect(mine.json().projects).toHaveLength(0);
  });

  it('SUPERVISOR kan een werknemer aan een project koppelen/ontkoppelen; koppelen is idempotent', async () => {
    await createUser({ email: 'supervisor@swatt.be', password: 'wachtwoord123', role: 'SUPERVISOR' });
    const peter = await createUser({ email: 'peter@swatt.be', password: 'werfwachtwoord1', role: 'EMPLOYEE' });
    const project = await createProject({ teamleaderId: 'proj-1', name: 'Onderhoud warmtepomp', customerName: 'Janssens BV' });

    const supervisorCookie = await loginAs('supervisor@swatt.be', 'wachtwoord123');
    const employeeId = peter.employee!.id;

    const assign1 = await app.inject({
      method: 'POST',
      url: `/admin/employees/${employeeId}/project-assignments`,
      headers: { cookie: supervisorCookie },
      payload: { projectId: project.id },
    });
    expect(assign1.statusCode).toBe(204);

    // Nogmaals koppelen (bv. dubbele klik) mag geen foutmelding geven.
    const assign2 = await app.inject({
      method: 'POST',
      url: `/admin/employees/${employeeId}/project-assignments`,
      headers: { cookie: supervisorCookie },
      payload: { projectId: project.id },
    });
    expect(assign2.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: `/admin/employees/${employeeId}/project-assignments`,
      headers: { cookie: supervisorCookie },
    });
    expect(list.json().projectIds).toEqual([project.id]);

    const remove = await app.inject({
      method: 'POST',
      url: `/admin/employees/${employeeId}/project-assignments/remove`,
      headers: { cookie: supervisorCookie },
      payload: { projectId: project.id },
    });
    expect(remove.statusCode).toBe(204);

    const listAfterRemove = await app.inject({
      method: 'GET',
      url: `/admin/employees/${employeeId}/project-assignments`,
      headers: { cookie: supervisorCookie },
    });
    expect(listAfterRemove.json().projectIds).toEqual([]);
  });

  it('EMPLOYEE mag geen werknemers aan projecten koppelen', async () => {
    const peter = await createUser({ email: 'peter@swatt.be', password: 'werfwachtwoord1', role: 'EMPLOYEE' });
    const project = await createProject({ teamleaderId: 'proj-1', name: 'Onderhoud warmtepomp', customerName: 'Janssens BV' });
    const peterCookie = await loginAs('peter@swatt.be', 'werfwachtwoord1');

    const response = await app.inject({
      method: 'POST',
      url: `/admin/employees/${peter.employee!.id}/project-assignments`,
      headers: { cookie: peterCookie },
      payload: { projectId: project.id },
    });
    expect(response.statusCode).toBe(403);
  });
});
