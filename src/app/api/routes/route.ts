import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  const filePath = path.join(process.cwd(), 'upload', 'tehran_rout.geojson');
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);

  const routeNames = new Set<string>();
  for (const f of data.features) {
    const props = f.properties as Record<string, string>;
    if (props['مسیر فعلی (ثبت‌شده)']) {
      routeNames.add(props['مسیر فعلی (ثبت‌شده)']);
    }
  }

  return NextResponse.json({ routes: Array.from(routeNames).sort() });
}