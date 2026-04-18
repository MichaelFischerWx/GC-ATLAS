// GC-ATLAS — static streamlines overlay.
// Seeds points uniformly on the sphere and integrates each forward on the
// (u, v) wind field using RK2. Rendered with LineSegments2 for thick strokes
// (WebGL's built-in line width is capped at 1px in most browsers; LineSegments2
// uses a shader trick to render real thick lines via instanced geometry).

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const N_SEEDS    = 2800;
const STEPS      = 80;
const STEP_SIZE  = 0.004;
const RADIUS     = 1.006;
const POLE_MASK  = 83;
const LINE_WIDTH = 1.6;     // in pixels
const OPACITY    = 0.78;

const D2R = Math.PI / 180;

export class StreamlineField {
    constructor(getUV, projectFn) {
        this.getUV = getUV;
        this.project = projectFn || ((lat, lon, r) => {
            const phi = lat * D2R, lam = lon * D2R;
            return new THREE.Vector3(
                r * Math.cos(phi) * Math.sin(lam),
                r * Math.sin(phi),
                r * Math.cos(phi) * Math.cos(lam),
            );
        });

        this.geom = new LineSegmentsGeometry();
        this.material = new LineMaterial({
            color: 0xffffff,
            linewidth: LINE_WIDTH,
            worldUnits: false,
            transparent: true,
            opacity: OPACITY,
            depthWrite: false,
            resolution: new THREE.Vector2(
                window.innerWidth * (window.devicePixelRatio || 1),
                window.innerHeight * (window.devicePixelRatio || 1),
            ),
        });
        this.object = new LineSegments2(this.geom, this.material);
        this.object.frustumCulled = false;

        this.rebuild();
    }

    setVisible(v) { this.object.visible = v; }
    updateResolution(w, h) { this.material.resolution.set(w, h); }

    /** Uniform sphere sample; reject near-polar. */
    seedPoint() {
        while (true) {
            const u = Math.random();
            const v = Math.random();
            const phi = Math.acos(2 * v - 1);
            const lat = 90 - (phi * 180 / Math.PI);
            if (Math.abs(lat) <= POLE_MASK) {
                const lon = (u * 360) - 180;
                return [lat, lon];
            }
        }
    }

    integrate(lat, lon) {
        const trace = [[lat, lon]];
        for (let s = 0; s < STEPS; s++) {
            const uv0 = this.getUV(lat, lon);
            if (!uv0 || !Number.isFinite(uv0[0]) || !Number.isFinite(uv0[1])) break;
            const [u0, v0] = uv0;

            const halfLat = lat + v0 * STEP_SIZE * 0.5;
            const halfLon = lon + u0 * STEP_SIZE * 0.5 / Math.max(0.08, Math.cos(lat * D2R));
            const uvm = this.getUV(halfLat, halfLon);
            if (!uvm || !Number.isFinite(uvm[0]) || !Number.isFinite(uvm[1])) break;
            const [um, vm] = uvm;

            lat += vm * STEP_SIZE;
            lon += um * STEP_SIZE / Math.max(0.08, Math.cos(lat * D2R));

            if (Math.abs(lat) > POLE_MASK) break;
            if (lon > 180)       lon -= 360;
            else if (lon < -180) lon += 360;

            trace.push([lat, lon]);
        }
        return trace;
    }

    rebuild() {
        const segs = [];   // flat [sx, sy, sz, ex, ey, ez, ...]
        for (let s = 0; s < N_SEEDS; s++) {
            const [lat0, lon0] = this.seedPoint();
            const trace = this.integrate(lat0, lon0);
            if (trace.length < 2) continue;

            for (let i = 1; i < trace.length; i++) {
                const [aLat, aLon] = trace[i - 1];
                const [bLat, bLon] = trace[i];
                // Skip dateline-wrap segments — they'd streak across the flat map.
                if (Math.abs(aLon - bLon) > 180) continue;

                const pa = this.project(aLat, aLon, RADIUS);
                const pb = this.project(bLat, bLon, RADIUS);
                segs.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
            }
        }
        this.geom.setPositions(new Float32Array(segs));
    }

    onProjectionChanged() { this.rebuild(); }
    refresh()             { this.rebuild(); }
}
