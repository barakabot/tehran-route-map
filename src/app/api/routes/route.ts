import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  const routes = await db.route.findMany({
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  return NextResponse.json({ routes: routes.map((r) => r.name) });
}