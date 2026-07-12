import { NextResponse } from 'next/server';
import { checkPassword, setSessionCookie } from '@/lib/auth';

export async function POST(req: Request) {
  let password: unknown;
  try {
    ({ password } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  if (!checkPassword(password)) {
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 });
  }

  await setSessionCookie();
  return NextResponse.json({ ok: true });
}
