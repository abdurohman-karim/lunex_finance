import { execSync } from 'node:child_process';
import 'dotenv/config';
import pg from 'pg';

/**
 * e2e tests run on a database of their own beside the development one (`lunex_e2e` on the
 * same server, or E2E_DATABASE_URL): a running development server, its jobs and the Central
 * Bank's rates it loads never meet the tests' data.
 */
export function e2eDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const url = new URL(
    process.env.DATABASE_URL ?? 'postgresql://lunex:lunex@localhost:5442/lunex',
  );
  url.pathname = '/lunex_e2e';
  return url.toString();
}

/** Vitest global setup: the database is created once, then migrated and seeded every run. */
export default async function setup(): Promise<void> {
  const url = e2eDatabaseUrl();
  const name = new URL(url).pathname.slice(1);
  const server = new URL(url);
  server.pathname = '/postgres';
  const client = new pg.Client({ connectionString: server.toString() });
  await client.connect();
  try {
    const found = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if (found.rowCount === 0) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  const env = { ...process.env, DATABASE_URL: url };
  execSync('npx prisma migrate deploy', { env, stdio: 'pipe' });
  execSync('npx prisma db seed', { env, stdio: 'pipe' });
}
