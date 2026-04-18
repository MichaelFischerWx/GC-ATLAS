// GC-ATLAS — wind particle advection overlay.
// CPU-tracked particles that advect on a (u, v) field provided by the caller.
// Each particle carries a short trail of past positions; the trail is drawn
// as LineSegments with per-vertex alpha so the head is bright and the tail
// fades smoothly. Designed for ~3.5k particles × 14-step trails (~100k verts),
// comfortable at 60fps on a modern laptop.

import * as THREE from 'three';

const N         = 3500;    // particle count
const TRAIL     = 14;      // trail length (positions per particle)
const MAX_AGE   = 140;     // frames before a particle respawns
const SPEED     = 0.0045;  // deg per (m/s · frame) — tune for visual legibility
const RADIUS    = 1.006;   // lift slightly above data texture
const POLE_MASK = 82;      // avoid seeding or advecting beyond ±82°

export class ParticleField {
    constructor(getUV) {
        this.getUV = getUV;

        this.state = new Float32Array(N * 3);           // lat, lon, age
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
            uniforms: { uColor: { value: new THREE.Color(0xEEF5EE) } },
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
        const phi = lat * Math.PI / 180;
        const lam = lon * Math.PI / 180;
        return [
            RADIUS * Math.cos(phi) * Math.sin(lam),
            RADIUS * Math.sin(phi),
            RADIUS * Math.cos(phi) * Math.cos(lam),
        ];
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

            if (Math.abs(lat) > POLE_MASK + 3 || age > MAX_AGE) {
                this.respawn(i);
                continue;
            }
            if (lon > 180) lon -= 360;
            else if (lon < -180) lon += 360;

            this.state[i * 3]     = lat;
            this.state[i * 3 + 1] = lon;
            this.state[i * 3 + 2] = age;

            // Shift trail: position[0] is newest, position[TRAIL-1] oldest.
            const tx = i * TRAIL * 3;
            for (let t = TRAIL - 1; t > 0; t--) {
                this.trail[tx + t * 3]     = this.trail[tx + (t - 1) * 3];
                this.trail[tx + t * 3 + 1] = this.trail[tx + (t - 1) * 3 + 1];
                this.trail[tx + t * 3 + 2] = this.trail[tx + (t - 1) * 3 + 2];
            }
            const [x, y, z] = this.latLonToXYZ(lat, lon);
            this.trail[tx]     = x;
            this.trail[tx + 1] = y;
            this.trail[tx + 2] = z;
        }
        this.updateGeometry();
    }

    updateGeometry() {
        const pos = this.positions, al = this.alphas;
        const tailMax = TRAIL - 1;
        for (let i = 0; i < N; i++) {
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
                al[ak]     = 0.9  * (1 - t / tailMax);
                al[ak + 1] = 0.9  * (1 - (t + 1) / tailMax);
            }
        }
        this.geom.attributes.position.needsUpdate = true;
        this.geom.attributes.alpha.needsUpdate = true;
    }

    setVisible(v) { this.object.visible = v; }
}
