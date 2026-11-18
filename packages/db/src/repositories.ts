import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  sum,
} from 'drizzle-orm';
import type { StufloDatabase } from './client';
import {
  attachments,
  auditLogs,
  canvasCourseSnapshots,
  authSessions,
  emailChallenges,
  canvasConnections,
  canvasInitializationRuns,
  creditGrants,
  creditGrantSpends,
  googleConnections,
  operationalAlerts,
  studentMemories,
  studentProfiles,
  students,
  stripeCustomers,
  stripeEvents,
  stripeSubscriptions,
  usageEvents,
  usageSettings,
  users,
  verificationTokens,
  type EncryptionEnvelopeRecord,
} from './schema';

const PAID_PLANS = ['stuflo', 'stupro'] as const;

function decimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('Credit amount must be nonnegative.');
  return value.toFixed(6);
}

function periodBounds(now: Date) {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    key: now.toISOString().slice(0, 7),
  };
}

export async function getOrCreateUsageSettings(
  db: StufloDatabase,
  defaults: object,
) {
  await db
    .insert(usageSettings)
    .values({ key: 'global', value: defaults as Record<string, unknown> })
    .onConflictDoNothing({ target: usageSettings.key });
  const [row] = await db
    .select({ value: usageSettings.value, updatedAt: usageSettings.updatedAt })
    .from(usageSettings)
    .where(eq(usageSettings.key, 'global'))
    .limit(1);
  if (!row) throw new Error('Global usage settings could not be loaded.');
  return row;
}

export async function ensureMonthlyCreditGrant(
  db: StufloDatabase,
  input: { studentId: string; credits: number; now?: Date; stripeSubscriptionId?: string | null },
) {
  if (input.credits <= 0) return null;
  const now = input.now ?? new Date();
  const period = periodBounds(now);
  const idempotencyKey = `monthly:${input.studentId}:${period.key}`;
  const credits = decimal(input.credits);
  const [row] = await db
    .insert(creditGrants)
    .values({
      studentId: input.studentId,
      source: 'monthly',
      idempotencyKey,
      creditsGranted: credits,
      creditsRemaining: credits,
      periodStart: period.start,
      periodEnd: period.end,
    })
    .onConflictDoUpdate({
      target: creditGrants.idempotencyKey,
      set: {
        creditsRemaining: sql`GREATEST(${creditGrants.creditsRemaining}, 0) + GREATEST(${credits}::numeric - ${creditGrants.creditsGranted}, 0)`,
        creditsGranted: sql`GREATEST(${creditGrants.creditsGranted}, ${credits}::numeric)`,
        periodEnd: period.end,
      },
    })
    .returning({
      id: creditGrants.id,
      creditsGranted: creditGrants.creditsGranted,
      creditsRemaining: creditGrants.creditsRemaining,
      periodEnd: creditGrants.periodEnd,
    });
  return row;
}

export async function grantCredits(
  db: StufloDatabase,
  input: {
    studentId: string;
    source: string;
    idempotencyKey: string;
    credits: number;
    periodStart?: Date | null;
    periodEnd?: Date | null;
  },
) {
  const credits = decimal(input.credits);
  const [row] = await db
    .insert(creditGrants)
    .values({
      studentId: input.studentId,
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      creditsGranted: credits,
      creditsRemaining: credits,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    })
    .onConflictDoNothing({ target: creditGrants.idempotencyKey })
    .returning({ id: creditGrants.id });
  return row ?? null;
}

export async function getStudentUsageStatus(
  db: StufloDatabase,
  studentId: string,
  now = new Date(),
) {
  const grants = await db
    .select({
      creditsGranted: creditGrants.creditsGranted,
      creditsRemaining: creditGrants.creditsRemaining,
    })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.studentId, studentId),
        or(isNull(creditGrants.periodEnd), gt(creditGrants.periodEnd, now)),
      ),
    );
  const recentEvents = await db
    .select({
      id: usageEvents.id,
      createdAt: usageEvents.createdAt,
      provider: usageEvents.provider,
      model: usageEvents.model,
      operation: usageEvents.operation,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      estimatedProviderCostUsd: usageEvents.estimatedProviderCostUsd,
      creditsCharged: usageEvents.creditsCharged,
      metadata: usageEvents.metadata,
    })
    .from(usageEvents)
    .where(eq(usageEvents.studentId, studentId))
    .orderBy(desc(usageEvents.createdAt))
    .limit(8);
  return {
    creditsGranted: grants.reduce((sum, grant) => sum + Number(grant.creditsGranted), 0),
    creditsRemaining: grants.reduce((sum, grant) => sum + Number(grant.creditsRemaining), 0),
    recentEvents,
  };
}

export async function chargeStudentUsage(
  db: StufloDatabase,
  input: {
    studentId: string;
    provider: string;
    model: string;
    operation: string;
    inputTokens: number;
    outputTokens: number;
    estimatedProviderCostUsd: number;
    creditValueUsd: number;
    creditsCharged: number;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (transaction) => {
    const grants = await transaction
      .select({
        id: creditGrants.id,
        creditsRemaining: creditGrants.creditsRemaining,
      })
      .from(creditGrants)
      .where(
        and(
          eq(creditGrants.studentId, input.studentId),
          gt(creditGrants.creditsRemaining, '0'),
          or(isNull(creditGrants.periodEnd), gt(creditGrants.periodEnd, now)),
        ),
      )
      .orderBy(
        sql`CASE WHEN ${creditGrants.source} = 'monthly' THEN 0 ELSE 1 END`,
        sql`${creditGrants.periodEnd} ASC NULLS LAST`,
        asc(creditGrants.createdAt),
      )
      .for('update');

    let uncovered = Math.max(0, input.creditsCharged);
    const spends: Array<{ creditGrantId: string; creditsSpent: string }> = [];
    for (const grant of grants) {
      if (uncovered <= 0) break;
      const available = Math.max(0, Number(grant.creditsRemaining));
      const spent = Math.min(available, uncovered);
      if (spent <= 0) continue;
      const remaining = Math.max(0, available - spent);
      await transaction
        .update(creditGrants)
        .set({ creditsRemaining: decimal(remaining) })
        .where(eq(creditGrants.id, grant.id));
      spends.push({ creditGrantId: grant.id, creditsSpent: decimal(spent) });
      uncovered = Math.max(0, uncovered - spent);
    }
    const covered = Math.max(0, input.creditsCharged - uncovered);
    const [event] = await transaction
      .insert(usageEvents)
      .values({
        studentId: input.studentId,
        provider: input.provider,
        model: input.model,
        operation: input.operation,
        inputTokens: Math.trunc(input.inputTokens),
        outputTokens: Math.trunc(input.outputTokens),
        estimatedProviderCostUsd: input.estimatedProviderCostUsd.toFixed(8),
        creditValueUsd: input.creditValueUsd.toFixed(8),
        creditsCharged: decimal(input.creditsCharged),
        metadata: {
          ...(input.metadata || {}),
          creditsCovered: Number(decimal(covered)),
          uncoveredCredits: Number(decimal(uncovered)),
        },
      })
      .returning({ id: usageEvents.id, createdAt: usageEvents.createdAt });
    if (spends.length) {
      await transaction.insert(creditGrantSpends).values(
        spends.map((spend) => ({
          usageEventId: event.id,
          creditGrantId: spend.creditGrantId,
          creditsSpent: spend.creditsSpent,
        })),
      );
    }
    return {
      ...event,
      creditsCovered: Number(decimal(covered)),
      uncoveredCredits: Number(decimal(uncovered)),
    };
  });
}

export async function getActiveStudentByEmail(db: StufloDatabase, rawEmail: string) {
  const email = rawEmail.trim().toLowerCase();
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      studentId: students.id,
      studentKey: students.studentKey,
      timeZone: students.timeZone,
      plan: students.plan,
      status: students.status,
    })
    .from(users)
    .innerJoin(students, eq(users.id, students.userId))
    .where(and(eq(users.email, email), eq(students.status, 'active')))
    .limit(1);
  return row ?? null;
}

