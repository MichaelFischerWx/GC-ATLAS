// GC-ATLAS — wind particle advection overlay.
// CPU-tracked particles that advect on a (u, v) field provided by the caller.
// Each particle carries a short trail of past positions; the trail is drawn
// as LineSegments with per-vertex alpha so the head is bright and the tail
// fades smoothly. Designed for ~3.5k particles × 14-step trails (~100k verts),
// comfortable at 60fps on a modern laptop.

import * as THREE from 'three';

const N           = 8000;    // particle count — dense cover
const TRAIL       = 12;      // trail length (positions per particle)
const MAX_AGE     = 160;     // frames before a particle respawns
const SPEED       = 0.0042;  // deg per (m/s · frame)
const RADIUS      = 1.006;   // lift slightly above data texture
const POLE_MASK   = 82;      // avoid seeding beyond ±82°
const SPEED_NORM  = 22;      // m/s that saturates particle opacity
const ALPHA_FLOOR = 0.28;    // minimum head opacity so calm flow is still legible
const ALPHA_PEAK  = 0.95;    // head opacity at jet-stream speeds

export class ParticleField {
    constructor(getUV, projectFn) {
        this.getUV = getUV;
        // Injected projection (globe sphere or equirectangular plane). Must
        // return a THREE.Vector3 when given (lat, lon, radius-or-layer).
        this.project = projectFn || ((lat, lon, r) => {
            const phi = lat * Math.PI / 180;
            const lam = lon * Math.PI / 180;
            return new THREE.Vector3(
                r * Math.cos(phi) * Math.sin(lam),
                r * Math.sin(phi),
                r * Math.cos(phi) * Math.cos(lam),
            );
        });

        this.state = new Float32Array(N * 3);           // lat, lon, age
        this.speed = new Float32Array(N);               // per-particle speed (m/s)
        this.trail = new Float32Array(N * TRAIL * 3);   // xyz per trail step

        const segs = N * (TRAIL - 1);
        this.positions = new Float32Array(segs * 2 * 3);
        this.alphas    = new Float32Array(segs * 2);

        this.geom = new THREE.BufferGeometry();
        this.geom.setAttribute('position',
            new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
        this.geom.setAttribute('alpha',
            new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));

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

        for (let i = 0; i < N; i++) this.respawn(i);
        this.updateGeometry();
    }

    respawn(i) {
        const lat = (Math.random() * 2 - 1) * POLE_MASK;
        const lon = Math.random() * 360 - 180;
        this.state[i * 3]     = lat;
        this.state[i * 3 + 1] = lon;
        this.state[i * 3 + 2] = Math.floor(Math.random() * MAX_AGE);
        const [x, y, z] = this.latLonToXYZ(lat, lon);
        const tx = i * TRAIL * 3;
        for (let t = 0; t < TRAIL; t++) {
            this.trail[tx + t * 3]     = x;
            this.trail[tx + t * 3 + 1] = y;
            this.trail[tx + t * 3 + 2] = z;
        }
    }

    latLonToXYZ(lat, lon) {
        const v = this.project(lat, lon, RADIUS);
        return [v.x, v.y, v.z];
    }

    /** Called by the host when the projection changes (globe ↔ map). */
    onProjectionChanged() {
        for (let i = 0; i < N; i++) {
            const [x, y, z] = this.latLonToXYZ(this.state[i * 3], this.state[i * 3 + 1]);
            const tx = i * TRAIL * 3;
            for (let t = 0; t < TRAIL; t++) {
                this.trail[tx + t * 3]     = x;
                this.trail[tx + t * 3 + 1] = y;
                this.trail[tx + t * 3 + 2] = z;
            }
        }
        this.updateGeometry();
    }

    step() {
        for (let i = 0; i < N; i++) {
            let lat = this.state[i * 3];
            let lon = this.state[i * 3 + 1];
            let age = this.state[i * 3 + 2];

            const uv = this.getUV(lat, lon);
            if (!uv || !Number.isFinite(uv[0]) || !Number.isFinite(uv[1])) {
                this.respawn(i);
                continue;
            }
            const [u, v] = uv;
            const dlat = v * SPEED;
            const dlon = u * SPEED / Math.max(0.08, Math.cos(lat * Math.PI / 180));
            lat += dlat;
            lon += dlon;
            age += 1;
            this.speed[i] = Math.sqrt(u * u + v * v);

            if (Math.abs(lat) > POLE_MASK + 3 || age > MAX_AGE) {
                this.respawn(i);
                continue;
            }
            let wrapped = false;
            if (lon > 180)       { lon -= 360; wrapped = true; }
            else if (lon < -180) { lon += 360; wrapped = true; }

            this.state[i * 3]     = lat;
            this.state[i * 3 + 1] = lon;
            this.state[i * 3 + 2] = age;

            const tx = i * TRAIL * 3;
            const [x, y, z] = this.latLonToXYZ(lat, lon);

            if (wrapped) {
                // Reset the trail to the new head. On the sphere this doesn't
                // matter (old and new positions are adjacent in 3D), but on the
                // flat equirectangular map the trail would streak across the
                // whole width if we shifted normally.
                for (let t = 0; t < TRAIL; t++) {
                    this.trail[tx + t * 3]     = x;
                    this.trail[tx + t * 3 + 1] = y;
                    this.trail[tx + t * 3 + 2] = z;
                }
            } else {
                // Shift trail: position[0] is newest, position[TRAIL-1] oldest.
                for (let t = TRAIL - 1; t > 0; t--) {
                    this.trail[tx + t * 3]     = this.trail[tx + (t - 1) * 3];
                    this.trail[tx + t * 3 + 1] = this.trail[tx + (t - 1) * 3 + 1];
                    this.trail[tx + t * 3 + 2] = this.trail[tx + (t - 1) * 3 + 2];
                }
                this.trail[tx]     = x;
                this.trail[tx + 1] = y;
                this.trail[tx + 2] = z;
            }
        }
        this.updateGeometry();
    }

    updateGeometry() {
        const pos = this.positions, al = this.alphas;
        const tailMax = TRAIL - 1;
        for (let i = 0; i < N; i++) {
            // Head opacity scales with local wind speed — fast flow punches
            // through bright colormaps, slow flow lingers as faint streaks.
            const headAlpha = ALPHA_FLOOR +
                (ALPHA_PEAK - ALPHA_FLOOR) * Math.min(1, this.speed[i] / SPEED_NORM);
            const tx = i * TRAIL * 3;
            const ox = i * tailMax * 6;
            const ax = i * tailMax * 2;
            for (let t = 0; t < tailMax; t++) {
                const k = ox + t * 6;
                const ak = ax + t * 2;
                pos[k]     = this.trail[tx + t * 3];
                pos[k + 1] = this.trail[tx + t * 3 + 1];
                pos[k + 2] = this.trail[tx + t * 3 + 2];
                pos[k + 3] = this.trail[tx + (t + 1) * 3];
                pos[k + 4] = this.trail[tx + (t + 1) * 3 + 1];
                pos[k + 5] = this.trail[tx + (t + 1) * 3 + 2];
                al[ak]     = headAlpha * (1 - t / tailMax);
                al[ak + 1] = headAlpha * (1 - (t + 1) / tailMax);
            }
        }
        this.geom.attributes.position.needsUpdate = true;
        this.geom.attributes.alpha.needsUpdate = true;
    }

    setVisible(v) { this.object.visible = v; }
}
