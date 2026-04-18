// GC-ATLAS — static streamlines overlay.
// Seeds points uniformly on the sphere, integrates each forward on the (u, v)
// wind field using RK2, and renders each streamline as a single Line2 object
// so the shader handles mitered joins between segments — the result reads as
// one continuous curve, matching the plt.streamplot aesthetic. Thick strokes
// via LineMaterial (WebGL's built-in gl.lineWidth is clamped to 1 px).

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const N_SEEDS    = 1800;
const STEPS      = 90;
const STEP_SIZE  = 0.004;
const RADIUS     = 1.006;
const POLE_MASK  = 83;
const LINE_WIDTH = 2.4;    // pixels
const OPACITY    = 0.92;

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

        this.object = new THREE.Group();
        this.object.frustumCulled = false;

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

        this.rebuild();
    }

    setVisible(v) { this.object.visible = v; }
    updateResolution(w, h) { this.material.resolution.set(w, h); }

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

    /** Split a (lat, lon) trace into contiguous sub-traces at dateline wraps. */
    splitOnDateline(trace) {
        const segments = [];
        let current = [trace[0]];
        for (let i = 1; i < trace.length; i++) {
            const [aLat, aLon] = trace[i - 1];
            const [bLat, bLon] = trace[i];
            if (Math.abs(aLon - bLon) > 180) {
                if (current.length >= 2) segments.push(current);
                current = [trace[i]];
            } else {
                current.push(trace[i]);
            }
        }
        if (current.length >= 2) segments.push(current);
        return segments;
    }

    rebuild() {
        // Dispose old child geometries, clear the group.
        for (const child of this.object.children) {
            if (child.geometry) child.geometry.dispose();
        }
        this.object.clear();

        for (let s = 0; s < N_SEEDS; s++) {
            const [lat0, lon0] = this.seedPoint();
            const trace = this.integrate(lat0, lon0);
            if (trace.length < 2) continue;

            const subTraces = this.splitOnDateline(trace);
            for (const sub of subTraces) {
                const positions = [];
                for (const [lat, lon] of sub) {
                    const p = this.project(lat, lon, RADIUS);
                    positions.push(p.x, p.y, p.z);
                }
                const geom = new LineGeometry();
                geom.setPositions(positions);
                const line = new Line2(geom, this.material);
                line.computeLineDistances();
                line.frustumCulled = false;
                this.object.add(line);
            }
        }
    }

    onProjectionChanged() { this.rebuild(); }
    refresh()             { this.rebuild(); }
}