export async function getAuthSessionByTokenHash(
  db: StufloDatabase,
  sessionTokenHash: string,
  now = new Date(),
) {
  const [row] = await db
    .select({
      sessionId: authSessions.id,
      sessionExpiresAt: authSessions.expiresAt,
      userId: users.id,
      email: users.email,
      name: users.name,
      studentId: students.id,
      studentKey: students.studentKey,
      timeZone: students.timeZone,
      plan: students.plan,
    })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .innerJoin(students, eq(users.id, students.userId))
    .where(
      and(
        eq(authSessions.sessionTokenHash, sessionTokenHash),
        gt(authSessions.expiresAt, now),
        eq(students.status, 'active'),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function revokeAuthSession(db: StufloDatabase, sessionTokenHash: string) {
  await db.delete(authSessions).where(eq(authSessions.sessionTokenHash, sessionTokenHash));
}


export async function getStripeCustomerByUserId(db: StufloDatabase, userId: string) {
  const [row] = await db
    .select({ stripeCustomerId: stripeCustomers.stripeCustomerId })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function getStripeCustomerByCustomerId(
  db: StufloDatabase,
  stripeCustomerId: string,
) {
  const [row] = await db
    .select({ userId: stripeCustomers.userId, stripeCustomerId: stripeCustomers.stripeCustomerId })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return row ?? null;
}

export async function getBillingSummaryByUserId(db: StufloDatabase, userId: string) {
  const [customer] = await db
    .select({ stripeCustomerId: stripeCustomers.stripeCustomerId })
    .from(stripeCustomers)
    .where(eq(stripeCustomers.userId, userId))
    .limit(1);
  const subscriptions = await db
    .select({
      stripeSubscriptionId: stripeSubscriptions.stripeSubscriptionId,
      status: stripeSubscriptions.status,
      priceId: stripeSubscriptions.priceId,
      plan: stripeSubscriptions.plan,
      currentPeriodStart: stripeSubscriptions.currentPeriodStart,
      currentPeriodEnd: stripeSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: stripeSubscriptions.cancelAtPeriodEnd,
    })
    .from(stripeSubscriptions)
    .where(eq(stripeSubscriptions.userId, userId))
    .orderBy(desc(stripeSubscriptions.updatedAt));
  return { stripeCustomerId: customer?.stripeCustomerId ?? null, subscriptions };
}

export async function fulfillStripeCheckout(
  db: StufloDatabase,
  input: {
    eventId: string;
    userId?: string;
    eventType: string;
    livemode: boolean;
    email: string;
    name?: string | null;
    studentKey: string;
    customerId: string;
    subscriptionId: string;
    subscriptionStatus: string;
    priceId: string;
    plan: 'stuflo' | 'stupro';
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
    monthlyCredits: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const paidStatus = ['active', 'trialing', 'past_due'].includes(input.subscriptionStatus);
  return db.transaction(async (transaction) => {
    const [claimed] = await transaction
      .insert(stripeEvents)
      .values({
        stripeEventId: input.eventId,
        type: input.eventType,
        livemode: input.livemode,
        result: { status: 'processing' },
      })
      .onConflictDoNothing({ target: stripeEvents.stripeEventId })
      .returning({ eventId: stripeEvents.stripeEventId });
    if (!claimed) return { duplicate: true as const };

    const email = input.email.trim().toLowerCase();
    const [linkedCustomer] = await transaction.select({ userId: stripeCustomers.userId })
      .from(stripeCustomers).where(eq(stripeCustomers.stripeCustomerId, input.customerId));
    if (linkedCustomer && input.userId && linkedCustomer.userId !== input.userId) {
      throw new Error('Checkout account reference does not match the linked customer.');
    }
    const linkedUserId = linkedCustomer?.userId || input.userId;
    let user: { id: string; email: string };
    if (linkedUserId) {
      const [existing] = await transaction.select({ id: users.id, email: users.email })
        .from(users).where(eq(users.id, linkedUserId));
      if (!existing) throw new Error('Checkout account no longer exists.');
      user = existing;
    } else {
      // Compatibility for legacy checkouts created before account-first onboarding.
      [user] = await transaction
      .insert(users)
      .values({ email, name: input.name?.trim() || null })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          ...(input.name?.trim() ? { name: input.name.trim() } : {}),
          updatedAt: now,
        },
      })
      .returning({ id: users.id, email: users.email });
    }
    const [student] = await transaction
      .insert(students)
      .values({
        userId: user.id,
        studentKey: input.studentKey,
        plan: paidStatus ? input.plan : 'free',
        status: 'active',
      })
      .onConflictDoUpdate({
        target: students.userId,
        set: { plan: paidStatus ? input.plan : 'free', status: 'active', updatedAt: now },
      })
      .returning({ id: students.id, studentKey: students.studentKey, plan: students.plan });
    await transaction
      .insert(stripeCustomers)
      .values({ userId: user.id, stripeCustomerId: input.customerId })
      .onConflictDoUpdate({
        target: stripeCustomers.userId,
        set: { stripeCustomerId: input.customerId, updatedAt: now },
      });
    await transaction
      .insert(stripeSubscriptions)
      .values({
        userId: user.id,
        stripeSubscriptionId: input.subscriptionId,
        status: input.subscriptionStatus,
        priceId: input.priceId,
        plan: input.plan,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      })
      .onConflictDoUpdate({
        target: stripeSubscriptions.stripeSubscriptionId,
        set: {
          userId: user.id,
          status: input.subscriptionStatus,
          priceId: input.priceId,
          plan: input.plan,
          currentPeriodStart: input.currentPeriodStart,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
          updatedAt: now,
        },
      });
    if (paidStatus && input.monthlyCredits > 0) {
      const period = periodBounds(now);
      const idempotencyKey = `monthly:${student.id}:${period.key}`;
      const credits = decimal(input.monthlyCredits);
      await transaction
        .insert(creditGrants)
        .values({
          studentId: student.id,
          source: 'monthly',
          idempotencyKey,
          creditsGranted: credits,
          creditsRemaining: credits,
          periodStart: period.start,
          periodEnd: period.end,
        })
        .onConflictDoUpdate({
          target: creditGrants.idempotencyKey,
          set: {
            creditsRemaining: sql`GREATEST(${creditGrants.creditsRemaining}, 0) + GREATEST(${credits}::numeric - ${creditGrants.creditsGranted}, 0)`,
            creditsGranted: sql`GREATEST(${creditGrants.creditsGranted}, ${credits}::numeric)`,
            periodEnd: period.end,
          },
        });
    }
    await transaction
      .update(stripeEvents)
      .set({
        result: {
          status: 'processed',
          userId: user.id,
          studentId: student.id,
          studentKey: student.studentKey,
          plan: student.plan,
        },
      })
      .where(eq(stripeEvents.stripeEventId, input.eventId));
    return { duplicate: false as const, user, student };
  });
}

export async function fulfillStripeInvoicePaid(
  db: StufloDatabase,
  input: {
    eventId: string;
    eventType: string;
    livemode: boolean;
    customerId: string;
    stufloMonthlyCredits: number;
    stuproMonthlyCredits: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (transaction) => {
    const [claimed] = await transaction
      .insert(stripeEvents)
      .values({
        stripeEventId: input.eventId,
        type: input.eventType,
        livemode: input.livemode,
        result: { status: 'processing' },
      })
      .onConflictDoNothing({ target: stripeEvents.stripeEventId })
      .returning({ eventId: stripeEvents.stripeEventId });
    if (!claimed) return { duplicate: true as const };
    const [student] = await transaction
      .select({ id: students.id, plan: students.plan })
      .from(stripeCustomers)
      .innerJoin(students, eq(stripeCustomers.userId, students.userId))
      .where(eq(stripeCustomers.stripeCustomerId, input.customerId))
      .limit(1);
    if (!student || !PAID_PLANS.includes(student.plan as (typeof PAID_PLANS)[number])) {
      await transaction
        .update(stripeEvents)
        .set({ result: { status: 'ignored', reason: 'paid_student_not_found' } })
        .where(eq(stripeEvents.stripeEventId, input.eventId));
      return { duplicate: false as const, granted: false as const };
    }
    const credits = student.plan === 'stupro' ? input.stuproMonthlyCredits : input.stufloMonthlyCredits;
    const period = periodBounds(now);
    const idempotencyKey = `monthly:${student.id}:${period.key}`;
    await transaction
      .insert(creditGrants)
      .values({
        studentId: student.id,
        source: 'monthly',
        idempotencyKey,
        creditsGranted: decimal(credits),
        creditsRemaining: decimal(credits),
        periodStart: period.start,
        periodEnd: period.end,
      })
      .onConflictDoNothing({ target: creditGrants.idempotencyKey });
    await transaction
      .update(stripeEvents)
      .set({ result: { status: 'processed', studentId: student.id, plan: student.plan } })
      .where(eq(stripeEvents.stripeEventId, input.eventId));
    return { duplicate: false as const, granted: true as const };
  });
}

export async function fulfillStripeSubscriptionDeleted(
  db: StufloDatabase,
  input: {
    eventId: string;
    eventType: string;
    livemode: boolean;
    customerId: string;
    subscriptionId: string;
  },
) {
  return db.transaction(async (transaction) => {
    const [claimed] = await transaction
      .insert(stripeEvents)
      .values({
        stripeEventId: input.eventId,
        type: input.eventType,
        livemode: input.livemode,
        result: { status: 'processing' },
      })
      .onConflictDoNothing({ target: stripeEvents.stripeEventId })
      .returning({ eventId: stripeEvents.stripeEventId });
    if (!claimed) return { duplicate: true as const };
    const [customer] = await transaction
      .select({ userId: stripeCustomers.userId })
      .from(stripeCustomers)
      .where(eq(stripeCustomers.stripeCustomerId, input.customerId))
      .limit(1);
    if (customer) {
      await transaction
        .update(students)
        .set({ plan: 'free', updatedAt: new Date() })
        .where(eq(students.userId, customer.userId));
      await transaction
        .update(stripeSubscriptions)
        .set({ status: 'canceled', cancelAtPeriodEnd: false, updatedAt: new Date() })
        .where(eq(stripeSubscriptions.stripeSubscriptionId, input.subscriptionId));
    }
    await transaction
      .update(stripeEvents)
      .set({
        result: customer
          ? { status: 'processed', userId: customer.userId, plan: 'free' }
          : { status: 'ignored', reason: 'customer_not_found' },
      })
      .where(eq(stripeEvents.stripeEventId, input.eventId));
    return { duplicate: false as const, downgraded: Boolean(customer) };
  });
}

export async function fulfillStripeSubscriptionUpdated(
  db: StufloDatabase,
  input: {
    eventId: string;
    eventType: string;
    livemode: boolean;
    customerId: string;
    subscriptionId: string;
    subscriptionStatus: string;
    priceId: string;
    plan: 'stuflo' | 'stupro';
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd: boolean;
    monthlyCredits: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return db.transaction(async (transaction) => {
    const [claimed] = await transaction
      .insert(stripeEvents)
      .values({
        stripeEventId: input.eventId,
        type: input.eventType,
        livemode: input.livemode,
        result: { status: 'processing' },
      })
      .onConflictDoNothing({ target: stripeEvents.stripeEventId })
      .returning({ eventId: stripeEvents.stripeEventId });
    if (!claimed) return { duplicate: true as const };
    const [customer] = await transaction
      .select({ userId: stripeCustomers.userId, studentId: students.id })
      .from(stripeCustomers)
      .innerJoin(students, eq(stripeCustomers.userId, students.userId))
      .where(eq(stripeCustomers.stripeCustomerId, input.customerId))
      .limit(1);
    if (!customer) {
      await transaction
        .update(stripeEvents)
        .set({ result: { status: 'ignored', reason: 'customer_not_found' } })
        .where(eq(stripeEvents.stripeEventId, input.eventId));
      return { duplicate: false as const, updated: false as const };
    }
    await transaction
      .insert(stripeSubscriptions)
      .values({
        userId: customer.userId,
        stripeSubscriptionId: input.subscriptionId,
        status: input.subscriptionStatus,
        priceId: input.priceId,
        plan: input.plan,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      })
      .onConflictDoUpdate({
        target: stripeSubscriptions.stripeSubscriptionId,
        set: {
          status: input.subscriptionStatus,
          priceId: input.priceId,
          plan: input.plan,
          currentPeriodStart: input.currentPeriodStart,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd,
          updatedAt: now,
        },
      });
    const paidStatus = ['active', 'trialing', 'past_due'].includes(input.subscriptionStatus);
    await transaction
      .update(students)
      .set({ plan: paidStatus ? input.plan : 'free', updatedAt: now })
      .where(eq(students.id, customer.studentId));
    if (paidStatus && input.monthlyCredits > 0) {
      const period = periodBounds(now);
      const credits = decimal(input.monthlyCredits);
      await transaction
        .insert(creditGrants)
        .values({
          studentId: customer.studentId,
          source: 'monthly',
          idempotencyKey: `monthly:${customer.studentId}:${period.key}`,
          creditsGranted: credits,
          creditsRemaining: credits,
          periodStart: period.start,
          periodEnd: period.end,
        })
        .onConflictDoUpdate({
          target: creditGrants.idempotencyKey,
          set: {
            creditsRemaining: sql`GREATEST(${creditGrants.creditsRemaining}, 0) + GREATEST(${credits}::numeric - ${creditGrants.creditsGranted}, 0)`,
            creditsGranted: sql`GREATEST(${creditGrants.creditsGranted}, ${credits}::numeric)`,
            periodEnd: period.end,
          },
        });
    }
    await transaction
      .update(stripeEvents)
      .set({
        result: {
          status: 'processed',
          userId: customer.userId,
          studentId: customer.studentId,
          plan: paidStatus ? input.plan : 'free',
          subscriptionStatus: input.subscriptionStatus,
        },
      })
      .where(eq(stripeEvents.stripeEventId, input.eventId));
    return { duplicate: false as const, updated: true as const };
  });
}

export async function recordIgnoredStripeEvent(
  db: StufloDatabase,
  input: { eventId: string; eventType: string; livemode: boolean; reason: string },
) {
  const [row] = await db
    .insert(stripeEvents)
    .values({
      stripeEventId: input.eventId,
      type: input.eventType,
      livemode: input.livemode,
      result: { status: 'ignored', reason: input.reason },
    })
    .onConflictDoNothing({ target: stripeEvents.stripeEventId })
    .returning({ eventId: stripeEvents.stripeEventId });
  return { duplicate: !row };
}

export async function getStudentByKey(db: StufloDatabase, studentKey: string) {
  const [row] = await db
    .select({
      id: students.id,
      studentKey: students.studentKey,
      timeZone: students.timeZone,
      plan: students.plan,
      status: students.status,
      userId: users.id,
      email: users.email,
      name: users.name,
    })
    .from(students)
    .innerJoin(users, eq(students.userId, users.id))
    .where(eq(students.studentKey, studentKey))
    .limit(1);
  return row ?? null;
}

export async function createAttachment(
  db: StufloDatabase,
  input: {
    id: string;
    studentId: string;
    r2Key: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    expiresAt?: Date | null;
    source?: string;
    purpose?: string;
    sourceKey?: string | null;
    sourceUrl?: string | null;
    canvasHost?: string | null;
    courseId?: string | null;
    courseName?: string | null;
  },
) {
  const [row] = await db
    .insert(attachments)
    .values({
      id: input.id,
      studentId: input.studentId,
      r2Key: input.r2Key,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      expiresAt: input.expiresAt,
      source: input.source,
      purpose: input.purpose,
      sourceKey: input.sourceKey,
      sourceUrl: input.sourceUrl,
      canvasHost: input.canvasHost,
      courseId: input.courseId,
      courseName: input.courseName,
    })
    .returning({
      id: attachments.id,
      fileName: attachments.fileName,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      sha256: attachments.sha256,
      createdAt: attachments.createdAt,
      expiresAt: attachments.expiresAt,
      source: attachments.source,
      purpose: attachments.purpose,
    });
  if (!row) throw new Error('Attachment metadata could not be created.');
  return row;
}

export async function getAttachmentsForStudent(
  db: StufloDatabase,
  studentId: string,
  attachmentIds: string[],
) {
  if (attachmentIds.length === 0) return [];
  return db
    .select({
      id: attachments.id,
      r2Key: attachments.r2Key,
      fileName: attachments.fileName,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      sha256: attachments.sha256,
      status: attachments.status,
      source: attachments.source,
      purpose: attachments.purpose,
      sourceKey: attachments.sourceKey,
      sourceUrl: attachments.sourceUrl,
      canvasHost: attachments.canvasHost,
      courseId: attachments.courseId,
      courseName: attachments.courseName,
      createdAt: attachments.createdAt,
      updatedAt: attachments.updatedAt,
      expiresAt: attachments.expiresAt,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.studentId, studentId),
        inArray(attachments.id, attachmentIds),
        eq(attachments.status, 'stored'),
      ),
    );
}

export async function getCanvasAttachmentBySourceKey(
  db: StufloDatabase,
  studentId: string,
  sourceKey: string,
) {
  const [row] = await db
    .select({
      id: attachments.id,
      r2Key: attachments.r2Key,
      sha256: attachments.sha256,
      sizeBytes: attachments.sizeBytes,
      status: attachments.status,
      sourceKey: attachments.sourceKey,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.studentId, studentId),
        eq(attachments.source, 'canvas'),
        eq(attachments.sourceKey, sourceKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getCanvasStorageUsage(db: StufloDatabase, studentId: string) {
  const [row] = await db
    .select({
      bytesUsed: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)`,
      fileCount: count(attachments.id),
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.studentId, studentId),
        eq(attachments.source, 'canvas'),
        eq(attachments.status, 'stored'),
      ),
    );
  return {
    bytesUsed: Number(row?.bytesUsed || 0),
    fileCount: Number(row?.fileCount || 0),
  };
}

export async function upsertCanvasAttachment(
  db: StufloDatabase,
  input: {
    id: string;
    studentId: string;
    r2Key: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    purpose: string;
    sourceKey: string;
    sourceUrl: string;
    canvasHost: string;
    courseId: string;
    courseName: string;
  },
) {
  const [row] = await db
    .insert(attachments)
    .values({
      ...input,
      source: 'canvas',
      status: 'stored',
      expiresAt: null,
    })
    .onConflictDoUpdate({
      target: [attachments.studentId, attachments.sourceKey],
      set: {
        r2Key: input.r2Key,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        purpose: input.purpose,
        sourceUrl: input.sourceUrl,
        canvasHost: input.canvasHost,
        courseId: input.courseId,
        courseName: input.courseName,
        status: 'stored',
        expiresAt: null,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: attachments.id,
      r2Key: attachments.r2Key,
      fileName: attachments.fileName,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      sha256: attachments.sha256,
      purpose: attachments.purpose,
      courseId: attachments.courseId,
      courseName: attachments.courseName,
      sourceUrl: attachments.sourceUrl,
      createdAt: attachments.createdAt,
      updatedAt: attachments.updatedAt,
    });
  if (!row) throw new Error('Canvas storage metadata could not be saved.');
  return row;
}

export async function listCanvasAttachments(db: StufloDatabase, studentId: string) {
  return db
    .select({
      id: attachments.id,
      fileName: attachments.fileName,
      mimeType: attachments.mimeType,
      sizeBytes: attachments.sizeBytes,
      purpose: attachments.purpose,
      courseId: attachments.courseId,
      courseName: attachments.courseName,
      sourceUrl: attachments.sourceUrl,
      createdAt: attachments.createdAt,
      updatedAt: attachments.updatedAt,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.studentId, studentId),
        eq(attachments.source, 'canvas'),
        eq(attachments.status, 'stored'),
      ),
    )
    .orderBy(desc(attachments.updatedAt));
}

export async function deleteAttachmentForStudent(
  db: StufloDatabase,
  studentId: string,
  attachmentId: string,
  retainSourceTombstone = false,
) {
  if (retainSourceTombstone) {
    const [row] = await db.update(attachments).set({ status: 'deleted', updatedAt: new Date() })
      .where(and(eq(attachments.id, attachmentId), eq(attachments.studentId, studentId), eq(attachments.source, 'canvas'), eq(attachments.status, 'stored')))
      .returning({ id: attachments.id, r2Key: attachments.r2Key });
    return row ?? null;
  }
  const [row] = await db
    .delete(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.studentId, studentId)))
    .returning({ id: attachments.id, r2Key: attachments.r2Key });
  return row ?? null;
}

export async function updateStudentProfile(
  db: StufloDatabase,
  input: { userId: string; name: string },
) {
  const [user] = await db
    .update(users)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(users.id, input.userId))
    .returning({ id: users.id, email: users.email, name: users.name });
  return user ?? null;
}

export async function updateStudentTimeZone(
  db: StufloDatabase,
  input: { userId: string; timeZone: string },
) {
  const [student] = await db
    .update(students)
    .set({ timeZone: input.timeZone, updatedAt: new Date() })
    .where(eq(students.userId, input.userId))
    .returning({ studentKey: students.studentKey, timeZone: students.timeZone });
  return student ?? null;
}

export async function upsertCanvasConnection(
  db: StufloDatabase,
  input: {
    studentId: string;
    canvasHost: string;
    encryptedCookies: EncryptionEnvelopeRecord;
    encryptionVersion: string;
    cookiesUpdatedAt: Date;
    lastValidatedAt: Date;
  },
) {
  const [row] = await db
    .insert(canvasConnections)
    .values({ ...input, status: 'connected' })
    .onConflictDoUpdate({
      target: canvasConnections.studentId,
      // A slow validation must not replace cookies from a newer connect request.
      setWhere: lte(canvasConnections.cookiesUpdatedAt, input.cookiesUpdatedAt),
      set: {
        canvasHost: input.canvasHost,
        encryptedCookies: input.encryptedCookies,
        encryptionVersion: input.encryptionVersion,
        cookiesUpdatedAt: input.cookiesUpdatedAt,
        lastValidatedAt: input.lastValidatedAt,
        status: 'connected',
        updatedAt: new Date(),
      },
    })
    .returning({
      canvasHost: canvasConnections.canvasHost,
      status: canvasConnections.status,
      cookiesUpdatedAt: canvasConnections.cookiesUpdatedAt,
      lastValidatedAt: canvasConnections.lastValidatedAt,
    });
  return row;
}

export async function getCanvasConnectionByStudentKey(db: StufloDatabase, studentKey: string) {
  const [row] = await db
    .select({
      studentId: students.id,
      studentKey: students.studentKey,
      timeZone: students.timeZone,
      canvasHost: canvasConnections.canvasHost,
      encryptedCookies: canvasConnections.encryptedCookies,
      encryptionVersion: canvasConnections.encryptionVersion,
      cookiesUpdatedAt: canvasConnections.cookiesUpdatedAt,
      lastValidatedAt: canvasConnections.lastValidatedAt,
      status: canvasConnections.status,
    })
    .from(students)
    .innerJoin(canvasConnections, eq(students.id, canvasConnections.studentId))
    .where(
      and(
        eq(students.studentKey, studentKey),
        inArray(canvasConnections.status, ['connected', 'suspect']),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getBillingIdentityByUserId(db: StufloDatabase, userId: string) {
  const [row] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

export async function saveStripeCustomer(
  db: StufloDatabase,
  input: { userId: string; stripeCustomerId: string },
) {
  const [row] = await db
    .insert(stripeCustomers)
    .values(input)
    .onConflictDoUpdate({
      target: stripeCustomers.userId,
      set: { stripeCustomerId: input.stripeCustomerId, updatedAt: new Date() },
    })
    .returning({ stripeCustomerId: stripeCustomers.stripeCustomerId });
  return row;
}

export async function getCanvasConnectionRecordByStudentKey(db: StufloDatabase, studentKey: string) {
  const [row] = await db
    .select({
      studentId: students.id,
      studentKey: students.studentKey,
      timeZone: students.timeZone,
      canvasHost: canvasConnections.canvasHost,
      encryptedCookies: canvasConnections.encryptedCookies,
      encryptionVersion: canvasConnections.encryptionVersion,
      cookiesUpdatedAt: canvasConnections.cookiesUpdatedAt,
      lastValidatedAt: canvasConnections.lastValidatedAt,
      status: canvasConnections.status,
    })
    .from(students)
    .innerJoin(canvasConnections, eq(students.id, canvasConnections.studentId))
    .where(eq(students.studentKey, studentKey))
    .limit(1);
  return row ?? null;
}

export async function updateCanvasConnectionStatus(
  db: StufloDatabase,
  input: {
    studentId: string;
    status: string;
    lastValidatedAt: Date;
    expectedCookiesUpdatedAt?: Date;
    expectedLastValidatedAt?: Date | null;
  },
) {
  const [row] = await db
    .update(canvasConnections)
    .set({
      status: input.status,
      lastValidatedAt: input.lastValidatedAt,
      updatedAt: new Date(),
    })
    .where(and(
      eq(canvasConnections.studentId, input.studentId),
      input.expectedCookiesUpdatedAt ? sql`date_trunc('milliseconds', ${canvasConnections.cookiesUpdatedAt}) = ${input.expectedCookiesUpdatedAt.toISOString()}::timestamptz` : undefined,
      input.expectedLastValidatedAt === undefined ? undefined : input.expectedLastValidatedAt === null
        ? isNull(canvasConnections.lastValidatedAt)
        : sql`date_trunc('milliseconds', ${canvasConnections.lastValidatedAt}) = ${input.expectedLastValidatedAt.toISOString()}::timestamptz`,
    ))
    .returning({
      canvasHost: canvasConnections.canvasHost,
      status: canvasConnections.status,
      cookiesUpdatedAt: canvasConnections.cookiesUpdatedAt,
      lastValidatedAt: canvasConnections.lastValidatedAt,
    });
  return row ?? null;
}

export async function createCanvasInitializationRun(
  db: StufloDatabase,
  input: { studentId: string; canvasHost: string; reason: string },
) {
  const [row] = await db
    .insert(canvasInitializationRuns)
    .values(input)
    .returning({
      id: canvasInitializationRuns.id,
      canvasHost: canvasInitializationRuns.canvasHost,
      reason: canvasInitializationRuns.reason,
      status: canvasInitializationRuns.status,
      createdAt: canvasInitializationRuns.createdAt,
    });
  if (!row) throw new Error('Canvas initialization run could not be created.');
  return row;
}

export async function updateCanvasInitializationRun(
  db: StufloDatabase,
  input: {
    runId: string;
    status?: string;
    coursesTotal?: number;
    coursesCompleted?: number;
    syllabiFound?: number;
    syllabiStored?: number;
    summary?: Record<string, unknown>;
    warnings?: string[];
    errorMessage?: string | null;
    startedAt?: Date | null;
    completedAt?: Date | null;
  },
) {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (input.status !== undefined) values.status = input.status;
  if (input.coursesTotal !== undefined) values.coursesTotal = input.coursesTotal;
  if (input.coursesCompleted !== undefined) values.coursesCompleted = input.coursesCompleted;
  if (input.syllabiFound !== undefined) values.syllabiFound = input.syllabiFound;
  if (input.syllabiStored !== undefined) values.syllabiStored = input.syllabiStored;
  if (input.summary !== undefined) values.summary = input.summary;
  if (input.warnings !== undefined) values.warnings = input.warnings;
  if (input.errorMessage !== undefined) values.errorMessage = input.errorMessage;
  if (input.startedAt !== undefined) values.startedAt = input.startedAt;
  if (input.completedAt !== undefined) values.completedAt = input.completedAt;
  const [row] = await db
    .update(canvasInitializationRuns)
    .set(values)
    .where(eq(canvasInitializationRuns.id, input.runId))
    .returning({ id: canvasInitializationRuns.id, status: canvasInitializationRuns.status });
  return row ?? null;
}

export async function getLatestCanvasInitializationRun(
  db: StufloDatabase,
  studentId: string,
) {
  const [row] = await db
    .select({
      id: canvasInitializationRuns.id,
      canvasHost: canvasInitializationRuns.canvasHost,
      reason: canvasInitializationRuns.reason,
      status: canvasInitializationRuns.status,
      coursesTotal: canvasInitializationRuns.coursesTotal,
      coursesCompleted: canvasInitializationRuns.coursesCompleted,
      syllabiFound: canvasInitializationRuns.syllabiFound,
      syllabiStored: canvasInitializationRuns.syllabiStored,
      summary: canvasInitializationRuns.summary,
      warnings: canvasInitializationRuns.warnings,
      errorMessage: canvasInitializationRuns.errorMessage,
      startedAt: canvasInitializationRuns.startedAt,
      completedAt: canvasInitializationRuns.completedAt,
      createdAt: canvasInitializationRuns.createdAt,
      updatedAt: canvasInitializationRuns.updatedAt,
    })
    .from(canvasInitializationRuns)
    .where(eq(canvasInitializationRuns.studentId, studentId))
    .orderBy(desc(canvasInitializationRuns.createdAt))
    .limit(1);
  return row ?? null;
}

export async function markCanvasCourseSnapshotsInactive(
  db: StufloDatabase,
  studentId: string,
  canvasHost: string,
) {
  await db
    .update(canvasCourseSnapshots)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        eq(canvasCourseSnapshots.studentId, studentId),
        eq(canvasCourseSnapshots.canvasHost, canvasHost),
      ),
    );
}

export async function upsertCanvasCourseSnapshot(
  db: StufloDatabase,
  input: {
    studentId: string;
    canvasHost: string;
    courseId: string;
    courseName: string;
    courseCode?: string | null;
    termName?: string | null;
    courseUrl: string;
    isActive: boolean;
    syllabusStatus: string;
    syllabusSourceUrl?: string | null;
    syllabusAttachmentIds?: string[];
    externalSystems?: Array<{ name: string; url: string; kind: string; source: string }>;
    snapshot?: Record<string, unknown>;
    initializedAt: Date;
  },
) {
  const values = {
    ...input,
    courseCode: input.courseCode ?? null,
    termName: input.termName ?? null,
    syllabusSourceUrl: input.syllabusSourceUrl ?? null,
    syllabusAttachmentIds: input.syllabusAttachmentIds ?? [],
    externalSystems: input.externalSystems ?? [],
    snapshot: input.snapshot ?? {},
  };
  const [row] = await db
    .insert(canvasCourseSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [
        canvasCourseSnapshots.studentId,
        canvasCourseSnapshots.canvasHost,
        canvasCourseSnapshots.courseId,
      ],
      set: { ...values, updatedAt: new Date() },
    })
    .returning({
      id: canvasCourseSnapshots.id,
      courseId: canvasCourseSnapshots.courseId,
      courseName: canvasCourseSnapshots.courseName,
      syllabusStatus: canvasCourseSnapshots.syllabusStatus,
    });
  if (!row) throw new Error('Canvas course snapshot could not be saved.');
  return row;
}

export async function listCanvasCourseSnapshots(
  db: StufloDatabase,
  studentId: string,
  limit = 150,
) {
  return db
    .select({
      id: canvasCourseSnapshots.id,
      canvasHost: canvasCourseSnapshots.canvasHost,
      courseId: canvasCourseSnapshots.courseId,
      courseName: canvasCourseSnapshots.courseName,
      courseCode: canvasCourseSnapshots.courseCode,
      termName: canvasCourseSnapshots.termName,
      courseUrl: canvasCourseSnapshots.courseUrl,
      isActive: canvasCourseSnapshots.isActive,
      syllabusStatus: canvasCourseSnapshots.syllabusStatus,
      syllabusSourceUrl: canvasCourseSnapshots.syllabusSourceUrl,
      syllabusAttachmentIds: canvasCourseSnapshots.syllabusAttachmentIds,
      externalSystems: canvasCourseSnapshots.externalSystems,
      snapshot: canvasCourseSnapshots.snapshot,
      initializedAt: canvasCourseSnapshots.initializedAt,
      updatedAt: canvasCourseSnapshots.updatedAt,
    })
    .from(canvasCourseSnapshots)
    .where(eq(canvasCourseSnapshots.studentId, studentId))
    .orderBy(desc(canvasCourseSnapshots.isActive), desc(canvasCourseSnapshots.initializedAt))
    .limit(Math.max(1, Math.min(limit, 200)));
}

export async function upsertGoogleConnection(
  db: StufloDatabase,
  input: {
    studentId: string;
    googleEmail: string;
    encryptedTokens: EncryptionEnvelopeRecord;
    encryptionVersion: string;
    scopes: string[];
    lastRefreshedAt?: Date | null;
  },
) {
  const [row] = await db
    .insert(googleConnections)
    .values({ ...input, status: 'connected', connectedAt: new Date() })
    .onConflictDoUpdate({
      target: googleConnections.studentId,
      set: {
        googleEmail: input.googleEmail,
        encryptedTokens: input.encryptedTokens,
        encryptionVersion: input.encryptionVersion,
        scopes: input.scopes,
        lastRefreshedAt: input.lastRefreshedAt,
        status: 'connected',
        connectedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning({
      googleEmail: googleConnections.googleEmail,
      scopes: googleConnections.scopes,
      status: googleConnections.status,
      connectedAt: googleConnections.connectedAt,
      lastRefreshedAt: googleConnections.lastRefreshedAt,
    });
  return row;
}

export async function updateGoogleTokens(
  db: StufloDatabase,
  studentId: string,
  encryptedTokens: EncryptionEnvelopeRecord,
  encryptionVersion: string,
  connectedAt?: Date,
) {
  const [row] = await db
    .update(googleConnections)
    .set({ encryptedTokens, encryptionVersion, lastRefreshedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(googleConnections.studentId, studentId), eq(googleConnections.status, 'connected'),
      ...(connectedAt ? [sql`date_trunc('milliseconds', ${googleConnections.connectedAt}) = ${connectedAt.toISOString()}::timestamptz`] : [])))
    .returning({ studentId: googleConnections.studentId });
  if (!row) throw new Error('Google Calendar connection no longer exists.');
}

/** Serialize a student's storage changes across Workers and Durable Objects. */
export async function withStudentStorageLock<T>(
  db: StufloDatabase,
  studentId: string,
  operation: (transaction: StufloDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'canvas-storage:' + studentId}, 0))`);
    return operation(transaction as unknown as StufloDatabase);
  });
}

export async function getCanvasAttachmentForFile(
  db: StufloDatabase, studentId: string, canvasHost: string, courseId: string, fileId: string,
) {
  const [row] = await db.select({ id: attachments.id, r2Key: attachments.r2Key, sha256: attachments.sha256,
    sizeBytes: attachments.sizeBytes, status: attachments.status, sourceKey: attachments.sourceKey })
    .from(attachments).where(and(eq(attachments.studentId, studentId), eq(attachments.source, 'canvas'),
      eq(attachments.canvasHost, canvasHost), eq(attachments.courseId, courseId),
      sql`(regexp_match(${attachments.sourceUrl}, '/files/([0-9]+)(?:[/?.#]|$)'))[1] = ${fileId}`))
    .orderBy(sql`case when ${attachments.status} = 'deleted' then 0 else 1 end`, desc(attachments.updatedAt)).limit(1);
  return row ?? null;
}

export async function markGoogleConnectionExpired(db: StufloDatabase, studentId: string, connectedAt: Date) {
  await db.update(googleConnections).set({ status: 'expired', updatedAt: new Date() })
    .where(and(eq(googleConnections.studentId, studentId), sql`date_trunc('milliseconds', ${googleConnections.connectedAt}) = ${connectedAt.toISOString()}::timestamptz`));
}

export async function deleteGoogleConnection(db: StufloDatabase, studentId: string) {
  await db.delete(googleConnections).where(eq(googleConnections.studentId, studentId));
}

export async function getGoogleConnectionByStudentKey(db: StufloDatabase, studentKey: string, connectedOnly = true) {
  const [row] = await db
    .select({
      studentId: students.id,
      studentKey: students.studentKey,
      timeZone: students.timeZone,
      googleEmail: googleConnections.googleEmail,
      encryptedTokens: googleConnections.encryptedTokens,
      encryptionVersion: googleConnections.encryptionVersion,
      scopes: googleConnections.scopes,
      connectedAt: googleConnections.connectedAt,
      lastRefreshedAt: googleConnections.lastRefreshedAt,
      status: googleConnections.status,
    })
    .from(students)
    .innerJoin(googleConnections, eq(students.id, googleConnections.studentId))
    .where(and(eq(students.studentKey, studentKey), ...(connectedOnly ? [eq(googleConnections.status, 'connected')] : [])))
    .limit(1);
  return row ?? null;
}

export type StudentProfileInput = {
  preferredName?: string | null;
  communicationStyle?: 'concise' | 'balanced' | 'detailed';
  responseVerbosity?: 'concise' | 'balanced' | 'detailed';
  learningGoals?: string[];
  studyPreferences?: Record<string, string | number | boolean | string[]>;
};

export async function getStudentProfileByKey(db: StufloDatabase, studentKey: string) {
  const [student] = await db
    .select({ id: students.id })
    .from(students)
    .where(eq(students.studentKey, studentKey))
    .limit(1);
  if (!student) return null;
  const [profile] = await db
    .select({
      preferredName: studentProfiles.preferredName,
      communicationStyle: studentProfiles.communicationStyle,
      responseVerbosity: studentProfiles.responseVerbosity,
      learningGoals: studentProfiles.learningGoals,
      studyPreferences: studentProfiles.studyPreferences,
      memorySummary: studentProfiles.memorySummary,
      updatedAt: studentProfiles.updatedAt,
    })
    .from(studentProfiles)
    .where(eq(studentProfiles.studentId, student.id))
    .limit(1);
  return {
    studentId: student.id,
    profile: profile ?? {
      preferredName: null,
      communicationStyle: 'balanced',
      responseVerbosity: 'balanced',
      learningGoals: [],
      studyPreferences: {},
      memorySummary: '',
      updatedAt: null,
    },
  };
}

export async function upsertStudentProfileByKey(
  db: StufloDatabase,
  studentKey: string,
  input: StudentProfileInput,
) {
  const student = await getStudentByKey(db, studentKey);
  if (!student) return null;
  const values = {
    preferredName: input.preferredName ?? null,
    communicationStyle: input.communicationStyle ?? 'balanced',
    responseVerbosity: input.responseVerbosity ?? 'balanced',
    learningGoals: input.learningGoals ?? [],
    studyPreferences: input.studyPreferences ?? {},
  };
  const [profile] = await db
    .insert(studentProfiles)
    .values({ studentId: student.id, ...values })
    .onConflictDoUpdate({
      target: studentProfiles.studentId,
      set: { ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), updatedAt: new Date() },
    })
    .returning({
      preferredName: studentProfiles.preferredName,
      communicationStyle: studentProfiles.communicationStyle,
      responseVerbosity: studentProfiles.responseVerbosity,
      learningGoals: studentProfiles.learningGoals,
      studyPreferences: studentProfiles.studyPreferences,
      memorySummary: studentProfiles.memorySummary,
      updatedAt: studentProfiles.updatedAt,
    });
  return profile ?? null;
}

export async function listStudentMemoriesByKey(
  db: StufloDatabase,
  studentKey: string,
  limit = 100,
) {
  const student = await getStudentByKey(db, studentKey);
  if (!student) return null;
  const memories = await db
    .select({
      id: studentMemories.id,
      category: studentMemories.category,
      content: studentMemories.content,
      source: studentMemories.source,
      pinned: studentMemories.pinned,
      createdAt: studentMemories.createdAt,
      updatedAt: studentMemories.updatedAt,
      lastUsedAt: studentMemories.lastUsedAt,
    })
    .from(studentMemories)
    .where(and(eq(studentMemories.studentId, student.id), eq(studentMemories.status, 'active')))
    .orderBy(desc(studentMemories.pinned), desc(studentMemories.updatedAt))
    .limit(Math.max(1, Math.min(limit, 100)));
  return { studentId: student.id, memories };
}

export async function createStudentMemoryByKey(
  db: StufloDatabase,
  studentKey: string,
  input: { category: string; content: string; source: string; pinned?: boolean },
) {
  const student = await getStudentByKey(db, studentKey);
  if (!student) return null;
  return db.transaction(async (transaction) => {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'student-memory:' + student.id}, 0))`);
  const selection = {
    id: studentMemories.id, category: studentMemories.category, content: studentMemories.content,
    source: studentMemories.source, pinned: studentMemories.pinned, createdAt: studentMemories.createdAt,
    updatedAt: studentMemories.updatedAt,
  };
  const [existing] = await transaction.select(selection).from(studentMemories)
    .where(and(eq(studentMemories.studentId, student.id), eq(studentMemories.status, 'active'),
      eq(studentMemories.category, input.category), sql`lower(${studentMemories.content}) = ${input.content.toLowerCase()}`)).limit(1);
  if (existing) {
    const [memory] = await transaction.update(studentMemories)
      .set({ pinned: existing.pinned || input.pinned === true, updatedAt: new Date() })
      .where(and(eq(studentMemories.id, existing.id), eq(studentMemories.studentId, student.id), eq(studentMemories.status, 'active')))
      .returning(selection);
    return memory ?? null;
  }
  const [{ activeCount = 0 } = {}] = await transaction
    .select({ activeCount: count() })
    .from(studentMemories)
    .where(and(eq(studentMemories.studentId, student.id), eq(studentMemories.status, 'active')));
  if (Number(activeCount) >= 100) throw new Error('Student memory limit reached.');
  const [memory] = await transaction
    .insert(studentMemories)
    .values({ studentId: student.id, ...input, pinned: input.pinned ?? false })
    .returning({
      id: studentMemories.id,
      category: studentMemories.category,
      content: studentMemories.content,
      source: studentMemories.source,
      pinned: studentMemories.pinned,
      createdAt: studentMemories.createdAt,
      updatedAt: studentMemories.updatedAt,
    });
  return memory ?? null;
  });
}

export async function archiveStudentMemoryByKey(
  db: StufloDatabase,
  studentKey: string,
  memoryId: string,
) {
  const student = await getStudentByKey(db, studentKey);
  if (!student) return null;
  return db.transaction(async (transaction) => {
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'student-memory:' + student.id}, 0))`);
  const [memory] = await transaction
    .update(studentMemories)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(and(eq(studentMemories.id, memoryId), eq(studentMemories.studentId, student.id)))
    .returning({ id: studentMemories.id });
  return memory ?? null;
  });
}

