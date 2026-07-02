import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const district = searchParams.get('district');

  const where: Record<string, unknown> = {};
  if (district) {
    where.districtName = district;
  }

  const neighborhoods = await db.neighborhood.findMany({
    where,
    orderBy: { name: 'asc' },
  });

  const result = neighborhoods.map((n) => ({
    name: n.name,
    district_number: n.districtNumber,
    district_name: n.districtName,
    geometry: JSON.parse(n.geometry),
  }));

  const names = neighborhoods.map((n) => ({
    name: n.name,
    district_name: n.districtName,
    district_number: n.districtNumber,
  }));

  return NextResponse.json({ neighborhoods: result, names });
}