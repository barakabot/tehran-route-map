import { create } from 'zustand';
import type { CustomerPoint, MapLayerType, FilterMode } from './types';

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
  selectedSource: string;
  setSelectedSource: (s: string) => void;
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
      selectedSource: '',
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

  selectedSource: '',
  setSelectedSource: (s) => set({ selectedSource: s }),
}));