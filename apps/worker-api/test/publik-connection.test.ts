import { generateEncodedAesKey } from '@stuflo/crypto';
import { describe, expect, it, vi } from 'vitest';
import type { StufloEnv } from '../src/env';
import { PublikConnectionService, publikInstallId, publikLink } from '../src/services/publik';

function setup() {
  const credential = ['pk', 'testinstallcredential'].join('_');
  const ownKey = ['sk', 'exampletestonlynoncredential'].join('-');
  const rows = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => rows.get(key),
    put: async (key: string, data: unknown) => { rows.set(key, data); },
    delete: async (key: string) => rows.delete(key),
  } as unknown as DurableObjectStorage;
  const env = {
    PUBLIK_ENABLED: 'true',
    PUBLIK_APP_TOKEN: ['pat', 'fixture'].join('_'),
    PUBLIK_INSTALL_SECRET: 'test secret test secret test secret',
    COOKIE_ENCRYPTION_KEYS: JSON.stringify({ test: generateEncodedAesKey() }),
    ACTIVE_COOKIE_ENCRYPTION_KEY_ID: 'test',
  } as StufloEnv;
  let now = 1_800_000_000_000;
  const advance = (amount: number) => { now += amount; };
  const stub = vi.fn<typeof fetch>();
  const service = new PublikConnectionService(env, storage, stub, () => now);
  const claimUrl = 'https://publikhq.com/claim/demo';
  const wallet = { claim_state: 'claimed', plan: { kind: 'plan' }, balance_micros: 100, remaining_percent: 83 };
  return { service, env, stub, rows, credential, ownKey, claimUrl, wallet, advance };
}

describe('Publik hosted connection', () => {
  it('provisions only from the gate and never returns or stores a plaintext key', async () => {
    const t = setup();
    await expect(t.service.status('account-a', false)).resolves.toMatchObject({ state: 'unreachable' });
    expect(t.stub).not.toHaveBeenCalled();
    t.stub.mockResolvedValueOnce(Response.json({ key: t.credential, claim_url: t.claimUrl }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ claim_state: 'anonymous', claim_url: t.claimUrl }));
    await expect(t.service.status('account-a', true)).resolves.toEqual({ state: 'sign_in', claimUrl: t.claimUrl });
    const install = JSON.parse(String(t.stub.mock.calls[0]?.[1]?.body));
    expect(install).toMatchObject({ os: 'web', app_slug: 'stuflo', dialects: ['responses'] });
    expect(install).not.toHaveProperty('userId');
    expect(JSON.stringify([...t.rows])).not.toContain(t.credential);
    await expect(t.service.resolve()).resolves.toBeNull();
  });

  it('requires a claim and an explicit funding choice, and sends only metadata for opted-in activity', async () => {
    const t = setup();
    t.stub.mockResolvedValueOnce(Response.json({ key: t.credential }, { status: 201 }))
      .mockResolvedValueOnce(Response.json(t.wallet));
    await expect(t.service.status('account-a', true)).resolves.toMatchObject({ state: 'choose', remainingPercent: 83 });
    await expect(t.service.resolve()).resolves.toBeNull();
    await expect(t.service.preferences('account-a', { provider: 'own', ownKey: t.ownKey, usage: false }))
      .resolves.toMatchObject({ state: 'ready', provider: 'own', usage: false });
    expect(JSON.stringify([...t.rows])).not.toContain(t.ownKey);
    await expect(t.service.resolve()).resolves.toEqual({ provider: 'own', apiKey: t.ownKey });
    await t.service.activity();
    expect(t.stub).toHaveBeenCalledTimes(2);
    await t.service.preferences('account-a', { provider: 'publik', usage: true });
    t.stub.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await t.service.activity();
    const event = JSON.parse(String(t.stub.mock.calls[2]?.[1]?.body));
    expect(event).toEqual({ v: 1, app: 'stuflo', os: 'web', app_version: '0.1.0', event: 'app_opened', install_id: expect.any(String) });
    await t.service.activity();
    expect(t.stub).toHaveBeenCalledTimes(3);
    await t.service.remove();
    await expect(t.service.resolve()).resolves.toBeNull();
  });

  it('fails closed after revocation, preserves known claims during outages, and keeps IDs distinct', async () => {
    const t = setup();
    const id = await publikInstallId(t.env.PUBLIK_INSTALL_SECRET!, 'account-a', 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(publikInstallId(t.env.PUBLIK_INSTALL_SECRET!, 'account-a', 0)).resolves.toBe(id);
    await expect(publikInstallId(t.env.PUBLIK_INSTALL_SECRET!, 'account-b', 0)).resolves.not.toBe(id);
    t.stub.mockResolvedValueOnce(Response.json({ key: t.credential }, { status: 201 }))
      .mockResolvedValueOnce(Response.json(t.wallet));
    await t.service.status('account-a', true);
    await t.service.preferences('account-a', { provider: 'publik' });
    t.advance(11 * 60_000);
    t.stub.mockRejectedValueOnce(new TypeError('offline'));
    await expect(t.service.status('account-a', false)).resolves.toMatchObject({ state: 'ready' });
    t.stub.mockResolvedValueOnce(Response.json({ error: { type: 'key_revoked' } }, { status: 401 }));
    await expect(t.service.status('account-a', false)).resolves.toMatchObject({ state: 'unreachable' });
    await expect(t.service.resolve()).resolves.toBeNull();
    expect(publikLink('https://publikhq.com.evil.example/claim')).toBeNull();
  });
});
