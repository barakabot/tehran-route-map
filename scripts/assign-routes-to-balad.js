/**
 * Assign routes to بلده customers based on which route block polygon they fall within.
 * Uses bounding-box pre-filtering for speed: 10,587 customers × 460 routes
 */
const Database = require('better-sqlite3');
const db = new Database('db/custom.db');

// Point-in-polygon (ray casting) - GeoJSON [lng, lat] order
function pointInPolygon(x, y, coords) {
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const xi = coords[i][0], yi = coords[i][1];
    const xj = coords[j][0], yj = coords[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// Get bounding box
function getBBox(coords) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, maxLng, minLat, maxLat };
}

console.log('Loading route blocks...');
const t0 = Date.now();
const routeRows = db.prepare("SELECT name, geometry FROM Route WHERE length(geometry) > 2").all();

// Pre-parse route geometries and compute bounding boxes
const routes = routeRows.map(r => {
  const polyCoords = JSON.parse(r.geometry).coordinates[0];
  return {
    name: r.name,
    coords: polyCoords,
    bbox: getBBox(polyCoords),
  };
});

console.log(`Loaded ${routes.length} route blocks in ${Date.now() - t0}ms`);

// Sort routes by bounding box area (smaller first for faster matching)
// Actually, just index them by a grid for faster lookup
// Simple approach: for each customer, find the first matching route

console.log('Loading بلده customers...');
const t1 = Date.now();
const customers = db.prepare("SELECT id, lat, lng FROM Customer WHERE source = 'بلده'").all();
console.log(`Loaded ${customers.length} customers in ${Date.now() - t1}ms`);

// Build spatial index: grid cells
// Divide Tehran area into grid
const GRID_SIZE = 0.005; // ~500m
const grid = new Map(); // key: "gridX,gridY" -> [routeIndex, ...]

console.log('Building spatial index...');
const t2 = Date.now();
for (let ri = 0; ri < routes.length; ri++) {
  const r = routes[ri];
  const minGX = Math.floor(r.bbox.minLng / GRID_SIZE);
  const maxGX = Math.floor(r.bbox.maxLng / GRID_SIZE);
  const minGY = Math.floor(r.bbox.minLat / GRID_SIZE);
  const maxGY = Math.floor(r.bbox.maxLat / GRID_SIZE);

  for (let gx = minGX; gx <= maxGX; gx++) {
    for (let gy = minGY; gy <= maxGY; gy++) {
      const key = `${gx},${gy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(ri);
    }
  }
}
console.log(`Built grid with ${grid.size} cells in ${Date.now() - t2}ms`);

// Match customers to routes
console.log('Matching customers to routes...');
const t3 = Date.now();
let matched = 0;
let unmatched = 0;
const updates = []; // [id, routeName]

const updateStmt = db.prepare("UPDATE Customer SET currentRoute = ?, blockName = ? WHERE id = ?");

const transaction = db.transaction(() => {
  for (const c of customers) {
    const gx = Math.floor(c.lng / GRID_SIZE);
    const gy = Math.floor(c.lat / GRID_SIZE);
    const key = `${gx},${gy}`;
    const candidateRoutes = grid.get(key);

    if (!candidateRoutes) {
      unmatched++;
      continue;
    }

    let found = false;
    for (const ri of candidateRoutes) {
      const r = routes[ri];
      // Quick bounding box check
      if (c.lng < r.bbox.minLng || c.lng > r.bbox.maxLng ||
          c.lat < r.bbox.minLat || c.lat > r.bbox.maxLat) {
        continue;
      }
      // Full PIP check
      if (pointInPolygon(c.lng, c.lat, r.coords)) {
        updateStmt.run(r.name, r.name, c.id);
        matched++;
        found = true;
        break;
      }
    }
    if (!found) unmatched++;
  }
});

transaction();
const t4 = Date.now();

console.log('\n=== Results ===');
console.log(`Matched: ${matched}`);
console.log(`Unmatched: ${unmatched}`);
console.log(`Total: ${customers.length}`);
console.log(`Time: ${t4 - t3}ms (${((t4 - t3) / 1000).toFixed(1)}s)`);

// Verify
const verify = db.prepare("SELECT currentRoute, COUNT(*) as cnt FROM Customer WHERE source = 'بلده' GROUP BY currentRoute ORDER BY cnt DESC LIMIT 10").all();
console.log('\nTop routes for بلده:');
for (const v of verify) {
  console.log(`  ${v.currentRoute || '(empty)'}: ${v.cnt}`);
}

const stillEmpty = db.prepare("SELECT COUNT(*) as cnt FROM Customer WHERE source = 'بلده' AND (currentRoute = '' OR currentRoute IS NULL)").get();
console.log(`\nStill without route: ${stillEmpty.cnt}`);

db.close();