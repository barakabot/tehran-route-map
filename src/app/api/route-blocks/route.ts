import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  const routes = await db.route.findMany({
    where: { geometry: { not: '' } },
    select: {
      name: true,
      geometry: true,
      customerCount: true,
      coreCustomerCount: true,
      outlierCount: true,
      salesOffice: true,
      distributionCenter: true,
    },
    orderBy: { name: 'asc' },
  });

  const routeBlocks = routes.map((r) => ({
    name: r.name,
    geometry: JSON.parse(r.geometry),
    customerCount: r.customerCount,
    coreCustomerCount: r.coreCustomerCount,
    outlierCount: r.outlierCount,
    salesOffice: r.salesOffice,
    distributionCenter: r.distributionCenter,
  }));

  return NextResponse.json({ routeBlocks });
}