export async function recordAuditLog(
  db: StufloDatabase,
  input: {
    actorUserId: string | null;
    studentId?: string | null;
    action: string;
    metadata?: Record<string, unknown>;
  },
) {
  const [row] = await db
    .insert(auditLogs)
    .values({
      actorUserId: input.actorUserId,
      studentId: input.studentId ?? null,
      action: input.action,
      metadata: input.metadata ?? {},
    })
    .returning({ id: auditLogs.id, createdAt: auditLogs.createdAt });
  return row;
}

export async function updateUsageSettings(
  db: StufloDatabase,
  value: Record<string, unknown>,
) {
  const [row] = await db
    .insert(usageSettings)
    .values({ key: 'global', value })
    .onConflictDoUpdate({
      target: usageSettings.key,
      set: { value, updatedAt: new Date() },
    })
    .returning({ value: usageSettings.value, updatedAt: usageSettings.updatedAt });
  return row;
}

function utcPeriodStarts(now = new Date()) {
  return {
    day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    month: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  };
}

export async function getGlobalUsageCosts(db: StufloDatabase, now = new Date()) {
  const starts = utcPeriodStarts(now);
  const readCost = async (since: Date) => {
    const [row] = await db
      .select({
        value: sum(usageEvents.estimatedProviderCostUsd),
        events: count(),
        averageDurationMs: sql<number>`coalesce(avg((${usageEvents.metadata}->>'durationMs')::numeric), 0)`,
      })
      .from(usageEvents)
      .where(gte(usageEvents.createdAt, since));
    return {
      costUsd: Number(row?.value ?? 0),
      events: Number(row?.events ?? 0),
      averageDurationMs: Number(row?.averageDurationMs ?? 0),
    };
  };
  const [day, month] = await Promise.all([readCost(starts.day), readCost(starts.month)]);
  return { day, month, periodStarts: starts };
}

