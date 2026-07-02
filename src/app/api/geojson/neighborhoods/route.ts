import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const district = searchParams.get('district');

  const filePath = path.join(process.cwd(), 'upload', 'tehran_neighborhoods.geojson');
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);

  let features = data.features;
  if (district) {
    features = features.filter(
      (f: Record<string, unknown>) =>
        (f.properties as Record<string, string>).district_name === district
    );
  }

  const neighborhoods = features.map((f: Record<string, unknown>) => ({
    name: (f.properties as Record<string, string>).name,
    district_number: (f.properties as Record<string, number>).district_number,
    district_name: (f.properties as Record<string, string>).district_name,
    geometry: f.geometry,
  }));

  const names = features.map((f: Record<string, unknown>) => ({
    name: (f.properties as Record<string, string>).name,
    district_name: (f.properties as Record<string, string>).district_name,
    district_number: (f.properties as Record<string, number>).district_number,
  }));

  return NextResponse.json({ neighborhoods, names });
}