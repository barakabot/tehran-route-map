import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

// Point-in-polygon (ray casting) - GeoJSON [lng, lat] order
function pointInPolygon(x: number, y: number, coords: number[][]): boolean {
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

// Get bounding box of polygon
function getBBox(coords: number[][]): { minLng: number; maxLng: number; minLat: number; maxLat: number } {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, maxLng, minLat, maxLat };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const route = searchParams.get('route');
    const district = searchParams.get('district');
    const neighborhood = searchParams.get('neighborhood');
    const search = searchParams.get('search');
    const neighborhoodWhere = neighborhood
      ? { name: neighborhood, ...(district ? { districtName: district } : {}) }
      : null;

    // Get total stats using raw SQL (fastest)
    const statsRows = await db.$queryRawUnsafe(
      'SELECT source, COUNT(*) as cnt FROM Customer GROUP BY source'
    ) as Array<{ source: string; cnt: number }>;

    const totalSourceCounts: Record<string, number> = {};
    let grandTotal = 0;
    for (const s of statsRows) {
      totalSourceCounts[s.source] = Number(s.cnt);
      grandTotal += Number(s.cnt);
    }

    // If no filter, just return stats
    if (!route && !district && !neighborhood && !search) {
      return NextResponse.json({
        customers: [],
        total: grandTotal,
        sourceCounts: totalSourceCounts,
        filtered: false,
      });
    }

    // === Route filter (fast, indexed) ===
    if (route) {
      const customers = await db.$queryRawUnsafe(
        'SELECT id, customerName, sellerName, currentRoute, blockName, routeChange, address, source, lat, lng, isNew, optimizedOrder, optimizedNeighborhood, optimizedNeighborhoodId, routeOptimizedAt FROM Customer WHERE currentRoute = ?',
        route
      ) as Array<Record<string, unknown>>;

      let filtered = customers;
      if (district) {
        const dist = await db.district.findFirst({ where: { name: district } });
        if (dist) {
          const pc = (JSON.parse(dist.geometry) as GeoJSON.Polygon).coordinates[0];
          filtered = filtered.filter((c) => pointInPolygon(Number(c.lng), Number(c.lat), pc));
        }
      }
      if (neighborhood) {
        const neigh = await db.neighborhood.findFirst({ where: neighborhoodWhere! });
        if (neigh) {
          const pc = (JSON.parse(neigh.geometry) as GeoJSON.Polygon).coordinates[0];
          filtered = filtered.filter((c) => pointInPolygon(Number(c.lng), Number(c.lat), pc));
        }
      }

      const fsc: Record<string, number> = {};
      for (const c of filtered) fsc[c.source as string] = (fsc[c.source as string] || 0) + 1;

      return NextResponse.json({ customers: filtered, total: grandTotal, sourceCounts: totalSourceCounts, filteredSourceCounts: fsc, filtered: true });
    }

    // === Search filter ===
    if (search) {
      const customers = await db.$queryRawUnsafe(
        'SELECT id, customerName, sellerName, currentRoute, blockName, routeChange, address, source, lat, lng, isNew, optimizedOrder, optimizedNeighborhood, optimizedNeighborhoodId, routeOptimizedAt FROM Customer WHERE customerName LIKE ? OR address LIKE ? OR sellerName LIKE ?',
        `%${search}%`, `%${search}%`, `%${search}%`
      ) as Array<Record<string, unknown>>;

      let filtered = customers;
      if (district) {
        const dist = await db.district.findFirst({ where: { name: district } });
        if (dist) {
          const pc = (JSON.parse(dist.geometry) as GeoJSON.Polygon).coordinates[0];
          filtered = filtered.filter((c) => pointInPolygon(Number(c.lng), Number(c.lat), pc));
        }
      }
      if (neighborhood) {
        const neigh = await db.neighborhood.findFirst({ where: neighborhoodWhere! });
        if (neigh) {
          const pc = (JSON.parse(neigh.geometry) as GeoJSON.Polygon).coordinates[0];
          filtered = filtered.filter((c) => pointInPolygon(Number(c.lng), Number(c.lat), pc));
        }
      }

      const fsc: Record<string, number> = {};
      for (const c of filtered) fsc[c.source as string] = (fsc[c.source as string] || 0) + 1;

      return NextResponse.json({ customers: filtered, total: grandTotal, sourceCounts: totalSourceCounts, filteredSourceCounts: fsc, filtered: true });
    }

    // === District / Neighborhood filter (spatial) ===
    let polyCoords: number[][] | null = null;
    if (district) {
      const dist = await db.district.findFirst({ where: { name: district } });
      if (dist) polyCoords = (JSON.parse(dist.geometry) as GeoJSON.Polygon).coordinates[0];
    }
    if (neighborhood) {
      const neigh = await db.neighborhood.findFirst({ where: neighborhoodWhere! });
      if (neigh) polyCoords = (JSON.parse(neigh.geometry) as GeoJSON.Polygon).coordinates[0];
    }

    if (!polyCoords) {
      return NextResponse.json({ customers: [], total: grandTotal, sourceCounts: totalSourceCounts, filteredSourceCounts: {}, filtered: true });
    }

    const bbox = getBBox(polyCoords);

    // Step 1: Lightweight query with bounding box
    const lightRows = await db.$queryRawUnsafe(
      'SELECT id, lat, lng, source FROM Customer WHERE lng >= ? AND lng <= ? AND lat >= ? AND lat <= ?',
      bbox.minLng, bbox.maxLng, bbox.minLat, bbox.maxLat
    ) as Array<{ id: string; lat: number; lng: number; source: string }>;

    // Step 2: Point-in-polygon
    const matchingIds: string[] = [];
    const fsc: Record<string, number> = {};
    for (const row of lightRows) {
      if (pointInPolygon(row.lng, row.lat, polyCoords!)) {
        matchingIds.push(row.id);
        fsc[row.source] = (fsc[row.source] || 0) + 1;
      }
    }

    // Step 3: Fetch full records in batches
    const allCustomers: Array<Record<string, unknown>> = [];
    if (matchingIds.length > 0) {
      for (let i = 0; i < matchingIds.length; i += 200) {
        const batch = matchingIds.slice(i, i + 200);
        const placeholders = batch.map(() => '?').join(',');
        const rows = await db.$queryRawUnsafe(
          `SELECT id, customerName, sellerName, currentRoute, blockName, routeChange, address, source, lat, lng, isNew, optimizedOrder, optimizedNeighborhood, optimizedNeighborhoodId, routeOptimizedAt FROM Customer WHERE id IN (${placeholders})`,
          ...batch
        ) as Array<Record<string, unknown>>;
        allCustomers.push(...rows);
      }
    }

    return NextResponse.json({ customers: allCustomers, total: grandTotal, sourceCounts: totalSourceCounts, filteredSourceCounts: fsc, filtered: true });
  } catch (error) {
    console.error('by-filter error:', error);
    return NextResponse.json({ error: String(error), customers: [], total: 0, sourceCounts: {}, filtered: false }, { status: 500 });
  }
}
