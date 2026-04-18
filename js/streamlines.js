// GC-ATLAS — static streamlines overlay.
// Seeds points uniformly on the sphere and integrates each forward on the
// (u, v) wind field using RK2. Renders as static LineSegments with head-to-tail
// alpha fade. Rebuilt on state change; no per-frame animation.

import * as THREE from 'three';

const N_SEEDS    = 1400;   // uniformly sampled points on the sphere
const STEPS      = 60;     // integration steps per streamline
const STEP_SIZE  = 0.004;  // deg per (m/s · step) — matches particles speed feel
const RADIUS     = 1.006;  // lift slightly above data texture
const POLE_MASK  = 83;
const ALPHA_HEAD = 0.92;
const ALPHA_TAIL = 0.06;

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

        const maxSegVerts = N_SEEDS * (STEPS - 1) * 2;
        this.positions = new Float32Array(maxSegVerts * 3);
        this.alphas    = new Float32Array(maxSegVerts);

        this.geom = new THREE.BufferGeometry();
        this.geom.setAttribute('position',
            new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
        this.geom.setAttribute('alpha',
            new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
        this.geom.setDrawRange(0, 0);

        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            uniforms: { uColor: { value: new THREE.Color(0xFFFFFF) } },
            vertexShader: `
                attribute float alpha;
                varying float vAlpha;
                void main() {
                    vAlpha = alpha;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                varying float vAlpha;
                void main() {
                    gl_FragColor = vec4(uColor, vAlpha);
                }
            `,
        });
        this.object = new THREE.LineSegments(this.geom, mat);

        this.rebuild();
    }

    setVisible(v) { this.object.visible = v; }

    /** Sample a uniform distribution on the sphere, reject near-polar points. */
    seedPoint() {
        while (true) {
            const u = Math.random();
            const v = Math.random();
            const phi = Math.acos(2 * v - 1);     // 0..π from north pole
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
        let writeVerts = 0;
        for (let s = 0; s < N_SEEDS; s++) {
            const [lat0, lon0] = this.seedPoint();
            const trace = this.integrate(lat0, lon0);
            const L = trace.length;
            if (L < 2) continue;

            for (let i = 1; i < L; i++) {
                const [aLat, aLon] = trace[i - 1];
                const [bLat, bLon] = trace[i];
                // Skip segments that jump across the dateline (only matters
                // on the flat map; on the sphere this is a no-op).
                if (Math.abs(aLon - bLon) > 180) continue;

                const pa = this.project(aLat, aLon, RADIUS);
                const pb = this.project(bLat, bLon, RADIUS);

                const aFrac = (i - 1) / (STEPS - 1);
                const bFrac = i / (STEPS - 1);
                const aAlpha = ALPHA_HEAD - (ALPHA_HEAD - ALPHA_TAIL) * aFrac;
                const bAlpha = ALPHA_HEAD - (ALPHA_HEAD - ALPHA_TAIL) * bFrac;

                const p = writeVerts * 3;
                this.positions[p]     = pa.x;
                this.positions[p + 1] = pa.y;
                this.positions[p + 2] = pa.z;
                this.alphas[writeVerts] = aAlpha;
                writeVerts++;

                const q = writeVerts * 3;
                this.positions[q]     = pb.x;
                this.positions[q + 1] = pb.y;
                this.positions[q + 2] = pb.z;
                this.alphas[writeVerts] = bAlpha;
                writeVerts++;
            }
        }

        this.geom.setDrawRange(0, writeVerts);
        this.geom.attributes.position.needsUpdate = true;
        this.geom.attributes.alpha.needsUpdate = true;
    }

    /** Called by the host when the projection or the wind field changes. */
    onProjectionChanged() { this.rebuild(); }
    refresh()             { this.rebuild(); }
}
