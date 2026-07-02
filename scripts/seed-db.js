const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient({ log: ['error'] });
const dbPath = path.join(process.cwd(), 'db', 'custom.db');

// Use better-sqlite3 directly for fast bulk inserts
const Database = require('better-sqlite3');
const db = new Database(dbPath);

async function seedRouteBlocks() {
  console.log('Seeding route blocks...');
  const filePath = path.join(process.cwd(), 'upload', 'route_blocks (1).geojson');
  if (!fs.existsSync(filePath)) { console.log('  Not found, skip'); return; }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  console.log(`  ${data.features.length} polygons`);

  db.exec('DELETE FROM Route');
  const insert = db.prepare(`INSERT INTO Route (id, name, color, geometry, customerCount, coreCustomerCount, outlierCount, salesOffice, distributionCenter, createdAt, updatedAt)
    VALUES (lower(hex(randomblob(8))), ?, '', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`);

  const tx = db.transaction((features) => {
    for (const f of features) {
      const p = f.properties;
      insert.run(
        p.route_name || '',
        JSON.stringify(f.geometry),
        p.customer_count || 0,
        p.core_customer_count || 0,
        p.outlier_count || 0,
        p.sales_office || '',
        p.distribution_center || ''
      );
    }
  });
  tx(data.features);
  console.log(`  Done: ${data.features.length} routes`);
}

async function seedCustomers() {
  console.log('Seeding customers...');
  const filePath = path.join(process.cwd(), 'upload', 'tehran_rout.geojson');
  if (!fs.existsSync(filePath)) { console.log('  Not found, skip'); return; }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  console.log(`  ${data.features.length} points`);

  db.exec('DELETE FROM Customer');
  const insert = db.prepare(`INSERT INTO Customer (id, customerName, sellerName, currentRoute, blockName, routeChange, address, source, lat, lng, isNew, routeName, createdAt, updatedAt)
    VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, 'ورانگر', ?, ?, 0, ?, datetime('now'), datetime('now'))`);

  const rows = [];
  for (const f of data.features) {
    if (f.geometry?.type !== 'Point') continue;
    const p = f.properties || {};
    const c = f.geometry.coordinates;
    const lat = typeof c[1] === 'number' ? c[1] : 0;
    const lng = typeof c[0] === 'number' ? c[0] : 0;
    const cr = p['مسیر فعلی (ثبت‌شده)'] || '';
    rows.push([
      p['کد و نام مشتری'] || '',
      p['نام فروشنده'] || '',
      cr,
      p['بلوکی که مشتری درونش هست'] || '',
      p['تغییر مسیر'] || '',
      p['آدرس'] || '',
      lat, lng, cr
    ]);
  }
  console.log(`  Point features: ${rows.length}`);

  const tx = db.transaction((rows) => {
    for (const r of rows) insert.run(...r);
  });
  tx(rows);
  console.log(`  Done: ${rows.length} customers`);
}

async function seedDistricts() {
  console.log('Seeding districts...');
  const filePath = path.join(process.cwd(), 'upload', 'tehran_districts.geojson');
  if (!fs.existsSync(filePath)) { console.log('  Not found, skip'); return; }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  db.exec('DELETE FROM District');
  const insert = db.prepare(`INSERT INTO District (id, name, districtNumber, geometry, areaKm2, population, location, description, createdAt, updatedAt)
    VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`);

  const tx = db.transaction((features) => {
    for (const f of features) {
      const p = f.properties || {};
      insert.run(
        p.name || '',
        p.district_number || 0,
        JSON.stringify(f.geometry),
        p.area_km2 || null,
        p.population || null,
        p.location || null,
        p.description || null
      );
    }
  });
  tx(data.features);
  console.log(`  Done: ${data.features.length} districts`);
}

async function seedNeighborhoods() {
  console.log('Seeding neighborhoods...');
  const filePath = path.join(process.cwd(), 'upload', 'tehran_neighborhoods.geojson');
  if (!fs.existsSync(filePath)) { console.log('  Not found, skip'); return; }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  db.exec('DELETE FROM Neighborhood');
  const insert = db.prepare(`INSERT INTO Neighborhood (id, name, districtName, districtNumber, geometry, areaKm2, createdAt, updatedAt)
    VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`);

  const tx = db.transaction((features) => {
    for (const f of features) {
      const p = f.properties || {};
      insert.run(
        p.name || '',
        p.district_name || '',
        p.district_number || 0,
        JSON.stringify(f.geometry),
        p.area_km2 || null
      );
    }
  });
  tx(data.features);
  console.log(`  Done: ${data.features.length} neighborhoods`);
}

async function main() {
  console.log('=== DB Seed (raw SQL) ===');
  const t0 = Date.now();

  seedRouteBlocks();
  seedCustomers();
  seedDistricts();
  seedNeighborhoods();

  // Verify counts
  const c = db.prepare('SELECT COUNT(*) as n FROM Customer').get().n;
  const r = db.prepare('SELECT COUNT(*) as n FROM Route').get().n;
  const d = db.prepare('SELECT COUNT(*) as n FROM District').get().n;
  const n = db.prepare('SELECT COUNT(*) as n FROM Neighborhood').get().n;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== Done in ${elapsed}s ===`);
  console.log(`Customers: ${c} | Routes: ${r} | Districts: ${d} | Neighborhoods: ${n}`);

  db.close();
}

main().catch(e => { console.error('FAIL:', e.message); db.close(); process.exit(1); });