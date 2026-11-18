import { redirect } from 'next/navigation';
import { workerApiFetch } from './worker-api';

/** Validate the session before rendering a protected dashboard request. */
export async function requireDashboardSession(): Promise<boolean> {
  let response: Response;
  try {
    response = await workerApiFetch('/v1/auth/session');
  } catch {
    // A temporary API outage is not evidence that the student signed out.
    return false;
  }

  if (response.status === 401) redirect('/auth/signin');
  if (!response.ok) return false;

  try {
    const session = await response.json() as { user?: { studentKey?: unknown } } | null;
    return typeof session?.user?.studentKey === 'string' && session.user.studentKey.length > 0;
  } catch {
    return false;
  }
}
