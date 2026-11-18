import {
  deleteAdminStudentAccount,
  getAdminOverview,
  getAdminStudentByKey,
  getAdminStudentDeletionTarget,
  getOrCreateUsageSettings,
  listAdminStudents,
  listOperationalAlerts,
  recordAuditLog,
  resolveOperationalAlert,
  updateUsageSettings,
} from '@stuflo/db';
import { DEFAULT_USAGE_SETTINGS, normalizeUsageSettings } from '@stuflo/usage';
import { getAgentByName } from 'agents';
import type { StufloEnv } from '../env';
import { StuAgent } from '../agents/stu-agent';
import type { AuthenticatedSession } from './admin-authorization';
export { isAdminEmail, requireAdmin } from './admin-authorization';
export type { AuthenticatedSession } from './admin-authorization';
import {
  adminStudentStripeSnapshot,
  deleteStripeCustomer,
} from './billing';
import { openDatabase } from './database';

export async function loadAdminOverview(env: StufloEnv) {
  const opened = openDatabase(env);
  let databaseOverview;
  let alerts;
  let settingsRow;
  try {
    [databaseOverview, alerts, settingsRow] = await Promise.all([
      getAdminOverview(opened.db),
      listOperationalAlerts(opened.db, 50),
      getOrCreateUsageSettings(opened.db, DEFAULT_USAGE_SETTINGS),
    ]);
  } finally {
    await opened.close();
  }
  return {
    ...databaseOverview,
    alerts,
    usageSettings: normalizeUsageSettings(settingsRow.value),
  };
}

export async function loadAdminStudents(env: StufloEnv, search?: string, page = 1) {
  const input = { search, limit: 50, offset: (Math.max(1, page) - 1) * 50 };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const opened = openDatabase(env);
    try {
      return await listAdminStudents(opened.db, input);
    } catch (error) {
      const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
      const message =
        cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause || '');
      const retryable = /CONNECTION_(?:ENDED|CLOSED|DESTROYED)/.test(message);
      if (!retryable || attempt > 0) throw error;
    } finally {
      await opened.close();
    }
  }
  throw new Error('Admin student directory query failed.');
}

export async function loadAdminStudent(
  env: StufloEnv,
  actor: AuthenticatedSession,
  studentKey: string,
  action: 'admin.student.view' | 'admin.chat.view' | 'admin.student.export',
) {
  const opened = openDatabase(env);
  let result;
  try {
    result = await getAdminStudentByKey(opened.db, studentKey);
    if (!result) return null;
    await recordAuditLog(opened.db, {
      actorUserId: actor.userId,
      studentId: result.student.id,
      action,
      metadata: { targetStudentKey: studentKey },
    });
  } finally {
    await opened.close();
  }
  const stripe = action === 'admin.student.view' && result.stripeCustomerId
    ? await adminStudentStripeSnapshot(env, result.stripeCustomerId).catch(() => ({
        customerId: result.stripeCustomerId!,
        unavailable: true as const,
      }))
    : null;
  return { ...result, stripe };
}

async function deletionFingerprint(studentKey: string, email: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${studentKey}:${email.trim().toLowerCase()}`),
  );
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function deleteAdminStudent(
  env: StufloEnv,
  actor: AuthenticatedSession,
  studentKey: string,
  confirmationEmail: string,
) {
  const opened = openDatabase(env);
  let target;
  try {
    target = await getAdminStudentDeletionTarget(opened.db, studentKey);
  } finally {
    await opened.close();
  }
  if (!target) return { error: 'student_not_found' as const };
  if (confirmationEmail.trim().toLowerCase() !== target.email.trim().toLowerCase()) {
    return { error: 'confirmation_mismatch' as const };
  }

  let stripeCustomerDeleted = false;
  if (target.stripeCustomerId) {
    const stripeResult = await deleteStripeCustomer(env, target.stripeCustomerId);
    stripeCustomerDeleted = stripeResult.deleted;
  }

  if (target.r2Keys.length) {
    if (!env.ATTACHMENTS) throw new Error('R2 attachment storage is not configured.');
    for (let index = 0; index < target.r2Keys.length; index += 1_000) {
      await env.ATTACHMENTS.delete(target.r2Keys.slice(index, index + 1_000));
    }
  }

  const agent = await getAgentByName<StufloEnv, StuAgent>(env.StuAgent, studentKey);
  await agent.deleteAllData();

  const deletionDb = openDatabase(env);
  try {
    const deleted = await deleteAdminStudentAccount(deletionDb.db, {
      actorUserId: actor.userId,
      studentId: target.studentId,
      userId: target.userId,
      studentKey: target.studentKey,
      email: target.email,
      targetFingerprint: await deletionFingerprint(target.studentKey, target.email),
      stripeCustomerDeleted,
      attachmentCount: target.r2Keys.length,
    });
    return deleted
      ? {
          ok: true as const,
          stripeCustomerDeleted,
          attachmentsDeleted: target.r2Keys.length,
        }
      : { error: 'student_not_found' as const };
  } finally {
    await deletionDb.close();
  }
}

export async function saveAdminUsageSettings(
  env: StufloEnv,
  actor: AuthenticatedSession,
  raw: Record<string, unknown>,
) {
  const settings = normalizeUsageSettings(raw);
  const opened = openDatabase(env);
  try {
    const row = await updateUsageSettings(opened.db, settings as unknown as Record<string, unknown>);
    await recordAuditLog(opened.db, {
      actorUserId: actor.userId,
      action: 'admin.usage_settings.update',
      metadata: { settings },
    });
    return row;
  } finally {
    await opened.close();
  }
}

export async function resolveAdminAlert(
  env: StufloEnv,
  actor: AuthenticatedSession,
  alertId: string,
) {
  const opened = openDatabase(env);
  try {
    const result = await resolveOperationalAlert(opened.db, alertId);
    if (result) {
      await recordAuditLog(opened.db, {
        actorUserId: actor.userId,
        action: 'admin.alert.resolve',
        metadata: { alertId },
      });
    }
    return result;
  } finally {
    await opened.close();
  }
}
