import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), redirect: vi.fn() }));
vi.mock('../../../dashboard/lib/worker-api', () => ({ workerApiFetch: mocks.fetch }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
import { requireDashboardSession } from '../../../dashboard/lib/dashboard-session';

describe('protected dashboard session', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.redirect.mockImplementation(() => { throw new Error('NEXT_REDIRECT'); });
  });

  it('allows a session validated by the API', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ user: { studentKey: 'student_test' } }));
    expect(await requireDashboardSession()).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledWith('/v1/auth/session');
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('redirects rejected sessions without swallowing the Next redirect', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ error: 'unauthorized' }, { status: 401 }));
    await expect(requireDashboardSession()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/auth/signin');
  });

  it('offers a retry rather than signing out during an API outage', async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await requireDashboardSession()).toBe(false);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('offers a retry rather than signing out on network failure', async () => {
    mocks.fetch.mockRejectedValue(new TypeError('fetch failed'));
    expect(await requireDashboardSession()).toBe(false);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('does not render protected content for a malformed success response', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ user: null }));
    expect(await requireDashboardSession()).toBe(false);
    expect(mocks.redirect).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValue(new Response('not JSON', { status: 200 }));
    expect(await requireDashboardSession()).toBe(false);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
