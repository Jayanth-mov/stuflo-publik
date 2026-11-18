import { WebCryptoKeyring, type EncryptedEnvelope } from '@stuflo/crypto';
import {
  getCanvasConnectionByStudentKey,
  getCanvasConnectionRecordByStudentKey,
  getStudentByKey,
  upsertCanvasConnection,
  updateCanvasConnectionStatus,
  type StufloDatabase,
} from '@stuflo/db';
import {
  CanvasAdapter,
  CanvasError,
  normalizeCanvasHost,
  validateCanvasCookies,
  type CanvasConnection,
} from '@stuflo/lms';
import type { StufloEnv } from '../env';
import { openDatabase } from './database';

function keyring(env: StufloEnv): WebCryptoKeyring {
  if (!env.COOKIE_ENCRYPTION_KEYS) throw new Error('COOKIE_ENCRYPTION_KEYS is not configured.');
  return WebCryptoKeyring.fromJson(env.COOKIE_ENCRYPTION_KEYS);
}

function activeKeyId(env: StufloEnv): string {
  if (!env.ACTIVE_COOKIE_ENCRYPTION_KEY_ID) {
    throw new Error('ACTIVE_COOKIE_ENCRYPTION_KEY_ID is not configured.');
  }
  return env.ACTIVE_COOKIE_ENCRYPTION_KEY_ID;
}

function reconnectMessage(code?: string) {
  return code === 'permission_denied'
    ? 'Canvas rejected the saved login. Open Canvas in Chrome, sign in again, and reconnect with the StuFlo extension.'
    : 'Your Canvas login has expired. Open Canvas in Chrome, sign in again, and reconnect with the StuFlo extension.';
}

const CANVAS_SESSION_RETRY_DELAY_MS = 250;
const CANVAS_STATUS_CACHE_MS = 60_000;
const CANVAS_RECONNECT_GRACE_MS = 90_000;

type CanvasRow = NonNullable<Awaited<ReturnType<typeof getCanvasConnectionRecordByStudentKey>>>;

function savedCanvasStatus(row: CanvasRow) {
  return {
    connected: row.status !== 'expired',
    verificationStatus: row.status === 'connected' ? 'stored' as const : row.status === 'expired' ? 'invalid' as const : 'unavailable' as const,
    reconnectRequired: row.status === 'expired',
    canvasHost: row.canvasHost,
    cookiesUpdatedAt: row.cookiesUpdatedAt,
    lastValidatedAt: row.lastValidatedAt,
    ...(row.status === 'expired' ? { message: reconnectMessage() } : row.status === 'suspect'
      ? { message: 'StuFlo kept your Canvas connection and is waiting for refreshed cookies before retrying.' } : {}),
  };
}

async function currentCanvasStatus(db: StufloDatabase, studentKey: string) {
  const row = await getCanvasConnectionRecordByStudentKey(db, studentKey);
  return row ? savedCanvasStatus(row) : { connected: false, verificationStatus: 'not_connected' as const };
}

export function nextCanvasConnectionStatus(currentStatus: string, errorCode: string) {
  if (errorCode === 'permission_denied') return currentStatus;
  if (errorCode === 'session_expired' && currentStatus === 'connected') return 'suspect';
  return 'expired';
}

export function nextCanvasToolFailureStatus(currentStatus: string, errorCode: string) {
  if (errorCode === 'permission_denied') return currentStatus;
  if (errorCode === 'session_expired' && currentStatus !== 'expired') return 'suspect';
  return 'expired';
}

function canvasErrorCode(validation: Awaited<ReturnType<CanvasAdapter['validateSession']>>) {
  return validation.data.errorCode || validation.warnings[0]?.code || 'session_expired';
}

async function validateCanvasSessionWithRetry(connection: CanvasConnection) {
  let validation = await new CanvasAdapter(connection).validateSession();
  if (!validation.data.connected && canvasErrorCode(validation) === 'session_expired') {
    await new Promise((resolve) => setTimeout(resolve, CANVAS_SESSION_RETRY_DELAY_MS));
    validation = await new CanvasAdapter(connection).validateSession();
  }
  return validation;
}

