const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const path = require('path');

const dbPath = path.join(process.cwd(), 'db', 'custom.db');
const db = new Database(dbPath);

console.log('=== Importing tehran_cleaned.xlsx (source: بلده) ===');
const t0 = Date.now();

const wb = XLSX.readFile(path.join(process.cwd(), 'upload', 'tehran_cleaned.xlsx'));
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws);

console.log(`Found ${rows.length} rows`);

// Check existing count
const before = db.prepare('SELECT COUNT(*) as n FROM Customer WHERE source = ?',).get('بلده').n;
console.log(`Existing بلده records: ${before}`);

const insert = db.prepare(`INSERT INTO Customer (id, customerName, sellerName, currentRoute, blockName, routeChange, address, source, lat, lng, isNew, routeName, createdAt, updatedAt)
  VALUES (lower(hex(randomblob(8))), ?, '', '', '', '', ?, 'بلده', ?, ?, 0, '', datetime('now'), datetime('now'))`);

const tx = db.transaction((rows) => {
  let inserted = 0;
  for (const r of rows) {
    const lat = parseFloat(r.place_coordinates_lat);
    const lng = parseFloat(r.place_coordinates_lng);
    if (isNaN(lat) || isNaN(lng)) continue;
    if (lat < 35 || lat > 36 || lng < 50 || lng > 53) continue;

    const address = r.place_address || '';
    const name = r.place_name || '';
    const category = r.category_display || r.category_slug || '';

    insert.run(
      `${name}${category ? ' [' + category + ']' : ''}`,
      address,
      lat, lng
    );
    inserted++;
  }
  return inserted;
});

const inserted = tx(rows);
const after = db.prepare('SELECT COUNT(*) as n FROM Customer WHERE source = ?',).get('بلده').n;
const total = db.prepare('SELECT COUNT(*) as n FROM Customer').get().n;

console.log(`Inserted: ${inserted}`);
console.log(`Total بلده: ${after}`);
console.log(`Total customers: ${total}`);
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

db.close();