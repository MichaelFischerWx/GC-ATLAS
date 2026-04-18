// GC-ATLAS — orbit view ("viewer from space", Level 3).
// Heliocentric scene: central sun at origin, a dashed ecliptic ring, and a
// mini-Earth that orbits the sun as the month advances. Earth's rotation
// axis stays FIXED in world space (always tilted 23.4° toward -X), so as it
// orbits the direction to the sun relative to its axis swings through the
// full ±23.4° seasonal range — that's the pedagogical payoff, a direct
// visual of why solstices and equinoxes work the way they do.
//
// Composition:
//   orbitGroup
//     sunMesh            (sphere at origin)
//     sunGlow            (larger transparent sphere, additive)
//     eclipticLine       (dashed circle in the XZ plane)
//     orbitArrow         (small cone pointing along the orbital direction)
//     earthPivot         (translated each frame to the orbital position)
//       earthTiltGroup   (fixed 23.4° tilt about +Z, same as globeGroup)
//         earthSpinGroup (diurnal rotation about local +Y)
//           earthMesh    (sphere with the shaded canvas texture)
//           terminator   (slightly larger sphere with day/night shader)
//         axisLine       (line through N and S poles — outside spin so the
//                         axis stays visually fixed even as Earth rotates)

import * as THREE from 'three';

const AXIAL_TILT   = 23.4 * Math.PI / 180;
const ORBIT_RADIUS = 3.0;
const EARTH_R      = 0.22;
const SUN_R        = 0.55;
const AXIS_LEN     = EARTH_R * 1.7;   // stub out past each pole
const DASH_N       = 96;              // segments around the dashed ring
const MONTH_RAD    = Math.PI / 6;     // 30° per month

function sunDirectionFromEarth(month) {
    const theta = month * MONTH_RAD;
    return new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
}

// Heliocentric Earth position = -sunDirection * R (the sun is at origin).
function earthOrbitPosition(month) {
    return sunDirectionFromEarth(month).multiplyScalar(-ORBIT_RADIUS);
}

const TERM_VERT = /* glsl */`
    varying vec3 vWorldNormal;
    void main() {
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const TERM_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uSunDir;
    uniform float uOpacity;
    varying vec3 vWorldNormal;
    void main() {
        float d = dot(vWorldNormal, uSunDir);
        float night = smoothstep(0.10, -0.08, d);
        if (night < 0.01) discard;
        gl_FragColor = vec4(0.0, 0.0, 0.0, night * uOpacity);
    }
`;