async function canvasFailureResponse(
  db: StufloDatabase,
  row: CanvasRow,
  errorCode: string,
  checkedAt: Date,
) {
  const nextStatus = nextCanvasConnectionStatus(row.status, errorCode);

  const updated = await updateCanvasConnectionStatus(db, {
    studentId: row.studentId,
    status: nextStatus,
    lastValidatedAt: checkedAt,
    expectedCookiesUpdatedAt: row.cookiesUpdatedAt,
    expectedLastValidatedAt: row.lastValidatedAt,
  });
  if (!updated) return currentCanvasStatus(db, row.studentKey);

  if (errorCode === 'permission_denied' && row.status !== 'expired') {
    return {
      connected: true,
      verificationStatus: 'unavailable' as const,
      reconnectRequired: false,
      errorCode,
      message: 'Canvas blocked this verification request. StuFlo kept your saved connection and will try again automatically.',
      canvasHost: row.canvasHost,
      cookiesUpdatedAt: row.cookiesUpdatedAt,
      lastValidatedAt: checkedAt,
    };
  }

  if (nextStatus === 'suspect') {
    return {
      connected: true,
      verificationStatus: 'unavailable' as const,
      reconnectRequired: false,
      errorCode,
      message: 'Canvas did not accept the saved session. StuFlo kept the connection and will retry before asking you to reconnect.',
      canvasHost: row.canvasHost,
      cookiesUpdatedAt: row.cookiesUpdatedAt,
      lastValidatedAt: checkedAt,
    };
  }

  return {
    connected: false,
    verificationStatus: 'invalid' as const,
    reconnectRequired: true,
    errorCode,
    message: reconnectMessage(errorCode),
    canvasHost: row.canvasHost,
    cookiesUpdatedAt: row.cookiesUpdatedAt,
    lastValidatedAt: checkedAt,
  };
}

async function storedCanvasConnection(
  row: Awaited<ReturnType<typeof getCanvasConnectionRecordByStudentKey>>,
  env: StufloEnv,
): Promise<CanvasConnection> {
  if (!row) throw new Error('Canvas is not connected.');
  const cookies = await keyring(env).decryptJson<unknown>(row.encryptedCookies as EncryptedEnvelope);
  validateCanvasCookies(cookies);
  return { canvasHost: row.canvasHost, cookies, timeZone: row.timeZone, cookiesUpdatedAt: row.cookiesUpdatedAt.toISOString() };
}

export async function connectCanvasForStudent(
  db: StufloDatabase,
  env: StufloEnv,
  studentKey: string,
  connection: CanvasConnection,
) {
  const receivedAt = new Date();
  const student = await getStudentByKey(db, studentKey);
  if (!student) throw new Error('Student does not exist in Postgres.');
  const canvasHost = normalizeCanvasHost(connection.canvasHost);
  const normalized: CanvasConnection = {
    canvasHost,
    cookies: connection.cookies,
    timeZone: student.timeZone,
  };
  const validation = await new CanvasAdapter(normalized).validateSession();
  if (!validation.data.connected) {
    const warning = validation.warnings[0];
    throw new CanvasError(
      validation.data.errorCode || warning?.code || 'session_expired',
      warning?.message || 'Canvas did not accept this session.',
      { status: 401, endpoint: warning?.endpoint || '/api/v1/users/self/profile' },
    );
  }
  const encryptedCookies = await keyring(env).encryptJson(connection.cookies, activeKeyId(env));
  const saved = await upsertCanvasConnection(db, {
    studentId: student.id,
    canvasHost,
    encryptedCookies,
    encryptionVersion: encryptedCookies.v,
    cookiesUpdatedAt: receivedAt,
    lastValidatedAt: new Date(),
  });
  if (!saved) {
    const current = await getCanvasConnectionRecordByStudentKey(db, studentKey);
    return { validation, connection: current ? savedCanvasStatus(current) : null };
  }
  return { validation, connection: saved };
}

export async function loadCanvasForStudent(
  env: StufloEnv,
  studentKey: string,
): Promise<CanvasConnection | undefined> {
  if ((!env.HYPERDRIVE && !env.DATABASE_URL) || !env.COOKIE_ENCRYPTION_KEYS) return undefined;
  const { db, close } = openDatabase(env);
  try {
    const row = await getCanvasConnectionByStudentKey(db, studentKey);
    if (!row) return undefined;
    try {
      return await storedCanvasConnection(row, env);
    } catch (error) {
      if (!(error instanceof CanvasError) || !['invalid_connection', 'not_connected'].includes(error.code)) throw error;
      // A bad saved cookie set must not break the whole chat across the Durable Object RPC boundary.
      await updateCanvasConnectionStatus(db, {
        studentId: row.studentId, status: 'expired', lastValidatedAt: new Date(),
        expectedCookiesUpdatedAt: row.cookiesUpdatedAt, expectedLastValidatedAt: row.lastValidatedAt,
      });
      return undefined;
    }
  } finally {
    await close();
  }
}

