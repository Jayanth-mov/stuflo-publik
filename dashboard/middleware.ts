import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Fast cookie-presence redirect for dashboard navigation. The Worker API still
 * validates the hashed session on every protected data request.
 *
 * OpenNext currently requires the Edge-compatible middleware entry point here;
 * Next 16's proxy entry point runs in the unsupported Node middleware runtime.
 */
export function middleware(request: NextRequest) {
  const hasSession = request.cookies.get('__Secure-stuflo.session')?.value;
  if (!hasSession && request.nextUrl.pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/auth/signin', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