export async function listAdminStudents(
  db: StufloDatabase,
  input: { search?: string; limit?: number; offset?: number } = {},
) {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 250));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const search = input.search?.trim();
  const where = search
    ? or(
        ilike(users.email, `%${search}%`),
        ilike(users.name, `%${search}%`),
        ilike(students.studentKey, `%${search}%`),
      )
    : undefined;
  const studentsPage = await db
    .select({
      id: students.id,
      studentKey: students.studentKey,
      email: users.email,
      name: users.name,
      plan: students.plan,
      status: students.status,
      timeZone: students.timeZone,
      createdAt: students.createdAt,
      canvasStatus: canvasConnections.status,
      canvasHost: canvasConnections.canvasHost,
      googleStatus: googleConnections.status,
      googleEmail: googleConnections.googleEmail,
    })
    .from(students)
    .innerJoin(users, eq(students.userId, users.id))
    .leftJoin(canvasConnections, eq(canvasConnections.studentId, students.id))
    .leftJoin(googleConnections, eq(googleConnections.studentId, students.id))
    .where(where)
    .orderBy(desc(students.createdAt))
    .limit(limit)
    .offset(offset);
  const [totalRow] = await db
    .select({ value: count() })
    .from(students)
    .innerJoin(users, eq(students.userId, users.id))
    .where(where);
  return { students: studentsPage, total: Number(totalRow?.value ?? 0), limit, offset };
}

