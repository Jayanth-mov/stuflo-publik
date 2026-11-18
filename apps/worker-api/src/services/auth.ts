import { hashOpaqueToken, readCookie, serializeExpiredSessionCookie } from '@stuflo/auth';
import { getAuthSessionByTokenHash, revokeAuthSession } from '@stuflo/db';
import type { StufloEnv } from '../env';
import { openDatabase } from './database';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,96}$/;

export async function authenticateRequest(request: Request, env: StufloEnv) {
  const sessionToken = readCookie(request);
  if (!sessionToken || !TOKEN_PATTERN.test(sessionToken)) return null;
  const sessionTokenHash = await hashOpaqueToken(sessionToken);
  const opened = openDatabase(env);
  try {
    return await getAuthSessionByTokenHash(opened.db, sessionTokenHash);
  } finally {
    await opened.close();
  }
}

export async function logout(request: Request, env: StufloEnv) {
  const sessionToken = readCookie(request);
  if (sessionToken && TOKEN_PATTERN.test(sessionToken) && (env.HYPERDRIVE || env.DATABASE_URL)) {
    const sessionTokenHash = await hashOpaqueToken(sessionToken);
    const opened = openDatabase(env);
    try {
      await revokeAuthSession(opened.db, sessionTokenHash);
    } finally {
      await opened.close();
    }
  }
  return serializeExpiredSessionCookie(request.url);
}
