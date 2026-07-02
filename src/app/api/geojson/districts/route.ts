import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  const filePath = path.join(process.cwd(), 'upload', 'tehran_districts.geojson');
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);

  const districts = data.features.map((f: Record<string, unknown>) => ({
    name: (f.properties as Record<string, string>).name,
    district_number: (f.properties as Record<string, number>).district_number,
    geometry: f.geometry,
  }));

  const names = data.features.map((f: Record<string, unknown>) => ({
    name: (f.properties as Record<string, string>).name,
    district_number: (f.properties as Record<string, number>).district_number,
  }));

  return NextResponse.json({ districts, names });
}