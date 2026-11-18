import {
  chargeStudentUsage,
  ensureMonthlyCreditGrant,
  getOrCreateUsageSettings,
  getGlobalUsageCosts,
  getStudentByKey,
  getStudentUsageStatus,
} from '@stuflo/db';
import {
  DEFAULT_USAGE_SETTINGS,
  GlobalUsageBudgetExceededError,
  UsageCreditsExhaustedError,
  combineUsageCharges,
  estimateUsageCharge,
  normalizeUsageSettings,
  planMonthlyCredits,
  usageWarningLevel,
} from '@stuflo/usage';
import type { StufloEnv } from '../env';
import type { ModelCompletion } from '../model/model-gateway';
import { openDatabase } from './database';
import { evaluateCostBudgets } from './alerts';

function isConfigured(env: StufloEnv): boolean {
  return Boolean(env.HYPERDRIVE || env.DATABASE_URL);
}

async function loadStatus(
  env: StufloEnv,
  studentKey: string,
  options: { enforceAvailableCredits: boolean },
) {
  if (!isConfigured(env)) return null;
  const opened = openDatabase(env);
  try {
    const student = await getStudentByKey(opened.db, studentKey);
    if (!student) throw new Error('Student does not exist in Postgres.');
    const settingsRow = await getOrCreateUsageSettings(opened.db, DEFAULT_USAGE_SETTINGS);
    const settings = normalizeUsageSettings(settingsRow.value);
    const costs = await getGlobalUsageCosts(opened.db);
    const budgets = await evaluateCostBudgets(opened.db, settings, costs);
    if (options.enforceAvailableCredits) {
      if (budgets.dailyExceeded) throw new GlobalUsageBudgetExceededError('daily');
      if (budgets.monthlyExceeded) throw new GlobalUsageBudgetExceededError('monthly');
    }
    const planCredits = planMonthlyCredits(student.plan, settings);
    await ensureMonthlyCreditGrant(opened.db, {
      studentId: student.id,
      credits: planCredits,
    });
    const status = await getStudentUsageStatus(opened.db, student.id);
    const warningLevel = usageWarningLevel(
      status.creditsGranted,
      status.creditsRemaining,
      settings.warningThresholds,
    );
    if (options.enforceAvailableCredits && status.creditsRemaining <= 0) {
      throw new UsageCreditsExhaustedError();
    }
    return {
      student,
      settings,
      planCredits,
      ...status,
      creditsUsed: Math.max(0, status.creditsGranted - status.creditsRemaining),
      warningLevel,
      isExhausted: status.creditsRemaining <= 0,
    };
  } finally {
    await opened.close();
  }
}

export async function preflightStudentUsage(env: StufloEnv, studentKey: string) {
  return loadStatus(env, studentKey, { enforceAvailableCredits: true });
}

export async function getUsageStatus(env: StufloEnv, studentKey: string) {
  return loadStatus(env, studentKey, { enforceAvailableCredits: false });
}

export async function recordStuAgentUsage(
  env: StufloEnv,
  input: {
    studentId: string;
    completions: ModelCompletion[];
    channel: 'web';
    toolNames: string[];
    operation?: 'chat.completion' | 'model.eval';
    funding?: 'publik' | 'own_key';
  },
) {
  if (!isConfigured(env)) return null;
  const opened = openDatabase(env);
  try {
    const settingsRow = await getOrCreateUsageSettings(opened.db, DEFAULT_USAGE_SETTINGS);
    const settings = normalizeUsageSettings(settingsRow.value);
    const events = [];
    const charges = [];
    for (const [completionIndex, completion] of input.completions.entries()) {
      const attempts = completion.usageAttempts?.length
        ? completion.usageAttempts : [completion.usage];
      // Provider long-context rates apply per request, not to token totals
      // merged after retrying an interrupted response.
      const estimatedCharge = combineUsageCharges(attempts.map((usage) => estimateUsageCharge(
        { provider: completion.provider, model: completion.model, ...usage },
        settings.creditValueUsd,
      )));
      // Student-funded inference is metered by their provider, not by StuFlo.
      const charge = input.funding
        ? { ...estimatedCharge, estimatedProviderCostUsd: 0, creditsCharged: 0 }
        : estimatedCharge;
      charges.push(charge);
      events.push(
        await chargeStudentUsage(opened.db, {
          studentId: input.studentId,
          provider: charge.provider,
          model: charge.model,
          operation: input.operation || 'chat.completion',
          inputTokens: charge.inputTokens,
          outputTokens: charge.outputTokens,
          estimatedProviderCostUsd: charge.estimatedProviderCostUsd,
          creditValueUsd: charge.creditValueUsd,
          creditsCharged: charge.creditsCharged,
          metadata: {
            channel: input.channel,
            funding: input.funding || 'stuflo',
            usageQuality: charge.usageQuality,
            cachedInputTokens: charge.cachedInputTokens,
            cacheWriteInputTokens: charge.cacheWriteInputTokens,
            completionIndex,
            completionCount: input.completions.length,
            requestCount: attempts.length,
            durationMs: completion.durationMs,
            toolsUsed: input.toolNames,
            payloadLogged: false,
          },
        }),
      );
    }
    await evaluateCostBudgets(
      opened.db,
      settings,
      await getGlobalUsageCosts(opened.db),
    );
    return { events, charge: combineUsageCharges(charges) };
  } finally {
    await opened.close();
  }
}
