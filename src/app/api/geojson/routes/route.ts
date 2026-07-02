import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const route = searchParams.get('route');
  const district = searchParams.get('district');
  const neighborhood = searchParams.get('neighborhood');
  const search = searchParams.get('search');
  const mismatch = searchParams.get('mismatch') === 'true';

  const filePath = path.join(process.cwd(), 'upload', 'tehran_rout.geojson');
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);

  let features = data.features;

  if (route) {
    features = features.filter(
      (f: Record<string, unknown>) => {
        const props = f.properties as Record<string, string>;
        return props['مسیر فعلی (ثبت‌شده)'] === route;
      }
    );
  }

  if (mismatch) {
    features = features.filter(
      (f: Record<string, unknown>) => {
        const props = f.properties as Record<string, string>;
        return props['تغییر مسیر'] && props['تغییر مسیر'] !== 'بدون تغییر';
      }
    );
  }

  if (search) {
    const q = search.toLowerCase();
    features = features.filter(
      (f: Record<string, unknown>) => {
        const props = f.properties as Record<string, string>;
        const name = (props['کد و نام مشتری'] || '').toLowerCase();
        const addr = (props['آدرس'] || '').toLowerCase();
        const seller = (props['نام فروشنده'] || '').toLowerCase();
        return name.includes(q) || addr.includes(q) || seller.includes(q);
      }
    );
  }

  const customers = features.map((f: Record<string, unknown>, i: number) => {
    const props = f.properties as Record<string, string>;
    const geom = f.geometry as { type: string; coordinates: number[] };
    return {
      id: `route-${i}`,
      customerName: props['کد و نام مشتری'] || '',
      sellerName: props['نام فروشنده'] || '',
      currentRoute: props['مسیر فعلی (ثبت‌شده)'] || '',
      blockName: props['بلوکی که مشتری درونش هست'] || '',
      routeChange: props['تغییر مسیر'] || '',
      address: props['آدرس'] || '',
      source: 'ورانگر',
      lat: geom.coordinates[1],
      lng: geom.coordinates[0],
      isNew: false,
    };
  });

  return NextResponse.json({ customers });
}