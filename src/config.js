// Configuration lue depuis l'environnement. Les secrets (clés d'IA, jeton d'accès)
// ne sont jamais stockés en base : ils restent dans l'environnement du processus.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

const env = process.env;

export function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir ?? env.OMNIA_DATA_DIR ?? path.resolve('data');
  return {
    host: env.OMNIA_HOST ?? '127.0.0.1',
    port: Number(env.OMNIA_PORT ?? 4747),
    token: env.OMNIA_TOKEN ?? '',
    stripeKey: env.OMNIA_STRIPE_KEY ?? '',
    cookieSecure: env.OMNIA_COOKIE_SECURE === '1',
    dataDir,
    dbPath: overrides.dbPath ?? env.OMNIA_DB ?? path.join(dataDir, 'omnia.db'),
    exportDir: path.join(dataDir, 'exports'),
    modulesDir: env.OMNIA_MODULES_DIR ?? path.join(dataDir, 'modules'),
    version: VERSION,
    ai: {
      provider: env.OMNIA_AI_PROVIDER ?? 'local',
      model: env.OMNIA_AI_MODEL ?? '',
      baseUrl: env.OMNIA_AI_BASE_URL ?? '',
      apiKey: env.OMNIA_AI_API_KEY ?? '',
    },
    schedulerSeconds: Number(env.OMNIA_SCHEDULER_SECONDS ?? 60),
    ...overrides,
  };
}

export const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);
