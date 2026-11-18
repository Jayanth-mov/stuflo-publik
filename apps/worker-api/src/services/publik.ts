import { WebCryptoKeyring, type EncryptedEnvelope } from '@stuflo/crypto';
import type { StufloEnv } from '../env';

export const APP_SLUG = "stuflo-publik";
const APP_VERSION = '0.1.0';
const ORIGIN = 'https://publikhq.com';
const RECHECK = 10 * 60_000;
const INTERVAL = 30 * 60_000;
const UNREACHABLE = 'publik is not reachable. Check your connection.';
const STORAGE_KEY = 'publik-install-v1';

type Provider = 'publik' | 'own' | 'stuflo';
export type PublikStatus =
  | { state: 'disabled' }
  | { state: 'unreachable'; message: string }
  | { state: 'sign_in'; claimUrl: string }
  | { state: 'choose' | 'ready'; provider?: Provider; usage: boolean; hasPlan: boolean; topUpUrl: string | null; aiProviders: string[]; remainingPercent: number | null };
export type PublikPreferences = { provider?: Provider; ownKey?: string; usage?: boolean };
type Connection = {
  installId: string; key: string; generation: number; claimed: boolean; checkedAt: number;
  claimUrl: string | null; topUpUrl: string | null; hasPlan: boolean; aiProviders: string[];
  remainingPercent: number | null;
  provider?: Provider; ownKey?: string; usage?: boolean; seenAt?: number; eventAt?: number;
};

type Wallet = {
  claim_state?: string; claim_url?: unknown; top_up_url?: unknown; ai_providers?: unknown;
  plan?: { kind?: string }; balance_micros?: number; used_percent?: unknown; remaining_percent?: unknown;
  prepaid_remaining_percent?: unknown; error?: { type?: string };
};

export function publikEnabled(env: Pick<StufloEnv, 'PUBLIK_ENABLED'>) {
  return env.PUBLIK_ENABLED === 'true';
}

export function publikLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value);
    return u.origin === ORIGIN && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

