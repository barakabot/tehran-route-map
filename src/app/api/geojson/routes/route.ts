import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const route = searchParams.get('route');
  const search = searchParams.get('search');
  const mismatch = searchParams.get('mismatch') === 'true';

  const where: Record<string, unknown> = {};

  if (route) {
    where.currentRoute = route;
  }

  if (mismatch) {
    where.routeChange = { not: '' };
    // Also need to exclude 'بدون تغییر'
  }

  if (search) {
    where.OR = [
      { customerName: { contains: search } },
      { address: { contains: search } },
      { sellerName: { contains: search } },
    ];
  }

  const customers = await db.customer.findMany({
    where,
    select: {
      id: true,
      customerName: true,
      sellerName: true,
      currentRoute: true,
      blockName: true,
      routeChange: true,
      address: true,
      source: true,
      lat: true,
      lng: true,
      isNew: true,
    },
  });

  // Client-side mismatch filter (SQLite doesn't have regex)
  const filtered = mismatch
    ? customers.filter((c) => c.routeChange && c.routeChange !== 'بدون تغییر')
    : customers;

  return NextResponse.json({ customers: filtered });
}