export async function getAdminStudentByKey(db: StufloDatabase, studentKey: string) {
  const [student] = await db
    .select({
      id: students.id,
      userId: students.userId,
      studentKey: students.studentKey,
      email: users.email,
      name: users.name,
      plan: students.plan,
      status: students.status,
      timeZone: students.timeZone,
      createdAt: students.createdAt,
      updatedAt: students.updatedAt,
      canvasStatus: canvasConnections.status,
      canvasHost: canvasConnections.canvasHost,
      canvasUpdatedAt: canvasConnections.updatedAt,
      googleStatus: googleConnections.status,
      googleEmail: googleConnections.googleEmail,
      googleUpdatedAt: googleConnections.updatedAt,
    })
    .from(students)
    .innerJoin(users, eq(students.userId, users.id))
    .leftJoin(canvasConnections, eq(canvasConnections.studentId, students.id))
    .leftJoin(googleConnections, eq(googleConnections.studentId, students.id))
    .where(eq(students.studentKey, studentKey))
    .limit(1);
  if (!student) return null;
  const [profile, memories, events, stripeCustomer, subscriptions] = await Promise.all([
    getStudentProfileByKey(db, studentKey),
    listStudentMemoriesByKey(db, studentKey, 100),
    db
      .select({
        id: usageEvents.id,
        provider: usageEvents.provider,
        model: usageEvents.model,
        operation: usageEvents.operation,
        inputTokens: usageEvents.inputTokens,
        outputTokens: usageEvents.outputTokens,
        estimatedProviderCostUsd: usageEvents.estimatedProviderCostUsd,
        creditsCharged: usageEvents.creditsCharged,
        metadata: usageEvents.metadata,
        createdAt: usageEvents.createdAt,
      })
      .from(usageEvents)
      .where(eq(usageEvents.studentId, student.id))
      .orderBy(desc(usageEvents.createdAt))
      .limit(100),
    db
      .select({ stripeCustomerId: stripeCustomers.stripeCustomerId })
      .from(stripeCustomers)
      .where(eq(stripeCustomers.userId, student.userId))
      .limit(1),
    db
      .select({
        stripeSubscriptionId: stripeSubscriptions.stripeSubscriptionId,
        status: stripeSubscriptions.status,
        priceId: stripeSubscriptions.priceId,
        plan: stripeSubscriptions.plan,
        currentPeriodStart: stripeSubscriptions.currentPeriodStart,
        currentPeriodEnd: stripeSubscriptions.currentPeriodEnd,
        cancelAtPeriodEnd: stripeSubscriptions.cancelAtPeriodEnd,
        updatedAt: stripeSubscriptions.updatedAt,
      })
      .from(stripeSubscriptions)
      .where(eq(stripeSubscriptions.userId, student.userId))
      .orderBy(desc(stripeSubscriptions.updatedAt))
      .limit(10),
  ]);
  return {
    student,
    profile: profile?.profile ?? null,
    memories: memories?.memories ?? [],
    usageEvents: events,
    stripeCustomerId: stripeCustomer[0]?.stripeCustomerId ?? null,
    subscriptions,
  };
}