export async function checkCanvasConnectionForStudent(
  db: StufloDatabase,
  env: StufloEnv,
  studentKey: string,
) {
  const row = await getCanvasConnectionRecordByStudentKey(db, studentKey);
  if (!row) return { connected: false, verificationStatus: 'not_connected' as const };

  const checkedAt = new Date();
  const ageMs = row.lastValidatedAt ? checkedAt.getTime() - row.lastValidatedAt.getTime() : Infinity;
  // Repeated status polls share a check and give the extension time to repair a session.
  if (ageMs >= 0 && ageMs < (row.status === 'connected' ? CANVAS_STATUS_CACHE_MS : CANVAS_RECONNECT_GRACE_MS)) {
    return savedCanvasStatus(row);
  }
  try {
    const connection = await storedCanvasConnection(row, env);
    const validation = await validateCanvasSessionWithRetry(connection);
    if (!validation.data.connected) {
      return canvasFailureResponse(db, row, canvasErrorCode(validation), checkedAt);
    }

    const updated = await updateCanvasConnectionStatus(db, {
      studentId: row.studentId,
      status: 'connected',
      lastValidatedAt: checkedAt,
      expectedCookiesUpdatedAt: row.cookiesUpdatedAt,
      expectedLastValidatedAt: row.lastValidatedAt,
    });
    if (!updated) return currentCanvasStatus(db, studentKey);
    return {
      connected: true,
      verificationStatus: 'valid' as const,
      canvasHost: row.canvasHost,
      cookiesUpdatedAt: row.cookiesUpdatedAt,
      lastValidatedAt: checkedAt,
    };
  } catch (error) {
    const canvasError = error instanceof CanvasError ? error : null;
    if (
      canvasError &&
      ['session_expired', 'permission_denied', 'not_connected', 'invalid_connection'].includes(
        canvasError.code,
      )
    ) {
      return canvasFailureResponse(db, row, canvasError.code, checkedAt);
    }

    return {
      connected: row.status !== 'expired',
      verificationStatus: 'unavailable' as const,
      reconnectRequired: row.status === 'expired',
      message: 'StuFlo could not verify Canvas right now. Your saved connection was kept; try checking again shortly.',
      canvasHost: row.canvasHost,
      cookiesUpdatedAt: row.cookiesUpdatedAt,
      lastValidatedAt: row.lastValidatedAt,
    };
  }
}

export async function markCanvasConnectionForReconnect(
  env: StufloEnv,
  studentKey: string,
  errorCode = 'session_expired',
  failedConnection?: CanvasConnection,
): Promise<void> {
  if (!env.HYPERDRIVE && !env.DATABASE_URL) return;
  const { db, close } = openDatabase(env);
  try {
    const row = await getCanvasConnectionRecordByStudentKey(db, studentKey);
    if (!row) return;
    if (errorCode === 'permission_denied') return;
    if (failedConnection) {
      if (failedConnection.canvasHost !== row.canvasHost) return;
      if (failedConnection.cookiesUpdatedAt) {
        if (failedConnection.cookiesUpdatedAt !== row.cookiesUpdatedAt.toISOString()) return;
      } else {
        const current = await storedCanvasConnection(row, env);
        if (JSON.stringify(current.cookies) !== JSON.stringify(failedConnection.cookies)) return;
      }
    }
    const nextStatus = nextCanvasToolFailureStatus(row.status, errorCode);
    if (nextStatus === row.status) return;
    await updateCanvasConnectionStatus(db, {
      studentId: row.studentId,
      status: nextStatus,
      lastValidatedAt: new Date(),
      expectedCookiesUpdatedAt: row.cookiesUpdatedAt,
      expectedLastValidatedAt: row.lastValidatedAt,
    });
  } finally {
    await close();
  }
}
