export type PublikStatus =
  | { state: 'disabled' | 'unreachable' }
  | { state: 'sign_in'; claimUrl: string | null }
  | {
    state: 'choose' | 'ready';
    topUpUrl: string | null;
    hasPlan: boolean;
    provider?: 'publik' | 'own' | 'stuflo';
    usage: boolean;
    stuPro: boolean;
    aiProviders: string[];
    remainingPercent: number | null;
  };

/** Links leave StuFlo, so allow only Publik's HTTPS origin. */
export function publikLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://publikhq.com' && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function parsePublikStatus(value: unknown): PublikStatus {
  if (!value || typeof value !== 'object') return { state: 'unreachable' };
  const item = value as Record<string, unknown>;
  switch (item.state) {
    case 'disabled':
    case 'unreachable':
      return { state: item.state };
    case 'sign_in': {
      const claimUrl = publikLink(item.claimUrl);
      return claimUrl ? { state: 'sign_in', claimUrl } : { state: 'unreachable' };
    }
    case 'choose':
    case 'ready':
      return {
        state: item.state,
        topUpUrl: publikLink(item.topUpUrl),
        hasPlan: item.hasPlan === true,
        provider: item.provider === 'publik' || item.provider === 'own' || item.provider === 'stuflo' ? item.provider : undefined,
        usage: item.usage !== false,
        stuPro: item.stuPro === true,
        aiProviders: Array.isArray(item.aiProviders) ? item.aiProviders.filter((value): value is string => typeof value === 'string').slice(0, 10) : [],
        remainingPercent: typeof item.remainingPercent === 'number' && item.remainingPercent >= 0 && item.remainingPercent <= 100 ? item.remainingPercent : null,
      };
    default:
      return { state: 'unreachable' };
  }
}
