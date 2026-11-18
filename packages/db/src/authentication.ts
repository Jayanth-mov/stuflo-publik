import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import type { StufloDatabase } from './client';
import { authSessions, emailChallenges, loginIdentities, students, users } from './schema';

type Transaction = Parameters<Parameters<StufloDatabase['transaction']>[0]>[0];

export async function issueEmailChallenge(db: StufloDatabase, input: {
  id: string; email: string; codeHash: string; now: Date; expiresAt: Date;
}) {
  return db.transaction(async (tx) => {
    // Serializes issuance across workers, including accounts that do not exist yet.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`auth:${input.email}`}, 0))`);
    const [recent] = await tx.select({ total: count(), latest: sql<Date>`max(${emailChallenges.createdAt})` })
      .from(emailChallenges).where(and(eq(emailChallenges.email, input.email),
        gt(emailChallenges.createdAt, new Date(input.now.getTime() - 24 * 60 * 60_000))));
    if (Number(recent?.total) >= 20 || (recent?.latest &&
      new Date(recent.latest).getTime() > input.now.getTime() - 60_000)) return false;
    await tx.update(emailChallenges).set({ consumedAt: input.now })
      .where(and(eq(emailChallenges.email, input.email), isNull(emailChallenges.consumedAt)));
    await tx.insert(emailChallenges).values({ ...input, createdAt: input.now });
    // Bounded cleanup keeps expired codes out of long-term account records.
    await tx.execute(sql`delete from email_challenges where id in (
      select id from email_challenges where expires_at < ${new Date(input.now.getTime() - 24 * 60 * 60_000).toISOString()}::timestamptz limit 200
    )`);
    return true;
  });
}

export async function invalidateEmailChallenge(db: StufloDatabase, id: string) {
  await db.update(emailChallenges).set({ consumedAt: new Date() }).where(eq(emailChallenges.id, id));
}

async function createSession(tx: Transaction, userId: string, input: {
  sessionTokenHash: string; sessionExpiresAt: Date;
}) {
  const [session] = await tx.select({ userId: users.id, email: users.email, name: users.name,
    studentId: students.id, studentKey: students.studentKey, timeZone: students.timeZone, plan: students.plan })
    .from(users).innerJoin(students, eq(students.userId, users.id))
    .where(and(eq(users.id, userId), eq(students.status, 'active'))).limit(1);
  if (!session) return null;
  await tx.insert(authSessions).values({ userId, sessionTokenHash: input.sessionTokenHash,
    expiresAt: input.sessionExpiresAt });
  return { ...session, sessionExpiresAt: input.sessionExpiresAt };
}

async function findOrCreateUser(tx: Transaction, email: string, name?: string) {
  await tx.insert(users).values({ email, name: name?.slice(0, 120) || null })
    .onConflictDoNothing({ target: users.email });
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  await tx.insert(students).values({ userId: user.id,
    studentKey: `student_${crypto.randomUUID().replace(/-/g, '')}`, plan: 'free' })
    .onConflictDoNothing({ target: students.userId });
  return user;
}

export async function redeemEmailChallenge(db: StufloDatabase, input: {
  id: string; email: string; codeHash: string; now: Date;
  sessionTokenHash: string; sessionExpiresAt: Date;
  googleSubject?: string;
}) {
  return db.transaction(async (tx) => {
    const [challenge] = await tx.select().from(emailChallenges)
      .where(and(eq(emailChallenges.id, input.id), eq(emailChallenges.email, input.email))).for('update');
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= input.now || challenge.attempts >= 5) return null;
    // Persist unsuccessful attempts; throwing here would roll back the counter.
    await tx.update(emailChallenges).set({ attempts: challenge.attempts + 1 })
      .where(eq(emailChallenges.id, input.id));
    if (challenge.codeHash !== input.codeHash) return null;
    await tx.update(emailChallenges).set({ consumedAt: input.now }).where(eq(emailChallenges.id, input.id));
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`identity:${input.email}`}, 0))`);
    const user = await findOrCreateUser(tx, input.email);
    if (input.googleSubject) {
      // Never transfer a provider identity already owned by another account.
      const [identity] = await tx.select().from(loginIdentities)
        .where(and(eq(loginIdentities.provider, 'google'), eq(loginIdentities.subject, input.googleSubject)));
      if (identity && identity.userId !== user.id) return null;
      const [existingLink] = await tx.select().from(loginIdentities)
        .where(and(eq(loginIdentities.provider, 'google'), eq(loginIdentities.userId, user.id)));
      if (existingLink && existingLink.subject !== input.googleSubject) return null;
      await tx.insert(loginIdentities).values({ provider: 'google', subject: input.googleSubject, userId: user.id })
        .onConflictDoNothing();
    }
    return createSession(tx, user.id, input);
  });
}

export async function signInGoogleIdentity(db: StufloDatabase, input: {
  subject: string; email: string; name?: string; emailAuthoritative: boolean;
  sessionTokenHash: string; sessionExpiresAt: Date;
}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`google:${input.subject}`}, 0))`);
    const [linked] = await tx.select().from(loginIdentities)
      .where(and(eq(loginIdentities.provider, 'google'), eq(loginIdentities.subject, input.subject)));
    if (linked) return { session: await createSession(tx, linked.userId, input), needsEmail: false };
    if (!input.emailAuthoritative) return { session: null, needsEmail: true };
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`identity:${input.email}`}, 0))`);
    const user = await findOrCreateUser(tx, input.email, input.name);
    const [otherIdentity] = await tx.select().from(loginIdentities)
      .where(and(eq(loginIdentities.provider, 'google'), eq(loginIdentities.userId, user.id)));
    if (otherIdentity) return { session: null, needsEmail: false };
    await tx.insert(loginIdentities).values({ provider: 'google', subject: input.subject, userId: user.id });
    return { session: await createSession(tx, user.id, input), needsEmail: false };
  });
}