export async function getAdminStudentDeletionTarget(db: StufloDatabase, studentKey: string) {
  const [target] = await db
    .select({
      studentId: students.id,
      userId: students.userId,
      studentKey: students.studentKey,
      email: users.email,
      stripeCustomerId: stripeCustomers.stripeCustomerId,
    })
    .from(students)
    .innerJoin(users, eq(students.userId, users.id))
    .leftJoin(stripeCustomers, eq(stripeCustomers.userId, users.id))
    .where(eq(students.studentKey, studentKey))
    .limit(1);
  if (!target) return null;
  const storedAttachments = await db
    .select({ r2Key: attachments.r2Key })
    .from(attachments)
    .where(eq(attachments.studentId, target.studentId));
  return { ...target, r2Keys: storedAttachments.map((attachment) => attachment.r2Key) };
}

export async function deleteAdminStudentAccount(
  db: StufloDatabase,
  input: {
    actorUserId: string;
    studentId: string;
    userId: string;
    studentKey: string;
    email: string;
    targetFingerprint: string;
    stripeCustomerDeleted: boolean;
    attachmentCount: number;
  },
) {
  return db.transaction(async (transaction) => {
    await transaction.delete(auditLogs).where(eq(auditLogs.studentId, input.studentId));
    await transaction
      .delete(stripeEvents)
      .where(
        or(
          sql`${stripeEvents.result}->>'studentId' = ${input.studentId}`,
          sql`${stripeEvents.result}->>'userId' = ${input.userId}`,
        ),
      );
    await transaction
      .delete(operationalAlerts)
      .where(
        or(
          sql`${operationalAlerts.metadata}->>'studentKey' = ${input.studentKey}`,
          sql`${operationalAlerts.metadata}->>'path' like ${`%${input.studentKey}%`}`,
        ),
      );
    await transaction
      .delete(verificationTokens)
      .where(eq(verificationTokens.email, input.email.trim().toLowerCase()));
    await transaction.delete(emailChallenges).where(eq(emailChallenges.email, input.email.trim().toLowerCase()));
    await transaction.insert(auditLogs).values({
      actorUserId: input.actorUserId,
      studentId: input.studentId,
      action: 'admin.student.delete',
      metadata: {
        targetFingerprint: input.targetFingerprint,
        stripeCustomerDeleted: input.stripeCustomerDeleted,
        attachmentCount: input.attachmentCount,
      },
    });
    const [deleted] = await transaction
      .delete(users)
      .where(eq(users.id, input.userId))
      .returning({ id: users.id });
    return Boolean(deleted);
  });
}

