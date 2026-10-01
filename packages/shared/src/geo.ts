const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** geohash 编码（用于地点模糊化，见文档 13.2） */
export function encodeGeohash({ lat, lng }: LatLng, precision = 7): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        ch = (ch << 1) + 1;
        lngMin = mid;
      } else {
        ch <<= 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch = (ch << 1) + 1;
        latMin = mid;
      } else {
        ch <<= 1;
        latMax = mid;
      }
    }
    even = !even;
    if (bit < 4) {
      bit += 1;
    } else {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export function decodeGeohashBounds(hash: string): GeoBounds {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let even = true;

  for (const c of hash) {
    const idx = BASE32.indexOf(c);
    if (idx < 0) throw new Error(`非法 geohash 字符：${c}`);
    for (let mask = 16; mask >= 1; mask >>= 1) {
      const bitSet = (idx & mask) !== 0;
      if (even) {
        const mid = (lngMin + lngMax) / 2;
        if (bitSet) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bitSet) latMin = mid;
        else latMax = mid;
      }
      even = !even;
    }
  }
  return { minLat: latMin, maxLat: latMax, minLng: lngMin, maxLng: lngMax };
}

/** 模糊化取网格中心（而非随机抖动，避免多次请求平均反推真值，见 13.2） */
export function geohashCenter(hash: string): LatLng {
  const b = decodeGeohashBounds(hash);
  return {
    lat: (b.minLat + b.maxLat) / 2,
    lng: (b.minLng + b.maxLng) / 2,
  };
}

export function roundCoord(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** 球面距离（Haversine，单位 km） */
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371.0088;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 站间通勤估算（没有路网数据时的确定性估计，可复算）：
 * 市区均速 28 km/h + 8 分钟停车/步行固定开销，最少 5 分钟。
 * 只用于取景路线重排的可解释估算，不用于精确导航。
 */
export function estimateCommuteMin(km: number): number {
  if (!Number.isFinite(km) || km <= 0) return 5;
  return Math.max(5, Math.round((km / 28) * 60) + 8);
}

/** 距离区间文案：模糊坐标下不输出精确距离值（见 13.5） */
export function distanceBand(km: number): string {
  const bands: [number, string][] = [
    [0.5, '500m 内'],
    [1, '1km 内'],
    [3, '3km 内'],
    [10, '10km 内'],
    [30, '30km 内'],
    [100, '100km 内'],
  ];
  for (const [limit, label] of bands) if (km <= limit) return label;
  return '100km 以外';
}

/** Web Mercator 投影（比例 0..1），供前端自绘地图使用 */
export function projectMercator({ lat, lng }: LatLng): { x: number; y: number } {
  const x = (lng + 180) / 360;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return { x, y };
}

export function unprojectMercator(x: number, y: number): LatLng {
  const lng = x * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

export function bboxContains(b: GeoBounds, p: LatLng): boolean {
  return p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng;
}
