'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useMapStore } from '@/lib/store';
import type { CustomerPoint } from '@/lib/types';

// Color palette for districts
const DISTRICT_COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4',
  '#469990', '#dcbeff', '#9A6324', '#fffac8', '#800000',
  '#aaffc3', '#808000', '#ffd8b1', '#000075', '#a9a9a9',
  '#e6194b', '#3cb44b',
];

// Minimal point-in-polygon (ray casting)
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

// Convex hull (Graham scan)
function convexHull(points: number[][]): number[][] {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  function cross(O: number[], A: number[], B: number[]): number {
    return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
  }

  const lower: number[][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: number[][] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Pad a polygon ring outward by a small amount
function padPolygon(ring: number[][], pad: number): number[][] {
  return ring.map((point, i) => {
    const prev = ring[(i - 1 + ring.length) % ring.length];
    const next = ring[(i + 1) % ring.length];
    // Direction from prev to next
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    // Normal (perpendicular)
    const nx = -dy / len;
    const ny = dx / len;
    return [point[0] + nx * pad, point[1] + ny * pad];
  });
}

export default function InteractiveMap() {
  const mapRef = useRef<unknown>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const customerLayerRef = useRef<unknown>(null);
  const districtLayerRef = useRef<unknown>(null);
  const neighborhoodLayerRef = useRef<unknown>(null);
  const userMarkerRef = useRef<unknown>(null);
  const routeLayerRef = useRef<unknown>(null);
  const leafletRef = useRef<typeof import('leaflet') | null>(null);

  const [isExporting, setIsExporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [customerCount, setCustomerCount] = useState(0);
  const [editDialog, setEditDialog] = useState<{ open: boolean; customer: CustomerPoint | null; lat: number; lng: number }>({ open: false, customer: null, lat: 0, lng: 0 });
  const [batchDialog, setBatchDialog] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [districts, setDistricts] = useState<Array<{ name: string; district_number: number; geometry: Record<string, unknown> }>>([]);
  const [neighborhoods, setNeighborhoods] = useState<Array<{ name: string; district_name: string; geometry: Record<string, unknown> }>>([]);
  const [districtNames, setDistrictNames] = useState<Array<{ name: string; district_number: number }>>([]);
  const [neighborhoodNames, setNeighborhoodNames] = useState<Array<{ name: string; district_name: string; district_number: number }>>([]);
  const [routeNames, setRouteNames] = useState<string[]>([]);
  const [showSidebar, setShowSidebar] = useState(true);

  const {
    layers, toggleLayer,
    customers, setCustomers, addCustomer, addCustomers, updateCustomer, removeCustomer,
    selectedCustomer, setSelectedCustomer,
    editMode, setEditMode,
    highlightMismatch, toggleHighlightMismatch,
    clearFilter,
    userLocation, setUserLocation,
    selectedDistrict, selectedNeighborhood, selectedRoute,
    setSelectedDistrict, setSelectedNeighborhood, setSelectedRoute,
    searchQuery, setSearchQuery,
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

      map.on('click', (e: { latlng: { lat: number; lng: number } }) => {
        if (editMode === 'addCustomer') {
          setEditDialog({ open: true, customer: null, lat: e.latlng.lat, lng: e.latlng.lng });
        }
      });

      mapRef.current = map;
    }
    initLeaflet();
  }, []);

  // Load data
  useEffect(() => {
    async function loadData() {
      try {
        const [routesRes, distRes, neighRes, routeNamesRes] = await Promise.all([
          fetch('/api/geojson/routes'),
          fetch('/api/geojson/districts'),
          fetch('/api/geojson/neighborhoods'),
          fetch('/api/routes'),
        ]);
        const routesData = await routesRes.json();
        const distData = await distRes.json();
        const neighData = await neighRes.json();
        const routeNamesData = await routeNamesRes.json();

        setCustomers(routesData.customers);
        setCustomerCount(routesData.customers.length);
        setDistricts(distData.districts);
        setDistrictNames(distData.names);
        setNeighborhoods(neighData.neighborhoods);
        setNeighborhoodNames(neighData.names);
        setRouteNames(routeNamesData.routes);
        setLoading(false);
      } catch (err) {
        console.error('Failed to load data:', err);
        setLoading(false);
      }
    }
    loadData();
  }, [setCustomers]);

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

    neighborhoods.forEach((n) => {
      const geojson = L.geoJSON(n.geometry as GeoJSON.GeometryObject, {
        style: {
          color: '#6366f1',
          weight: 1.5,
          fillColor: '#818cf8',
          fillOpacity: 0.1,
          opacity: 0.5,
          dashArray: '4, 4',
        },
      });

      geojson.eachLayer((layer: unknown) => {
        const l = layer as L.Polygon;
        l.bindTooltip(n.name, { sticky: true, direction: 'top' });
        l.on('click', () => {
          setSelectedNeighborhood(n.name);
        });
        if (editMode === 'editPolygon') {
          l.pm?.enable({ allowSelfIntersection: false });
        }
      });

      nl.addLayer(geojson);
    });
  }, [neighborhoods, layers.neighborhoods, editMode, setSelectedNeighborhood]);

  // Render route polygons (convex hull around customers of each route)
  useEffect(() => {
    const L = leafletRef.current;
    if (!L || !routeLayerRef.current) return;
    const rl = routeLayerRef.current as ReturnType<typeof L.layerGroup>;
    rl.clearLayers();
    if (!layers.routes) return;

    // Group customers by route
    const routeGroups = new Map<string, Array<[number, number]>>();
    customers.forEach((c) => {
      if (!c.currentRoute) return;
      const pts = routeGroups.get(c.currentRoute) || [];
      pts.push([c.lng, c.lat]);
      routeGroups.set(c.currentRoute, pts);
    });

    // Route colors - generate distinct colors using HSL
    const routeColorMap = new Map<string, string>();
    let colorIdx = 0;
    routeGroups.forEach((_, name) => {
      const hue = (colorIdx * 137.508) % 360; // golden angle for good distribution
      routeColorMap.set(name, `hsl(${hue}, 65%, 50%)`);
      colorIdx++;
    });

    routeGroups.forEach((points, routeName) => {
      if (points.length < 3) return;

      // Compute convex hull
      const hull = convexHull(points);
      if (hull.length < 3) return;

      // Close the hull ring
      const ring = hull.map((p) => p as [number, number]);
      ring.push(ring[0] as [number, number]);

      // Pad the hull slightly for better visibility
      const paddedRing = padPolygon(ring, 0.002);

      const color = routeColorMap.get(routeName) || '#888';

      const polygon = L.polygon(
        paddedRing.map((p) => [p[1], p[0]] as [number, number]),
        {
          color: color,
          weight: 2,
          fillColor: color,
          fillOpacity: 0.12,
          opacity: 0.8,
          dashArray: '6, 3',
        }
      );

      const customerCount = points.length;
      polygon.bindTooltip(
        `<div style="direction:rtl;text-align:right;font-size:12px;">
          <strong>${routeName}</strong><br/>
          <span style="color:#666;">تعداد مشتری: ${customerCount}</span>
        </div>`,
        { sticky: true, direction: 'top', className: 'custom-tooltip' }
      );

      polygon.on('click', () => {
        setSelectedRoute(routeName);
      });

      rl.addLayer(polygon);
    });
  }, [customers, layers.routes, setSelectedRoute]);

  // Get filtered customers
  const getFilteredCustomers = useCallback(() => {
    let filtered = [...customers];

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (c) =>
          c.customerName.toLowerCase().includes(q) ||
          c.address.toLowerCase().includes(q) ||
          c.sellerName.toLowerCase().includes(q)
      );
    }

    if (selectedDistrict) {
      const dist = districts.find((d) => d.name === selectedDistrict);
      if (dist) {
        filtered = filtered.filter((c) => {
          try {
            const poly = dist.geometry as { coordinates: number[][][] };
            return pointInPolygon(c.lng, c.lat, poly.coordinates[0]);
          } catch {
            return true;
          }
        });
      }
    }

    if (selectedNeighborhood) {
      const neigh = neighborhoods.find((n) => n.name === selectedNeighborhood);
      if (neigh) {
        filtered = filtered.filter((c) => {
          try {
            const poly = neigh.geometry as { coordinates: number[][][] };
            return pointInPolygon(c.lng, c.lat, poly.coordinates[0]);
          } catch {
            return true;
          }
        });
      }
    }

    if (selectedRoute) {
      filtered = filtered.filter((c) => c.currentRoute === selectedRoute);
    }

    return filtered;
  }, [customers, searchQuery, selectedDistrict, selectedNeighborhood, selectedRoute, districts, neighborhoods]);

  // Render customer points
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current as ReturnType<typeof L.map> | null;
    if (!L || !customerLayerRef.current) return;
    const cl = customerLayerRef.current as ReturnType<typeof L.layerGroup>;
    cl.clearLayers();
    if (!layers.customers) return;

    const filtered = getFilteredCustomers();

    filtered.forEach((customer) => {
      const isMismatch = highlightMismatch && customer.routeChange && customer.routeChange !== 'بدون تغییر';
      const color = isMismatch ? '#ef4444' : (customer.isNew ? '#22c55e' : '#3b82f6');
      const radius = isMismatch ? 6 : 4;

      const marker = L.circleMarker([customer.lat, customer.lng], {
        radius,
        fillColor: color,
        color: isMismatch ? '#dc2626' : '#1d4ed8',
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

      marker.on('click', () => {
        setSelectedCustomer(customer);
        setEditDialog({ open: true, customer, lat: customer.lat, lng: customer.lng });
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
  }, [customers, layers.customers, editMode, highlightMismatch, getFilteredCustomers, setSelectedCustomer, updateCustomer]);

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
      const filtered = getFilteredCustomers();
      const data = filtered.map((c) => ({
        'کد و نام مشتری': c.customerName,
        'نام فروشنده': c.sellerName,
        'مسیر فعلی': c.currentRoute,
        'بلوک': c.blockName,
        'تغییر مسیر': c.routeChange,
        'آدرس': c.address,
        'منبع': c.source,
        'عرض جغرافیایی': c.lat,
        'طول جغرافیایی': c.lng,
      }));

      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'مشتریان');

      ws['!cols'] = [
        { wch: 35 }, { wch: 25 }, { wch: 35 }, { wch: 35 },
        { wch: 20 }, { wch: 50 }, { wch: 10 }, { wch: 15 }, { wch: 15 },
      ];

      XLSX.writeFile(wb, 'tehran_customers.xlsx');
    } catch (err) {
      console.error('Export failed:', err);
    }
    setIsExporting(false);
  }, [getFilteredCustomers]);

  // Save customer from dialog
  const handleSaveCustomer = useCallback((data: {
    customerName: string; sellerName: string; currentRoute: string; address: string;
  }) => {
    if (editDialog.customer) {
      updateCustomer(editDialog.customer.id, data);
    } else {
      addCustomer({
        id: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...data,
        blockName: '',
        routeChange: '',
        source: 'ورانگر',
        lat: editDialog.lat,
        lng: editDialog.lng,
        isNew: true,
      });
    }
    setEditDialog({ open: false, customer: null, lat: 0, lng: 0 });
  }, [editDialog, addCustomer, updateCustomer]);

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
        newCustomers.push({
          id: `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          customerName: parts[0] || '',
          sellerName: parts[1] || '',
          currentRoute: parts[2] || '',
          blockName: '',
          routeChange: '',
          address: parts[3] || '',
          source: 'ورانگر',
          lat: center.lat + (Math.random() - 0.5) * 0.01,
          lng: center.lng + (Math.random() - 0.5) * 0.01,
          isNew: true,
        });
      }
    }

    if (newCustomers.length > 0) {
      addCustomers(newCustomers);
      setBatchText('');
      setBatchDialog(false);
      setEditMode('editPoint');
    }
  }, [batchText, addCustomers, setEditMode]);

  // Remove selected customer
  const handleRemoveCustomer = useCallback(() => {
    if (editDialog.customer) {
      removeCustomer(editDialog.customer.id);
      setEditDialog({ open: false, customer: null, lat: 0, lng: 0 });
    }
  }, [editDialog.customer, removeCustomer]);

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

  const mismatchCount = customers.filter(
    (c) => c.routeChange && c.routeChange !== 'بدون تغییر'
  ).length;

  const filteredCustomers = getFilteredCustomers();

  return (
    <div className="relative w-full h-screen flex" dir="rtl">
      {/* Sidebar Toggle (mobile) */}
      <button
        onClick={() => setShowSidebar(!showSidebar)}
        className="absolute top-3 right-3 z-[1000] bg-white dark:bg-gray-800 rounded-lg shadow-lg p-2 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors lg:hidden"
        style={{ display: showSidebar ? 'none' : 'block' }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>

      {/* Sidebar */}
      <div className={`${showSidebar ? 'translate-x-0' : 'translate-x-full'} fixed lg:relative z-[999] w-80 h-full bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700 overflow-y-auto transition-transform duration-300 flex flex-col`}>
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-l from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30">
          <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" /></svg>
            نقشه تعاملی تهران
          </h1>
          <p className="text-xs text-gray-500 mt-1">مدیریت مشتریان و مسیرها</p>
        </div>

        {/* Stats */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-2">
              <div className="text-lg font-bold text-blue-600">{customerCount.toLocaleString('fa-IR')}</div>
              <div className="text-[10px] text-gray-500">مشتری</div>
            </div>
            <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-lg p-2">
              <div className="text-lg font-bold text-emerald-600">22</div>
              <div className="text-[10px] text-gray-500">منطقه</div>
            </div>
            <div className="bg-amber-50 dark:bg-amber-950/30 rounded-lg p-2">
              <div className="text-lg font-bold text-amber-600">{mismatchCount.toLocaleString('fa-IR')}</div>
              <div className="text-[10px] text-gray-500">عدم تطابق</div>
            </div>
          </div>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <input
            type="text"
            placeholder="جستجوی مشتری..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
        </div>

        {/* Layers */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">لایه‌ها</h3>
          <div className="space-y-2">
            {[
              { key: 'districts' as const, label: 'مناطق شهرداری', color: 'bg-emerald-500' },
              { key: 'neighborhoods' as const, label: 'محله‌ها', color: 'bg-violet-500' },
              { key: 'routes' as const, label: 'مسیرها (پلی‌گون)', color: 'bg-orange-500' },
              { key: 'customers' as const, label: 'مشتریان', color: 'bg-blue-500' },
            ].map(({ key, label, color }) => (
              <label key={key} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 rounded p-1">
                <div className={`w-3 h-3 rounded ${color} ${layers[key] ? 'opacity-100' : 'opacity-30'}`} />
                <span className="text-gray-700 dark:text-gray-300">{label}</span>
                <input
                  type="checkbox"
                  checked={layers[key]}
                  onChange={() => toggleLayer(key)}
                  className="mr-auto accent-emerald-600"
                />
              </label>
            ))}
          </div>
        </div>

        {/* Mismatch Toggle */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <label className="flex items-center gap-2 cursor-pointer">
            <div className={`w-3 h-3 rounded ${highlightMismatch ? 'bg-red-500' : 'bg-gray-300'}`} />
            <span className="text-sm text-gray-700 dark:text-gray-300">نمایش عدم تطابق مسیر</span>
            <input
              type="checkbox"
              checked={highlightMismatch}
              onChange={toggleHighlightMismatch}
              className="mr-auto accent-red-500"
            />
          </label>
          {highlightMismatch && (
            <p className="text-xs text-red-500 mt-1 mr-5">
              نقاطی که مسیر ثبت‌شده با بلوک محل حضورشان مطابقت ندارد قرمز نمایش داده می‌شوند
            </p>
          )}
        </div>

        {/* Tools */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">ابزارها</h3>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setEditMode(editMode === 'addCustomer' ? 'none' : 'addCustomer')}
              className={`text-xs px-2 py-2 rounded-lg border transition-colors ${
                editMode === 'addCustomer'
                  ? 'bg-emerald-500 text-white border-emerald-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              + افزودن مشتری
            </button>
            <button
              onClick={() => setBatchDialog(true)}
              className="text-xs px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              افزودن گروهی
            </button>
            <button
              onClick={() => setEditMode(editMode === 'editPoint' ? 'none' : 'editPoint')}
              className={`text-xs px-2 py-2 rounded-lg border transition-colors ${
                editMode === 'editPoint'
                  ? 'bg-amber-500 text-white border-amber-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              ویرایش نقطه
            </button>
            <button
              onClick={() => setEditMode(editMode === 'editPolygon' ? 'none' : 'editPolygon')}
              className={`text-xs px-2 py-2 rounded-lg border transition-colors ${
                editMode === 'editPolygon'
                  ? 'bg-violet-500 text-white border-violet-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              ویرایش پلی‌گون
            </button>
            <button
              onClick={goToUserLocation}
              className="text-xs px-2 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors col-span-2"
            >
              📍 نمایش موقعیت من
            </button>
          </div>
        </div>

        {/* Filter by District */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">فیلتر بر اساس منطقه</h3>
          <select
            value={selectedDistrict}
            onChange={(e) => {
              const val = e.target.value;
              setSelectedDistrict(val || '');
              if (val) flyToDistrict(val);
            }}
            className="w-full px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-2"
          >
            <option value="">همه مناطق</option>
            {districtNames.map((d) => (
              <option key={d.name} value={d.name}>{d.name}</option>
            ))}
          </select>

          {selectedDistrict && (
            <select
              value={selectedNeighborhood}
              onChange={(e) => setSelectedNeighborhood(e.target.value || '')}
              className="w-full px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="">همه محله‌ها</option>
              {neighborhoodNames
                .filter((n) => n.district_name === selectedDistrict)
                .map((n) => (
                  <option key={n.name} value={n.name}>{n.name}</option>
                ))}
            </select>
          )}
        </div>

        {/* Filter by Route */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">فیلتر بر اساس مسیر</h3>
          <select
            value={selectedRoute}
            onChange={(e) => setSelectedRoute(e.target.value || '')}
            className="w-full px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="">همه مسیرها</option>
            {routeNames.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>

        {/* Active Filters */}
        {(selectedDistrict || selectedNeighborhood || selectedRoute || searchQuery) && (
          <div className="p-3 border-b border-gray-100 dark:border-gray-800">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-500">فیلتر فعال: {filteredCustomers.length.toLocaleString('fa-IR')} مشتری</span>
              <button onClick={clearFilter} className="text-xs text-red-500 hover:text-red-700">پاک‌سازی</button>
            </div>
          </div>
        )}

        {/* Export */}
        <div className="p-3 border-b border-gray-100 dark:border-gray-800">
          <button
            onClick={handleExport}
            disabled={isExporting}
            className="w-full py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isExporting ? (
              <><span className="animate-spin inline-block">⟳</span> در حال خروجی...</>
            ) : (
              <>📥 خروجی اکسل ({filteredCustomers.length.toLocaleString('fa-IR')} مشتری)</>
            )}
          </button>
        </div>

        {/* Mode indicator */}
        {editMode !== 'none' && (
          <div className="p-3 bg-amber-50 dark:bg-amber-950/30">
            <div className="flex items-center justify-between">
              <span className="text-xs text-amber-700 dark:text-amber-400 font-medium">
                {editMode === 'addCustomer' && '👆 روی نقشه کلیک کنید تا مشتری اضافه شود'}
                {editMode === 'editPoint' && '✋ نقاط مشتریان را بکشید تا جابجا شوند'}
                {editMode === 'editPolygon' && '📐 روی پلی‌گون‌ها کلیک کنید تا ویرایش شوند'}
              </span>
              <button onClick={() => setEditMode('none')} className="text-xs text-red-500 hover:text-red-700">✕</button>
            </div>
          </div>
        )}

        {/* Selected Customer Info */}
        {selectedCustomer && (
          <div className="p-3 border-b border-gray-100 dark:border-gray-800 bg-blue-50 dark:bg-blue-950/30">
            <h3 className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-1">مشتری انتخاب‌شده</h3>
            <p className="text-xs text-gray-600 dark:text-gray-400 truncate">{selectedCustomer.customerName}</p>
            <p className="text-xs text-gray-500 truncate">{selectedCustomer.address}</p>
          </div>
        )}
      </div>

      {/* Map Container */}
      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 z-[999] flex items-center justify-center bg-white/80">
            <div className="text-center">
              <div className="animate-spin text-3xl mb-2 inline-block">⟳</div>
              <p className="text-sm text-gray-500">در حال بارگذاری داده‌ها...</p>
              <p className="text-xs text-gray-400 mt-1">لطفا صبر کنید</p>
            </div>
          </div>
        )}
        <div ref={mapContainerRef} className="w-full h-full" />

        {/* Edit mode banner */}
        {editMode !== 'none' && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-amber-500 text-white px-4 py-2 rounded-full text-sm font-medium shadow-lg">
            {editMode === 'addCustomer' && 'حالت افزودن مشتری - روی نقشه کلیک کنید'}
            {editMode === 'editPoint' && 'حالت ویرایش نقطه فعال'}
            {editMode === 'editPolygon' && 'حالت ویرایش پلی‌گون فعال'}
          </div>
        )}
      </div>

      {/* Add/Edit Customer Dialog */}
      {editDialog.open && (
        <div className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50 p-4" onClick={() => setEditDialog({ open: false, customer: null, lat: 0, lng: 0 })}>
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md p-6" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-4">
              {editDialog.customer ? 'ویرایش مشتری' : 'افزودن مشتری جدید'}
            </h2>

            {!editDialog.customer && (
              <div className="mb-3 p-2 bg-gray-50 dark:bg-gray-800 rounded-lg text-xs text-gray-500">
                مختصات: {editDialog.lat.toFixed(6)}, {editDialog.lng.toFixed(6)}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">نام مشتری *</label>
                <input
                  id="dialog-customer-name"
                  type="text"
                  defaultValue={editDialog.customer?.customerName || ''}
                  className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  placeholder="نام و کد مشتری"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">نام فروشنده</label>
                <input
                  id="dialog-seller-name"
                  type="text"
                  defaultValue={editDialog.customer?.sellerName || ''}
                  className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  placeholder="نام فروشنده"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">مسیر</label>
                <select
                  id="dialog-route"
                  defaultValue={editDialog.customer?.currentRoute || ''}
                  className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  <option value="">انتخاب مسیر</option>
                  {routeNames.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">آدرس</label>
                <textarea
                  id="dialog-address"
                  defaultValue={editDialog.customer?.address || ''}
                  rows={2}
                  className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none"
                  placeholder="آدرس مشتری"
                />
              </div>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 text-xs text-gray-500">
                منبع: <span className="font-medium text-gray-700 dark:text-gray-300">ورانگر</span>
              </div>
            </div>

            <div className="flex gap-2 mt-5">
              <button
                onClick={() => {
                  const name = (document.getElementById('dialog-customer-name') as HTMLInputElement).value;
                  const seller = (document.getElementById('dialog-seller-name') as HTMLInputElement).value;
                  const route = (document.getElementById('dialog-route') as HTMLSelectElement).value;
                  const address = (document.getElementById('dialog-address') as HTMLTextAreaElement).value;
                  if (!name.trim()) return;
                  handleSaveCustomer({ customerName: name, sellerName: seller, currentRoute: route, address });
                }}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg transition-colors"
              >
                {editDialog.customer ? 'ذخیره تغییرات' : 'افزودن'}
              </button>
              {editDialog.customer && (
                <button
                  onClick={handleRemoveCustomer}
                  className="py-2 px-3 bg-red-500 hover:bg-red-600 text-white text-sm rounded-lg transition-colors"
                >
                  حذف
                </button>
              )}
              <button
                onClick={() => setEditDialog({ open: false, customer: null, lat: 0, lng: 0 })}
                className="py-2 px-3 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                انصراف
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch Add Dialog */}
      {batchDialog && (
        <div className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50 p-4" onClick={() => setBatchDialog(false)}>
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg p-6" dir="rtl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-2">افزودن گروهی مشتریان</h2>
            <p className="text-xs text-gray-500 mb-4">
              هر خط یک مشتری. فرمت: نام مشتری, نام فروشنده, مسیر, آدرس
            </p>
            <textarea
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              rows={10}
              className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none font-mono"
              placeholder={`سوپر مارکت نمونه, علی محمدی, غرب - 110002024-مطهری, آدرس نمونه\nفروشگاه نمونه 2, رضا احمدی, شرق - 17 شهريور, آدرس نمونه 2`}
            />
            <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2 text-xs text-gray-500 mt-2">
              منبع همه مشتریان: <span className="font-medium text-gray-700 dark:text-gray-300">ورانگر</span>
              <br />
              مشتریان در مرکز نقشه قرار می‌گیرند و می‌توانید آنها را جابجا کنید.
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={handleBatchAdd}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg transition-colors"
              >
                افزودن ({batchText.trim().split('\n').filter((l) => l.trim()).length} مشتری)
              </button>
              <button
                onClick={() => setBatchDialog(false)}
                className="py-2 px-3 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 text-sm rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
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