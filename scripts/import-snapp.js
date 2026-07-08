/**
 * Import SNAPP_EXPRESS and CORNER_SHOP vendors into Customer table.
 * Source: "SNAPP_EXPRESS" for both types.
 */
const Database = require('better-sqlite3');
const db = new Database('db/custom.db');
const data = require('../upload/vendors_202607082045.json');

const vendors = data.vendors.filter(
  v => v.vendor_type === 'SNAPP_EXPRESS' || v.vendor_type === 'CORNER_SHOP'
);

console.log(`Filtered: ${vendors.length} vendors (SNAPP_EXPRESS + CORNER_SHOP)`);

const { nanoid } = require('nanoid');

const insertStmt = db.prepare(`
  INSERT INTO Customer (id, customerName, sellerName, currentRoute, blockName, routeChange, address, source, lat, lng, isNew, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
`);

// First, check if snapp data already exists
const existingSnapp = db.prepare("SELECT COUNT(*) as cnt FROM Customer WHERE source = 'SNAPP_EXPRESS'").get();
if (existingSnapp.cnt > 0) {
  console.log(`Warning: ${existingSnapp.cnt} SNAPP_EXPRESS customers already exist. Skipping import.`);
  console.log('Delete them first if you want to re-import.');
  db.close();
  process.exit(0);
}

const t0 = Date.now();
const transaction = db.transaction(() => {
  for (const v of vendors) {
    const name = v.title || '';
    const address = v.area ? `محله: ${v.area}` : '';
    insertStmt.run(
      nanoid(20),
      name,
      '',                           // sellerName
      '',                           // currentRoute (will be assigned later)
      '',                           // blockName
      '',                           // routeChange
      address,
      'SNAPP_EXPRESS',
      v.lat,
      v.long
    );
  }
});

transaction();
console.log(`Imported ${vendors.length} SNAPP_EXPRESS customers in ${Date.now() - t0}ms`);

// Verify
const count = db.prepare("SELECT COUNT(*) as cnt FROM Customer WHERE source = 'SNAPP_EXPRESS'").get();
console.log(`Total SNAPP_EXPRESS in DB: ${count.cnt}`);

// Stats
const stats = db.prepare("SELECT source, COUNT(*) as cnt FROM Customer GROUP BY source").all();
console.log('\nAll sources:', stats);

db.close();