// GC-ATLAS — sun position + day/night terminator.
// Places a sun sprite in world space on the ecliptic (XZ plane) at the
// month-dependent heliocentric longitude, and darkens the antisolar
// hemisphere of the globe with a soft-edge shader pass. Earth's axis
// remains fixed (globeGroup.rotation.z = AXIAL_TILT) so the subsolar
// latitude oscillates ±23.4° across the year — students see polar night,
// polar day, and the seasonal shift of the terminator directly.
//
// Both the sprite and the shadow sphere live in the scene (not in
// globeGroup), so their geometry is in world coords — the fragment
// shader's dot(normal, sunDir) is a straight world-space calculation.

import * as THREE from 'three';

const SUN_DIST  = 5.5;   // world units — reads as "far" without leaving the frustum
const SUN_SIZE  = 0.55;
const SHADOW_R  = 1.003; // just above contours so night mutes everything below

/**
 * Month ∈ [1..12]. Returns a unit vector from Earth's centre toward the sun,
 * assuming the ecliptic is the world XZ plane and Earth's axial tilt is a
 * +23.4° rotation about +Z. Dec solstice → +X, Jun solstice → −X.
 */
export function sunDirection(month) {
    const theta = month * Math.PI / 6;   // 30° per month; Dec=12 ≡ 0
    return new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
}

function makeSunTexture() {
    const size = 128, r = size / 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0.00, 'rgba(255, 244, 200, 1.00)');
    g.addColorStop(0.30, 'rgba(255, 214, 118, 0.95)');
    g.addColorStop(0.65, 'rgba(255, 170, 70,  0.35)');
    g.addColorStop(1.00, 'rgba(255, 150, 40,  0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

const TERM_VERT = /* glsl */`
    varying vec3 vNormal;
    void main() {
        vNormal = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const TERM_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uSunDir;
    uniform float uOpacity;
    varying vec3 vNormal;
    void main() {
        float d = dot(vNormal, uSunDir);          // +1 at subsolar, -1 antisolar
        float night = smoothstep(0.10, -0.08, d); // soft terminator band
        if (night < 0.01) discard;
        gl_FragColor = vec4(0.0, 0.0, 0.0, night * uOpacity);
    }
`;

export class SunLight {
    constructor() {
        this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: makeSunTexture(),
            transparent: true,
            depthWrite: false,
        }));
        this.sprite.scale.set(SUN_SIZE, SUN_SIZE, 1);
        this.sprite.renderOrder = 5;

        this.material = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            vertexShader: TERM_VERT,
            fragmentShader: TERM_FRAG,
            uniforms: {
                uSunDir:  { value: new THREE.Vector3(1, 0, 0) },
                uOpacity: { value: 0.55 },
            },
        });
        this.shadowMesh = new THREE.Mesh(
            new THREE.SphereGeometry(SHADOW_R, 96, 48),
            this.material,
        );
        this.shadowMesh.renderOrder = 3;
    }

    /** Update sun position and terminator normal for month ∈ [1..12]. */
    update(month) {
        const dir = sunDirection(month);
        this.sprite.position.copy(dir).multiplyScalar(SUN_DIST);
        this.material.uniforms.uSunDir.value.copy(dir);
    }

    setVisible(v) {
        this.sprite.visible = v;
        this.shadowMesh.visible = v;
    }
}
