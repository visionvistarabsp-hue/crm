import { NextResponse } from 'next/server';
import { processDueJobs } from '@/lib/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Internal: drains the background job queue (cron-invoked).
export async function GET() {
  try {
    const processed = await processDueJobs(25);
    return NextResponse.json({ ok: true, processed });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

export const POST = GET;