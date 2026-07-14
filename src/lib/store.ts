import { create } from 'zustand';
import type { CustomerPoint, MapLayerType, FilterMode } from './types';

export interface RoutingWaypoint {
  customer: CustomerPoint;
  order: number;
}

export interface RouteResult {
  distance: number;
  duration: number;
  geometry: GeoJSON.LineString;
  legs: Array<{
    distance: number;
    duration: number;
    steps: Array<{
      distance: number;
      duration: number;
      instruction: string;
      type: string;
      name: string;
      geometry: GeoJSON.LineString;
    }>;
  }>;
}

interface MapStore {
  // Layer visibility
  layers: MapLayerType;
  toggleLayer: (layer: keyof MapLayerType) => void;

  // Customers
  customers: CustomerPoint[];
  setCustomers: (customers: CustomerPoint[]) => void;
  addCustomer: (customer: CustomerPoint) => void;
  addCustomers: (customers: CustomerPoint[]) => void;
  updateCustomer: (id: string, updates: Partial<CustomerPoint>) => void;
  removeCustomer: (id: string) => void;

  // Selected customer
  selectedCustomer: CustomerPoint | null;
  setSelectedCustomer: (customer: CustomerPoint | null) => void;

  // Editing mode
  editMode: 'none' | 'addCustomer' | 'addPoint' | 'editPolygon' | 'editPoint' | 'batchAdd';
  setEditMode: (mode: MapStore['editMode']) => void;

  // Highlight mismatch
  highlightMismatch: boolean;
  toggleHighlightMismatch: () => void;

  // Filter
  filterMode: FilterMode;
  filterValue: string;
  setFilter: (mode: FilterMode, value: string) => void;
  clearFilter: () => void;

  // User location
  userLocation: [number, number] | null;
  setUserLocation: (loc: [number, number] | null) => void;

  // Selected polygon for filter
  selectedDistrict: string;
  selectedNeighborhood: string;
  selectedRoute: string;
  setSelectedDistrict: (d: string) => void;
  setSelectedNeighborhood: (n: string) => void;
  setSelectedRoute: (r: string) => void;

  // Search
  searchQuery: string;
  setSearchQuery: (q: string) => void;

  // Source filter
  selectedSources: string[];
  setSelectedSources: (sources: string[]) => void;

  // Routing
  routingMode: boolean;
  setRoutingMode: (v: boolean) => void;
  routingWaypoints: RoutingWaypoint[];
  addRoutingWaypoint: (customer: CustomerPoint) => void;
  removeRoutingWaypoint: (customerId: string) => void;
  clearRoutingWaypoints: () => void;
  setRoutingWaypoints: (customers: CustomerPoint[]) => void;
  reorderRoutingWaypoints: (fromIndex: number, toIndex: number) => void;
  routeResult: RouteResult | null;
  setRouteResult: (r: RouteResult | null) => void;
  routingLoading: boolean;
  setRoutingLoading: (v: boolean) => void;
}

export const useMapStore = create<MapStore>((set) => ({
  layers: {
    districts: true,
    neighborhoods: false,
    customers: true,
    routes: false,
  },
  toggleLayer: (layer) =>
    set((state) => ({
      layers: { ...state.layers, [layer]: !state.layers[layer] },
    })),

  customers: [],
  setCustomers: (customers) => set({ customers }),
  addCustomer: (customer) =>
    set((state) => ({ customers: [...state.customers, customer] })),
  addCustomers: (newCustomers) =>
    set((state) => ({ customers: [...state.customers, ...newCustomers] })),
  updateCustomer: (id, updates) =>
    set((state) => ({
      customers: state.customers.map((c) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    })),
  removeCustomer: (id) =>
    set((state) => ({
      customers: state.customers.filter((c) => c.id !== id),
    })),

  selectedCustomer: null,
  setSelectedCustomer: (customer) => set({ selectedCustomer: customer }),

  editMode: 'none',
  setEditMode: (mode) => set({ editMode: mode }),

  highlightMismatch: false,
  toggleHighlightMismatch: () =>
    set((state) => ({ highlightMismatch: !state.highlightMismatch })),

  filterMode: 'all',
  filterValue: '',
  setFilter: (mode, value) => set({ filterMode: mode, filterValue: value }),
  clearFilter: () =>
    set({
      filterMode: 'all',
      filterValue: '',
      selectedDistrict: '',
      selectedNeighborhood: '',
      selectedRoute: '',
      selectedSources: [],
    }),

  userLocation: null,
  setUserLocation: (loc) => set({ userLocation: loc }),

  selectedDistrict: '',
  selectedNeighborhood: '',
  selectedRoute: '',
  setSelectedDistrict: (d) => set({ selectedDistrict: d, filterMode: 'district', filterValue: d }),
  setSelectedNeighborhood: (n) => set({ selectedNeighborhood: n, filterMode: 'neighborhood', filterValue: n }),
  setSelectedRoute: (r) => set({ selectedRoute: r, filterMode: 'route', filterValue: r }),

  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),

  selectedSources: [],
  setSelectedSources: (sources) => set({ selectedSources: [...new Set(sources)] }),

  // Routing
  routingMode: false,
  setRoutingMode: (v) => set({ routingMode: v, routingWaypoints: [], routeResult: null }),
  routingWaypoints: [],
  addRoutingWaypoint: (customer) =>
    set((state) => {
      if (state.routingWaypoints.some((w) => w.customer.id === customer.id)) {
        return {
          routingWaypoints: state.routingWaypoints.filter((w) => w.customer.id !== customer.id),
          routeResult: null,
        };
      }
      return {
        routingWaypoints: [...state.routingWaypoints, { customer, order: state.routingWaypoints.length }],
        routeResult: null,
      };
    }),
  removeRoutingWaypoint: (customerId) =>
    set((state) => ({
      routingWaypoints: state.routingWaypoints.filter((w) => w.customer.id !== customerId),
      routeResult: null,
    })),
  clearRoutingWaypoints: () => set({ routingWaypoints: [], routeResult: null }),
  setRoutingWaypoints: (customers) =>
    set({
      routingWaypoints: customers.map((customer, order) => ({ customer, order })),
      routeResult: null,
    }),
  reorderRoutingWaypoints: (fromIndex, toIndex) =>
    set((state) => {
      const wp = [...state.routingWaypoints];
      const [moved] = wp.splice(fromIndex, 1);
      wp.splice(toIndex, 0, moved);
      return { routingWaypoints: wp, routeResult: null };
    }),
  routeResult: null,
  setRouteResult: (r) => set({ routeResult: r }),
  routingLoading: false,
  setRoutingLoading: (v) => set({ routingLoading: v }),
}));
