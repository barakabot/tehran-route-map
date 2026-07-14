import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

interface OsrmWaypoint {
  waypoint_index: number;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const coords = searchParams.get('coords');

  if (!coords) {
    return NextResponse.json({ error: 'coords parameter is required (lng,lat;lng,lat;...)' }, { status: 400 });
  }

  const points = coords.split(';');
  if (points.length < 2) {
    return NextResponse.json({ error: 'At least 2 points are required' }, { status: 400 });
  }
  if (points.length > 100) {
    return NextResponse.json({ error: 'A maximum of 100 points is supported' }, { status: 400 });
  }

  for (const point of points) {
    const [lng, lat] = point.split(',').map(Number);
    if (Number.isNaN(lng) || Number.isNaN(lat) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return NextResponse.json({ error: `Invalid coordinate: ${point}` }, { status: 400 });
    }
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const osrmUrl = `https://router.project-osrm.org/trip/v1/driving/${coords}?roundtrip=false&source=first&destination=last&overview=full&geometries=geojson&steps=true`;

    const response = await fetch(osrmUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return NextResponse.json({ error: `OSRM server error: ${response.status}` }, { status: 502 });
    }

    const data = await response.json();
    if (data.code !== 'Ok' || !data.trips?.[0]) {
      return NextResponse.json(
        { error: data.message || 'OSRM trip optimization failed', code: data.code },
        { status: 400 }
      );
    }

    const order = (data.waypoints as OsrmWaypoint[])
      .map((waypoint, inputIndex) => ({ inputIndex, waypointIndex: waypoint.waypoint_index }))
      .sort((a, b) => a.waypointIndex - b.waypointIndex)
      .map(({ inputIndex }) => inputIndex);

    const trip = data.trips[0] as Record<string, unknown>;
    return NextResponse.json({
      order,
      route: {
        distance: trip.distance,
        duration: trip.duration,
        geometry: trip.geometry,
        legs: (trip.legs as Array<Record<string, unknown>>)?.map((leg) => ({
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
      },
    });
  } catch (error) {
    console.error('OSRM trip request failed:', error);
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'OSRM server timeout - try again'
      : 'Failed to connect to OSRM server';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
