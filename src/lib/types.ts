export interface CustomerPoint {
  id: string;
  customerName: string;
  sellerName: string;
  currentRoute: string;
  blockName: string;
  routeChange: string;
  address: string;
  source: string;
  lat: number;
  lng: number;
  isNew?: boolean;
  optimizedOrder?: number | null;
  optimizedNeighborhood?: string;
  optimizedNeighborhoodId?: string;
  routeOptimizedAt?: string | null;
}

export interface DistrictFeature {
  type: 'Feature';
  properties: {
    name: string;
    district_number: number;
    area_km2?: number;
    population?: number;
    location?: string;
    description?: string;
    centroid?: [number, number];
    [key: string]: unknown;
  };
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
  };
}

export interface NeighborhoodFeature {
  type: 'Feature';
  properties: {
    name: string;
    district_number: number;
    district_name: string;
    area_km2?: number;
    centroid?: [number, number];
    [key: string]: unknown;
  };
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
  };
}

export interface MapLayerType {
  districts: boolean;
  neighborhoods: boolean;
  customers: boolean;
  routes: boolean;
}

export type FilterMode = 'all' | 'district' | 'neighborhood' | 'route' | 'mismatch';

export interface MapViewState {
  center: [number, number];
  zoom: number;
}
