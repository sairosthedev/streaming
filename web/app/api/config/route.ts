import { NextResponse } from 'next/server';
import { isAuthenticated, passwordRequired } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    requiresPassword: passwordRequired(),
    authenticated: await isAuthenticated(),
  });
}
