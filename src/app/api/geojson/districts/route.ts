import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  const districts = await db.district.findMany({
    orderBy: { districtNumber: 'asc' },
  });

  const result = districts.map((d) => ({
    name: d.name,
    district_number: d.districtNumber,
    geometry: JSON.parse(d.geometry),
  }));

  const names = districts.map((d) => ({
    name: d.name,
    district_number: d.districtNumber,
  }));

  return NextResponse.json({ districts: result, names });
}