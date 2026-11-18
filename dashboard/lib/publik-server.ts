import { cache } from 'react';
import { redirect } from 'next/navigation';
import { parsePublikStatus, type PublikStatus } from './publik';
import { workerApiFetch } from './worker-api';

export const readPublikStatus = cache(async (): Promise<PublikStatus> => {
  const response = await workerApiFetch('/v1/publik/status').catch(() => null);
  if (response?.status === 401) redirect('/auth/signin');
  // Allow a rolling deployment while the old Worker still lacks the route.
  if (response?.status === 404) return { state: 'disabled' };
  if (!response?.ok) return { state: 'unreachable' };
  return parsePublikStatus(await response.json().catch(() => null));
});
