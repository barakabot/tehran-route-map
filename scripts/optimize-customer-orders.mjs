const DEFAULT_OSRM_TRIP_URL = 'https://router.project-osrm.org/trip/v1/driving';
const MAX_OSRM_CUSTOMERS = 99;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CONCURRENCY = 3;

function pointInRing(lng, lat, coordinates) {
  let inside = false;
  for (let index = 0, previous = coordinates.length - 1; index < coordinates.length; previous = index++) {
    const [currentLng, currentLat] = coordinates[index];
    const [previousLng, previousLat] = coordinates[previous];
    if (
      ((currentLat > lat) !== (previousLat > lat))
      && lng < ((previousLng - currentLng) * (lat - currentLat)) / (previousLat - currentLat) + currentLng
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(lng, lat, rings) {
  if (!rings[0] || !pointInRing(lng, lat, rings[0])) return false;
  return !rings.slice(1).some((hole) => pointInRing(lng, lat, hole));
}

function getBoundingBox(coordinates) {
  return coordinates.reduce(
    (box, [lng, lat]) => ({
      minLng: Math.min(box.minLng, lng),
      maxLng: Math.max(box.maxLng, lng),
      minLat: Math.min(box.minLat, lat),
      maxLat: Math.max(box.maxLat, lat),
    }),
    { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity }
  );
}

function getPolygonCenter(bounds) {
  return {
    lng: (bounds.minLng + bounds.maxLng) / 2,
    lat: (bounds.minLat + bounds.maxLat) / 2,
  };
}

function squaredDistance(first, second) {
  const averageLatitude = ((first.lat + second.lat) / 2) * Math.PI / 180;
  const lngDistance = (first.lng - second.lng) * Math.cos(averageLatitude);
  const latDistance = first.lat - second.lat;
  return lngDistance * lngDistance + latDistance * latDistance;
}

function nearestNeighborOrder(customers, origin) {
  const remaining = [...customers];
  const ordered = [];
  let current = origin;

  while (remaining.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = squaredDistance(current, remaining[0]);
    for (let index = 1; index < remaining.length; index++) {
      const distance = squaredDistance(current, remaining[index]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    const [nearest] = remaining.splice(nearestIndex, 1);
    ordered.push(nearest);
    current = nearest;
  }

  return ordered;
}

function hasValidStoredOrder(group) {
  const orders = group.customers
    .map((customer) => customer.optimizedOrder)
    .sort((first, second) => Number(first) - Number(second));

  return group.customers.every(
    (customer) => customer.optimizedNeighborhoodId === group.neighborhoodId
      && Number.isInteger(customer.optimizedOrder)
  ) && orders.every((order, index) => order === index + 1);
}

function buildGroups(neighborhoods, customers) {
  const preparedNeighborhoods = neighborhoods.flatMap((neighborhood) => {
    try {
      const geometry = JSON.parse(neighborhood.geometry);
      if (geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates?.[0])) return [];
      const rings = geometry.coordinates;
      const bounds = getBoundingBox(rings[0]);
      return [{ ...neighborhood, rings, bounds, center: getPolygonCenter(bounds) }];
    } catch {
      console.warn(`Skipping neighborhood with invalid geometry: ${neighborhood.name} (${neighborhood.id})`);
      return [];
    }
  });

  const groups = new Map();
  for (const customer of customers) {
    const neighborhood = preparedNeighborhoods.find((candidate) =>
      customer.lng >= candidate.bounds.minLng
      && customer.lng <= candidate.bounds.maxLng
      && customer.lat >= candidate.bounds.minLat
      && customer.lat <= candidate.bounds.maxLat
      && pointInPolygon(customer.lng, customer.lat, candidate.rings)
    );
    if (!neighborhood) continue;

    const key = `${neighborhood.id}\u0000${customer.source}`;
    const group = groups.get(key) || {
      neighborhoodId: neighborhood.id,
      neighborhoodName: neighborhood.name,
      districtName: neighborhood.districtName,
      source: customer.source,
      center: neighborhood.center,
      customers: [],
    };
    group.customers.push(customer);
    groups.set(key, group);
  }

  return [...groups.values()];
}

async function fetchOsrmOrder(group) {
  if (group.customers.length === 1) return group.customers;
  if (group.customers.length > MAX_OSRM_CUSTOMERS) {
    throw new Error(`OSRM supports at most ${MAX_OSRM_CUSTOMERS} customers with the neighborhood origin`);
  }

  const coordinates = [
    `${group.center.lng},${group.center.lat}`,
    ...group.customers.map((customer) => `${customer.lng},${customer.lat}`),
  ].join(';');
  const baseUrl = process.env.OSRM_TRIP_BASE_URL || DEFAULT_OSRM_TRIP_URL;
  const url = `${baseUrl}/${coordinates}?roundtrip=false&source=first&destination=any&overview=false&steps=false`;
  const timeoutMs = Number(process.env.STARTUP_ROUTE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OSRM returned HTTP ${response.status}`);

    const data = await response.json();
    if (data.code !== 'Ok' || !Array.isArray(data.waypoints)) {
      throw new Error(data.message || `OSRM returned ${data.code || 'an invalid response'}`);
    }

    const inputOrder = data.waypoints
      .map((waypoint, inputIndex) => ({ inputIndex, waypointIndex: waypoint.waypoint_index }))
      .sort((first, second) => first.waypointIndex - second.waypointIndex)
      .map(({ inputIndex }) => inputIndex)
      .filter((inputIndex) => inputIndex !== 0);
    if (inputOrder.length !== group.customers.length) {
      throw new Error('OSRM returned an incomplete customer order');
    }

    return inputOrder.map((inputIndex) => group.customers[inputIndex - 1]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function calculateGroupOrder(group) {
  try {
    return { orderedCustomers: await fetchOsrmOrder(group), method: 'osrm' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `Route service unavailable for ${group.neighborhoodName} / ${group.source || 'بدون سورس'}; using geographic fallback (${reason}).`
    );
    return {
      orderedCustomers: nearestNeighborOrder(group.customers, group.center),
      method: 'geographic-fallback',
    };
  }
}

async function saveGroupOrder(prisma, group, orderedCustomers, optimizedAt) {
  await prisma.$transaction(async (transaction) => {
    await transaction.customer.updateMany({
      where: { optimizedNeighborhoodId: group.neighborhoodId, source: group.source },
      data: {
        optimizedOrder: null,
        optimizedNeighborhood: '',
        optimizedNeighborhoodId: '',
        routeOptimizedAt: null,
      },
    });

    for (let index = 0; index < orderedCustomers.length; index++) {
      await transaction.customer.update({
        where: { id: orderedCustomers[index].id },
        data: {
          optimizedOrder: index + 1,
          optimizedNeighborhood: group.neighborhoodName,
          optimizedNeighborhoodId: group.neighborhoodId,
          routeOptimizedAt: optimizedAt,
        },
      });
    }
  });
}

export async function optimizeCustomerOrders(prisma) {
  const [neighborhoods, customers] = await Promise.all([
    prisma.neighborhood.findMany({
      select: { id: true, name: true, districtName: true, geometry: true },
    }),
    prisma.customer.findMany({
      select: {
        id: true,
        source: true,
        lat: true,
        lng: true,
        optimizedOrder: true,
        optimizedNeighborhoodId: true,
      },
    }),
  ]);

  const groups = buildGroups(neighborhoods, customers);
  const pendingGroups = groups.filter((group) => !hasValidStoredOrder(group));
  if (pendingGroups.length === 0) {
    console.log(`Customer route orders are current for all ${groups.length} neighborhood/source groups.`);
    return { totalGroups: groups.length, optimizedGroups: 0, fallbackGroups: 0 };
  }

  console.log(
    `Optimizing ${pendingGroups.length} of ${groups.length} neighborhood/source customer groups...`
  );
  const concurrency = Math.max(
    1,
    Math.min(10, Number(process.env.STARTUP_ROUTE_CONCURRENCY) || DEFAULT_CONCURRENCY)
  );
  let completed = 0;
  let fallbackGroups = 0;

  for (let index = 0; index < pendingGroups.length; index += concurrency) {
    const batch = pendingGroups.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (group) => ({
      group,
      ...(await calculateGroupOrder(group)),
    })));

    for (const result of results) {
      await saveGroupOrder(prisma, result.group, result.orderedCustomers, new Date());
      completed += 1;
      if (result.method === 'geographic-fallback') fallbackGroups += 1;
    }
    console.log(`Optimized ${completed}/${pendingGroups.length} customer groups.`);
  }

  console.log(
    `Startup route optimization complete: ${completed} groups saved (${fallbackGroups} geographic fallbacks).`
  );
  return { totalGroups: groups.length, optimizedGroups: completed, fallbackGroups };
}
