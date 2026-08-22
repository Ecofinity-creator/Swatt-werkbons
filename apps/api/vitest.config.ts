import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 20000,
    // Meerdere testbestanden (auth.integration.test.ts, teamleader.routes.integration.test.ts, ...)
    // draaien tegen dezelfde echte Postgres-testdatabase en ruimen elk in hun eigen
    // `beforeEach` user/session-rijen op (`deleteMany`). Vitest draait testbestanden
    // standaard parallel over meerdere workers — twee van die opruimbeurten door elkaar
    // veroorzaakt precies dit soort "Foreign key constraint violated: session_user_id_fkey"
    // (het ene bestand verwijdert net de user waar het andere bestand intussen al een
    // sessie voor probeert aan te maken). `fileParallelism: false` laat testbestanden
    // gewoon na elkaar lopen — trager, maar correct voor gedeelde-DB-integratietests.
    fileParallelism: false,
  },
});