export class OrbitScene {
    constructor(getEarthTexture) {
        this.getEarthTexture = getEarthTexture;
        this.group = new THREE.Group();
        this.group.visible = false;

        // ── Sun ────────────────────────────────────────────────────────
        const sunMat = new THREE.MeshBasicMaterial({ color: 0xffd668 });
        this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 48, 32), sunMat);
        this.group.add(this.sunMesh);

        // Soft additive glow so the sun reads as luminous.
        const glowMat = new THREE.MeshBasicMaterial({
            color: 0xffae3a, transparent: true, opacity: 0.22,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        this.sunGlow = new THREE.Mesh(new THREE.SphereGeometry(SUN_R * 1.8, 32, 24), glowMat);
        this.group.add(this.sunGlow);

        // ── Ecliptic ring (dashed) ─────────────────────────────────────
        const ringPts = [];
        for (let i = 0; i <= DASH_N; i++) {
            const th = (i / DASH_N) * Math.PI * 2;
            ringPts.push(new THREE.Vector3(
                Math.cos(th) * ORBIT_RADIUS, 0, Math.sin(th) * ORBIT_RADIUS,
            ));
        }
        const ringGeom = new THREE.BufferGeometry().setFromPoints(ringPts);
        const ringMat = new THREE.LineDashedMaterial({
            color: 0x7FB8B5, dashSize: 0.12, gapSize: 0.10,
            transparent: true, opacity: 0.65,
        });
        this.ring = new THREE.Line(ringGeom, ringMat);
        this.ring.computeLineDistances();  // required for dashed rendering
        this.group.add(this.ring);

        // ── Orbital direction arrow — a small cone tangent to the ring ─
        const arrowGeom = new THREE.ConeGeometry(0.05, 0.16, 12);
        arrowGeom.translate(0, 0.08, 0);
        const arrowMat = new THREE.MeshBasicMaterial({ color: 0x8BB0A1 });
        this.orbitArrow = new THREE.Mesh(arrowGeom, arrowMat);
        // Anchor at the point on the ring at θ=90° (pointing from Dec toward
        // the direction of increasing month, consistent with our convention).
        this.orbitArrow.position.set(0, 0, ORBIT_RADIUS);
        // Lay the cone flat on the XZ plane and point it along +X (direction
        // of increasing theta at this anchor — tangent vector = (-sin, 0, cos),
        // at θ=90° that's (-1, 0, 0), i.e. -X).
        this.orbitArrow.rotation.set(0, 0, Math.PI / 2);
        this.group.add(this.orbitArrow);

        // ── Mini-Earth hierarchy ───────────────────────────────────────
        this.earthPivot     = new THREE.Group();
        this.earthTiltGroup = new THREE.Group();
        this.earthSpinGroup = new THREE.Group();
        this.earthTiltGroup.rotation.z = AXIAL_TILT;
        this.earthPivot.add(this.earthTiltGroup);
        this.earthTiltGroup.add(this.earthSpinGroup);
        this.group.add(this.earthPivot);

        const earthGeom = new THREE.SphereGeometry(EARTH_R, 96, 48);
        // The passed-in texture already has offset.x = 0.25 (sphere
        // alignment) and the correct wrap/colour-space set by globe.js.
        this.earthMat = new THREE.MeshBasicMaterial({
            map: this.getEarthTexture(),
        });
        this.earthMesh = new THREE.Mesh(earthGeom, this.earthMat);
        this.earthSpinGroup.add(this.earthMesh);

        // Terminator on the mini-Earth: slightly larger translucent shell,
        // attached to the SPIN group so it rotates with the Earth surface —
        // but the shader does a world-space dot product so the dark side
        // always faces away from the sun regardless of spin angle.
        this.termMaterial = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            vertexShader: TERM_VERT,
            fragmentShader: TERM_FRAG,
            uniforms: {
                uSunDir:  { value: new THREE.Vector3(1, 0, 0) },
                uOpacity: { value: 0.55 },
            },
        });
        this.terminator = new THREE.Mesh(
            new THREE.SphereGeometry(EARTH_R * 1.003, 64, 32),
            this.termMaterial,
        );
        this.terminator.renderOrder = 3;
        this.earthSpinGroup.add(this.terminator);

        // Visible rotation axis — stays fixed under tilt, does NOT spin, so
        // students see Earth "twirling" under a tilted stick.
        const axisGeom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, -AXIS_LEN, 0),
            new THREE.Vector3(0,  AXIS_LEN, 0),
        ]);
        const axisMat = new THREE.LineBasicMaterial({
            color: 0xE8C26A, transparent: true, opacity: 0.85,
        });
        this.axisLine = new THREE.Line(axisGeom, axisMat);
        this.earthTiltGroup.add(this.axisLine);

        this.update(1);
    }

    /**
     * Position Earth on its orbital point for the given month (1..12) and
     * update the terminator's sun direction. Call this whenever month or
     * spin angle changes.
     */
    update(month, spinAngle = 0) {
        const earthPos = earthOrbitPosition(month);
        this.earthPivot.position.copy(earthPos);
        this.earthSpinGroup.rotation.y = spinAngle;

        // Direction from Earth toward the sun (sun is at origin).
        const sunDir = earthPos.clone().negate().normalize();
        this.termMaterial.uniforms.uSunDir.value.copy(sunDir);
    }

    setVisible(v) { this.group.visible = v; }

}

export { ORBIT_RADIUS };
