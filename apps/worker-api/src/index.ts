import { getAgentByName } from 'agents';
import { EmailDeliveryError } from '@stuflo/auth';
import {
  updateStudentProfile,
  updateStudentTimeZone,
} from '@stuflo/db';
import type { StufloEnv } from './env';
import {
  errorResponse,
  json,
  readJsonBody,
  RequestInputError,
  validateCanvasConnection,
} from './http';
import {
  checkCanvasConnectionForStudent,
  connectCanvasForStudent,
} from './services/canvas-connections';
import { openDatabase } from './services/database';
import {
  authenticateRequest,
  logout,
} from './services/auth';
import { getUsageStatus } from './services/usage';
import { authOriginAllowed, finishGoogleSignIn, pendingGoogleLink, requestEmailCode, startGoogleSignIn, verifyEmailCode } from './services/passwordless';
import {
  billingSummary,
  createCheckout,
  TrialUnavailableError,
  createPortal,
  handleStripeWebhook,
  publicPlanPricing,
} from './services/billing';
import {
  completeGoogleAuthorization,
  createGoogleAuthorizationUrl,
  googleOAuthErrorCode,
} from './services/google-oauth';
import { checkGoogleConnectionForStudent, disconnectGoogleForStudent } from './services/google-connections';
import {
  deleteAttachment,
  downloadAttachment,
  prepareAttachmentContext,
  uploadAttachment,
} from './services/attachments';
import { addMemory, getPreferences, removeMemory, updatePreferences } from './services/preferences';
import {
  isAdminEmail,
  deleteAdminStudent,
  loadAdminOverview,
  loadAdminStudent,
  loadAdminStudents,
  requireAdmin,
  resolveAdminAlert,
  saveAdminUsageSettings,
} from './services/admin';
import { reportOperationalError } from './services/alerts';
import { canvasStorageResponse } from './services/canvas-storage';
import { getCanvasInitializationOverview } from './services/canvas-initializer';
import { handleAdminModelEval } from './services/model-evals';
import { PublikInputError, PublikPaymentRequiredError } from './model/publik-model-gateway';
import { publikEnabled, type PublikPreferences } from './services/publik';

export { StuAgent } from './agents/stu-agent';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function allowRate(binding: RateLimit | undefined, key: string) {
  if (!binding) return true;
  return (await binding.limit({ key })).success;
}

