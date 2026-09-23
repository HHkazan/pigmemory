import { createHmac } from "node:crypto";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function distanceMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const radians = Math.PI / 180;
  const latA = latitudeA * radians;
  const latB = latitudeB * radians;
  const deltaLat = (latitudeB - latitudeA) * radians;
  const deltaLon = (longitudeB - longitudeA) * radians;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function encodeGeohash(latitude: number, longitude: number, precision = 7): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let value = 0;
  let bit = 0;
  let useLongitude = true;
  let out = "";
  while (out.length < precision) {
    if (useLongitude) {
      const middle = (lonMin + lonMax) / 2;
      if (longitude >= middle) {
        value = (value << 1) | 1;
        lonMin = middle;
      } else {
        value <<= 1;
        lonMax = middle;
      }
    } else {
      const middle = (latMin + latMax) / 2;
      if (latitude >= middle) {
        value = (value << 1) | 1;
        latMin = middle;
      } else {
        value <<= 1;
        latMax = middle;
      }
    }
    useLongitude = !useLongitude;
    bit++;
    if (bit === 5) {
      out += BASE32[value];
      bit = 0;
      value = 0;
    }
  }
  return out;
}

export function geohashNeighborhood(latitude: number, longitude: number): string[] {
  const center = encodeGeohash(latitude, longitude, 7);
  const bounds = decodeBounds(center);
  const latStep = bounds.latMax - bounds.latMin;
  const lonStep = bounds.lonMax - bounds.lonMin;
  const hashes = new Set<string>();
  for (const latOffset of [-1, 0, 1]) {
    for (const lonOffset of [-1, 0, 1]) {
      const lat = clamp(latitude + latOffset * latStep, -89.999999, 89.999999);
      const lon = wrapLongitude(longitude + lonOffset * lonStep);
      hashes.add(encodeGeohash(lat, lon, 7));
    }
  }
  return [...hashes].sort();
}

export function neighborhoodHmacs(
  latitude: number,
  longitude: number,
  key: string,
): string[] {
  return geohashNeighborhood(latitude, longitude).map((cell) =>
    createHmac("sha256", key).update(`pigmemory:location:geohash7:${cell}`).digest("hex")
  );
}

export function stableLocationHmac(key: string, purpose: string, value: string): string {
  return createHmac("sha256", key).update(`pigmemory:location:${purpose}:${value}`).digest("hex");
}

function decodeBounds(hash: string): {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
} {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let useLongitude = true;
  for (const char of hash) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error("invalid geohash");
    for (let mask = 16; mask > 0; mask >>= 1) {
      if (useLongitude) {
        const middle = (lonMin + lonMax) / 2;
        if ((value & mask) !== 0) lonMin = middle;
        else lonMax = middle;
      } else {
        const middle = (latMin + latMax) / 2;
        if ((value & mask) !== 0) latMin = middle;
        else latMax = middle;
      }
      useLongitude = !useLongitude;
    }
  }
  return { latMin, latMax, lonMin, lonMax };
}

function wrapLongitude(value: number): number {
  let out = value;
  while (out > 180) out -= 360;
  while (out < -180) out += 360;
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