export async function publikInstallId(secret: string, userId: string, generation: number) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${APP_SLUG}\n${userId}\n${generation}`)));
  mac[6] = (mac[6]! & 0x0f) | 0x40;
  mac[8] = (mac[8]! & 0x3f) | 0x80;
  const h = Array.from(mac.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Storage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;

export class PublikConnectionService {
  constructor(private env: StufloEnv, private storage: Storage, private request = fetch, private now = Date.now) {}

  private keyring() {
    return WebCryptoKeyring.fromJson(this.env.COOKIE_ENCRYPTION_KEYS || '');
  }

  private async read() {
    const envelope = await this.storage.get<EncryptedEnvelope>(STORAGE_KEY);
    return envelope ? this.keyring().decryptJson<Connection>(envelope) : undefined;
  }

  private async save(record: Connection) {
    const keyId = this.env.ACTIVE_COOKIE_ENCRYPTION_KEY_ID;
    if (!keyId) throw new Error('Publik connection encryption is not configured.');
    const encrypted = await this.keyring().encryptJson(record, keyId);
    await this.storage.put(STORAGE_KEY, encrypted);
  }

  async remove() { await this.storage.delete(STORAGE_KEY); }

  private async provision(userId: string, from: number, usage?: boolean) {
    const secret = this.env.PUBLIK_INSTALL_SECRET;
    const token = this.env.PUBLIK_APP_TOKEN;
    if (!secret || secret.length < 32 || !token?.startsWith('pat_')) throw new Error('Publik is not configured.');
    for (let generation = from; generation < from + 4; generation++) {
      const installId = await publikInstallId(secret, userId, generation);
      const response = await this.request(`${ORIGIN}/api/v1/installs`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_token: token, app_slug: APP_SLUG, app_version: APP_VERSION, os: 'web',
          install_id: installId, disclosure_version: 1, dialects: ['responses'] }),
      });
      const body = await response.json().catch(() => null) as { key?: unknown; claim_url?: unknown; error?: { type?: string } } | null;
      if (response.status === 201 && typeof body?.key === 'string' && /^pk_[\x21-\x7e]{8,500}$/.test(body.key)) {
        const next: Connection = { installId, key: body.key, generation, claimed: false, checkedAt: 0,
          claimUrl: publikLink(body.claim_url), topUpUrl: null, hasPlan: false, aiProviders: [], remainingPercent: null, usage };
        await this.save(next);
        return next;
      }
      if (response.status !== 200 && body?.error?.type !== 'install_revoked') break;
    }
    throw new Error('Publik could not provision this account.');
  }

  private publicState(record: Connection): PublikStatus {
    if (!record.claimed) {
      return record.claimUrl
        ? { state: 'sign_in', claimUrl: record.claimUrl }
        : { state: 'unreachable', message: UNREACHABLE };
    }
    return { state: record.provider ? 'ready' : 'choose', provider: record.provider, usage: record.usage !== false,
      hasPlan: record.hasPlan, topUpUrl: record.topUpUrl, aiProviders: record.aiProviders, remainingPercent: record.remainingPercent };
  }

  async status(userId: string, allowProvision: boolean): Promise<PublikStatus> {
    if (!publikEnabled(this.env)) return { state: 'disabled' };
    let record: Connection | undefined;
    try {
      record = await this.read();
      if (!record && !allowProvision) return { state: 'unreachable', message: UNREACHABLE };
      record ??= await this.provision(userId, 0);
      const freshness = record.claimed && record.provider && record.hasPlan ? RECHECK : 2_500;
      if (this.now() - record.checkedAt < freshness) return this.publicState(record);
      const response = await this.request(`${ORIGIN}/api/v1/wallet`, {
        headers: { authorization: `Bearer ${record.key}` }, redirect: 'error', signal: AbortSignal.timeout(6_000),
      });
      const wallet = await response.json().catch(() => null) as Wallet | null;
      if ((response.status === 401 || response.status === 403) && typeof wallet?.error?.type === 'string') {
        const generation = record.generation + 1, usage = record.usage;
        record = { ...record, claimed: false, provider: undefined, ownKey: undefined, claimUrl: null, checkedAt: 0 };
        await this.save(record);
        if (!allowProvision) return this.publicState(record);
        record = await this.provision(userId, generation, usage);
        return this.publicState(record);
      }
      if (!response.ok || !wallet || !['claimed', 'anonymous'].includes(wallet.claim_state || '')) {
        return record.claimed ? this.publicState(record) : { state: 'unreachable', message: UNREACHABLE };
      }
      const claimed = wallet.claim_state === 'claimed';
      const percent = wallet.remaining_percent ?? wallet.prepaid_remaining_percent;
      record = {
        ...record, claimed, checkedAt: this.now(),
        claimUrl: claimed ? null : publikLink(wallet.claim_url) || record.claimUrl,
        hasPlan: (Boolean(wallet.plan?.kind) && wallet.plan?.kind !== 'none') || (wallet.balance_micros ?? 0) > 0,
        topUpUrl: publikLink(wallet.top_up_url),
        aiProviders: Array.isArray(wallet.ai_providers)
          ? wallet.ai_providers.filter((p): p is string => typeof p === 'string' && /^[a-z0-9 .-]{1,60}$/i.test(p)).slice(0, 10) : [],
        remainingPercent: typeof percent === 'number' && percent >= 0 && percent <= 100 ? percent : null,
      };
      if (!claimed) { delete record.provider; delete record.ownKey; }
      await this.save(record);
      return this.publicState(record);
    } catch {
      return record?.claimed ? this.publicState(record) : { state: 'unreachable', message: UNREACHABLE };
    }
  }

  async preferences(userId: string, prefs: PublikPreferences): Promise<PublikStatus> {
    const status = await this.status(userId, false);
    if (status.state !== 'choose' && status.state !== 'ready') return status;
    const record = await this.read();
    if (!record?.claimed) return { state: 'unreachable', message: UNREACHABLE };
    if (prefs.provider === 'own') {
      if (!prefs.ownKey && !record.ownKey) return this.publicState(record);
      record.ownKey = prefs.ownKey || record.ownKey;
      record.provider = 'own';
    } else if (prefs.provider === 'publik') {
      delete record.ownKey;
      record.provider = 'publik';
    } else if (prefs.provider === 'stuflo') {
      delete record.ownKey;
      record.provider = 'stuflo';
    }
    if (typeof prefs.usage === 'boolean') record.usage = prefs.usage;
    await this.save(record);
    return this.publicState(record);
  }

  async resolve() {
    if (!publikEnabled(this.env)) return null;
    const record = await this.read();
    if (!record?.claimed || !record.provider) return null;
    if (record.provider === 'stuflo') return { provider: 'stuflo' as const };
    if (record.provider === 'own') return record.ownKey ? { provider: 'own' as const, apiKey: record.ownKey } : null;
    return { provider: 'publik' as const, apiKey: record.key };
  }

  async activity() {
    if (!publikEnabled(this.env)) return;
    try {
      const record = await this.read();
      if (!record?.claimed || !record.provider || record.usage === false) return;
      const now = this.now();
      const event = !record.eventAt || now - (record.seenAt || 0) > INTERVAL
        ? 'app_opened' : now - record.eventAt >= INTERVAL ? 'active_session' : null;
      if (event || now - (record.seenAt || 0) >= 60_000) {
        await this.save({ ...record, seenAt: now, eventAt: event ? now : record.eventAt });
      }
      if (event) await this.request(`${ORIGIN}/api/v1/telemetry`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${record.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, app: APP_SLUG, install_id: record.installId, event, app_version: APP_VERSION, os: 'web' }),
      });
    } catch { /* Usage telemetry never blocks the app. */ }
  }
}
