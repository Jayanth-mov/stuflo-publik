import type { authenticateRequest } from './auth';
import type { StufloEnv } from '../env';

export type AuthenticatedSession = NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>;

export function isAdminEmail(email: string, env: StufloEnv) {
  return new Set((env.ADMIN_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
    .has(email.trim().toLowerCase());
}

export function requireAdmin(session: AuthenticatedSession | null, env: StufloEnv) {
  if (!session) return { error: 'unauthorized' as const, status: 401 };
  if (!isAdminEmail(session.email, env)) return { error: 'forbidden' as const, status: 403 };
  return { session };
}
