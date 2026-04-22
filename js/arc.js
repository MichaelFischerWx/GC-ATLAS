// GC-ATLAS — great-circle geometry helpers.
//
// Interpolates between two points on a unit sphere via spherical linear
// interpolation (slerp), used for the click-drag cross-section arc and its
// on-globe visualisation.

import * as THREE from 'three';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const EARTH_R_KM = 6371;

/** (lat, lon) in degrees → unit Vector3 matching globe's projection convention. */
export function latLonToVec3(lat, lon) {
    const phi = lat * D2R, lam = lon * D2R;
    return new THREE.Vector3(
        Math.cos(phi) * Math.sin(lam),
        Math.sin(phi),
        Math.cos(phi) * Math.cos(lam),
    );
}

/** Unit Vector3 on the sphere → { lat, lon } in degrees. */
export function vec3ToLatLon(v) {
    const n = v.length() || 1;
    return {
        lat: Math.asin(v.y / n) * R2D,
        lon: Math.atan2(v.x, v.z) * R2D,
    };
}

/** Great-circle distance between two (lat, lon) points, in km. */
export function gcDistanceKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * D2R;
    const dLon = (lon2 - lon1) * D2R;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Interpolate n+1 points along the minor great-circle arc from (lat1, lon1)
 * to (lat2, lon2). Returns an array of { lat, lon }. For identical endpoints
 * returns a single point. Uses slerp for numerical stability on short arcs.
 */
/**
 * Linear-in-(lat, lon) interpolation between two points. Unlike the
 * great-circle arc, this traces a line that's STRAIGHT on an
 * equirectangular map projection — useful for map-view cross-sections
 * where "straight on the map" is what the user expects. Handles the
 * longitude seam by picking the shortest direction (|Δlon| ≤ 180°).
 */
export function linearLatLonArc(lat1, lon1, lat2, lon2, nSegments = 128) {
    let dlon = lon2 - lon1;
    if (dlon >  180) dlon -= 360;
    if (dlon < -180) dlon += 360;
    const out = [];
    for (let i = 0; i <= nSegments; i++) {
        const t = i / nSegments;
        out.push({
            lat: lat1 + t * (lat2 - lat1),
            lon: ((lon1 + t * dlon + 540) % 360) - 180,
        });
    }
    return out;
}

export function greatCircleArc(lat1, lon1, lat2, lon2, nSegments = 128) {
    const v1 = latLonToVec3(lat1, lon1);
    const v2 = latLonToVec3(lat2, lon2);
    const cosT = Math.max(-1, Math.min(1, v1.dot(v2)));
    const theta = Math.acos(cosT);
    const out = [];
    if (theta < 1e-6) { out.push({ lat: lat1, lon: lon1 }); return out; }
    const sinT = Math.sin(theta);
    for (let i = 0; i <= nSegments; i++) {
        const t = i / nSegments;
        const a = Math.sin((1 - t) * theta) / sinT;
        const b = Math.sin(t * theta) / sinT;
        const v = new THREE.Vector3(
            a * v1.x + b * v2.x,
            a * v1.y + b * v2.y,
            a * v1.z + b * v2.z,
        ).normalize();
        out.push(vec3ToLatLon(v));
    }
    return out;
}

/**
 * Great-circle midpoint of two (lat, lon) points — half-way between them
 * along the minor great-circle arc. Used when the cross-section arc is
 * auto-derived (mid not pinned by the user).
 */
export function greatCircleMidpoint(lat1, lon1, lat2, lon2) {
    const v = latLonToVec3(lat1, lon1).add(latLonToVec3(lat2, lon2));
    if (v.lengthSq() < 1e-12) return { lat: lat1, lon: lon1 };
    return vec3ToLatLon(v.normalize());
}

/** Linear-lat/lon midpoint — same seam-aware logic as linearLatLonArc. */
export function linearLatLonMidpoint(lat1, lon1, lat2, lon2) {
    let dlon = lon2 - lon1;
    if (dlon >  180) dlon -= 360;
    if (dlon < -180) dlon += 360;
    return {
        lat: (lat1 + lat2) / 2,
        lon: ((lon1 + dlon / 2 + 540) % 360) - 180,
    };
}

/**
 * Three-point arc — two sub-arcs concatenated through a pinned midpoint,
 * sampled at N+1 points total with allocation proportional to each
 * sub-arc's length so the spacing stays roughly uniform.
 * `kind` is 'gc' (great-circle, globe view) or 'linear' (map view).
 * Produces a kink at `mid` — that's intentional; the midpoint handle is
 * a pedagogical choice ("follow this curved jet-streak") and the bend is
 * a visible signal to the user that their curve is not geodesic.
 */
export function threePointArc(start, mid, end, nSegments = 128, { kind = 'gc' } = {}) {
    const seg1 = (kind === 'linear')
        ? linearLatLonArc(start.lat, start.lon, mid.lat, mid.lon, 2)
        : greatCircleArc(start.lat, start.lon, mid.lat, mid.lon, 2);
    const seg2 = (kind === 'linear')
        ? linearLatLonArc(mid.lat, mid.lon, end.lat, end.lon, 2)
        : greatCircleArc(mid.lat, mid.lon, end.lat, end.lon, 2);
    // Rough sub-arc lengths (any monotonic proxy works for allocation).
    const L1 = gcDistanceKm(start.lat, start.lon, mid.lat, mid.lon);
    const L2 = gcDistanceKm(mid.lat, mid.lon, end.lat, end.lon);
    const total = L1 + L2;
    if (!(total > 0)) {
        return (kind === 'linear')
            ? linearLatLonArc(start.lat, start.lon, end.lat, end.lon, nSegments)
            : greatCircleArc(start.lat, start.lon, end.lat, end.lon, nSegments);
    }
    // Allocate at least 1 segment to each half so we always get a 3-point shape.
    const n1 = Math.max(1, Math.round(nSegments * L1 / total));
    const n2 = Math.max(1, nSegments - n1);
    const full1 = (kind === 'linear')
        ? linearLatLonArc(start.lat, start.lon, mid.lat, mid.lon, n1)
        : greatCircleArc(start.lat, start.lon, mid.lat, mid.lon, n1);
    const full2 = (kind === 'linear')
        ? linearLatLonArc(mid.lat, mid.lon, end.lat, end.lon, n2)
        : greatCircleArc(mid.lat, mid.lon, end.lat, end.lon, n2);
    // Drop the duplicate mid point from the second half.
    return full1.concat(full2.slice(1));
}

/** Total along-path distance of a sampled arc (km). For curved / pinned-
 *  midpoint arcs this is longer than the endpoint-to-endpoint great-circle
 *  distance — the cross-section x-axis label should reflect the actual
 *  path length, not the shortcut. */
export function arcPathLengthKm(arc) {
    let total = 0;
    for (let i = 1; i < arc.length; i++) {
        total += gcDistanceKm(arc[i - 1].lat, arc[i - 1].lon, arc[i].lat, arc[i].lon);
    }
    return total;
}