export async function getAdminOverview(db: StufloDatabase, now = new Date()) {
  const [
    studentCountRow,
    canvasCountRow,
    googleCountRow,
    openAlertCountRow,
    usage,
    recentAuditLogs,
  ] =
    await Promise.all([
      db.select({ value: count() }).from(students),
      db
        .select({ value: count() })
        .from(canvasConnections)
        .where(eq(canvasConnections.status, 'connected')),
      db
        .select({ value: count() })
        .from(googleConnections)
        .where(eq(googleConnections.status, 'connected')),
      db
        .select({ value: count() })
        .from(operationalAlerts)
        .where(eq(operationalAlerts.status, 'open')),
      getGlobalUsageCosts(db, now),
      db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .orderBy(desc(auditLogs.createdAt))
        .limit(25),
    ]);
  return {
    studentCount: Number(studentCountRow[0]?.value ?? 0),
    connectedCanvasCount: Number(canvasCountRow[0]?.value ?? 0),
    connectedGoogleCount: Number(googleCountRow[0]?.value ?? 0),
    openAlertCount: Number(openAlertCountRow[0]?.value ?? 0),
    usage,
    recentAuditLogs,
  };
}

export async function listOperationalAlerts(db: StufloDatabase, limit = 100) {
  return db
    .select()
    .from(operationalAlerts)
    .orderBy(desc(operationalAlerts.lastTriggeredAt))
    .limit(Math.max(1, Math.min(limit, 250)));
}

export async function upsertOperationalAlert(
  db: StufloDatabase,
  input: {
    dedupeKey: string;
    type: string;
    severity: string;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
  },
) {
  const now = new Date();
  const [row] = await db
    .insert(operationalAlerts)
    .values({ ...input, metadata: input.metadata ?? {}, firstTriggeredAt: now, lastTriggeredAt: now })
    .onConflictDoUpdate({
      target: operationalAlerts.dedupeKey,
      set: {
        type: input.type,
        severity: input.severity,
        title: input.title,
        message: input.message,
        metadata: input.metadata ?? {},
        status: 'open',
        lastTriggeredAt: now,
        resolvedAt: null,
      },
    })
    .returning();
  return row;
}

export async function resolveOperationalAlert(db: StufloDatabase, id: string) {
  const [row] = await db
    .update(operationalAlerts)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(eq(operationalAlerts.id, id))
    .returning({ id: operationalAlerts.id });
  return row ?? null;
}
