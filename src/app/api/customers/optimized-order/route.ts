import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

function pointInPolygon(x: number, y: number, coordinates: number[][]): boolean {
  let inside = false;
  for (let index = 0, previous = coordinates.length - 1; index < coordinates.length; previous = index++) {
    const [x1, y1] = coordinates[index];
    const [x2, y2] = coordinates[previous];
    if (((y1 > y) !== (y2 > y)) && (x < (x2 - x1) * (y - y1) / (y2 - y1) + x1)) {
      inside = !inside;
    }
  }
  return inside;
}

function getBoundingBox(coordinates: number[][]) {
  return coordinates.reduce(
    (box, [lng, lat]) => ({
      minLng: Math.min(box.minLng, lng),
      maxLng: Math.max(box.maxLng, lng),
      minLat: Math.min(box.minLat, lat),
      maxLat: Math.max(box.maxLat, lat),
    }),
    { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity }
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const neighborhoodName = typeof body.neighborhood === 'string' ? body.neighborhood.trim() : '';
    const districtName = typeof body.district === 'string' ? body.district.trim() : '';
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const orderedCustomerIds = Array.isArray(body.orderedCustomerIds)
      ? body.orderedCustomerIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : [];

    if (!neighborhoodName || !source || orderedCustomerIds.length === 0) {
      return NextResponse.json({ error: 'محله، سورس و ترتیب مشتریان الزامی است.' }, { status: 400 });
    }
    if (orderedCustomerIds.length > 2000 || new Set(orderedCustomerIds).size !== orderedCustomerIds.length) {
      return NextResponse.json({ error: 'ترتیب مشتریان معتبر نیست.' }, { status: 400 });
    }

    const neighborhood = await db.neighborhood.findFirst({
      where: { name: neighborhoodName, ...(districtName ? { districtName } : {}) },
    });
    if (!neighborhood) {
      return NextResponse.json({ error: 'محله پیدا نشد.' }, { status: 404 });
    }

    const polygon = (JSON.parse(neighborhood.geometry) as GeoJSON.Polygon).coordinates[0];
    const bounds = getBoundingBox(polygon);
    const candidates = await db.customer.findMany({
      where: {
        source,
        lng: { gte: bounds.minLng, lte: bounds.maxLng },
        lat: { gte: bounds.minLat, lte: bounds.maxLat },
      },
      select: { id: true, lat: true, lng: true },
    });
    const neighborhoodCustomerIds = candidates
      .filter((customer) => pointInPolygon(customer.lng, customer.lat, polygon))
      .map((customer) => customer.id);

    const expectedIds = [...neighborhoodCustomerIds].sort();
    const receivedIds = [...orderedCustomerIds].sort();
    if (
      expectedIds.length !== receivedIds.length
      || expectedIds.some((id, index) => id !== receivedIds[index])
    ) {
      return NextResponse.json(
        { error: 'فهرست مشتریان تغییر کرده است؛ اطلاعات محله را دوباره بارگذاری کنید.' },
        { status: 409 }
      );
    }

    const optimizedAt = new Date();
    await db.$transaction(async (transaction) => {
      await transaction.customer.updateMany({
        where: { optimizedNeighborhoodId: neighborhood.id, source },
        data: {
          optimizedOrder: null,
          optimizedNeighborhood: '',
          optimizedNeighborhoodId: '',
          routeOptimizedAt: null,
        },
      });

      for (let index = 0; index < orderedCustomerIds.length; index++) {
        await transaction.customer.update({
          where: { id: orderedCustomerIds[index] },
          data: {
            optimizedOrder: index + 1,
            optimizedNeighborhood: neighborhoodName,
            optimizedNeighborhoodId: neighborhood.id,
            routeOptimizedAt: optimizedAt,
          },
        });
      }
    });

    return NextResponse.json({
      saved: true,
      neighborhood: neighborhoodName,
      neighborhoodId: neighborhood.id,
      source,
      customerCount: orderedCustomerIds.length,
      optimizedAt: optimizedAt.toISOString(),
    });
  } catch (error) {
    console.error('Save optimized customer order error:', error);
    return NextResponse.json({ error: 'ذخیره ترتیب مشتریان انجام نشد.' }, { status: 500 });
  }
}
