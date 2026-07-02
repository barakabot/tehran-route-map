import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting import...');

  // 1. Import Routes and Customers
  console.log('Importing routes and customers...');
  const routesPath = path.join(process.cwd(), 'upload', 'tehran_rout.geojson');
  const routesData = JSON.parse(fs.readFileSync(routesPath, 'utf-8'));

  const routeSet = new Set<string>();
  let colorIdx = 0;
  const routeBatch: { name: string; color: string }[] = [];
  const customerBatch: {
    customerName: string; sellerName: string; currentRoute: string;
    blockName: string; routeChange: string; address: string;
    source: string; lat: number; lng: number; routeName: string;
  }[] = [];

  for (const f of routesData.features) {
    const props = f.properties as Record<string, string>;
    const routeName = props['مسیر فعلی (ثبت‌شده)'] || '';

    if (routeName && !routeSet.has(routeName.trim())) {
      const trimmed = routeName.trim();
      if (trimmed) {
        routeSet.add(trimmed);
        const hue = (colorIdx * 137.508) % 360;
        routeBatch.push({ name: trimmed, color: `hsl(${hue}, 65%, 50%)` });
        colorIdx++;
      }
    }

    customerBatch.push({
      customerName: props['کد و نام مشتری'] || '',
      sellerName: props['نام فروشنده'] || '',
      currentRoute: (routeName || '').trim(),
      blockName: props['بلوکی که مشتری درونش هست'] || '',
      routeChange: props['تغییر مسیر'] || '',
      address: props['آدرس'] || '',
      source: 'ورانگر',
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      routeName: (routeName || '').trim(),
    });
  }

  // Insert routes
  console.log(`Inserting ${routeBatch.length} routes...`);
  for (let i = 0; i < routeBatch.length; i += 100) {
    await prisma.route.createMany({ data: routeBatch.slice(i, i + 100) });
  }
  console.log('  Routes done.');

  // Insert customers
  console.log(`Inserting ${customerBatch.length} customers...`);
  const CUST_BATCH = 500;
  for (let i = 0; i < customerBatch.length; i += CUST_BATCH) {
    await prisma.customer.createMany({ data: customerBatch.slice(i, i + CUST_BATCH) });
    if (i % 5000 === 0) console.log(`  ${Math.min(i + CUST_BATCH, customerBatch.length)}/${customerBatch.length}`);
  }
  console.log('  Customers done.');

  // 2. Districts
  console.log('\nImporting districts...');
  const distPath = path.join(process.cwd(), 'upload', 'tehran_districts.geojson');
  const distData = JSON.parse(fs.readFileSync(distPath, 'utf-8'));
  for (const f of distData.features) {
    const p = f.properties as Record<string, unknown>;
    await prisma.district.create({
      data: {
        name: (p.name as string) || '',
        districtNumber: (p.district_number as number) || 0,
        geometry: JSON.stringify(f.geometry),
        areaKm2: (p.area_km2 as number) ?? null,
        population: (p.population as number) ?? null,
        location: (p.location as string) ?? null,
        description: (p.description as string) ?? null,
      },
    });
  }
  console.log(`  ${distData.features.length} districts done.`);

  // 3. Neighborhoods
  console.log('\nImporting neighborhoods...');
  const neighPath = path.join(process.cwd(), 'upload', 'tehran_neighborhoods.geojson');
  const neighData = JSON.parse(fs.readFileSync(neighPath, 'utf-8'));
  const neighBatch: { name: string; districtName: string; districtNumber: number; geometry: string; areaKm2: number | null }[] = [];
  for (const f of neighData.features) {
    const p = f.properties as Record<string, unknown>;
    neighBatch.push({
      name: (p.name as string) || '',
      districtName: (p.district_name as string) || '',
      districtNumber: (p.district_number as number) || 0,
      geometry: JSON.stringify(f.geometry),
      areaKm2: (p.area_km2 as number) ?? null,
    });
  }
  for (let i = 0; i < neighBatch.length; i += 100) {
    await prisma.neighborhood.createMany({ data: neighBatch.slice(i, i + 100) });
  }
  console.log(`  ${neighBatch.length} neighborhoods done.`);

  // Summary
  const tc = await prisma.customer.count();
  const tr = await prisma.route.count();
  const td = await prisma.district.count();
  const tn = await prisma.neighborhood.count();
  console.log('\n=== Done ===');
  console.log(`Customers:     ${tc}`);
  console.log(`Routes:        ${tr}`);
  console.log(`Districts:     ${td}`);
  console.log(`Neighborhoods: ${tn}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());