function requestIp(request: Request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

async function handleApi(request: Request, env: StufloEnv): Promise<Response> {
  const url = new URL(request.url);
  let currentSession: ReturnType<typeof authenticateRequest> | undefined;
  const sessionForRequest = () => currentSession ??= authenticateRequest(request, env);
  if (request.method === 'GET' && url.pathname === '/health') {
    return json({
      ok: true,
      service: 'stuflo-api',
      runtime: 'cloudflare-workers-agents',
      environment: env.ENVIRONMENT,
      capabilities: {
        stuAgent: true,
        canvasAdapter: true,
        agentMemory: true,
        adminOperations: Boolean(env.ADMIN_EMAILS),
        metadataUsageLogs: true,
        costBudgets: true,
        aiConfigured: Boolean(
          env.AI || env.OPENAI_API_KEY || (publikEnabled(env) && env.PUBLIK_APP_TOKEN),
        ),
        publikEnabled: publikEnabled(env),
        aiGatewayMetadataLogs: Boolean(
          env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_TOKEN && env.OPENAI_API_KEY,
        ),
        aiGatewayAuthenticated: Boolean(env.CLOUDFLARE_AI_TOKEN),
        openAiConfigured: Boolean(env.OPENAI_API_KEY),
        hyperdriveConfigured: Boolean(env.HYPERDRIVE),
        attachments: Boolean(env.ATTACHMENTS),
        canvasStorage: Boolean(env.ATTACHMENTS && (env.HYPERDRIVE || env.DATABASE_URL)),
        canvasBrowserFallback: Boolean(env.BROWSER),
        canvasInitializer: Boolean(
          env.ATTACHMENTS && env.StuAgent && (env.HYPERDRIVE || env.DATABASE_URL),
        ),
        authConfigured: Boolean(
          (env.HYPERDRIVE || env.DATABASE_URL) && env.RESEND_API_KEY && env.AUTH_SECRET,
        ),
        emailCodeSignIn: Boolean(env.RESEND_API_KEY && env.AUTH_SECRET),
        googleSignIn: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.AUTH_SECRET),
        freeSignup: true,
        billingConfigured: Boolean(
          (env.HYPERDRIVE || env.DATABASE_URL) &&
            env.STRIPE_SECRET_KEY &&
            env.STRIPE_WEBHOOK_SECRET,
        ),
      },
    });
  }

  if (request.method === 'GET' && url.pathname === '/v1/plans') {
    return json(await publicPlanPricing(env), 200, {
      'cache-control': 'public, max-age=300',
    });
  }

  if (url.pathname.startsWith('/v1/auth/magic/')) {
    return json({ error: 'magic_links_retired', message: 'Sign in with Google or an email code.' }, 410);
  }
  if (request.method === 'GET' && url.pathname === '/v1/auth/options') {
    const pending = await pendingGoogleLink(env, request);
    return json({ googleStartUrl: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? (env.API_ORIGIN || 'https://api.stuflo.com') + '/v1/auth/google/start' : null,
      pendingEmail: pending?.email || null }, 200, { 'cache-control': 'no-store' });
  }
  if (request.method === 'GET' && url.pathname === '/v1/auth/google/start') {
    if (!(await allowRate(env.AUTH_RATE_LIMITER, requestIp(request)))) return json({ error: 'rate_limited' }, 429);
    return startGoogleSignIn(env, request);
  }
  if (request.method === 'POST' && ['/v1/auth/email/request', '/v1/auth/email/verify'].includes(url.pathname)) {
    if (!authOriginAllowed(request, env)) return json({ error: 'invalid_origin' }, 403);
    if (!(await allowRate(env.AUTH_RATE_LIMITER, requestIp(request)))) {
      return json({ error: 'rate_limited', message: 'Too many attempts. Please wait a minute.' }, 429);
    }
    const body = await readJsonBody<{ email?: unknown; code?: unknown; challengeId?: unknown }>(request, 4096);
    if (url.pathname.endsWith('/request')) {
      const result = await requestEmailCode(env, body.email);
      if (result.status === 'invalid_email') return json({ error: result.status, message: 'Enter a valid email address.' }, 400);
      if (result.status === 'rate_limited') return json({ error: result.status, message: 'Please wait before requesting another code. Too many requests today may require a longer wait.' }, 429);
      return json({ ok: true, challengeId: result.challengeId }, 202, { 'cache-control': 'no-store' });
    }
    const result = await verifyEmailCode(env, request, body);
    if (!result) return json({ error: 'invalid_code', message: 'That code is incorrect, expired, or has reached its attempt limit. Request a new code if needed.' }, 400);
    const response = json({ ok: true }, 200, { 'cache-control': 'no-store', 'set-cookie': result.cookie });
    response.headers.append('set-cookie', result.clearLinkCookie);
    return response;
  }
  if (request.method === 'GET' && url.pathname === '/v1/auth/session') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    return json({
      user: {
        email: session.email,
        name: session.name,
        studentKey: session.studentKey,
        timeZone: session.timeZone,
        plan: session.plan,
        isAdmin: isAdminEmail(session.email, env),
      },
      expiresAt: session.sessionExpiresAt,
    });
  }
  if (request.method === 'POST' && url.pathname === '/v1/auth/logout') {
    return json({ ok: true }, 200, { 'set-cookie': await logout(request, env) });
  }
  if (url.pathname.startsWith('/v1/publik/')) {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!publikEnabled(env)) return json({ state: 'disabled' });
    const agent = await getAgentByName(env.StuAgent, session.studentKey);
    if (request.method === 'GET' && url.pathname === '/v1/publik/status') {
      const state = await agent.publikStatus(session.userId, true);
      const stuPro = session.plan === 'stupro';
      if (state.state === 'ready' && state.provider === 'stuflo' && !stuPro) {
        return json({ ...state, state: 'choose', provider: undefined, stuPro });
      }
      return json({ ...state, stuPro });
    }
    if (request.method === 'POST' && ['/v1/publik/preferences', '/v1/publik/activity'].includes(url.pathname)) {
      if (!authOriginAllowed(request, env)) return json({ error: 'invalid_origin' }, 403);
      if (url.pathname.endsWith('/activity')) {
        if (request.headers.get('dnt') !== '1' && request.headers.get('sec-gpc') !== '1') await agent.publikActivity();
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      }
      const { provider, ownKey, usage } = await readJsonBody<Record<string, unknown>>(request, 2_048);
      const prefs: PublikPreferences = {};
      if (provider === 'publik' || provider === 'own' || (provider === 'stuflo' && session.plan === 'stupro')) prefs.provider = provider;
      else if (provider !== undefined) throw new RequestInputError('Choose Publik or your own OpenAI key.');
      if (ownKey !== undefined) {
        if (provider !== 'own' || typeof ownKey !== 'string' || !/^sk-[A-Za-z0-9_-]{10,400}$/.test(ownKey.trim())) {
          throw new RequestInputError('Enter a valid OpenAI API key.');
        }
        prefs.ownKey = ownKey.trim();
      }
      if (typeof usage === 'boolean') prefs.usage = usage;
      else if (usage !== undefined) throw new RequestInputError('Choose whether to share usage events.');
      const state = await agent.publikPreferences(session.userId, prefs);
      const stuPro = session.plan === 'stupro';
      if (state.state === 'ready' && state.provider === 'stuflo' && !stuPro) {
        return json({ ...state, state: 'choose', provider: undefined, stuPro });
      }
      return json({ ...state, stuPro });
    }
    return json({ error: 'not_found' }, 404);
  }
  if (publikEnabled(env) && url.pathname.startsWith('/v1/')
    && !url.pathname.startsWith('/v1/auth/')
    && !['/v1/billing/webhook', '/v1/connections/google/callback', '/v1/billing/checkout'].includes(url.pathname)) {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const agent = await getAgentByName(env.StuAgent, session.studentKey);
    const state = await agent.publikStatus(session.userId);
    if (state.state !== 'ready' || (state.provider === 'stuflo' && session.plan !== 'stupro')) {
      return json({ error: 'publik_required', message: 'Finish connecting Publik before using StuFlo.' }, 403);
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat' && state.provider === 'publik' && !state.hasPlan) {
      return json({ error: 'publik_payment_required', message: 'Set up a Publik balance to use AI, or choose your own key.', topUpUrl: state.topUpUrl }, 402);
    }
  }
  if (request.method === 'PATCH' && url.pathname === '/v1/account') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const body = await readJsonBody<{ name?: unknown }>(request, 4_096);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return json({ error: 'invalid_name' }, 400);
    const opened = openDatabase(env);
    try {
      const user = await updateStudentProfile(opened.db, { userId: session.userId, name });
      if (!user) return json({ error: 'account_not_found' }, 404);
      return json({ ok: true, name: user.name, email: user.email, plan: session.plan });
    } finally {
      await opened.close();
    }
  }
  if (request.method === 'POST' && url.pathname === '/v1/account/timezone') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const body = await readJsonBody<{ timeZone?: unknown }>(request, 4_096);
    const timeZone = typeof body.timeZone === 'string' ? body.timeZone.trim() : '';
    try {
      if (!timeZone || timeZone.length > 64) throw new Error('invalid');
      new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    } catch {
      return json({ error: 'invalid_timezone' }, 400);
    }
    const opened = openDatabase(env);
    try {
      const student = await updateStudentTimeZone(opened.db, {
        userId: session.userId,
        timeZone,
      });
      if (!student) return json({ error: 'account_not_found' }, 404);
      return json({ ok: true, timeZone: student.timeZone });
    } finally {
      await opened.close();
    }
  }
  if (request.method === 'GET' && url.pathname === '/v1/usage/status') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const status = await getUsageStatus(env, session.studentKey);
    if (!status) throw new Error('Postgres/Hyperdrive is not configured.');
    return json({
      plan: status.student.plan,
      period: new Date().toISOString().slice(0, 7),
      planCredits: status.planCredits,
      creditsGranted: status.creditsGranted,
      creditsUsed: status.creditsUsed,
      creditsRemaining: status.creditsRemaining,
      warningLevel: status.warningLevel,
      isExhausted: status.isExhausted,
      recentEvents: status.recentEvents,
    });
  }
  if (request.method === 'POST' && url.pathname === '/v1/billing/webhook') {
    return json({ ok: true, result: await handleStripeWebhook(request, env) });
  }
  if (request.method === 'GET' && url.pathname === '/v1/billing/summary') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const summary = await billingSummary(env, session.userId);
    return json({
      plan: session.plan,
      subscriptions: summary.subscriptions,
      hasStripeCustomer: Boolean(summary.stripeCustomerId),
      invoices: summary.invoices,
    });
  }
  if (request.method === 'POST' && url.pathname === '/v1/billing/checkout') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const body = await readJsonBody<{ plan?: unknown; interval?: unknown; trial?: unknown }>(request, 4_096);
    if (body.plan !== 'stupro') {
      return json({ error: 'invalid_plan' }, 400);
    }
    if (body.interval !== 'monthly' && body.interval !== 'yearly') {
      return json({ error: 'invalid_interval' }, 400);
    }
    if (body.trial !== undefined && typeof body.trial !== 'boolean') {
      return json({ error: 'invalid_trial' }, 400);
    }
    try { return json(await createCheckout(env, {
      userId: session.userId,
      plan: body.plan,
      interval: body.interval,
      trial: body.trial === true,
    })); } catch (error) {
      if (error instanceof TrialUnavailableError) return json({ error: 'trial_unavailable', message: error.message }, 409);
      throw error;
    }
  }
  if (request.method === 'POST' && url.pathname === '/v1/billing/portal') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    return json(await createPortal(env, session.userId));
  }
  if (request.method === 'POST' && url.pathname === '/v1/chat') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!(await allowRate(env.CHAT_RATE_LIMITER, session.userId))) {
      return json({ error: 'rate_limited', message: 'Chat limit reached. Try again shortly.' }, 429);
    }
    const body = await readJsonBody<{
      message?: unknown;
      attachments?: unknown;
      assistantMessageId?: unknown;
    }>(request, 64_000);
    if (typeof body.message !== 'string') return json({ error: 'message_required' }, 400);
    if (body.message.trim().length > 20_000) return json({ error: 'message_too_long', message: 'Messages must be at most 20,000 characters.' }, 400);
    let prepared;
    try {
      prepared = await prepareAttachmentContext(env, session, body.attachments);
    } catch (error) {
      return json({
        error: 'invalid_attachments',
        message: error instanceof Error ? error.message : 'Attachments are invalid.',
      }, 400);
    }
    if ((!body.message.trim() && !prepared.context.trim()) || prepared.context.length > 60_000) {
      return json({ error: 'invalid_message', message: 'Send a message or a valid attachment.' }, 400);
    }
    const agent = await getAgentByName(env.StuAgent, session.studentKey);
    if ((request.headers.get('accept') || '').includes('text/plain')) {
      const stream = await agent.chatStream({
        message: body.message,
        attachmentContext: prepared.context,
        assistantMessageId:
          typeof body.assistantMessageId === 'string' ? body.assistantMessageId : undefined,
      });
      return new Response(stream, {
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    const result = await agent.chat({
      message: body.message,
      attachmentContext: prepared.context,
      assistantMessageId:
        typeof body.assistantMessageId === 'string' ? body.assistantMessageId : undefined,
    });
    return json({ ...result, attachments: prepared.attachments });
  }
  if (request.method === 'GET' && url.pathname === '/v1/chat/history') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 50;
    const agent = await getAgentByName(env.StuAgent, session.studentKey);
    return json({ messages: await agent.history(limit) });
  }
  if (request.method === 'POST' && url.pathname === '/v1/attachments') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!(await allowRate(env.UPLOAD_RATE_LIMITER, session.userId))) {
      return json({ error: 'rate_limited', message: 'Upload limit reached. Try again shortly.' }, 429);
    }
    return uploadAttachment(request, env, session);
  }
  if (request.method === 'GET' && url.pathname === '/v1/storage') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    return canvasStorageResponse(env, session.studentId);
  }
  if (url.pathname === '/v1/canvas/initialization' && request.method === 'GET') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    return json(await getCanvasInitializationOverview(env, session.studentKey));
  }
  if (url.pathname === '/v1/canvas/initialization' && request.method === 'POST') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const agent = await getAgentByName(env.StuAgent, session.studentKey);
    return json(await agent.initializeCanvas('manual', true), 202);
  }
  const attachmentMatch = url.pathname.match(/^\/v1\/attachments\/([^/]+)$/);
  if (attachmentMatch && request.method === 'GET') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    return downloadAttachment(env, session, attachmentMatch[1]!);
  }
  if (attachmentMatch && request.method === 'DELETE') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    return deleteAttachment(env, session, attachmentMatch[1]!);
  }
  if (request.method === 'GET' && url.pathname === '/v1/connections/status') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const opened = openDatabase(env);
    try {
      const [canvas, google] = await Promise.all([
        checkCanvasConnectionForStudent(opened.db, env, session.studentKey),
        checkGoogleConnectionForStudent(opened.db, env, session.studentKey, url.searchParams.get('verify') === 'google'),
      ]);
      return json({
        canvas,
        googleCalendar: google,
      });
    } finally {
      await opened.close();
    }
  }
  if (request.method === 'POST' && url.pathname === '/v1/connections/canvas') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const body = await readJsonBody<{ canvasConnection?: unknown }>(request, 128_000);
    const connection = validateCanvasConnection(body.canvasConnection);
    const opened = openDatabase(env);
    let connected;
    try {
      connected = await connectCanvasForStudent(opened.db, env, session.studentKey, connection);
    } finally {
      await opened.close();
    }
    let initialization: unknown = null;
    try {
      const agent = await getAgentByName(env.StuAgent, session.studentKey);
      initialization = await agent.initializeCanvas('canvas_connected', false);
    } catch (error) {
      initialization = {
        queued: false,
        error: error instanceof Error ? error.message.slice(0, 500) : 'Initialization could not be scheduled.',
      };
    }
    return json({ ...connected, initialization });
  }
  if (request.method === 'DELETE' && url.pathname === '/v1/connections/google') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const opened = openDatabase(env);
    try {
      return json(await disconnectGoogleForStudent(opened.db, session.studentKey));
    } finally {
      await opened.close();
    }
  }
  if (request.method === 'GET' && url.pathname === '/v1/connections/google/start') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    return json({ authorizationUrl: await createGoogleAuthorizationUrl(env, session.studentKey) });
  }
  if (request.method === 'GET' && url.pathname === '/v1/connections/google/callback') {
    if (url.searchParams.get('state')?.startsWith('login.')) return finishGoogleSignIn(env, request);
    const appOrigin = env.APP_ORIGIN || 'https://app.stuflo.com';
    const session = await sessionForRequest();
    if (!session) {
      return Response.redirect(`${appOrigin}/dashboard/connections?google=error&reason=session`, 303);
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (url.searchParams.has('error')) {
      return Response.redirect(`${appOrigin}/dashboard/connections?google=cancelled`, 303);
    }
    if (!code || !state) {
      return Response.redirect(`${appOrigin}/dashboard/connections?google=error`, 303);
    }
    try {
      await completeGoogleAuthorization(env, {
        code,
        state,
        authenticatedStudentKey: session.studentKey,
      });
      return Response.redirect(`${appOrigin}/dashboard/connections?google=connected`, 303);
    } catch (error) {
      const reason = googleOAuthErrorCode(error);
      console.error('Google OAuth callback failed.', {
        reason,
        message: error instanceof Error ? error.message : 'unknown',
      });
      return Response.redirect(`${appOrigin}/dashboard/connections?google=error&reason=${reason}`, 303);
    }
  }

  if (request.method === 'GET' && url.pathname === '/v1/preferences') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const result = await getPreferences(env, session.studentKey);
    return result ? json(result) : json({ error: 'account_not_found' }, 404);
  }
  if (request.method === 'PATCH' && url.pathname === '/v1/preferences') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const body = await readJsonBody<Record<string, unknown>>(request, 32_000);
    const result = await updatePreferences(env, session.studentKey, body);
    return result ? json({ profile: result }) : json({ error: 'account_not_found' }, 404);
  }
  if (request.method === 'POST' && url.pathname === '/v1/memories') {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    const body = await readJsonBody<Record<string, unknown>>(request, 8_000);
    const memory = await addMemory(env, session.studentKey, body);
    return memory ? json({ memory }, 201) : json({ error: 'account_not_found' }, 404);
  }
  const memoryMatch = url.pathname.match(/^\/v1\/memories\/([^/]+)$/);
  if (request.method === 'DELETE' && memoryMatch) {
    const session = await sessionForRequest();
    if (!session) return json({ error: 'unauthorized' }, 401);
    if (!UUID_PATTERN.test(memoryMatch[1]!)) return json({ error: 'invalid_memory_id' }, 400);
    const result = await removeMemory(env, session.studentKey, memoryMatch[1]!);
    return result ? json({ ok: true }) : json({ error: 'memory_not_found' }, 404);
  }

  if (url.pathname.startsWith('/v1/admin/')) {
    const authorization = requireAdmin(await sessionForRequest(), env);
    if ('error' in authorization) return json({ error: authorization.error }, authorization.status);
    const adminSession = authorization.session;
    if (!(await allowRate(env.ADMIN_RATE_LIMITER, adminSession.userId))) {
      return json({ error: 'rate_limited', message: 'Admin request limit reached.' }, 429);
    }
    if (request.method === 'GET' && url.pathname === '/v1/admin/overview') {
      return json(await loadAdminOverview(env));
    }
    if (request.method === 'GET' && url.pathname === '/v1/admin/students') {
      const requestedPage = Number(url.searchParams.get('page') || 1);
      const page = Number.isFinite(requestedPage) ? Math.max(1, Math.trunc(requestedPage)) : 1;
      return json(await loadAdminStudents(env, url.searchParams.get('q') || undefined, page));
    }
    if (request.method === 'POST' && url.pathname === '/v1/admin/model-evals') {
      if (!(await allowRate(env.CHAT_RATE_LIMITER, `model-eval:${adminSession.userId}`))) {
        return json({ error: 'rate_limited', message: 'Model evaluation limit reached.' }, 429);
      }
      const body = await readJsonBody<Record<string, unknown>>(request, 1_000);
      const result = await handleAdminModelEval(env, adminSession, body);
      return json(result.body, result.status);
    }
    if (request.method === 'PATCH' && url.pathname === '/v1/admin/usage-settings') {
      const body = await readJsonBody<Record<string, unknown>>(request, 16_000);
      const result = await saveAdminUsageSettings(env, adminSession, body);
      return json({ settings: result?.value, updatedAt: result?.updatedAt });
    }
    const alertMatch = url.pathname.match(/^\/v1\/admin\/alerts\/([^/]+)\/resolve$/);
    if (request.method === 'POST' && alertMatch) {
      if (!UUID_PATTERN.test(alertMatch[1]!)) return json({ error: 'invalid_alert_id' }, 400);
      const result = await resolveAdminAlert(env, adminSession, alertMatch[1]!);
      return result ? json({ ok: true }) : json({ error: 'alert_not_found' }, 404);
    }
    const studentMatch = url.pathname.match(
      /^\/v1\/admin\/students\/(student_[a-zA-Z0-9_-]{6,80})(?:\/(chat|export))?$/,
    );
    if (request.method === 'DELETE' && studentMatch && !studentMatch[2]) {
      const body = await readJsonBody<{ confirmationEmail?: unknown }>(request, 4_000);
      if (typeof body.confirmationEmail !== 'string') {
        return json({ error: 'confirmation_required' }, 400);
      }
      const result = await deleteAdminStudent(
        env,
        adminSession,
        studentMatch[1]!,
        body.confirmationEmail,
      );
      if ('error' in result) {
        return json(
          { error: result.error },
          result.error === 'student_not_found' ? 404 : 409,
        );
      }
      return json(result);
    }
    if (request.method === 'GET' && studentMatch) {
      const studentKey = studentMatch[1]!;
      const operation = studentMatch[2];
      const detail = await loadAdminStudent(
        env,
        adminSession,
        studentKey,
        operation === 'chat'
          ? 'admin.chat.view'
          : operation === 'export'
            ? 'admin.student.export'
            : 'admin.student.view',
      );
      if (!detail) return json({ error: 'student_not_found' }, 404);
      if (!operation) return json(detail);
      const agent = await getAgentByName(env.StuAgent, studentKey);
      const messages = await agent.history(operation === 'export' ? 1_000 : 200);
      if (operation === 'chat') return json({ student: detail.student, messages });
      return json(
        {
          format: 'stuflo-student-export-v1',
          exportedAt: new Date().toISOString(),
          student: detail.student,
          profile: detail.profile,
          memories: detail.memories,
          connections: {
            canvas: {
              status: detail.student.canvasStatus,
              host: detail.student.canvasHost,
              updatedAt: detail.student.canvasUpdatedAt,
            },
            google: {
              status: detail.student.googleStatus,
              email: detail.student.googleEmail,
              updatedAt: detail.student.googleUpdatedAt,
            },
          },
          subscriptions: detail.subscriptions,
          usageEvents: detail.usageEvents,
          messages,
          exclusions: [
            'authentication tokens',
            'session hashes',
            'Canvas cookies',
            'Google OAuth tokens',
            'Stripe secrets',
            'attachment bodies',
          ],
        },
        200,
        { 'content-disposition': `attachment; filename="${studentKey}-stuflo-export.json"` },
      );
    }
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request: Request, env: StufloEnv, context: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS' && url.pathname.startsWith('/v1/')) {
        return withCors(request, env, new Response(null, { status: 204 }));
      }
      return withCors(request, env, await handleApi(request, env));
    } catch (error) {
      // Database errors may include bound parameters. Never log authentication inputs or hashes.
      const path = new URL(request.url).pathname;
      if ((path.startsWith('/v1/auth/') || path.startsWith('/v1/publik/'))
        && !(error instanceof EmailDeliveryError) && !(error instanceof RequestInputError)) {
        error = new Error('Authentication request failed.');
      }
      const response = error instanceof PublikPaymentRequiredError
        ? json({ error: 'publik_payment_required', message: error.message, topUpUrl: error.topUpUrl }, 402)
        : error instanceof PublikInputError ? json({ error: error.code, message: error.message }, error.status) : errorResponse(error);
      if (response.status === 500 || error instanceof EmailDeliveryError) {
        const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
        const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
        const causeName = cause && typeof cause === 'object' && 'name' in cause ? String(cause.name) : undefined;
        const causeCode = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined;
        const causeMessage =
          cause && typeof cause === 'object' && 'message' in cause ? String(cause.message).slice(0, 500) : undefined;
        console.error('Unhandled Worker request error.', {
          requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
          causeName,
          causeCode,
          causeMessage,
        });
        context.waitUntil(
          reportOperationalError(env, request, error).catch((reportingError) =>
            console.error(
              'Operational error reporting failed.',
              reportingError instanceof Error ? reportingError.message : 'unknown',
            ),
          ),
        );
      }
      return withCors(request, env, response);
    }
  },
} satisfies ExportedHandler<StufloEnv>;

function withCors(request: Request, env: StufloEnv, response: Response): Response {
  const origin = request.headers.get('origin');
  if (!origin || !env.APP_ORIGIN || origin !== new URL(env.APP_ORIGIN).origin) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-credentials', 'true');
  headers.set('access-control-allow-headers', 'accept,content-type,dnt,sec-gpc');
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  headers.append('vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
