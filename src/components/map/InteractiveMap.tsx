'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useMapStore, type RouteResult } from '@/lib/store';
import type { CustomerPoint } from '@/lib/types';
import { toast } from '@/hooks/use-toast';

// Color palette for districts
const DISTRICT_COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4',
  '#469990', '#dcbeff', '#9A6324', '#fffac8', '#800000',
  '#aaffc3', '#808000', '#ffd8b1', '#000075', '#a9a9a9',
  '#e6194b', '#3cb44b',
];

// Calculate bearing between two points for arrow rotation
function bearing(from: [number, number], to: [number, number]): number {
  const dLng = ((to[1] - from[1]) * Math.PI) / 180;
  const lat1 = (from[0] * Math.PI) / 180;
  const lat2 = (to[0] * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Route block type
interface RouteBlock {
  name: string;
  geometry: { type: string; coordinates: number[][][] };
  customerCount: number;
  coreCustomerCount: number;
  outlierCount: number;
  salesOffice: string;
  distributionCenter: string;
}

// Stats from server
interface SourceStats {
  total: number;
  sourceCounts: Record<string, number>;
  filteredSourceCounts?: Record<string, number>;
}

interface OptimizationSummary {
  savedDistance: number;
  savedDuration: number;
  changedStops: number;
}

type UserLatLng = [number, number];

function buildBaladNavigationUrl(origin: UserLatLng, destination: CustomerPoint): string {
  const originValue = `${origin[1]},${origin[0]}`;
  const destinationValue = `${destination.lng},${destination.lat}`;
  return `https://balad.ir/directions/driving?origin=${encodeURIComponent(originValue)}&destination=${encodeURIComponent(destinationValue)}`;
}

function geographicCustomerOrder(customers: CustomerPoint[], origin: UserLatLng): CustomerPoint[] {
  const remaining = [...customers];
  const ordered: CustomerPoint[] = [];
  let current = { lat: origin[0], lng: origin[1] };

  while (remaining.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = Infinity;
    for (let index = 0; index < remaining.length; index++) {
      const averageLatitude = ((current.lat + remaining[index].lat) / 2) * Math.PI / 180;
      const lngDistance = (current.lng - remaining[index].lng) * Math.cos(averageLatitude);
      const latDistance = current.lat - remaining[index].lat;
      const distance = lngDistance * lngDistance + latDistance * latDistance;
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

async function fetchTrafficRoute(coordinatePoints: string[]): Promise<RouteResult> {
  let distance = 0;
  let duration = 0;
  const coordinates: GeoJSON.Position[] = [];
  const legs: RouteResult['legs'] = [];

  for (let start = 0; start < coordinatePoints.length - 1; start += 99) {
    const chunk = coordinatePoints.slice(start, start + 100);
    const response = await fetch(`/api/raah/route?coords=${encodeURIComponent(chunk.join(';'))}`);
    const data = await response.json();
    if (!response.ok || data.error || !data.routes?.[0]) {
      throw new Error(data.error || 'مسیر ترافیکی محله از سرویس راه دریافت نشد.');
    }

    const route = data.routes[0] as RouteResult;
    distance += route.distance;
    duration += route.duration;
    legs.push(...route.legs);
    const segmentCoordinates = route.geometry.coordinates;
    coordinates.push(...(coordinates.length > 0 ? segmentCoordinates.slice(1) : segmentCoordinates));
  }

  return { distance, duration, geometry: { type: 'LineString', coordinates }, legs };
}

export default function InteractiveMap() {
  const mapRef = useRef<unknown>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const customerLayerRef = useRef<unknown>(null);
  const districtLayerRef = useRef<unknown>(null);
  const neighborhoodLayerRef = useRef<unknown>(null);
  const userMarkerRef = useRef<unknown>(null);
  const routeLayerRef = useRef<unknown>(null);
  const routingLayerRef = useRef<unknown>(null);
  const waypointMarkerLayerRef = useRef<unknown>(null);
  const leafletRef = useRef<typeof import('leaflet') | null>(null);
  const customerRequestIdRef = useRef(0);
  const autoRouteRequestRef = useRef('');

  const [isExporting, setIsExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [loadedNeighborhood, setLoadedNeighborhood] = useState('');
  const [customers, setCustomers] = useState<CustomerPoint[]>([]);
  const [stats, setStats] = useState<SourceStats>({ total: 0, sourceCounts: {} });
  const [editDialog, setEditDialog] = useState<{ open: boolean; customer: CustomerPoint | null; lat: number; lng: number }>({ open: false, customer: null, lat: 0, lng: 0 });
  const [reportDialog, setReportDialog] = useState<{ open: boolean; customer: CustomerPoint | null }>({ open: false, customer: null });
  const [reportStatus, setReportStatus] = useState('');
  const [reportDescription, setReportDescription] = useState('');
  const [reportFollowUpDate, setReportFollowUpDate] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportError, setReportError] = useState('');
  const [routingAction, setRoutingAction] = useState<'calculate' | 'optimize' | 'neighborhood' | null>(null);
  const [optimizationSummary, setOptimizationSummary] = useState<OptimizationSummary | null>(null);
  const [batchDialog, setBatchDialog] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [batchSource, setBatchSource] = useState('ورانگر');
  const [districts, setDistricts] = useState<Array<{ name: string; district_number: number; geometry: Record<string, unknown> }>>([]);
  const [neighborhoods, setNeighborhoods] = useState<Array<{ id: string; name: string; district_name: string; geometry: Record<string, unknown> }>>([]);
  const [districtNames, setDistrictNames] = useState<Array<{ name: string; district_number: number }>>([]);
  const [neighborhoodNames, setNeighborhoodNames] = useState<Array<{ id: string; name: string; district_name: string; district_number: number }>>([]);
  const [routeNames, setRouteNames] = useState<string[]>([]);
  const [routeBlocks, setRouteBlocks] = useState<RouteBlock[]>([]);
  const [showSidebar, setShowSidebar] = useState(
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true
  );

  const {
    layers, toggleLayer,
    addCustomer, addCustomers, updateCustomer, removeCustomer,
    selectedCustomer, setSelectedCustomer,
    editMode, setEditMode,
    highlightMismatch, toggleHighlightMismatch,
    clearFilter,
    userLocation, setUserLocation,
    selectedDistrict, selectedNeighborhood, selectedRoute,
    setSelectedDistrict, setSelectedNeighborhood, setSelectedRoute,
    searchQuery, setSearchQuery,
    selectedSource, setSelectedSource,
    routingMode, setRoutingMode,
    routingWaypoints, addRoutingWaypoint, removeRoutingWaypoint, clearRoutingWaypoints, setRoutingWaypoints,
    routeResult, setRouteResult, routingLoading, setRoutingLoading,
  } = useMapStore();

  // Dynamically import leaflet and plugins
  useEffect(() => {
    async function initLeaflet() {
      const L = await import('leaflet');
      await import('leaflet/dist/leaflet.css');
      await import('@geoman-io/leaflet-geoman-free');
      await import('@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css');

      // Fix marker icon
      delete (L.Icon.Default.prototype as Record<string, unknown>)._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      });

      leafletRef.current = L;

      if (!mapContainerRef.current || mapRef.current) return;

      const map = L.map(mapContainerRef.current, {
        center: [35.6892, 51.389],
        zoom: 11,
        zoomControl: false,
        pmIgnore: false,
      });

      L.control.zoom({ position: 'topright' }).addTo(map);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);

      map.pm.addControls({
        position: 'topleft',
        drawMarker: false,
        drawPolyline: false,
        drawRectangle: false,
        drawCircle: false,
        drawCircleMarker: false,
        drawText: false,
        drawPolygon: false,
        editMode: false,
        removalMode: false,
        cutPolygon: false,
      });

      customerLayerRef.current = L.layerGroup().addTo(map);
      districtLayerRef.current = L.layerGroup().addTo(map);
      neighborhoodLayerRef.current = L.layerGroup().addTo(map);
      routeLayerRef.current = L.layerGroup().addTo(map);
      routingLayerRef.current = L.layerGroup().addTo(map);
      waypointMarkerLayerRef.current = L.layerGroup().addTo(map);

      map.on('click', (e: { latlng: { lat: number; lng: number } }) => {
        if (editMode === 'addCustomer') {
          setEditDialog({ open: true, customer: null, lat: e.latlng.lat, lng: e.latlng.lng });
        }
      });

      mapRef.current = map;
    }
    initLeaflet();
  }, []);

  // Load metadata (no customers) + stats
  useEffect(() => {
    async function loadData() {
      try {
        const [distRes, neighRes, routeNamesRes, routeBlocksRes, statsRes] = await Promise.all([
          fetch('/api/geojson/districts'),
          fetch('/api/geojson/neighborhoods'),
          fetch('/api/routes'),
          fetch('/api/route-blocks'),
          fetch('/api/customers/by-filter'),
        ]);
        const distData = await distRes.json();
        const neighData = await neighRes.json();
        const routeNamesData = await routeNamesRes.json();
        const routeBlocksData = await routeBlocksRes.json();
        const statsData = await statsRes.json();

        setDistricts(distData.districts);
        setDistrictNames(distData.names);
        setNeighborhoods(neighData.neighborhoods);
        setNeighborhoodNames(neighData.names);
        setRouteNames(routeNamesData.routes);
        setRouteBlocks(routeBlocksData.routeBlocks || []);
        setStats(statsData);
        setLoading(false);
      } catch (err) {
        console.error('Failed to load data:', err);
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Fetch filtered customers from server when filter changes
  const fetchFilteredCustomers = useCallback(async () => {
    const requestId = ++customerRequestIdRef.current;
    setLoadingCustomers(true);
    setLoadedNeighborhood('');
    try {
      const params = new URLSearchParams();
      if (selectedRoute) params.set('route', selectedRoute);
      if (selectedDistrict) params.set('district', selectedDistrict);
      if (selectedNeighborhood) params.set('neighborhood', selectedNeighborhood);
      if (searchQuery) params.set('search', searchQuery);

      const res = await fetch(`/api/customers/by-filter?${params.toString()}`);
      const data = await res.json();
      if (requestId !== customerRequestIdRef.current) return;

      setCustomers(data.customers || []);
      setLoadedNeighborhood(selectedNeighborhood);
      setStats({
        total: data.total,
        sourceCounts: data.sourceCounts || {},
        filteredSourceCounts: data.filteredSourceCounts,
      });
    } catch (err) {
      if (requestId !== customerRequestIdRef.current) return;
      console.error('Failed to fetch customers:', err);
      setCustomers([]);
      setLoadedNeighborhood('');
    } finally {
      if (requestId === customerRequestIdRef.current) {
        setLoadingCustomers(false);
      }
    }
  }, [selectedRoute, selectedDistrict, selectedNeighborhood, searchQuery]);

  // Trigger customer fetch when filter changes
  useEffect(() => {
    fetchFilteredCustomers();
  }, [fetchFilteredCustomers]);

  // Render districts
  useEffect(() => {
    const L = leafletRef.current;
    if (!L || !districtLayerRef.current) return;
    const dl = districtLayerRef.current as ReturnType<typeof L.layerGroup>;
    dl.clearLayers();
    if (!layers.districts) return;

    districts.forEach((d, i) => {
      const geojson = L.geoJSON(d.geometry as GeoJSON.GeometryObject, {
        style: {
          color: DISTRICT_COLORS[i % DISTRICT_COLORS.length],
          weight: 2,
          fillColor: DISTRICT_COLORS[i % DISTRICT_COLORS.length],
          fillOpacity: 0.08,
          opacity: 0.7,
        },
        onEachFeature: (_feature: unknown, layer: unknown) => {
          const l = layer as L.Polygon;
          l.bindTooltip(d.name, { sticky: true, direction: 'top' });
          l.on('click', () => {
            setSelectedDistrict(d.name);
          });
          if (editMode === 'editPolygon') {
            l.pm?.enable({ allowSelfIntersection: false });
          }
        },
      });
      dl.addLayer(geojson);
    });
  }, [districts, layers.districts, editMode, setSelectedDistrict]);

  // Render neighborhoods
  useEffect(() => {
    const L = leafletRef.current;
    if (!L || !neighborhoodLayerRef.current) return;
    const nl = neighborhoodLayerRef.current as ReturnType<typeof L.layerGroup>;
    nl.clearLayers();
    if (!layers.neighborhoods) return;

    // Color neighborhoods by district using a palette
    const neighborhoodColorMap = new Map<string, string>();
    const NEIGHBORHOOD_PALETTE = [
      '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444',
      '#ec4899', '#6366f1', '#14b8a6', '#84cc16', '#f97316',
      '#e11d48', '#a855f7', '#0ea5e9', '#22c55e', '#eab308',
      '#d946ef', '#3b82f6', '#059669', '#65a30d', '#ea580c',
      '#be185d', '#7c3aed', '#0891b2', '#16a34a', '#ca8a04',
    ];
    const districtNamesList = [...new Set(neighborhoods.map(n => n.district_name))];
    districtNamesList.forEach((dName, i) => {
      neighborhoodColorMap.set(dName, NEIGHBORHOOD_PALETTE[i % NEIGHBORHOOD_PALETTE.length]);
    });

    neighborhoods.forEach((n) => {
      const nColor = neighborhoodColorMap.get(n.district_name) || '#818cf8';
      const isSelected = selectedNeighborhood === n.name && selectedDistrict === n.district_name;
      const geojson = L.geoJSON(n.geometry as GeoJSON.GeometryObject, {
        style: {
          color: nColor,
          fillColor: nColor,
          fillOpacity: isSelected ? 0.45 : 0.15,
          opacity: isSelected ? 1 : 0.9,
          weight: isSelected ? 3 : 2.5,
          dashArray: isSelected ? '' : '4, 4',
        },
      });

      geojson.eachLayer((layer: unknown) => {
        const l = layer as L.Polygon;
        l.bindTooltip(n.name, { sticky: true, direction: 'top' });
        l.on('click', () => {
          if (isSelected) {
            setSelectedNeighborhood('');
          } else {
            setSelectedDistrict(n.district_name);
            setSelectedNeighborhood(n.name);
          }
        });
        if (editMode === 'editPolygon') {
          l.pm?.enable({ allowSelfIntersection: false });
        }
      });

      nl.addLayer(geojson);
    });
  }, [
    neighborhoods,
    layers.neighborhoods,
    editMode,
    selectedDistrict,
    selectedNeighborhood,
    setSelectedDistrict,
    setSelectedNeighborhood,
  ]);

  // Render route block polygons (from database - real polygons)
  useEffect(() => {
    const L = leafletRef.current;
    if (!L || !routeLayerRef.current) return;
    const rl = routeLayerRef.current as ReturnType<typeof L.layerGroup>;
    rl.clearLayers();
    if (!layers.routes || routeBlocks.length === 0) return;

    // Generate distinct colors using golden angle HSL
    const routeColorMap = new Map<string, string>();
    routeBlocks.forEach((rb, i) => {
      const hue = (i * 137.508) % 360;
      routeColorMap.set(rb.name, `hsl(${hue}, 65%, 50%)`);
    });

    routeBlocks.forEach((rb) => {
      if (!rb.geometry?.coordinates?.[0]) return;

      const color = routeColorMap.get(rb.name) || '#888';

      // Convert GeoJSON [lng, lat] to Leaflet [lat, lng]
      const latLngs = rb.geometry.coordinates[0].map(
        (c) => [c[1], c[0]] as [number, number]
      );

      const polygon = L.polygon(latLngs, {
        color: color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.12,
        opacity: 0.8,
        dashArray: '6, 3',
      });

      polygon.bindTooltip(
        `<div style="direction:rtl;text-align:right;font-size:12px;">
          <strong>${rb.name}</strong><br/>
          <span style="color:#666;">تعداد مشتری: ${rb.customerCount}</span><br/>
          <span style="color:#888;">هسته: ${rb.coreCustomerCount} | خارج: ${rb.outlierCount}</span>
          ${rb.salesOffice ? `<br/><span style="color:#999;">دفتر: ${rb.salesOffice}</span>` : ''}
        </div>`,
        { sticky: true, direction: 'top', className: 'custom-tooltip' }
      );

      polygon.on('click', () => {
        setSelectedRoute(rb.name);
      });

      if (editMode === 'editPolygon') {
        polygon.pm?.enable({ allowSelfIntersection: false });
      }

      rl.addLayer(polygon);
    });
  }, [routeBlocks, layers.routes, editMode, setSelectedRoute]);

  // Client-side source filter (applied on already-fetched customers)
  const displayCustomers = selectedSource
    ? customers.filter((c) => c.source === selectedSource)
    : customers;
  const selectedNeighborhoodId = neighborhoodNames.find(
    (neighborhood) => neighborhood.name === selectedNeighborhood
      && neighborhood.district_name === selectedDistrict
  )?.id || '';

  // Render customer points
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current as ReturnType<typeof L.map> | null;
    if (!L || !customerLayerRef.current) return;
    const cl = customerLayerRef.current as ReturnType<typeof L.layerGroup>;
    cl.clearLayers();
    if (!layers.customers) return;

    displayCustomers.forEach((customer) => {
      const isMismatch = highlightMismatch && customer.routeChange && customer.routeChange !== 'بدون تغییر';
      const sourceColors: Record<string, string> = { 'بلده': '#f59e0b', 'SNAPP_EXPRESS': '#10b981' };
      const sourceBorderColors: Record<string, string> = { 'بلده': '#d97706', 'SNAPP_EXPRESS': '#059669' };
      const sourceColor = sourceColors[customer.source] || '#3b82f6';
      const color = isMismatch ? '#ef4444' : (customer.isNew ? '#22c55e' : sourceColor);
      const radius = isMismatch ? 6 : 4;

      const marker = L.circleMarker([customer.lat, customer.lng], {
        radius,
        fillColor: color,
        color: isMismatch ? '#dc2626' : (sourceBorderColors[customer.source] || '#1d4ed8'),
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.8,
      });

      const tooltipContent = `
        <div style="direction:rtl; text-align:right; font-size:12px; min-width:200px;">
          <strong style="color:${isMismatch ? '#ef4444' : '#1e40af'}">${customer.customerName}</strong><br/>
          <span style="color:#666">فروشنده:</span> ${customer.sellerName}<br/>
          <span style="color:#666">مسیر:</span> ${customer.currentRoute}<br/>
          <span style="color:#666">بلوک:</span> ${customer.blockName}<br/>
          ${isMismatch ? '<span style="color:#ef4444; font-weight:bold">&#9888; عدم تطابق مسیر</span><br/>' : ''}
          <span style="color:#666">آدرس:</span> ${customer.address}<br/>
          <span style="color:#999">منبع: ${customer.source}</span>
        </div>
      `;

      marker.bindTooltip(tooltipContent, {
        sticky: true,
        direction: 'top',
        className: 'custom-tooltip',
      });

      marker.on('click', (event: { originalEvent: MouseEvent }) => {
        L.DomEvent.stopPropagation(event.originalEvent);
        if (routingMode) {
          setOptimizationSummary(null);
          addRoutingWaypoint(customer);
          return;
        }
        setSelectedCustomer(customer);
        setReportStatus('');
        setReportDescription('');
        setReportFollowUpDate('');
        setReportError('');
        setReportDialog({ open: true, customer });
      });

      // Drag to edit point position
      if (editMode === 'editPoint' && map) {
        marker.on('mouseover', () => {
          map.getContainer().style.cursor = 'grab';
        });
        marker.on('mouseout', () => {
          map.getContainer().style.cursor = '';
        });
        marker.on('mousedown', () => {
          map.getContainer().style.cursor = 'grabbing';
          const onMove = (e: { latlng: { lat: number; lng: number } }) => {
            marker.setLatLng(e.latlng);
          };
          const onUp = (e: { latlng: { lat: number; lng: number } }) => {
            map.getContainer().style.cursor = '';
            map.off('mousemove', onMove);
            map.off('mouseup', onUp);
            updateCustomer(customer.id, {
              lat: e.latlng.lat,
              lng: e.latlng.lng,
            });
          };
          map.on('mousemove', onMove);
          map.on('mouseup', onUp);
        });
      }

      cl.addLayer(marker);
    });
  }, [displayCustomers, layers.customers, editMode, highlightMismatch, setSelectedCustomer, updateCustomer, routingMode, addRoutingWaypoint]);

  // Draw routing waypoints on map
  useEffect(() => {
    const L = leafletRef.current;
    if (!L || !waypointMarkerLayerRef.current) return;
    const wml = waypointMarkerLayerRef.current as ReturnType<typeof L.layerGroup>;
    wml.clearLayers();
    if (!routingMode) return;

    routingWaypoints.forEach((wp, idx) => {
      const isStart = idx === 0;
      const isEnd = idx === routingWaypoints.length - 1 && routingWaypoints.length > 1;

      const markerIcon = L.divIcon({
        html: `<div style="
          width:${isStart || isEnd ? 28 : 24}px;
          height:${isStart || isEnd ? 28 : 24}px;
          background:${isStart ? '#10b981' : isEnd ? '#ef4444' : '#f59e0b'};
          border:3px solid white;
          border-radius:50%;
          box-shadow:0 2px 8px rgba(0,0,0,0.3);
          display:flex;align-items:center;justify-content:center;
          color:white;font-size:${isStart || isEnd ? 13 : 11}px;font-weight:bold;
        ">${idx + 1}</div>`,
        className: '',
        iconSize: [isStart || isEnd ? 28 : 24, isStart || isEnd ? 28 : 24],
        iconAnchor: [isStart || isEnd ? 14 : 12, isStart || isEnd ? 14 : 12],
      });

      const marker = L.marker([wp.customer.lat, wp.customer.lng], { icon: markerIcon, zIndexOffset: 1000 });
      marker.bindTooltip(
        `<div style="direction:rtl;text-align:right;font-size:12px;">
          <strong>${wp.customer.customerName}</strong><br/>
          <span style="color:#666;">ایستگاه ${idx + 1}</span>
        </div>`,
        { sticky: true, direction: 'top', className: 'custom-tooltip' }
      );
      wml.addLayer(marker);
    });
  }, [routingMode, routingWaypoints]);

  // Draw route polyline on map
  useEffect(() => {
    const L = leafletRef.current;
    if (!L || !routingLayerRef.current) return;
    const rl = routingLayerRef.current as ReturnType<typeof L.layerGroup>;
    rl.clearLayers();
    if (!routeResult) return;

    const coords = routeResult.geometry.coordinates.map(
      (c: number[]) => [c[1], c[0]] as [number, number]
    );

    // Draw the main route line with an animated dashed background
    const bgLine = L.polyline(coords, {
      color: '#1e40af',
      weight: 8,
      opacity: 0.2,
      lineCap: 'round',
      lineJoin: 'round',
    });
    rl.addLayer(bgLine);

    const mainLine = L.polyline(coords, {
      color: '#3b82f6',
      weight: 5,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
      dashArray: '12, 8',
    });
    rl.addLayer(mainLine);

    // Add direction arrows along the route
    for (let i = 0; i < coords.length - 1; i += Math.max(1, Math.floor(coords.length / 15))) {
      const arrowIcon = L.divIcon({
        html: `<div style="color:#1e40af;font-size:14px;transform:rotate(${bearing(coords[i], coords[Math.min(i + 1, coords.length - 1)])}deg);line-height:1;">▲</div>`,
        className: '',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      const arrow = L.marker(coords[i], { icon: arrowIcon, interactive: false });
      rl.addLayer(arrow);
    }

    // Fit map to route bounds
    const map = mapRef.current as ReturnType<typeof L.map> | null;
    if (map) {
      map.fitBounds(mainLine.getBounds(), { padding: [60, 60], duration: 1 });
    }
  }, [routeResult]);

  // Clear routing layers when exiting routing mode
  useEffect(() => {
    if (!routingMode) {
      const L = leafletRef.current;
      if (L && routingLayerRef.current) {
        (routingLayerRef.current as ReturnType<typeof L.layerGroup>).clearLayers();
      }
      if (L && waypointMarkerLayerRef.current) {
        (waypointMarkerLayerRef.current as ReturnType<typeof L.layerGroup>).clearLayers();
      }
    }
  }, [routingMode]);

  // User location
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current as ReturnType<typeof L.map> | null;
    if (!L || !map) return;
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          setUserLocation([lat, lng]);

          if (userMarkerRef.current) {
            map.removeLayer(userMarkerRef.current as L.Marker);
          }

          const pulseIcon = L.divIcon({
            html: '<div style="width:20px;height:20px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 0 10px rgba(59,130,246,0.5);animation:pulse 2s infinite;"></div>',
            className: '',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });

          userMarkerRef.current = L.marker([lat, lng], { icon: pulseIcon })
            .addTo(map)
            .bindTooltip('موقعیت شما', { direction: 'top', permanent: false });
        },
        () => {
          console.warn('Geolocation permission denied');
        },
        { enableHighAccuracy: true }
      );
    }
  }, [setUserLocation]);

  // Export to Excel
  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const XLSX = await import('xlsx');
      const routeOrder = new Map(
        routingWaypoints.map((waypoint, index) => [waypoint.customer.id, index + 1])
      );
      const exportCustomers = routingWaypoints.length > 0
        ? [...displayCustomers].sort((a, b) =>
            (routeOrder.get(a.id) || Number.MAX_SAFE_INTEGER)
            - (routeOrder.get(b.id) || Number.MAX_SAFE_INTEGER)
          )
        : displayCustomers;
      const data = exportCustomers.map((c) => ({
        'ترتیب مسیر': routeOrder.get(c.id) || '',
        'کد و نام مشتری': c.customerName,
        'نام فروشنده': c.sellerName,
        'مسیر فعلی': c.currentRoute,
        'بلوک': c.blockName,
        'تغییر مسیر': c.routeChange,
        'آدرس': c.address,
        'منبع': c.source,
        'عرض جغرافیایی': c.lat,
        'طول جغرافیایی': c.lng,
        'لینک مسیریابی بلد': userLocation ? buildBaladNavigationUrl(userLocation, c) : '',
      }));

      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'مشتریان');

      ws['!cols'] = [
        { wch: 12 }, { wch: 35 }, { wch: 25 }, { wch: 35 }, { wch: 35 },
        { wch: 20 }, { wch: 50 }, { wch: 10 }, { wch: 15 }, { wch: 15 }, { wch: 70 },
      ];

      XLSX.writeFile(wb, 'tehran_customers.xlsx');
    } catch (err) {
      console.error('Export failed:', err);
    }
    setIsExporting(false);
  }, [displayCustomers, routingWaypoints, userLocation]);

  // Save customer from dialog
  const handleSaveCustomer = useCallback((data: {
    customerName: string; sellerName: string; currentRoute: string; address: string; source: string;
  }) => {
    if (editDialog.customer) {
      // Update in local state
      setCustomers((prev) => prev.map((c) =>
        c.id === editDialog.customer!.id ? { ...c, ...data } : c
      ));
    } else {
      const newCustomer: CustomerPoint = {
        id: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...data,
        blockName: '',
        routeChange: '',
        lat: editDialog.lat,
        lng: editDialog.lng,
        isNew: true,
      };
      addCustomer(newCustomer);
      setCustomers((prev) => [...prev, newCustomer]);
    }
    setEditDialog({ open: false, customer: null, lat: 0, lng: 0 });
  }, [editDialog, addCustomer]);

  // Handle batch add
  const handleBatchAdd = useCallback(() => {
    const lines = batchText.trim().split('\n');
    const newCustomers: CustomerPoint[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length >= 1 && parts[0]) {
        const L = leafletRef.current;
        const map = mapRef.current as ReturnType<typeof L.map> | null;
        const center = map?.getCenter() || { lat: 35.6892, lng: 51.389 };
        const nc: CustomerPoint = {
          id: `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          customerName: parts[0] || '',
          sellerName: parts[1] || '',
          currentRoute: parts[2] || '',
          blockName: '',
          routeChange: '',
          address: parts[3] || '',
          source: batchSource,
          lat: center.lat + (Math.random() - 0.5) * 0.01,
          lng: center.lng + (Math.random() - 0.5) * 0.01,
          isNew: true,
        };
        newCustomers.push(nc);
      }
    }

    if (newCustomers.length > 0) {
      addCustomers(newCustomers);
      setCustomers((prev) => [...prev, ...newCustomers]);
      setBatchText('');
      setBatchDialog(false);
      setEditMode('editPoint');
    }
  }, [batchText, batchSource, addCustomers, setEditMode]);

  // Remove selected customer
  const handleRemoveCustomer = useCallback(() => {
    if (editDialog.customer) {
      removeCustomer(editDialog.customer.id);
      setCustomers((prev) => prev.filter((c) => c.id !== editDialog.customer!.id));
      setEditDialog({ open: false, customer: null, lat: 0, lng: 0 });
    }
  }, [editDialog.customer, removeCustomer]);

  // Save a visit report for the selected customer
  const handleSubmitReport = useCallback(async () => {
    const customer = reportDialog.customer;
    if (!customer || reportSubmitting) return;

    if (!reportStatus || !reportDescription.trim()) {
      setReportError('نتیجه مراجعه و توضیحات گزارش را وارد کنید.');
      return;
    }

    setReportSubmitting(true);
    setReportError('');

    try {
      const response = await fetch(`/api/customers/${encodeURIComponent(customer.id)}/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitStatus: reportStatus,
          description: reportDescription,
          followUpDate: reportFollowUpDate || null,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'ثبت گزارش انجام نشد.');
      }

      setReportDialog({ open: false, customer: null });
      setReportStatus('');
      setReportDescription('');
      setReportFollowUpDate('');
      toast({
        title: 'گزارش ثبت شد',
        description: `گزارش مراجعه ${customer.customerName} با موفقیت ذخیره شد.`,
      });
    } catch (error) {
      setReportError(error instanceof Error ? error.message : 'ثبت گزارش انجام نشد.');
    } finally {
      setReportSubmitting(false);
    }
  }, [reportDialog.customer, reportStatus, reportDescription, reportFollowUpDate, reportSubmitting]);

  // Go to user location
  const goToUserLocation = useCallback(() => {
    const L = leafletRef.current;
    const map = mapRef.current as ReturnType<typeof L.map> | null;
    if (!navigator.geolocation || !map) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        map.flyTo([lat, lng], 16, { duration: 1.5 });
      },
      () => {},
      { enableHighAccuracy: true }
    );
  }, []);

  const getCurrentUserLocation = useCallback((): Promise<UserLatLng> => {
    if (!navigator.geolocation) {
      return Promise.reject(new Error('موقعیت مکانی در این دستگاه در دسترس نیست.'));
    }

    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const location: UserLatLng = [
            position.coords.latitude,
            position.coords.longitude,
          ];
          setUserLocation(location);
          resolve(location);
        },
        () => reject(new Error('برای مسیریابی، دسترسی به موقعیت مکانی را فعال کنید.')),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
      );
    });
  }, [setUserLocation]);

  const openBaladNavigation = useCallback(async (customer: CustomerPoint) => {
    const navigationWindow = window.open('about:blank', '_blank');
    try {
      const origin = userLocation || await getCurrentUserLocation();
      const url = buildBaladNavigationUrl(origin, customer);
      if (navigationWindow) {
        navigationWindow.opener = null;
        navigationWindow.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (error) {
      navigationWindow?.close();
      toast({
        variant: 'destructive',
        title: 'مسیریابی بلد باز نشد',
        description: error instanceof Error ? error.message : 'موقعیت فعلی شما دریافت نشد.',
      });
    }
  }, [getCurrentUserLocation, userLocation]);

  // Draw the selected order with Raah traffic-aware directions
  const calculateRoute = useCallback(async () => {
    if (routingWaypoints.length < 2) return;
    setRoutingLoading(true);
    setRoutingAction('calculate');
    setOptimizationSummary(null);
    setRouteResult(null);
    try {
      const coords = routingWaypoints
        .map((w) => `${w.customer.lng},${w.customer.lat}`)
        .join(';');
      const res = await fetch(`/api/raah/route?coords=${encodeURIComponent(coords)}`);
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }
      const route = data.routes[0];
      setRouteResult({
        distance: route.distance,
        duration: route.duration,
        geometry: route.geometry,
        legs: route.legs || [],
      });
    } catch (err) {
      console.error('Routing failed:', err);
      toast({
        variant: 'destructive',
        title: 'مسیریابی انجام نشد',
        description: err instanceof Error ? err.message : 'ارتباط با سرویس مسیریابی برقرار نشد.',
      });
    } finally {
      setRoutingLoading(false);
      setRoutingAction(null);
    }
  }, [routingWaypoints, setRouteResult, setRoutingLoading]);

  // Optimize middle stops, then draw the final route with Raah traffic data
  const optimizeRoute = useCallback(async () => {
    if (routingWaypoints.length < 4) return;

    setRoutingLoading(true);
    setRoutingAction('optimize');
    setOptimizationSummary(null);

    try {
      const coords = routingWaypoints
        .map((waypoint) => `${waypoint.customer.lng},${waypoint.customer.lat}`)
        .join(';');

      const [currentResponse, optimizedResponse] = await Promise.all([
        fetch(`/api/raah/route?coords=${encodeURIComponent(coords)}`),
        fetch(`/api/osrm/trip?coords=${encodeURIComponent(coords)}`),
      ]);
      const [currentData, optimizedData] = await Promise.all([
        currentResponse.json(),
        optimizedResponse.json(),
      ]);

      if (!currentResponse.ok || currentData.error) {
        throw new Error(currentData.error || 'محاسبه مسیر فعلی انجام نشد.');
      }
      if (!optimizedResponse.ok || optimizedData.error) {
        throw new Error(optimizedData.error || 'بهینه‌سازی ترتیب انجام نشد.');
      }
      if (!Array.isArray(optimizedData.order) || optimizedData.order.length !== routingWaypoints.length) {
        throw new Error('ترتیب پیشنهادی سرویس معتبر نیست.');
      }

      const optimizedCustomers = optimizedData.order.map(
        (inputIndex: number) => routingWaypoints[inputIndex].customer
      );
      const changedStops = optimizedData.order.filter(
        (inputIndex: number, optimizedIndex: number) => inputIndex !== optimizedIndex
      ).length;

      const optimizedCoords = optimizedCustomers
        .map((customer: CustomerPoint) => `${customer.lng},${customer.lat}`)
        .join(';');
      const optimizedRouteResponse = await fetch(
        `/api/raah/route?coords=${encodeURIComponent(optimizedCoords)}`
      );
      const optimizedRouteData = await optimizedRouteResponse.json();
      if (!optimizedRouteResponse.ok || optimizedRouteData.error) {
        throw new Error(optimizedRouteData.error || 'رسم مسیر بهینه با سرویس راه انجام نشد.');
      }

      const originalRoute = currentData.routes[0] as RouteResult;
      const optimizedRouteResult = optimizedRouteData.routes[0] as RouteResult;
      setRoutingWaypoints(optimizedCustomers);
      setRouteResult(optimizedRouteResult);
      setOptimizationSummary({
        savedDistance: originalRoute.distance - optimizedRouteResult.distance,
        savedDuration: originalRoute.duration - optimizedRouteResult.duration,
        changedStops,
      });

      toast({
        title: 'ترتیب مسیر بهینه شد',
        description: changedStops > 0
          ? `جای ${changedStops.toLocaleString('fa-IR')} توقف تغییر کرد.`
          : 'ترتیب فعلی از قبل مناسب بود.',
      });
    } catch (error) {
      console.error('Route optimization failed:', error);
      toast({
        variant: 'destructive',
        title: 'بهینه‌سازی انجام نشد',
        description: error instanceof Error ? error.message : 'ارتباط با سرویس بهینه‌سازی برقرار نشد.',
      });
    } finally {
      setRoutingLoading(false);
      setRoutingAction(null);
    }
  }, [routingWaypoints, setRouteResult, setRoutingLoading, setRoutingWaypoints]);

  // Build an open-ended route for all visible customers in the selected neighborhood.
  const optimizeNeighborhoodRoute = useCallback(async () => {
    if (!selectedNeighborhood || !selectedSource || displayCustomers.length === 0) return;

    const neighborhoodCustomers = displayCustomers.filter((customer) =>
      Number.isFinite(customer.lat) && Number.isFinite(customer.lng)
    );
    if (neighborhoodCustomers.length === 0) return;
    setRoutingLoading(true);
    setRoutingAction('neighborhood');
    setOptimizationSummary(null);
    setRouteResult(null);

    try {
      const origin = await getCurrentUserLocation();
      const inputCoords = [
        `${origin[1]},${origin[0]}`,
        ...neighborhoodCustomers.map((customer) => `${customer.lng},${customer.lat}`),
      ];

      const savedOrders = neighborhoodCustomers
        .map((customer) => customer.optimizedOrder)
        .filter((order): order is number => Number.isInteger(order));
      const hasValidSavedOrder = neighborhoodCustomers.every((customer) =>
        customer.optimizedNeighborhoodId === selectedNeighborhoodId
        && Number.isInteger(customer.optimizedOrder)
      ) && [...savedOrders].sort((a, b) => a - b).every((order, index) => order === index + 1);

      let optimizedCustomers = hasValidSavedOrder
        ? [...neighborhoodCustomers].sort(
            (first, second) => (first.optimizedOrder || 0) - (second.optimizedOrder || 0)
          )
        : neighborhoodCustomers;

      if (!hasValidSavedOrder && neighborhoodCustomers.length > 99) {
        optimizedCustomers = geographicCustomerOrder(neighborhoodCustomers, origin);
      } else if (!hasValidSavedOrder && neighborhoodCustomers.length > 1) {
        const optimizationResponse = await fetch(
          `/api/osrm/trip?coords=${encodeURIComponent(inputCoords.join(';'))}&destination=any`
        );
        const optimizationData = await optimizationResponse.json();
        if (!optimizationResponse.ok || optimizationData.error) {
          throw new Error(optimizationData.error || 'ترتیب سریع مشتریان محله پیدا نشد.');
        }
        if (!Array.isArray(optimizationData.order) || optimizationData.order.length !== inputCoords.length) {
          throw new Error('ترتیب پیشنهادی سرویس معتبر نیست.');
        }

        optimizedCustomers = optimizationData.order
          .filter((inputIndex: number) => inputIndex !== 0)
          .map((inputIndex: number) => neighborhoodCustomers[inputIndex - 1])
          .filter(Boolean);
      }

      if (!hasValidSavedOrder) {
        const saveResponse = await fetch('/api/customers/optimized-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            neighborhood: selectedNeighborhood,
            district: selectedDistrict,
            source: selectedSource,
            orderedCustomerIds: optimizedCustomers.map((customer) => customer.id),
          }),
        });
        const saveData = await saveResponse.json();
        if (!saveResponse.ok || saveData.error) {
          throw new Error(saveData.error || 'ذخیره ترتیب مشتریان انجام نشد.');
        }

        const orderById = new Map(
          optimizedCustomers.map((customer, index) => [customer.id, index + 1])
        );
        setCustomers((currentCustomers) => currentCustomers.map((customer) => {
          const optimizedOrder = orderById.get(customer.id);
          if (!optimizedOrder) return customer;
          return {
            ...customer,
            optimizedOrder,
            optimizedNeighborhood: selectedNeighborhood,
            optimizedNeighborhoodId: saveData.neighborhoodId,
            routeOptimizedAt: saveData.optimizedAt,
          };
        }));
      }

      // Show persisted numbering even if drawing the traffic line fails afterwards.
      setRoutingMode(true);
      setRoutingWaypoints(optimizedCustomers);

      const finalCoordinates = [
        `${origin[1]},${origin[0]}`,
        ...optimizedCustomers.map((customer) => `${customer.lng},${customer.lat}`),
      ];

      setRouteResult(await fetchTrafficRoute(finalCoordinates));
      toast({
        title: hasValidSavedOrder ? 'ترتیب ذخیره‌شده بارگذاری شد' : `مسیر محله ${selectedNeighborhood} بهینه شد`,
        description: `${optimizedCustomers.length.toLocaleString('fa-IR')} مشتری سورس ${selectedSource} شماره‌گذاری شدند.`,
      });
    } catch (error) {
      console.error('Neighborhood route optimization failed:', error);
      toast({
        variant: 'destructive',
        title: 'ساخت مسیر محله انجام نشد',
        description: error instanceof Error ? error.message : 'ارتباط با سرویس مسیریابی برقرار نشد.',
      });
    } finally {
      setRoutingLoading(false);
      setRoutingAction(null);
    }
  }, [
    displayCustomers,
    getCurrentUserLocation,
    selectedNeighborhood,
    selectedNeighborhoodId,
    selectedDistrict,
    selectedSource,
    setRouteResult,
    setRoutingLoading,
    setRoutingMode,
    setRoutingWaypoints,
  ]);

  // A neighborhood route always belongs to exactly one source. Select the first available
  // source automatically, while preserving the user's source when it exists in the neighborhood.
  useEffect(() => {
    if (
      !selectedNeighborhood
      || loadedNeighborhood !== selectedNeighborhood
      || loadingCustomers
      || customers.length === 0
    ) return;

    const neighborhoodSources = [...new Set(customers.map((customer) => customer.source))]
      .filter(Boolean)
      .sort((first, second) => first.localeCompare(second, 'fa'));
    if (neighborhoodSources.length > 0 && !neighborhoodSources.includes(selectedSource)) {
      autoRouteRequestRef.current = '';
      setSelectedSource(neighborhoodSources[0]);
    }
  }, [
    customers,
    loadedNeighborhood,
    loadingCustomers,
    selectedNeighborhood,
    selectedSource,
    setSelectedSource,
  ]);

  // Automatically calculate and number the route after the selected neighborhood finishes loading.
  useEffect(() => {
    if (!selectedNeighborhood) {
      autoRouteRequestRef.current = '';
      return;
    }
    if (
      loadedNeighborhood !== selectedNeighborhood
      || loadingCustomers
      || routingLoading
      || !selectedSource
      || displayCustomers.length === 0
    ) return;

    const routeKey = `${selectedNeighborhood}|${selectedSource}|${displayCustomers
      .map((customer) => customer.id)
      .sort()
      .join(',')}`;
    if (autoRouteRequestRef.current === routeKey) return;

    autoRouteRequestRef.current = routeKey;
    void optimizeNeighborhoodRoute();
  }, [
    displayCustomers,
    loadedNeighborhood,
    loadingCustomers,
    optimizeNeighborhoodRoute,
    routingLoading,
    selectedNeighborhood,
    selectedSource,
  ]);

  // Format distance/duration helpers
  const formatDistance = (m: number) => {
    if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m)} m`;
  };
  const formatDuration = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h} ساعت ${m} دقیقه`;
    return `${m} دقیقه`;
  };

  // Fly to district
  const flyToDistrict = useCallback((name: string) => {
    const L = leafletRef.current;
    const map = mapRef.current as ReturnType<typeof L.map> | null;
    if (!L || !map) return;
    const dist = districts.find((d) => d.name === name);
    if (dist) {
      const layer = L.geoJSON(dist.geometry as GeoJSON.GeometryObject);
      map.flyToBounds(layer.getBounds(), { padding: [20, 20], duration: 1 });
    }
  }, [districts]);

  // Determine current source counts to show
  const isFiltered = selectedDistrict || selectedNeighborhood || selectedRoute || searchQuery;
  const currentSourceCounts = isFiltered && stats.filteredSourceCounts ? stats.filteredSourceCounts : stats.sourceCounts;
  const currentCount = displayCustomers.length;
  const hasFilter = selectedDistrict || selectedNeighborhood || selectedRoute || selectedSource || searchQuery;

  // Source list for dropdown (from stats)
  const sourceList = Object.keys(stats.sourceCounts);

  return (
    <div className="relative w-full h-screen h-[100dvh] flex" dir="rtl">
      {/* Sidebar Toggle (mobile) - always visible on mobile */}
      <button
        onClick={() => setShowSidebar(!showSidebar)}
        className="absolute top-3 right-3 z-[1001] lg:hidden bg-white dark:bg-gray-800 rounded-lg shadow-lg p-3 hover:bg-gray-50 dark:hover:bg-gray-700 active:bg-gray-100 dark:active:bg-gray-600 transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
        aria-label={showSidebar ? 'بستن منو' : 'باز کردن منو'}
      >
        {showSidebar ? (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
        )}
      </button>

      {/* Mobile Backdrop */}
      {showSidebar && (
        <div
          className="fixed inset-0 z-[998] bg-black/40 lg:hidden transition-opacity duration-300"
          onClick={() => setShowSidebar(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <div
        className={`
          fixed inset-x-0 bottom-0 z-[999] w-full max-h-[60vh]
          lg:relative lg:inset-auto lg:bottom-auto lg:left-auto lg:right-auto
          lg:w-80 lg:max-h-none lg:h-full
          rounded-t-2xl lg:rounded-none
          bg-white dark:bg-gray-900
          border-t border-gray-200 dark:border-gray-700
          lg:border-t-0 lg:border-l
          overflow-y-auto
          flex flex-col
          transition-transform duration-300 ease-in-out
          ${showSidebar
            ? 'translate-y-0 lg:translate-x-0'
            : 'translate-y-full lg:translate-x-full pointer-events-none lg:pointer-events-auto'
          }
        `}
      >
        {/* Drag handle (mobile only) */}
        <div className="flex justify-center pt-2.5 pb-1 lg:hidden flex-shrink-0">
          <div className="w-10 h-1 bg-gray-300 dark:bg-gray-600 rounded-full" />
        </div>

        {/* Close button (mobile only) */}
        <button
          onClick={() => setShowSidebar(false)}
          className="absolute top-2 left-2 z-10 lg:hidden bg-gray-100 dark:bg-gray-800 rounded-full min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700 active:bg-gray-300 dark:active:bg-gray-600 transition-colors"
          aria-label="بستن"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>

        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-l from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 flex-shrink-0">
          <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" /></svg>
            نقشه تعاملی تهران
          </h1>
          <p className="text-xs text-gray-500 mt-1">مدیریت مشتریان و مسیرها</p>
        </div>

        {/* Stats - with source breakdown */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <div className="grid grid-cols-2 gap-1.5 mb-2">
            <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-2 min-h-[56px] flex flex-col items-center justify-center">
              <div className="text-base font-bold text-blue-600">
                {isFiltered ? currentCount.toLocaleString('fa-IR') : stats.total.toLocaleString('fa-IR')}
              </div>
              <div className="text-[9px] text-gray-500">
                {isFiltered ? 'مشتری فیلترشده' : 'کل مشتریان'}
              </div>
            </div>
            <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-lg p-2 min-h-[56px] flex flex-col items-center justify-center">
              <div className="text-base font-bold text-emerald-600">22</div>
              <div className="text-[9px] text-gray-500">منطقه</div>
            </div>
          </div>
          {/* Source breakdown */}
          <div className="flex gap-1.5">
            {sourceList.map((src) => (
              <div key={src} className="flex-1 bg-purple-50 dark:bg-purple-950/30 rounded-lg p-1.5 flex flex-col items-center justify-center min-h-[44px]">
                <div className="text-sm font-bold text-purple-600">
                  {(currentSourceCounts[src] || 0).toLocaleString('fa-IR')}
                </div>
                <div className="text-[9px] text-gray-500">{src}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Info banner when no filter */}
        {!hasFilter && !loading && (
          <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/20 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
            <p className="text-[11px] text-amber-700 dark:text-amber-400 text-center">
              برای مشاهده مشتریان، یک مسیر، منطقه یا محله را انتخاب کنید
            </p>
          </div>
        )}

        {/* Search */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <input
            type="text"
            placeholder="جستجوی مشتری..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 min-h-[44px]"
          />
        </div>

        {/* Layers */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">لایه‌ها</h3>
          <div className="space-y-1">
            {[
              { key: 'districts' as const, label: 'مناطق شهرداری', color: 'bg-emerald-500' },
              { key: 'neighborhoods' as const, label: 'محله‌ها', color: 'bg-violet-500' },
              { key: 'routes' as const, label: 'مسیرها (پلی‌گون)', color: 'bg-orange-500' },
              { key: 'customers' as const, label: 'مشتریان', color: 'bg-blue-500' },
            ].map(({ key, label, color }) => (
              <label key={key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700 rounded-lg px-2 py-2 min-h-[44px]">
                <div className={`w-3.5 h-3.5 rounded flex-shrink-0 ${color} ${layers[key] ? 'opacity-100' : 'opacity-30'}`} />
                <span className="text-gray-700 dark:text-gray-300 flex-1">{label}</span>
                <input
                  type="checkbox"
                  checked={layers[key]}
                  onChange={() => toggleLayer(key)}
                  className="accent-emerald-600 w-5 h-5 flex-shrink-0"
                />
              </label>
            ))}
          </div>
        </div>

        {/* Mismatch Toggle */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <label className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700 rounded-lg px-2 py-2 min-h-[44px]">
            <div className={`w-3.5 h-3.5 rounded flex-shrink-0 ${highlightMismatch ? 'bg-red-500' : 'bg-gray-300'}`} />
            <span className="text-sm text-gray-700 dark:text-gray-300 flex-1">نمایش عدم تطابق مسیر</span>
            <input
              type="checkbox"
              checked={highlightMismatch}
              onChange={toggleHighlightMismatch}
              className="accent-red-500 w-5 h-5 flex-shrink-0"
            />
          </label>
          {highlightMismatch && (
            <p className="text-xs text-red-500 mt-1 mr-5">
              نقاطی که مسیر ثبت‌شده با بلوک محل حضورشان مطابقت ندارد قرمز نمایش داده می‌شوند
            </p>
          )}
        </div>

        {/* Tools */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">ابزارها</h3>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setEditMode(editMode === 'addCustomer' ? 'none' : 'addCustomer')}
              className={`text-xs px-2 py-2.5 rounded-lg border transition-colors min-h-[44px] ${
                editMode === 'addCustomer'
                  ? 'bg-emerald-500 text-white border-emerald-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700'
              }`}
            >
              + افزودن مشتری
            </button>
            <button
              onClick={() => setBatchDialog(true)}
              className="text-xs px-2 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700 transition-colors min-h-[44px]"
            >
              افزودن گروهی
            </button>
            <button
              onClick={() => setEditMode(editMode === 'editPoint' ? 'none' : 'editPoint')}
              className={`text-xs px-2 py-2.5 rounded-lg border transition-colors min-h-[44px] ${
                editMode === 'editPoint'
                  ? 'bg-amber-500 text-white border-amber-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700'
              }`}
            >
              ویرایش نقطه
            </button>
            <button
              onClick={() => setEditMode(editMode === 'editPolygon' ? 'none' : 'editPolygon')}
              className={`text-xs px-2 py-2.5 rounded-lg border transition-colors min-h-[44px] ${
                editMode === 'editPolygon'
                  ? 'bg-violet-500 text-white border-violet-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700'
              }`}
            >
              ویرایش پلی‌گون
            </button>
            <button
              onClick={goToUserLocation}
              className="text-xs px-2 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700 transition-colors col-span-2 min-h-[44px]"
            >
              📍 نمایش موقعیت من
            </button>
            <button
              onClick={() => {
                setOptimizationSummary(null);
                if (routingMode) {
                  setRoutingMode(false);
                } else {
                  setEditMode('none');
                  setRoutingMode(true);
                }
              }}
              className={`text-xs px-2 py-2.5 rounded-lg border transition-colors col-span-2 min-h-[44px] font-medium ${
                routingMode
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700'
              }`}
            >
              {routingMode ? '✕ خروج از مسیریابی' : '🚗 مسیریابی بین مشتریان'}
            </button>
          </div>
        </div>

        {/* Routing Panel */}
        {routingMode && (
          <div className="p-3 border-b border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 flex-shrink-0">
            <h3 className="text-sm font-semibold text-blue-700 dark:text-blue-400 mb-2">مسیریابی</h3>
            <p className="text-[11px] text-blue-600 dark:text-blue-400 mb-2">
              {routingWaypoints.length === 0
                ? 'روی نقاط مشتریان کلیک کنید تا اضافه شوند'
                : `${routingWaypoints.length} نقطه انتخاب شده`}
            </p>

            {/* Waypoint list */}
            {routingWaypoints.length > 0 && (
              <div className="space-y-1 mb-3 max-h-48 overflow-y-auto">
                {routingWaypoints.map((wp, idx) => (
                  <div
                    key={wp.customer.id}
                    className="flex items-center gap-2 bg-white dark:bg-gray-800 rounded-lg px-2 py-1.5 border border-blue-100 dark:border-blue-900"
                  >
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0 ${
                      idx === 0 ? 'bg-emerald-500' : idx === routingWaypoints.length - 1 ? 'bg-red-500' : 'bg-amber-500'
                    }`}>
                      {idx + 1}
                    </span>
                    <span className="text-xs text-gray-700 dark:text-gray-300 truncate flex-1" title={wp.customer.customerName}>
                      {wp.customer.customerName}
                    </span>
                    <button
                      onClick={() => openBaladNavigation(wp.customer)}
                      className="text-blue-500 hover:text-blue-700 active:text-blue-900 min-w-[32px] min-h-[32px] flex items-center justify-center transition-colors"
                      aria-label={`مسیریابی بلد به ${wp.customer.customerName}`}
                      title="مسیریابی از موقعیت من با بلد"
                    >
                      🧭
                    </button>
                    {idx > 0 && (
                      <button
                        onClick={() => {
                          setOptimizationSummary(null);
                          removeRoutingWaypoint(wp.customer.id);
                        }}
                        className="text-red-400 hover:text-red-600 active:text-red-800 min-w-[32px] min-h-[32px] flex items-center justify-center transition-colors"
                        aria-label="حذف"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Route action buttons */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={calculateRoute}
                disabled={routingWaypoints.length < 2 || routingLoading}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-xs rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 min-h-[44px] font-medium"
              >
                {routingAction === 'calculate' ? (
                  <><span className="animate-spin inline-block">⟳</span> در حال مسیریابی...</>
                ) : (
                  <>🚗 محاسبه مسیر</>
                )}
              </button>
              <button
                onClick={optimizeRoute}
                disabled={routingWaypoints.length < 4 || routingLoading}
                className="py-2.5 bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white text-xs rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5 min-h-[44px] font-medium"
                title={routingWaypoints.length < 4 ? 'برای بهینه‌سازی حداقل ۴ مشتری انتخاب کنید' : 'بهینه‌سازی ترتیب توقف‌های میانی'}
              >
                {routingAction === 'optimize' ? (
                  <><span className="animate-spin inline-block">⟳</span> در حال بهینه‌سازی...</>
                ) : (
                  <>✨ بهینه‌سازی ترتیب</>
                )}
              </button>
              {(routingWaypoints.length > 0 || routeResult) && (
                <button
                  onClick={() => {
                    clearRoutingWaypoints();
                    setRouteResult(null);
                    setOptimizationSummary(null);
                  }}
                  className="col-span-2 py-2.5 px-3 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-xs rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700 transition-colors min-h-[44px]"
                >
                  پاک‌سازی
                </button>
              )}
            </div>

            {routingWaypoints.length > 0 && (
              <p className="mt-2 text-[10px] leading-4 text-blue-500 dark:text-blue-400">
                شماره‌ها ترتیب مراجعه هستند. آیکن قطب‌نما، مسیر هر مشتری را از موقعیت فعلی شما در بلد باز می‌کند.
              </p>
            )}

            {/* Route result */}
            {routeResult && (
              <div className="mt-3 bg-white dark:bg-gray-800 rounded-lg p-2.5 border border-blue-100 dark:border-blue-900 space-y-1.5">
                {optimizationSummary && (
                  <div className="mb-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 p-2 border border-emerald-100 dark:border-emerald-900">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-semibold text-emerald-700 dark:text-emerald-400">نتیجه بهینه‌سازی</span>
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {optimizationSummary.changedStops.toLocaleString('fa-IR')} توقف جابه‌جا شد
                      </span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 gap-1 text-[10px]">
                      <span className={optimizationSummary.savedDistance >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
                        {formatDistance(Math.abs(optimizationSummary.savedDistance))} {optimizationSummary.savedDistance >= 0 ? 'مسافت کمتر' : 'مسافت بیشتر'}
                      </span>
                      <span className={optimizationSummary.savedDuration >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
                        {formatDuration(Math.abs(optimizationSummary.savedDuration))} {optimizationSummary.savedDuration >= 0 ? 'زمان کمتر' : 'زمان بیشتر'}
                      </span>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">مسافت کل</span>
                  <span className="text-sm font-bold text-blue-700 dark:text-blue-400">{formatDistance(routeResult.distance)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">زمان تخمینی</span>
                  <span className="text-sm font-bold text-blue-700 dark:text-blue-400">{formatDuration(routeResult.duration)}</span>
                </div>
                <div className="pt-1.5 border-t border-gray-100 dark:border-gray-700 text-[10px] text-emerald-600 dark:text-emerald-400">
                  مسیر نهایی با اطلاعات ترافیکی راه محاسبه شده است.
                </div>
                {routeResult.legs.length > 1 && (
                  <div className="pt-1.5 border-t border-gray-100 dark:border-gray-700">
                    <span className="text-[10px] text-gray-400">{routeResult.legs.length} بخش مسیر</span>
                  </div>
                )}
                {/* Step-by-step turn-by-turn */}
                {routeResult.legs.length > 0 && routeResult.legs[0].steps.length > 0 && (
                  <div className="pt-1.5 border-t border-gray-100 dark:border-gray-700 max-h-32 overflow-y-auto">
                    <span className="text-[10px] text-gray-500 font-medium">مسیر حرکت:</span>
                    <div className="mt-1 space-y-0.5">
                      {routeResult.legs.flatMap(l => l.steps).slice(0, 10).map((step, i) => (
                        <div key={i} className="text-[10px] text-gray-600 dark:text-gray-400 flex items-start gap-1">
                          <span className="text-blue-400 flex-shrink-0 mt-px">•</span>
                          <span className="truncate">
                            {step.name ? `${step.name} - ` : ''}{formatDistance(step.distance)}
                          </span>
                        </div>
                      ))}
                      {routeResult.legs.flatMap(l => l.steps).length > 10 && (
                        <div className="text-[10px] text-gray-400">
                          و {routeResult.legs.flatMap(l => l.steps).length - 10} مرحله دیگر...
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Filter by District */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">فیلتر بر اساس منطقه</h3>
          <select
            value={selectedDistrict}
            onChange={(e) => {
              const val = e.target.value;
              autoRouteRequestRef.current = '';
              clearRoutingWaypoints();
              setRouteResult(null);
              setOptimizationSummary(null);
              setSelectedNeighborhood('');
              setSelectedDistrict(val || '');
              if (val) flyToDistrict(val);
            }}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-2 min-h-[44px]"
          >
            <option value="">همه مناطق</option>
            {districtNames.map((d) => (
              <option key={d.name} value={d.name}>{d.name}</option>
            ))}
          </select>

          {selectedDistrict && (
            <>
              <select
                value={selectedNeighborhood}
                onChange={(e) => {
                  autoRouteRequestRef.current = '';
                  clearRoutingWaypoints();
                  setRouteResult(null);
                  setOptimizationSummary(null);
                  setSelectedNeighborhood(e.target.value || '');
                }}
                className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[44px]"
              >
                <option value="">همه محله‌ها</option>
                {neighborhoodNames
                  .filter((n) => n.district_name === selectedDistrict)
                  .map((n) => (
                    <option key={n.name} value={n.name}>{n.name}</option>
                  ))}
              </select>
              {selectedNeighborhood && (
                <button
                  onClick={optimizeNeighborhoodRoute}
                  disabled={displayCustomers.length === 0 || routingLoading || loadingCustomers}
                  className="mt-2 w-full px-3 py-2.5 text-xs font-medium rounded-lg bg-violet-600 hover:bg-violet-700 active:bg-violet-800 text-white transition-colors min-h-[44px] disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {routingAction === 'neighborhood' ? (
                    <><span className="animate-spin inline-block">⟳</span> در حال ساخت مسیر محله...</>
                  ) : (
                    <>↻ محاسبه مجدد مسیر ({displayCustomers.length.toLocaleString('fa-IR')} مشتری)</>
                  )}
                </button>
              )}
            </>
          )}
        </div>

        {/* Filter by Route */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">فیلتر بر اساس مسیر</h3>
          <select
            value={selectedRoute}
            onChange={(e) => setSelectedRoute(e.target.value || '')}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[44px]"
          >
            <option value="">همه مسیرها</option>
            {routeNames.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>

        {/* Filter by Source */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">فیلتر بر اساس منبع</h3>
          <select
            value={selectedSource}
            onChange={(e) => setSelectedSource(e.target.value || '')}
            className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[44px]"
          >
            <option value="">{selectedNeighborhood ? 'انتخاب خودکار سورس' : 'همه منابع'}</option>
            {sourceList.map((s) => (
              <option key={s} value={s}>{s} ({(currentSourceCounts[s] || 0).toLocaleString('fa-IR')})</option>
            ))}
          </select>
        </div>

        {/* Active Filters */}
        {hasFilter && (
          <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
            <div className="flex items-center justify-between min-h-[44px]">
              <span className="text-xs text-gray-500">
                {loadingCustomers ? (
                  <span className="flex items-center gap-1">
                    <span className="animate-spin inline-block">⟳</span>
                    در حال بارگذاری...
                  </span>
                ) : (
                  <span>نمایش: {currentCount.toLocaleString('fa-IR')} مشتری</span>
                )}
              </span>
              <button onClick={clearFilter} className="text-xs text-red-500 hover:text-red-700 active:text-red-800 min-h-[44px] px-3 flex items-center transition-colors">پاک‌سازی</button>
            </div>
          </div>
        )}

        {/* Export */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800 flex-shrink-0">
          <button
            onClick={handleExport}
            disabled={isExporting || displayCustomers.length === 0}
            className="w-full py-2.5 px-3 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2 min-h-[44px]"
          >
            {isExporting ? (
              <><span className="animate-spin inline-block">⟳</span> در حال خروجی...</>
            ) : (
              <>📥 خروجی اکسل ({currentCount.toLocaleString('fa-IR')} مشتری)</>
            )}
          </button>
        </div>

        {/* Mode indicator (sidebar) */}
        {editMode !== 'none' && (
          <div className="p-3 bg-amber-50 dark:bg-amber-950/30 flex-shrink-0">
            <div className="flex items-center justify-between min-h-[44px]">
              <span className="text-xs text-amber-700 dark:text-amber-400 font-medium flex-1">
                {editMode === 'addCustomer' && '👆 روی نقشه کلیک کنید تا مشتری اضافه شود'}
                {editMode === 'editPoint' && '✋ نقاط مشتریان را بکشید تا جابجا شوند'}
                {editMode === 'editPolygon' && '📐 روی پلی‌گون‌ها کلیک کنید تا ویرایش شوند'}
              </span>
              <button onClick={() => setEditMode('none')} className="text-red-500 hover:text-red-700 active:text-red-800 min-h-[44px] min-w-[44px] flex items-center justify-center transition-colors mr-2" aria-label="خروج از حالت ویرایش">✕</button>
            </div>
          </div>
        )}

        {/* Selected Customer Info */}
        {selectedCustomer && (
          <div className="p-3 border-b border-gray-100 dark:border-gray-800 bg-blue-50 dark:bg-blue-950/30 flex-shrink-0">
            <h3 className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-1">مشتری انتخاب‌شده</h3>
            <p className="text-xs text-gray-600 dark:text-gray-400 truncate">{selectedCustomer.customerName}</p>
            <p className="text-xs text-gray-500 truncate">{selectedCustomer.address}</p>
          </div>
        )}
      </div>

      {/* Map Container */}
      <div className="flex-1 relative min-w-0">
        {loading && (
          <div className="absolute inset-0 z-[999] flex items-center justify-center bg-white/80 dark:bg-gray-900/80">
            <div className="text-center p-6">
              <div className="animate-spin text-4xl mb-3 inline-block">⟳</div>
              <p className="text-sm text-gray-500">در حال بارگذاری داده‌ها...</p>
              <p className="text-xs text-gray-400 mt-1">لطفا صبر کنید</p>
            </div>
          </div>
        )}
        <div ref={mapContainerRef} className="w-full h-full" />

        {/* Loading customers overlay */}
        {loadingCustomers && !loading && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 px-4 py-2 rounded-full text-xs font-medium shadow-lg flex items-center gap-2">
            <span className="animate-spin inline-block">⟳</span>
            در حال بارگذاری مشتریان...
          </div>
        )}

        {/* Source Legend */}
        {hasFilter && (
          <div className="absolute bottom-4 left-3 z-[1000] bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm rounded-lg shadow-lg p-2.5 text-xs space-y-1.5 border border-gray-200 dark:border-gray-700 min-w-[120px]">
            <div className="font-semibold text-gray-600 dark:text-gray-400 mb-0.5">راهنما</div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-blue-500 border border-blue-700 flex-shrink-0"></span>
                <span className="text-gray-700 dark:text-gray-300">ورانگر</span>
              </div>
              <span className="font-bold text-blue-600">{((isFiltered && stats.filteredSourceCounts?.['ورانگر']) || stats.sourceCounts?.['ورانگر'] || 0).toLocaleString('fa-IR')}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-amber-500 border border-amber-600 flex-shrink-0"></span>
                <span className="text-gray-700 dark:text-gray-300">بلده</span>
              </div>
              <span className="font-bold text-amber-600">{((isFiltered && stats.filteredSourceCounts?.['بلده']) || stats.sourceCounts?.['بلده'] || 0).toLocaleString('fa-IR')}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-emerald-500 border border-emerald-600 flex-shrink-0"></span>
                <span className="text-gray-700 dark:text-gray-300">اسنپ</span>
              </div>
              <span className="font-bold text-emerald-600">{((isFiltered && stats.filteredSourceCounts?.['SNAPP_EXPRESS']) || stats.sourceCounts?.['SNAPP_EXPRESS'] || 0).toLocaleString('fa-IR')}</span>
            </div>
            {highlightMismatch && (
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-red-500 border border-red-700 flex-shrink-0"></span>
                <span className="text-gray-700 dark:text-gray-300">عدم تطابق</span>
              </div>
            )}
          </div>
        )}

        {/* Edit mode banner */}
        {editMode !== 'none' && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-amber-500 text-white px-3 py-2 lg:px-4 lg:py-2 rounded-full text-xs lg:text-sm font-medium shadow-lg whitespace-nowrap max-w-[85vw] truncate">
            {editMode === 'addCustomer' && 'حالت افزودن مشتری - روی نقشه کلیک کنید'}
            {editMode === 'editPoint' && 'حالت ویرایش نقطه فعال'}
            {editMode === 'editPolygon' && 'حالت ویرایش پلی‌گون فعال'}
          </div>
        )}

        {/* Routing mode banner */}
        {routingMode && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-blue-600 text-white px-3 py-2 lg:px-4 lg:py-2 rounded-full text-xs lg:text-sm font-medium shadow-lg whitespace-nowrap max-w-[85vw] truncate">
            🚗 حالت مسیریابی - روی نقاط مشتریان کلیک کنید ({routingWaypoints.length} نقطه)
          </div>
        )}

        {/* Route info overlay on map */}
        {routeResult && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[1000] bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm px-4 py-2.5 rounded-xl shadow-lg border border-blue-200 dark:border-blue-800 flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
              <span className="font-bold text-blue-700 dark:text-blue-400">{formatDistance(routeResult.distance)}</span>
            </div>
            <div className="w-px h-4 bg-gray-200 dark:bg-gray-700"></div>
            <div className="flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              <span className="font-bold text-blue-700 dark:text-blue-400">{formatDuration(routeResult.duration)}</span>
            </div>
            <div className="w-px h-4 bg-gray-200 dark:bg-gray-700"></div>
            <span className="text-gray-500">{routingWaypoints.length} توقف</span>
          </div>
        )}
      </div>

      {/* Customer Report Dialog */}
      {reportDialog.open && reportDialog.customer && (
        <div
          className="fixed inset-0 z-[1001] flex items-end lg:items-center justify-center bg-black/50 p-0 lg:p-4 safe-area-bottom"
          onClick={() => {
            if (!reportSubmitting) setReportDialog({ open: false, customer: null });
          }}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-t-2xl lg:rounded-xl shadow-2xl w-full lg:max-w-md max-h-[90vh] overflow-y-auto p-5 pb-8 lg:p-6 lg:pb-6"
            dir="rtl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex justify-center mb-3 lg:hidden">
              <div className="w-10 h-1 bg-gray-300 dark:bg-gray-600 rounded-full" />
            </div>

            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">ثبت گزارش مشتری</h2>
                <p className="text-sm font-medium text-blue-700 dark:text-blue-400 mt-1">
                  {reportDialog.customer.customerName}
                </p>
              </div>
              <span className="text-2xl" aria-hidden="true">📝</span>
            </div>

            <div className="mb-4 rounded-xl bg-blue-50 dark:bg-blue-950/30 p-3 text-xs text-gray-600 dark:text-gray-300 space-y-1">
              {reportDialog.customer.currentRoute && (
                <p><span className="text-gray-500">مسیر:</span> {reportDialog.customer.currentRoute}</p>
              )}
              {reportDialog.customer.address && (
                <p className="leading-5"><span className="text-gray-500">آدرس:</span> {reportDialog.customer.address}</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => openBaladNavigation(reportDialog.customer!)}
              className="mb-4 w-full min-h-[44px] rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2.5 text-sm font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 transition-colors"
            >
              🧭 مسیریابی از موقعیت من با بلد
            </button>

            <div className="space-y-3">
              <div>
                <label htmlFor="report-status" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  نتیجه مراجعه *
                </label>
                <select
                  id="report-status"
                  value={reportStatus}
                  onChange={(event) => {
                    setReportStatus(event.target.value);
                    setReportError('');
                  }}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 min-h-[44px]"
                >
                  <option value="">انتخاب نتیجه مراجعه</option>
                  <option value="سفارش ثبت شد">سفارش ثبت شد</option>
                  <option value="مراجعه انجام شد">مراجعه انجام شد</option>
                  <option value="نیاز به پیگیری">نیاز به پیگیری</option>
                  <option value="مشتری حضور نداشت">مشتری حضور نداشت</option>
                  <option value="عدم تمایل مشتری">عدم تمایل مشتری</option>
                </select>
              </div>

              <div>
                <label htmlFor="report-description" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  توضیحات گزارش *
                </label>
                <textarea
                  id="report-description"
                  value={reportDescription}
                  onChange={(event) => {
                    setReportDescription(event.target.value);
                    setReportError('');
                  }}
                  rows={4}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none min-h-[112px]"
                  placeholder="شرح مراجعه، درخواست مشتری یا اقدام انجام‌شده را بنویسید..."
                />
              </div>

              <div>
                <label htmlFor="report-follow-up-date" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  تاریخ پیگیری بعدی (اختیاری)
                </label>
                <input
                  id="report-follow-up-date"
                  type="date"
                  value={reportFollowUpDate}
                  onChange={(event) => setReportFollowUpDate(event.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 min-h-[44px]"
                  dir="ltr"
                />
              </div>
            </div>

            {reportError && (
              <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-400" role="alert">
                {reportError}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 mt-5">
              <button
                onClick={handleSubmitReport}
                disabled={reportSubmitting}
                className="col-span-2 py-2.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm rounded-lg transition-colors min-h-[44px] font-medium disabled:opacity-60"
              >
                {reportSubmitting ? 'در حال ثبت گزارش...' : 'ثبت گزارش'}
              </button>
              <button
                onClick={() => {
                  const customer = reportDialog.customer;
                  if (!customer) return;
                  setReportDialog({ open: false, customer: null });
                  setEditDialog({ open: true, customer, lat: customer.lat, lng: customer.lng });
                }}
                disabled={reportSubmitting}
                className="py-2.5 px-4 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 text-sm rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors min-h-[44px] disabled:opacity-60"
              >
                ویرایش مشتری
              </button>
              <button
                onClick={() => setReportDialog({ open: false, customer: null })}
                disabled={reportSubmitting}
                className="py-2.5 px-4 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors min-h-[44px] disabled:opacity-60"
              >
                انصراف
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Customer Dialog */}
      {editDialog.open && (
        <div className="fixed inset-0 z-[1001] flex items-end lg:items-center justify-center bg-black/50 p-0 lg:p-4 safe-area-bottom" onClick={() => setEditDialog({ open: false, customer: null, lat: 0, lng: 0 })}>
          <div className="bg-white dark:bg-gray-900 rounded-t-2xl lg:rounded-xl shadow-2xl w-full lg:max-w-md max-h-[90vh] overflow-y-auto p-5 pb-8 lg:p-6 lg:pb-6" dir="rtl" onClick={(e) => e.stopPropagation()}>
            {/* Drag handle for mobile */}
            <div className="flex justify-center mb-3 lg:hidden">
              <div className="w-10 h-1 bg-gray-300 dark:bg-gray-600 rounded-full" />
            </div>

            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-4">
              {editDialog.customer ? 'ویرایش مشتری' : 'افزودن مشتری جدید'}
            </h2>

            {!editDialog.customer && (
              <div className="mb-3 p-2.5 bg-gray-50 dark:bg-gray-800 rounded-lg text-xs text-gray-500">
                مختصات: {editDialog.lat.toFixed(6)}, {editDialog.lng.toFixed(6)}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label htmlFor="dialog-customer-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">نام مشتری *</label>
                <input
                  id="dialog-customer-name"
                  type="text"
                  defaultValue={editDialog.customer?.customerName || ''}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 min-h-[44px]"
                  placeholder="نام و کد مشتری"
                />
              </div>
              <div>
                <label htmlFor="dialog-seller-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">نام فروشنده</label>
                <input
                  id="dialog-seller-name"
                  type="text"
                  defaultValue={editDialog.customer?.sellerName || ''}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 min-h-[44px]"
                  placeholder="نام فروشنده"
                />
              </div>
              <div>
                <label htmlFor="dialog-route" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">مسیر</label>
                <select
                  id="dialog-route"
                  defaultValue={editDialog.customer?.currentRoute || ''}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 min-h-[44px]"
                >
                  <option value="">انتخاب مسیر</option>
                  {routeNames.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="dialog-address" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">آدرس</label>
                <textarea
                  id="dialog-address"
                  defaultValue={editDialog.customer?.address || ''}
                  rows={2}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none min-h-[88px]"
                  placeholder="آدرس مشتری"
                />
              </div>
              <div>
                <label htmlFor="dialog-source" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">منبع</label>
                <select
                  id="dialog-source"
                  defaultValue={editDialog.customer?.source || 'ورانگر'}
                  className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 min-h-[44px]"
                >
                  {sourceList.length > 0 ? sourceList.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  )) : (
                    <>
                      <option value="ورانگر">ورانگر</option>
                      <option value="بلده">بلده</option>
                    </>
                  )}
                </select>
              </div>
            </div>

            <div className="flex gap-2 mt-5">
              <button
                onClick={() => {
                  const name = (document.getElementById('dialog-customer-name') as HTMLInputElement).value;
                  const seller = (document.getElementById('dialog-seller-name') as HTMLInputElement).value;
                  const route = (document.getElementById('dialog-route') as HTMLSelectElement).value;
                  const address = (document.getElementById('dialog-address') as HTMLTextAreaElement).value;
                  const source = (document.getElementById('dialog-source') as HTMLSelectElement).value;
                  if (!name.trim()) return;
                  handleSaveCustomer({ customerName: name, sellerName: seller, currentRoute: route, address, source });
                }}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm rounded-lg transition-colors min-h-[44px] font-medium"
              >
                {editDialog.customer ? 'ذخیره تغییرات' : 'افزودن'}
              </button>
              {editDialog.customer && (
                <button
                  onClick={handleRemoveCustomer}
                  className="py-2.5 px-4 bg-red-500 hover:bg-red-600 active:bg-red-700 text-white text-sm rounded-lg transition-colors min-h-[44px]"
                >
                  حذف
                </button>
              )}
              <button
                onClick={() => setEditDialog({ open: false, customer: null, lat: 0, lng: 0 })}
                className="py-2.5 px-4 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700 transition-colors min-h-[44px]"
              >
                انصراف
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Add Dialog */}
      {batchDialog && (
        <div className="fixed inset-0 z-[1001] flex items-end lg:items-center justify-center bg-black/50 p-0 lg:p-4 safe-area-bottom" onClick={() => setBatchDialog(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-t-2xl lg:rounded-xl shadow-2xl w-full lg:max-w-lg max-h-[90vh] overflow-y-auto p-5 pb-8 lg:p-6 lg:pb-6" dir="rtl" onClick={(e) => e.stopPropagation()}>
            {/* Drag handle for mobile */}
            <div className="flex justify-center mb-3 lg:hidden">
              <div className="w-10 h-1 bg-gray-300 dark:bg-gray-600 rounded-full" />
            </div>

            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-2">افزودن گروهی مشتریان</h2>
            <p className="text-xs text-gray-500 mb-4">
              هر خط یک مشتری. فرمت: نام مشتری, نام فروشنده, مسیر, آدرس
            </p>
            <textarea
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              rows={8}
              className="w-full px-3 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none font-mono min-h-[120px]"
              placeholder={`سوپر مارکت نمونه, علی محمدی, غرب - 110002024-مطهری, آدرس نمونه\nفروشگاه نمونه 2, رضا احمدی, شرق - 17 شهريور, آدرس نمونه 2`}
            />
            <div className="flex items-center gap-3 mt-2">
              <div className="flex-1">
                <label htmlFor="batch-source" className="block text-xs text-gray-500 mb-1">منبع مشتریان</label>
                <select
                  id="batch-source"
                  value={batchSource}
                  onChange={(e) => setBatchSource(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[44px]"
                >
                  {sourceList.length > 0 ? sourceList.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  )) : (
                    <>
                      <option value="ورانگر">ورانگر</option>
                      <option value="بلده">بلده</option>
                    </>
                  )}
                </select>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              مشتریان در مرکز نقشه قرار می‌گیرند و می‌توانید آنها را جابجا کنید.
            </p>
            <div className="flex gap-2 mt-4">
              <button
                onClick={handleBatchAdd}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm rounded-lg transition-colors min-h-[44px] font-medium"
              >
                افزودن ({batchText.trim().split('\n').filter((l) => l.trim()).length} مشتری)
              </button>
              <button
                onClick={() => setBatchDialog(false)}
                className="py-2.5 px-4 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 active:bg-gray-100 dark:active:bg-gray-700 transition-colors min-h-[44px]"
              >
                انصراف
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
