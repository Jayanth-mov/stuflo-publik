import { proxyWorkerRequest } from '@/lib/worker-api';

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxyWorkerRequest(request, `/v1/${path.map(encodeURIComponent).join('/')}`);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
