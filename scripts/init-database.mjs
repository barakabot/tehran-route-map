import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { optimizeCustomerOrders } from './optimize-customer-orders.mjs';

const projectRoot = process.cwd();

function loadLocalEnvironment() {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

function ensureSqliteDirectory(databaseUrl) {
  if (!databaseUrl.startsWith('file:')) return;

  const fileValue = decodeURIComponent(databaseUrl.slice('file:'.length).split('?')[0]);
  let databasePath;

  if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(fileValue)) {
    databasePath = fileValue.slice(1);
  } else if (path.isAbsolute(fileValue)) {
    databasePath = fileValue;
  } else {
    // Prisma resolves relative SQLite URLs from the folder containing schema.prisma.
    databasePath = path.resolve(projectRoot, 'prisma', fileValue);
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (!fs.existsSync(databasePath)) {
    fs.closeSync(fs.openSync(databasePath, 'a'));
  }
}

function runPrismaDbPush() {
  const prismaCli = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js');
  if (!fs.existsSync(prismaCli)) {
    throw new Error('Prisma CLI is not installed. Run npm install first.');
  }

  const result = spawnSync(
    process.execPath,
    [prismaCli, 'db', 'push'],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`prisma db push failed with exit code ${result.status}`);
  }
}

function runPrismaGenerate() {
  const prismaCli = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js');
  if (!fs.existsSync(prismaCli)) {
    throw new Error('Prisma CLI is not installed. Run npm install first.');
  }

  const result = spawnSync(
    process.execPath,
    [prismaCli, 'generate'],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`prisma generate failed with exit code ${result.status}`);
  }
}

function readFeatures(fileName) {
  const filePath = path.join(projectRoot, 'upload', fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Seed file is missing: ${filePath}`);
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(data.features)) {
    throw new Error(`Seed file has no features array: ${filePath}`);
  }
  return data.features;
}

async function createInChunks(model, records, chunkSize = 500) {
  for (let index = 0; index < records.length; index += chunkSize) {
    await model.createMany({ data: records.slice(index, index + chunkSize) });
  }
}

async function seedEmptyTables(prisma) {
  const [customerCount, routeCount, districtCount, neighborhoodCount] = await Promise.all([
    prisma.customer.count(),
    prisma.route.count(),
    prisma.district.count(),
    prisma.neighborhood.count(),
  ]);

  if (routeCount === 0) {
    const routes = readFeatures('route_blocks (1).geojson').map((feature) => {
      const properties = feature.properties || {};
      return {
        name: String(properties.route_name || '').trim(),
        color: '',
        geometry: JSON.stringify(feature.geometry),
        customerCount: Number(properties.customer_count) || 0,
        coreCustomerCount: Number(properties.core_customer_count) || 0,
        outlierCount: Number(properties.outlier_count) || 0,
        salesOffice: String(properties.sales_office || ''),
        distributionCenter: String(properties.distribution_center || ''),
      };
    }).filter((route) => route.name);
    await createInChunks(prisma.route, routes);
    console.log(`Seeded ${routes.length} routes.`);
  }

  if (customerCount === 0) {
    const customers = readFeatures('tehran_rout.geojson').flatMap((feature) => {
      if (feature.geometry?.type !== 'Point') return [];
      const properties = feature.properties || {};
      const [lng, lat] = feature.geometry.coordinates || [];
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
      const currentRoute = String(properties['مسیر فعلی (ثبت‌شده)'] || '').trim();
      return [{
        customerName: String(properties['کد و نام مشتری'] || ''),
        sellerName: String(properties['نام فروشنده'] || ''),
        currentRoute,
        blockName: String(properties['بلوکی که مشتری درونش هست'] || ''),
        routeChange: String(properties['تغییر مسیر'] || ''),
        address: String(properties['آدرس'] || ''),
        source: 'ورانگر',
        lat,
        lng,
        routeName: currentRoute,
      }];
    });
    await createInChunks(prisma.customer, customers);
    console.log(`Seeded ${customers.length} customers.`);
  }

  if (districtCount === 0) {
    const districts = readFeatures('tehran_districts.geojson').map((feature) => {
      const properties = feature.properties || {};
      return {
        name: String(properties.name || ''),
        districtNumber: Number(properties.district_number) || 0,
        geometry: JSON.stringify(feature.geometry),
        areaKm2: Number.isFinite(properties.area_km2) ? properties.area_km2 : null,
        population: Number.isFinite(properties.population) ? properties.population : null,
        location: properties.location ? String(properties.location) : null,
        description: properties.description ? String(properties.description) : null,
      };
    });
    await createInChunks(prisma.district, districts, 100);
    console.log(`Seeded ${districts.length} districts.`);
  }

  if (neighborhoodCount === 0) {
    const neighborhoods = readFeatures('tehran_neighborhoods.geojson').map((feature) => {
      const properties = feature.properties || {};
      return {
        name: String(properties.name || ''),
        districtName: String(properties.district_name || ''),
        districtNumber: Number(properties.district_number) || 0,
        geometry: JSON.stringify(feature.geometry),
        areaKm2: Number.isFinite(properties.area_km2) ? properties.area_km2 : null,
      };
    });
    await createInChunks(prisma.neighborhood, neighborhoods, 100);
    console.log(`Seeded ${neighborhoods.length} neighborhoods.`);
  }

  const counts = await Promise.all([
    prisma.customer.count(),
    prisma.route.count(),
    prisma.district.count(),
    prisma.neighborhood.count(),
  ]);
  console.log(
    `Database ready: ${counts[0]} customers, ${counts[1]} routes, ${counts[2]} districts, ${counts[3]} neighborhoods.`
  );
}

async function main() {
  loadLocalEnvironment();
  process.env.DATABASE_URL ||= 'file:./custom.db';
  ensureSqliteDirectory(process.env.DATABASE_URL);
  runPrismaDbPush();
  runPrismaGenerate();

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await seedEmptyTables(prisma);
    await optimizeCustomerOrders(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Database initialization failed:', error);
  process.exit(1);
});
