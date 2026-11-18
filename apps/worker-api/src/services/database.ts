import { createDatabase } from '@stuflo/db';
import type { StufloEnv } from '../env';

export function openDatabase(env: StufloEnv) {
  const connectionString = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
  if (!connectionString) throw new Error('Postgres/Hyperdrive is not configured.');
  return createDatabase(connectionString, {
    // A fresh Postgres.js client is created for each Worker request. Hyperdrive
    // owns connection cleanup at invocation end; explicitly ending it can race
    // with a later query in the same request.
    closeOnCleanup: !env.HYPERDRIVE,
    prepare: Boolean(env.HYPERDRIVE),
    fetchTypes: !env.HYPERDRIVE,
  });
}
