import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 30;

const RAAH_DIRECTIONS_URL =
  'https://direction.raah.ir/navigation-v7/directions/v5/mapbox/driving-traffic';

interface RaahStep {
  distance?: number;
  duration?: number;
  name?: string;
  geometry?: unknown;
  maneuver?: {
    instruction?: string;
    type?: string;
  };
}

interface RaahLeg {
  distance?: number;
  duration?: number;
  steps?: RaahStep[];
}

interface RaahFeature {
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
}

interface RaahRoute {
  distance?: number;
  duration?: number;
  legs?: RaahLeg[];
  feature_collection?: {
    features?: RaahFeature[];
  };
}

function isCoordinatePair(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length >= 2
    && typeof value[0] === 'number'
    && typeof value[1] === 'number';
}

function extractRouteGeometry(route: RaahRoute): GeoJSON.LineString | null {
  const lineStrings = (route.feature_collection?.features || [])
    .map((feature) => feature.geometry)
    .filter((geometry) => geometry?.type === 'LineString' && Array.isArray(geometry.coordinates))
    .map((geometry) => geometry!.coordinates as unknown[])
    .filter((coordinates) => coordinates.every(isCoordinatePair));

  if (lineStrings.length === 0) return null;

  const longestLine = lineStrings.reduce((longest, current) =>
    current.length > longest.length ? current : longest
  );

  return {
    type: 'LineString',
    coordinates: longestLine as [number, number][],
  };
}

export async function GET(request: NextRequest) {
  const coords = new URL(request.url).searchParams.get('coords');

  if (!coords) {
    return NextResponse.json(
      { error: 'coords parameter is required (lng,lat;lng,lat;...)' },
      { status: 400 }
    );
  }

  const points = coords.split(';');
  if (points.length < 2) {
    return NextResponse.json({ error: 'At least 2 points are required' }, { status: 400 });
  }
  if (points.length > 100) {
    return NextResponse.json({ error: 'A maximum of 100 points is supported' }, { status: 400 });
  }

  for (const point of points) {
    const parts = point.split(',');
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (
      parts.length !== 2
      || !Number.isFinite(lng)
      || !Number.isFinite(lat)
      || lat < -90
      || lat > 90
      || lng < -180
      || lng > 180
    ) {
      return NextResponse.json({ error: `Invalid coordinate: ${point}` }, { status: 400 });
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(
      `${RAAH_DIRECTIONS_URL}/${coords}?overview=full&steps=true&annotations=true`,
      {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: `Raah routing server error: ${response.status}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    const raahRoute = data.routes?.[0] as RaahRoute | undefined;
    if (!raahRoute) {
      return NextResponse.json(
        { error: data.message || 'Raah routing failed', code: data.code },
        { status: 400 }
      );
    }

    const geometry = extractRouteGeometry(raahRoute);
    if (!geometry) {
      return NextResponse.json({ error: 'Raah returned no drawable route geometry' }, { status: 502 });
    }

    return NextResponse.json({
      provider: 'raah',
      routes: [{
        distance: Number(raahRoute.distance) || 0,
        duration: Number(raahRoute.duration) || 0,
        geometry,
        legs: (raahRoute.legs || []).map((leg) => ({
          distance: Number(leg.distance) || 0,
          duration: Number(leg.duration) || 0,
          steps: (leg.steps || []).map((step) => ({
            distance: Number(step.distance) || 0,
            duration: Number(step.duration) || 0,
            instruction: step.maneuver?.instruction || '',
            type: step.maneuver?.type || '',
            name: step.name || '',
            geometry: step.geometry,
          })),
        })),
      }],
      waypoints: data.waypoints || [],
    });
  } catch (error) {
    console.error('Raah route request failed:', error);
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Raah routing server timeout - try again'
      : 'Failed to connect to Raah routing server';
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeoutId);
  }
}
