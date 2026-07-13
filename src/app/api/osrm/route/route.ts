import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const coords = searchParams.get('coords');

  if (!coords) {
    return NextResponse.json({ error: 'coords parameter is required (lng,lat;lng,lat;...)' }, { status: 400 });
  }

  // Validate coordinate format
  const points = coords.split(';');
  if (points.length < 2) {
    return NextResponse.json({ error: 'At least 2 points are required' }, { status: 400 });
  }

  for (const p of points) {
    const [lng, lat] = p.split(',').map(Number);
    if (isNaN(lng) || isNaN(lat) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return NextResponse.json({ error: `Invalid coordinate: ${p}` }, { status: 400 });
    }
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
    const response = await fetch(osrmUrl, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return NextResponse.json({ error: `OSRM server error: ${response.status}` }, { status: 502 });
    }

    const data = await response.json();

    if (data.code !== 'Ok') {
      return NextResponse.json({ error: data.message || 'OSRM routing failed', code: data.code }, { status: 400 });
    }

    // Return structured route data
    return NextResponse.json({
      routes: data.routes.map((r: Record<string, unknown>) => ({
        distance: r.distance,
        duration: r.duration,
        geometry: r.geometry,
        legs: (r.legs as Array<Record<string, unknown>>)?.map((leg) => ({
          distance: leg.distance,
          duration: leg.duration,
          steps: (leg.steps as Array<Record<string, unknown>>)?.map((step) => ({
            distance: step.distance,
            duration: step.duration,
            instruction: (step.maneuver as Record<string, unknown>)?.instruction || '',
            type: (step.maneuver as Record<string, unknown>)?.type || '',
            name: step.name || '',
            geometry: step.geometry,
          })),
        })),
      })),
      waypoints: data.waypoints,
    });
  } catch (err) {
    console.error('OSRM request failed:', err);
    const msg = err instanceof Error && err.name === 'AbortError'
      ? 'OSRM server timeout - try again'
      : 'Failed to connect to OSRM server';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}