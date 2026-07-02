import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function seedCustomers() {
  console.log('🌱 Seeding customers...');
  const filePath = path.join(process.cwd(), 'upload', 'tehran_rout.geojson');
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);

  const routeNames = new Set<string>();
  const customers: {
    customerName: string;
    sellerName: string;
    currentRoute: string;
    blockName: string;
    routeChange: string;
    address: string;
    source: string;
    lat: number;
    lng: number;
    routeName: string;
  }[] = [];

  for (const f of data.features) {
    const props = f.properties as Record<string, string>;
    const geom = f.geometry as { type: string; coordinates: number[] };

    const customerName = props['کد و نام مشتری'] || '';
    const sellerName = props['نام فروشنده'] || '';
    const currentRoute = props['مسیر فعلی (ثبت‌شده)'] || '';
    const blockName = props['بلوکی که مشتری درونش هست'] || '';
    const routeChange = props['تغییر مسیر'] || '';
    const address = props['آدرس'] || '';

    if (currentRoute) routeNames.add(currentRoute);

    customers.push({
      customerName,
      sellerName,
      currentRoute,
      blockName,
      routeChange,
      address,
      source: 'ورانگر',
      lat: geom.coordinates[1],
      lng: geom.coordinates[0],
      routeName: currentRoute,
    });
  }

  console.log(`Found ${customers.length} customers, ${routeNames.size} unique routes`);

  await prisma.customer.deleteMany();
  await prisma.route.deleteMany();
  console.log('  Cleared existing customer & route data');

  const CHUNK = 500;
  for (let i = 0; i < customers.length; i += CHUNK) {
    const chunk = customers.slice(i, i + CHUNK);
    await prisma.customer.createMany({ data: chunk });
    console.log(`  Inserted ${Math.min(i + CHUNK, customers.length)}/${customers.length} customers`);
  }

  const routeRecords = Array.from(routeNames)
    .filter(Boolean)
    .map((name) => ({ name }));
  for (let i = 0; i < routeRecords.length; i += CHUNK) {
    const chunk = routeRecords.slice(i, i + CHUNK);
    await prisma.route.createMany({ data: chunk });
  }
  console.log(`  Inserted ${routeRecords.length} routes`);
}

async function seedDistricts() {
  console.log('🌱 Seeding districts...');
  const filePath = path.join(process.cwd(), 'upload', 'tehran_districts.geojson');
  if (!fs.existsSync(filePath)) {
    console.log('  Districts file not found, skipping.');
    return;
  }
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);

  await prisma.district.deleteMany();
  console.log('  Cleared existing district data');

  for (const f of data.features) {
    const props = f.properties as Record<string, unknown>;
    const geom = f.geometry as { type: string; coordinates: number[][][] };
    await prisma.district.create({
      data: {
        name: (props.name as string) || '',
        districtNumber: (props.district_number as number) || 0,
        geometry: JSON.stringify(geom),
        areaKm2: (props.area_km2 as number) || null,
        population: (props.population as number) || null,
        location: (props.location as string) || null,
        description: (props.description as string) || null,
      },
    });
  }
  console.log(`  Inserted ${data.features.length} districts`);
}

async function seedNeighborhoods() {
  console.log('🌱 Seeding neighborhoods...');
  const filePath = path.join(process.cwd(), 'upload', 'tehran_neighborhoods.geojson');
  if (!fs.existsSync(filePath)) {
    console.log('  Neighborhoods file not found, skipping.');
    return;
  }
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);

  await prisma.neighborhood.deleteMany();
  console.log('  Cleared existing neighborhood data');

  const CHUNK = 100;
  for (let i = 0; i < data.features.length; i += CHUNK) {
    const chunk = data.features.slice(i, i + CHUNK);
    const records = chunk.map((f: Record<string, unknown>) => {
      const props = f.properties as Record<string, unknown>;
      const geom = f.geometry as { type: string; coordinates: number[][][] };
      return {
        name: (props.name as string) || '',
        districtName: (props.district_name as string) || '',
        districtNumber: (props.district_number as number) || 0,
        geometry: JSON.stringify(geom),
        areaKm2: (props.area_km2 as number) || null,
      };
    });
    await prisma.neighborhood.createMany({ data: records });
  }
  console.log(`  Inserted ${data.features.length} neighborhoods`);
}

async function main() {
  console.log('🚀 Starting database seed...');
  await seedCustomers();
  await seedDistricts();
  await seedNeighborhoods();

  const cCount = await prisma.customer.count();
  const rCount = await prisma.route.count();
  const dCount = await prisma.district.count();
  const nCount = await prisma.neighborhood.count();
  console.log(`\n✅ Done! Customers: ${cCount}, Routes: ${rCount}, Districts: ${dCount}, Neighborhoods: ${nCount}`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());