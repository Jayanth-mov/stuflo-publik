import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDatabase(
  connectionString: string,
  options: { closeOnCleanup?: boolean; prepare?: boolean; fetchTypes?: boolean } = {},
) {
  const client = postgres(connectionString, {
    max: 5,
    prepare: options.prepare ?? false,
    fetch_types: options.fetchTypes ?? true,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return {
    db: drizzle(client, { schema }),
    close: () => (options.closeOnCleanup === false ? Promise.resolve() : client.end({ timeout: 5 })),
  };
}

export type StufloDatabase = ReturnType<typeof createDatabase>['db'];
