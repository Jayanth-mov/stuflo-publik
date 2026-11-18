import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { createDatabase } from '../src/client';
import { issueEmailChallenge, redeemEmailChallenge, signInGoogleIdentity } from '../src/authentication';
import { ensureMonthlyCreditGrant, fulfillStripeCheckout, fulfillStripeSubscriptionDeleted, getStudentUsageStatus } from '../src/repositories';
import { users, students, emailChallenges, stripeEvents, stripeSubscriptions, loginIdentities } from '../src/schema';

const connection = process.env.AUTH_TEST_DATABASE_URL;
const suite = connection ? describe : describe.skip;
suite('passwordless authentication on an isolated Postgres branch', () => {
  // Require a second explicit guard: never run these integration tests against production.
  if (connection && process.env.AUTH_TEST_BRANCH !== 'dev-auth-signup-2026-09-19') throw new Error('An isolated auth test branch is required.');
  const opened = connection ? createDatabase(connection) : null;
  const db = opened?.db!;
  const prefix = `auth-test-${crypto.randomUUID()}`;
  const email = (label: string) => `${prefix}-${label}@example.invalid`;
  const now = new Date();
  function challenge(address: string, offset = 0) {
    return { id: crypto.randomUUID(), email: address, codeHash: 'correct-hmac',
      now: new Date(now.getTime() + offset), expiresAt: new Date(now.getTime() + offset + 600_000) };
  }
  function redeem(input: ReturnType<typeof challenge>, codeHash = input.codeHash) {
    return redeemEmailChallenge(db, { ...input, codeHash, now: new Date(), sessionTokenHash: crypto.randomUUID(),
      sessionExpiresAt: new Date(Date.now() + 3600_000) });
  }
  async function signup(label: string) {
    const input = challenge(email(label));
    expect(await issueEmailChallenge(db, input)).toBe(true);
    return (await redeem(input))!;
  }
  afterAll(async () => {
    if (!opened) return;
    await db.delete(emailChallenges).where(like(emailChallenges.email, `${prefix}%`));
    await db.delete(stripeEvents).where(like(stripeEvents.stripeEventId, `${prefix}%`));
    await db.delete(users).where(like(users.email, `${prefix}%`));
    await opened.close();
  });

  it('creates no account before verification, then one Free account with idempotent credits', async () => {
    const input = challenge(email('free'));
    expect(await issueEmailChallenge(db, input)).toBe(true);
    expect(await db.select().from(users).where(eq(users.email, input.email))).toHaveLength(0);
    const session = await redeem(input);
    expect(session?.plan).toBe('free');
    await ensureMonthlyCreditGrant(db, { studentId: session!.studentId, credits: 25 });
    await ensureMonthlyCreditGrant(db, { studentId: session!.studentId, credits: 25 });
    const usage = await getStudentUsageStatus(db, session!.studentId);
    expect(usage.creditsGranted).toBe(25);
    expect(await redeem(input)).toBeNull();
  });

  it('allows only five attempts, even when guesses run concurrently', async () => {
    const input = challenge(email('guesses'));
    await issueEmailChallenge(db, input);
    expect(await Promise.all(Array.from({ length: 8 }, () => redeem(input, 'wrong')))).toEqual(Array(8).fill(null));
    expect(await redeem(input)).toBeNull();
    const [row] = await db.select().from(emailChallenges).where(eq(emailChallenges.id, input.id));
    expect(row.attempts).toBe(5);
  });

  it('rejects expired codes and codes submitted for another email', async () => {
    const input = challenge(email('expired'), -700_000);
    await issueEmailChallenge(db, input);
    expect(await redeem(input)).toBeNull();
    const fresh = challenge(email('scoped'));
    await issueEmailChallenge(db, fresh);
    expect(await redeem({ ...fresh, email: email('other') })).toBeNull();
  });

  it('serializes concurrent resends and invalidates the older code', async () => {
    const old = challenge(email('resend'), -120_000);
    await issueEmailChallenge(db, old);
    const fresh = challenge(old.email);
    const competing = challenge(old.email);
    const issued = await Promise.all([issueEmailChallenge(db, fresh), issueEmailChallenge(db, competing)]);
    expect(issued.filter(Boolean)).toHaveLength(1);
    expect(await redeem(old)).toBeNull();
    const winner = issued[0] ? fresh : competing;
    const concurrent = await Promise.all([redeem(winner), redeem(winner)]);
    expect(concurrent.filter(Boolean)).toHaveLength(1);
  });

  it('preserves an existing paid account and links authoritative Google sign-in to it', async () => {
    const existing = await signup('existing');
    await db.update(students).set({ plan: 'stupro' }).where(eq(students.id, existing.studentId));
    const identity = { subject: `${prefix}-google`, email: existing.email, emailAuthoritative: true,
      sessionTokenHash: crypto.randomUUID(), sessionExpiresAt: new Date(Date.now() + 3600_000) };
    const result = await signInGoogleIdentity(db, identity);
    expect(result.session).toMatchObject({ userId: existing.userId, studentKey: existing.studentKey, plan: 'stupro' });
    const returned = await signInGoogleIdentity(db, { ...identity, email: email('changed-at-google'), sessionTokenHash: crypto.randomUUID() });
    expect(returned.session?.userId).toBe(existing.userId);
  });

  it('requires email proof for unlinked third-party Google addresses', async () => {
    const address = email('third-party');
    const subject = `${prefix}-third-party-google`;
    expect(await signInGoogleIdentity(db, { email: address, subject, emailAuthoritative: false,
      sessionTokenHash: crypto.randomUUID(), sessionExpiresAt: new Date(Date.now() + 3600_000) }))
      .toEqual({ session: null, needsEmail: true });
    expect(await db.select().from(users).where(eq(users.email, address))).toHaveLength(0);
    const input = challenge(address); await issueEmailChallenge(db, input);
    const session = await redeemEmailChallenge(db, { ...input, googleSubject: subject,
      sessionTokenHash: crypto.randomUUID(), sessionExpiresAt: new Date(Date.now() + 3600_000) });
    const identities = await db.select().from(loginIdentities).where(and(eq(loginIdentities.subject, subject), eq(loginIdentities.userId, session!.userId)));
    expect(identities).toHaveLength(1);
  });

  it('does not reactivate an inactive account on either login method', async () => {
    const existing = await signup('inactive');
    await db.update(students).set({ status: 'inactive' }).where(eq(students.id, existing.studentId));
    const input = challenge(existing.email, 120_000); await issueEmailChallenge(db, input);
    expect(await redeem(input)).toBeNull();
    const result = await signInGoogleIdentity(db, { email: existing.email, subject: `${prefix}-inactive`, emailAuthoritative: true,
      sessionTokenHash: crypto.randomUUID(), sessionExpiresAt: new Date(Date.now() + 3600_000) });
    expect(result.session).toBeNull();
  });

  it('upgrades the referenced account despite a different billing email, without duplicate grants', async () => {
    const existing = await signup('upgrade');
    await ensureMonthlyCreditGrant(db, { studentId: existing.studentId, credits: 25 });
    const checkout = { eventId: `${prefix}-checkout`, eventType: 'checkout.session.completed', livemode: false,
      userId: existing.userId, email: email('billing'), studentKey: `student_${crypto.randomUUID().replace(/-/g, '')}`,
      customerId: `${prefix}-customer`, subscriptionId: `${prefix}-subscription`, subscriptionStatus: 'active',
      priceId: 'price_test', plan: 'stupro' as const, monthlyCredits: 250 };
    const result = await fulfillStripeCheckout(db, checkout);
    expect(result.duplicate).toBe(false);
    if (!result.duplicate) expect(result.student.studentKey).toBe(existing.studentKey);
    expect((await getStudentUsageStatus(db, existing.studentId)).creditsGranted).toBe(250);
    expect((await fulfillStripeCheckout(db, checkout)).duplicate).toBe(true);
    expect(await db.select().from(users).where(eq(users.email, checkout.email))).toHaveLength(0);
    await fulfillStripeSubscriptionDeleted(db, { ...checkout, eventId: `${prefix}-cancel`, eventType: 'customer.subscription.deleted' });
    const [student] = await db.select().from(students).where(eq(students.id, existing.studentId));
    expect(student.plan).toBe('free'); expect(student.studentKey).toBe(existing.studentKey);
  });

  it('does not restore paid access or increase credits when an old checkout is retried after cancellation', async () => {
    const existing = await signup('canceled-checkout');
    await ensureMonthlyCreditGrant(db, { studentId: existing.studentId, credits: 25 });
    const checkout = { eventId: `${prefix}-canceled-checkout`, eventType: 'checkout.session.completed', livemode: false,
      userId: existing.userId, email: email('canceled-billing'), studentKey: `student_${crypto.randomUUID().replace(/-/g, '')}`,
      customerId: `${prefix}-canceled-customer`, subscriptionId: `${prefix}-canceled-subscription`, subscriptionStatus: 'canceled',
      priceId: 'price_legacy', plan: 'stupro' as const, monthlyCredits: 250 };
    const result = await fulfillStripeCheckout(db, checkout);
    expect(result.duplicate).toBe(false);
    if (!result.duplicate) expect(result.student).toMatchObject({ studentKey: existing.studentKey, plan: 'free' });
    expect(await getStudentUsageStatus(db, existing.studentId)).toMatchObject({ creditsGranted: 25, creditsRemaining: 25 });
    const [subscription] = await db.select().from(stripeSubscriptions)
      .where(eq(stripeSubscriptions.stripeSubscriptionId, checkout.subscriptionId));
    expect(subscription).toMatchObject({ plan: 'stupro', status: 'canceled' });
    const [event] = await db.select().from(stripeEvents).where(eq(stripeEvents.stripeEventId, checkout.eventId));
    expect(event.result).toMatchObject({ status: 'processed', plan: 'free' });
    expect((await fulfillStripeCheckout(db, checkout)).duplicate).toBe(true);
    expect(await getStudentUsageStatus(db, existing.studentId)).toMatchObject({ creditsGranted: 25, creditsRemaining: 25 });
  });

  it('does not grant paid credits to a legacy account first created by a canceled checkout', async () => {
    const checkout = { eventId: `${prefix}-legacy-canceled-checkout`, eventType: 'checkout.session.completed', livemode: false,
      email: email('legacy-canceled'), studentKey: `student_${crypto.randomUUID().replace(/-/g, '')}`,
      customerId: `${prefix}-legacy-canceled-customer`, subscriptionId: `${prefix}-legacy-canceled-subscription`, subscriptionStatus: 'canceled',
      priceId: 'price_legacy', plan: 'stupro' as const, monthlyCredits: 250 };
    const result = await fulfillStripeCheckout(db, checkout);
    expect(result.duplicate).toBe(false);
    if (!result.duplicate) {
      expect(result.student.plan).toBe('free');
      expect(await getStudentUsageStatus(db, result.student.id)).toMatchObject({ creditsGranted: 0, creditsRemaining: 0 });
    }
  });
});
