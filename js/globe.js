// GC-ATLAS — interactive globe renderer (Three.js).
// Mounts on #globe-mount, reads/writes controls in #field-select etc.
// Synthetic fields for now (js/data.js); swap to a Zarr loader when ERA5 lands.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fillRGBA, fillColorbar, COLORMAPS, meanLuminance } from './colormap.js';
import { getField, FIELDS, LEVELS, MONTHS, GRID } from './data.js';
import { ParticleField } from './particles.js';
import { BarbField } from './barbs.js';
import { ContourField } from './contours.js';
import { ContourLabels } from './contour_labels.js';
import { SunLight } from './sun.js';
import { OrbitScene, ORBIT_RADIUS } from './orbit.js';
import { computeZonalMean, renderCrossSection } from './cross_section.js';
import { loadManifest, onFieldLoaded, isReady as era5Ready, prefetchField, cachedMonth } from './era5.js';
import { decompose, annualMeanFrom } from './decompose.js';

const PLAY_INTERVAL_MS = 900;

const COASTLINE_URL = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_coastline.geojson';
const AXIAL_TILT = 23.4 * Math.PI / 180;

// Default globe viewpoint: centred on North America so the opening frame shows
// continents and the mid-latitude jet, not empty ocean.
const DEFAULT_VIEW = { lat: 35, lon: -95, distance: 3.35 };

// Equirectangular map dimensions (width 4, height 2 → lon spans [-2, 2], lat spans [-1, 1]).
const MAP_W = 4;
const MAP_H = 2;

// Split a polyline at points where consecutive x-coords jump by more than
// `maxJump` (i.e., the line crosses the equirectangular map's seam when the
// central meridian isn't at longitude 0). Returns a list of sub-polylines.
function splitAtSeam(pts, maxJump) {
    if (pts.length < 2) return [pts];
    const out = [];
    let cur = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        if (Math.abs(pts[i].x - pts[i - 1].x) > maxJump) {
            if (cur.length >= 2) out.push(cur);
            cur = [pts[i]];
        } else {
            cur.push(pts[i]);
        }
    }
    if (cur.length >= 2) out.push(cur);
    return out;
}

function cameraFromView({ lat, lon, distance }, tilt = 0) {
    const phi = lat * Math.PI / 180;
    const lam = lon * Math.PI / 180;
    const x0 = distance * Math.cos(phi) * Math.sin(lam);
    const y0 = distance * Math.sin(phi);
    const z0 = distance * Math.cos(phi) * Math.cos(lam);
    // globeGroup is rotated by `tilt` about +Z; apply the same rotation to the
    // camera target vector so the requested (lat, lon) actually ends up facing
    // the camera in world space.
    const c = Math.cos(tilt), s = Math.sin(tilt);
    return [x0 * c - y0 * s, x0 * s + y0 * c, z0];
}

class GlobeApp {
    listeners = {};

    constructor(mount) {
        this.mount = mount;
        this.state = {
            field: 't',
            level: 500,
            month: 1,
            cmap: FIELDS.t.cmap,
            viewMode: 'globe',   // 'globe' | 'map'
            showCoastlines: true,
            showGraticule: true,
            showContours: false,
            showSun: true,
            windMode: 'particles',   // 'off' | 'particles' | 'barbs'
            decompose: 'total',      // 'total' | 'zonal' | 'eddy' | 'anomaly'
            mapCenterLon: 0,         // central meridian for the flat map (-180..180)
            showXSection: false,
        };
        this.windCache = { u: null, v: null, nlat: 0, nlon: 0, stale: true };

        this.initScene();
        this.initGlobe();
        this.initGraticule();
        this.initCoastlines();
        this.initParticles();
        this.bindUI();
        this.updateField();
        this.animate();
        this.bootstrapEra5();
    }

    // ── ERA5 tile loader bootstrap ───────────────────────────────────
    async bootstrapEra5() {
        const ok = await loadManifest();
        if (!ok) return;
        onFieldLoaded(({ name, month, level }) => {
            const s = this.state;
            const levelMatches = (level == null || level === s.level);
            const monthMatches = (month === s.month);
            const feedsCurrentField =
                (name === s.field) ||
                (s.field === 'wspd' && (name === 'u' || name === 'v'));

            if (feedsCurrentField && monthMatches && levelMatches) this.updateField();

            // Anomaly mode needs all 12 months to compute an accurate annual
            // mean; re-render whenever any month of the current field lands
            // so the anomaly sharpens as tiles come in.
            if (feedsCurrentField && levelMatches && !monthMatches &&
                s.decompose === 'anomaly') {
                this.updateField();
            }

            if (name === 'u' || name === 'v') this.windCache.stale = true;

            if (s.showXSection && feedsCurrentField && monthMatches) this.updateXSection();
        });
        // Prime: ask for the current field, which triggers a fetch.
        this.updateField();
    }

    // ── scene / camera / controls ────────────────────────────────────
    initScene() {
        const { w, h } = this.size();
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 100);
        this.camera.position.set(...cameraFromView(DEFAULT_VIEW, AXIAL_TILT));

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(w, h);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.mount.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.rotateSpeed = 0.7;
        this.controls.zoomSpeed = 0.7;
        this.controls.minDistance = 1.4;
        this.controls.maxDistance = 8;
        this.controls.enablePan = false;

        // Fade the on-canvas hint on first interaction (drag or scroll).
        this.hint = document.querySelector('.globe-hint');
        if (this.hint) {
            const fade = () => {
                this.hint.classList.add('hidden');
                this.controls.removeEventListener('start', fade);
                this.renderer.domElement.removeEventListener('pointerdown', fade);
            };
            this.controls.addEventListener('start', fade);
            this.renderer.domElement.addEventListener('pointerdown', fade);
            // Also auto-fade after 8 s if the user never touches it.
            setTimeout(fade, 8000);
        }

        // Map-mode drag handler — shifts the central meridian instead of
        // panning the camera (OrbitControls.enablePan = false in map mode).
        this.installMapDrag();

        window.addEventListener('resize', () => this.onResize());
    }

    installMapDrag() {
        const el = this.renderer.domElement;
        let dragging = false;
        let lastX = 0;
        el.addEventListener('pointerdown', (e) => {
            if (this.state.viewMode !== 'map') return;
            dragging = true;
            lastX = e.clientX;
            el.setPointerCapture(e.pointerId);
        });
        el.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - lastX;
            lastX = e.clientX;
            // How many degrees of longitude does one CSS pixel correspond to
            // in world space? At the current camera distance/FOV, the visible
            // world width is  2·dist·tan(fov/2)·aspect.  One world-unit of
            // plane equals (360 / MAP_W)° of longitude.
            const dist = this.camera.position.length();
            const fovY = this.camera.fov * Math.PI / 180;
            const visibleW = 2 * dist * Math.tan(fovY / 2) * this.camera.aspect;
            const lonPerPx = (visibleW / el.clientWidth) * (360 / MAP_W);
            let lon = this.state.mapCenterLon - dx * lonPerPx;
            // Wrap into [-180, 180].
            lon = ((lon + 180) % 360 + 360) % 360 - 180;
            this.setState({ mapCenterLon: lon });
            // Keep the slider and label in sync.
            const slider = document.getElementById('map-center-slider');
            const label  = document.getElementById('map-center-value');
            if (slider) slider.value = lon.toFixed(0);
            if (label)  label.textContent = `${Math.round(lon)}°`;
        });
        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        };
        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);
        el.addEventListener('pointerleave', endDrag);
    }

    updateHintForViewMode() {
        if (!this.hint) return;
        const txt = {
            globe: 'drag to rotate · scroll to zoom',
            map:   'drag to pan · scroll to zoom',
            orbit: 'drag to orbit · scroll to zoom',
        }[this.state.viewMode] || '';
        this.hint.textContent = txt;
    }

    size() {
        const r = this.mount.getBoundingClientRect();
        return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    }

    onResize() {
        const { w, h } = this.size();
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        if (this.barbs) this.barbs.updateResolution(w, h);
    }

    // ── meshes + data textures ───────────────────────────────────────
    initGlobe() {
        // Two top-level groups. Only one is visible at a time.
        this.globeGroup = new THREE.Group();
        this.globeGroup.rotation.z = AXIAL_TILT;
        this.scene.add(this.globeGroup);

        this.mapGroup = new THREE.Group();
        this.mapGroup.visible = false;
        this.scene.add(this.mapGroup);

        this.orbitGroup = new THREE.Group();
        this.orbitGroup.visible = false;
        this.scene.add(this.orbitGroup);

        // Shared canvas → shared data grid.
        this.canvas = document.createElement('canvas');
        this.canvas.width = GRID.nlon;
        this.canvas.height = GRID.nlat;
        this.ctx = this.canvas.getContext('2d');
        this.imageData = this.ctx.createImageData(GRID.nlon, GRID.nlat);

        // Sphere uses a texture with a +0.25 u-offset (see SphereGeometry UV note).
        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.wrapS = THREE.RepeatWrapping;
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.offset.x = 0.25;

        // Plane uses a clone of the same canvas. Repeat-wrap horizontally so
        // shifting texture.offset.x changes the central meridian without
        // revealing an edge.
        this.mapTexture = new THREE.CanvasTexture(this.canvas);
        this.mapTexture.minFilter = THREE.LinearFilter;
        this.mapTexture.magFilter = THREE.LinearFilter;
        this.mapTexture.wrapS = THREE.RepeatWrapping;
        this.mapTexture.colorSpace = THREE.SRGBColorSpace;

        // Mini-Earth in orbit view shares the same shaded canvas but needs
        // its own texture instance so the +0.25 sphere offset doesn't bleed
        // into the flat map plane.
        this.earthTexture = new THREE.CanvasTexture(this.canvas);
        this.earthTexture.minFilter = THREE.LinearFilter;
        this.earthTexture.magFilter = THREE.LinearFilter;
        this.earthTexture.wrapS = THREE.RepeatWrapping;
        this.earthTexture.colorSpace = THREE.SRGBColorSpace;
        this.earthTexture.offset.x = 0.25;

        const sphereGeom = new THREE.SphereGeometry(1, 192, 96);
        const sphereMat  = new THREE.MeshBasicMaterial({ map: this.texture });
        this.globe = new THREE.Mesh(sphereGeom, sphereMat);
        this.globeGroup.add(this.globe);

        const planeGeom = new THREE.PlaneGeometry(MAP_W, MAP_H, GRID.nlon, GRID.nlat);
        const planeMat  = new THREE.MeshBasicMaterial({ map: this.mapTexture, side: THREE.DoubleSide });
        this.mapMesh = new THREE.Mesh(planeGeom, planeMat);
        this.mapGroup.add(this.mapMesh);

        // Contour overlay: isolines drawn on top of the shaded field.
        this.contours = new ContourField({
            nlon: GRID.nlon, nlat: GRID.nlat, mapW: MAP_W, mapH: MAP_H,
        });
        this.globeGroup.add(this.contours.sphereMesh);
        this.mapGroup.add(this.contours.planeMesh);
        this.contours.setVisible(this.state.showContours);

        // Labels for the contour isolines. Separate groups for globe vs map
        // since the sprite positions depend on projection.
        this.contourLabels = new ContourLabels((lat, lon, r) => this.project(lat, lon, r));
        this.globeGroup.add(this.contourLabels.group);
        this.contourLabels.setVisible(this.state.showContours);

        // Sun marker + day/night terminator. Both live in the scene (not the
        // globeGroup) so their geometry is in world coords — the shadow
        // shader's dot(vNormal, uSunDir) is a direct world-space product.
        this.sun = new SunLight();
        this.scene.add(this.sun.sprite);
        this.scene.add(this.sun.shadowMesh);
        this.sun.update(this.state.month);
        this.applySunVisibility();

        // Subtle rim glow on the globe (sphere mode only).
        const glow = new THREE.Mesh(
            new THREE.SphereGeometry(1.04, 96, 48),
            new THREE.MeshBasicMaterial({
                color: 0x2DBDA0, transparent: true, opacity: 0.07, side: THREE.BackSide,
            }),
        );
        this.globeGroup.add(glow);

        // Orbit view: heliocentric scene with a mini-Earth tied to the same
        // shaded canvas texture. Lives in its own group and toggles via the
        // view-mode segmented control.
        this.orbit = new OrbitScene(() => this.earthTexture);
        this.orbitGroup.add(this.orbit.group);
        this.orbit.group.visible = true;   // group already parented; outer group handles visibility
        this.orbit.update(this.state.month, 0, this.camera);
        this.spinAngle = 0;                 // cumulative diurnal rotation (rad)
    }

    currentGroup() { return this.state.viewMode === 'globe' ? this.globeGroup : this.mapGroup; }

    // Unified projection. r=1 lives on the sphere (or plane); r>1 lifts overlays.
    project(lat, lon, r = 1) {
        if (this.state.viewMode === 'map') {
            // Re-centre around state.mapCenterLon, wrapping into [-180, 180].
            let x = lon - this.state.mapCenterLon;
            if (x >  180) x -= 360;
            else if (x < -180) x += 360;
            return new THREE.Vector3(
                x * (MAP_W / 360),
                lat * (MAP_H / 180),
                (r - 1) * 0.25,
            );
        }
        const phi = lat * Math.PI / 180;
        const lam = lon * Math.PI / 180;
        return new THREE.Vector3(
            r * Math.cos(phi) * Math.sin(lam),
            r * Math.sin(phi),
            r * Math.cos(phi) * Math.cos(lam),
        );
    }

    // ── graticule overlay ─────────────────────────────────────────────
    initGraticule() {
        // Store raw (lat, lon) path definitions; the mesh is rebuilt per view mode.
        this.gratPaths = [];
        const seg = 180;
        for (let lat = -60; lat <= 60; lat += 30) {
            if (lat === 0) continue;
            const pts = [];
            for (let k = 0; k <= seg; k++) pts.push([lat, -180 + 360 * k / seg]);
            this.gratPaths.push({ kind: 'parallel', pts, style: 'main' });
        }
        {
            const pts = [];
            for (let k = 0; k <= seg; k++) pts.push([0, -180 + 360 * k / seg]);
            this.gratPaths.push({ kind: 'equator', pts, style: 'eq' });
        }
        for (let lon = -180; lon < 180; lon += 30) {
            const pts = [];
            for (let k = 0; k <= seg; k++) pts.push([-90 + 180 * k / seg, lon]);
            this.gratPaths.push({ kind: 'meridian', pts, style: 'main' });
        }
        this.gratGroup = new THREE.Group();
        this.rebuildGraticule();
    }

    rebuildGraticule() {
        this.gratGroup.parent?.remove(this.gratGroup);
        for (const child of this.gratGroup.children) child.geometry.dispose();
        this.gratGroup.clear();

        const main = new THREE.LineBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.55 });
        const eq   = new THREE.LineBasicMaterial({ color: 0xE8C26A, transparent: true, opacity: 0.90 });
        const R = 1.006;
        const wrap = this.state.viewMode === 'globe';  // parallels wrap on the sphere; not on a flat map
        const isMap = this.state.viewMode === 'map';
        const seamJump = MAP_W / 2;
        for (const path of this.gratPaths) {
            const pts = path.pts.map(([lat, lon]) => this.project(lat, lon, R));
            const mat = path.style === 'eq' ? eq : main;
            if (wrap && (path.kind === 'parallel' || path.kind === 'equator')) {
                const geom = new THREE.BufferGeometry().setFromPoints(pts);
                this.gratGroup.add(new THREE.LineLoop(geom, mat));
            } else {
                const segments = isMap ? splitAtSeam(pts, seamJump) : [pts];
                for (const seg of segments) {
                    if (seg.length < 2) continue;
                    const geom = new THREE.BufferGeometry().setFromPoints(seg);
                    this.gratGroup.add(new THREE.Line(geom, mat));
                }
            }
        }
        this.currentGroup().add(this.gratGroup);
        this.gratGroup.visible = this.state.showGraticule;
    }

    // ── coastlines overlay (Natural Earth 50 m, via jsdelivr) ─────────
    async initCoastlines() {
        this.coastGroup = new THREE.Group();
        try {
            const resp = await fetch(COASTLINE_URL);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const gj = await resp.json();
            this.coastFeatures = [];
            for (const feat of gj.features) {
                const g = feat.geometry;
                if (!g) continue;
                const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
                this.coastFeatures.push(...lines);
            }
            this.rebuildCoastlines();
        } catch (err) {
            console.warn('[globe] coastlines failed to load:', err);
        }
    }

    rebuildCoastlines() {
        if (!this.coastFeatures) return;
        this.coastGroup.parent?.remove(this.coastGroup);
        for (const child of this.coastGroup.children) child.geometry.dispose();
        this.coastGroup.clear();

        const mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.88 });
        const R = 1.003;
        const seamJump = MAP_W / 2;  // flag if consecutive x-coords wrap the map
        const isMap = this.state.viewMode === 'map';
        for (const ring of this.coastFeatures) {
            const pts = ring.map(([lon, lat]) => this.project(lat, lon, R));
            // In map mode the central-meridian shift can split continents across
            // the seam; drop adjacent points whose x jumps by more than half the
            // map width into separate Line objects so we don't draw a spurious
            // stroke across the whole globe.
            const segments = isMap ? splitAtSeam(pts, seamJump) : [pts];
            for (const seg of segments) {
                if (seg.length < 2) continue;
                const geom = new THREE.BufferGeometry().setFromPoints(seg);
                this.coastGroup.add(new THREE.Line(geom, mat));
            }
        }
        this.currentGroup().add(this.coastGroup);
        this.coastGroup.visible = this.state.showCoastlines;
    }

    // ── wind overlays (particles + barbs) ────────────────────────────
    initParticles() {
        const getUV = (lat, lon) => this.sampleWind(lat, lon);
        const proj  = (lat, lon, r) => this.project(lat, lon, r);

        this.particles = new ParticleField(getUV, proj);
        this.barbs = new BarbField(getUV, proj);

        this.applyWindMode();
        this.applyParticleContrast();
        this.currentGroup().add(this.particles.object);
        this.currentGroup().add(this.barbs.object);
    }

    applyMapCenterLon() {
        // Canvas maps uv.x=0 → lon=-180, uv.x=1 → +180. To show lon=centerLon
        // at plane-centre (uv.x=0.5), the texture sample needs offset
        // +centerLon/360 so that 0.5 + offset = (centerLon+180)/360.
        const u = this.state.mapCenterLon / 360;   // [-0.5, 0.5]
        if (this.mapTexture) {
            this.mapTexture.wrapS = THREE.RepeatWrapping;
            this.mapTexture.offset.x = u;
            this.mapTexture.needsUpdate = true;
        }
        // Contour overlay on the plane shares the same texture sample space
        // (see contours.js planeMaterial.uUOffset).
        if (this.contours?.planeMaterial?.uniforms?.uUOffset) {
            this.contours.planeMaterial.uniforms.uUOffset.value = u;
        }
        // Coastlines and graticule use project() which now reads state.mapCenterLon.
        if (this.state.viewMode === 'map') {
            this.rebuildCoastlines();
            this.rebuildGraticule();
        }
    }

    applySunVisibility() {
        if (!this.sun) return;
        // Sun / terminator are globe-mode concepts; hide in flat-map mode.
        this.sun.setVisible(this.state.showSun && this.state.viewMode === 'globe');
    }

    applyParticleContrast() {
        if (!this.particles) return;
        // Ink a dark near-black on bright colormaps (turbo, wind, plasma end)
        // and white on dark ones (viridis, magma). Threshold tuned so magma
        // stays white and turbo flips to dark. In eddy/anomaly modes the
        // effective cmap is forced to RdBu_r, so use that instead.
        const darkInk = 0x0b1a14;
        const lightInk = 0xffffff;
        const sym = this.state.decompose === 'eddy' || this.state.decompose === 'anomaly';
        const cmap = sym ? 'RdBu_r' : this.state.cmap;
        this.particles.setColor(meanLuminance(cmap) > 0.52 ? darkInk : lightInk);
    }

    applyWindMode() {
        const m = this.state.windMode;
        if (this.particles)   this.particles.setVisible(m === 'particles');
        if (this.barbs) this.barbs.setVisible(m === 'barbs');
    }

    refreshWindCache() {
        const { month, level } = this.state;
        const uF = getField('u', { month, level });
        const vF = getField('v', { month, level });
        this.windCache.u = uF.values;
        this.windCache.v = vF.values;
        this.windCache.nlat = GRID.nlat;
        this.windCache.nlon = GRID.nlon;
        this.windCache.stale = false;
    }

    sampleWind(lat, lon) {
        if (this.windCache.stale) this.refreshWindCache();
        const { u, v, nlat, nlon } = this.windCache;
        // Grid row 0 = lat +90, col 0 = lon −180.
        const rLat = 90 - lat;
        const rLon = ((lon + 180) % 360 + 360) % 360;
        if (rLat < 0 || rLat > nlat - 1) return null;
        const i0 = Math.floor(rLat);
        const i1 = Math.min(nlat - 1, i0 + 1);
        const j0 = Math.floor(rLon) % nlon;
        const j1 = (j0 + 1) % nlon;
        const fi = rLat - i0;
        const fj = rLon - Math.floor(rLon);
        const uTop = u[i0 * nlon + j0] * (1 - fj) + u[i0 * nlon + j1] * fj;
        const uBot = u[i1 * nlon + j0] * (1 - fj) + u[i1 * nlon + j1] * fj;
        const vTop = v[i0 * nlon + j0] * (1 - fj) + v[i0 * nlon + j1] * fj;
        const vBot = v[i1 * nlon + j0] * (1 - fj) + v[i1 * nlon + j1] * fj;
        return [uTop * (1 - fi) + uBot * fi, vTop * (1 - fi) + vBot * fi];
    }

    // ── mode switching ───────────────────────────────────────────────
    setViewMode(mode) {
        if (mode === this.state.viewMode) return;
        this.state.viewMode = mode;
        this.globeGroup.visible = mode === 'globe';
        this.mapGroup.visible   = mode === 'map';
        this.orbitGroup.visible = mode === 'orbit';

        // Map-specific controls only meaningful in map view.
        const mcg = document.getElementById('map-center-group');
        if (mcg) mcg.hidden = mode !== 'map';
        this.updateHintForViewMode();

        this.rebuildCoastlines();
        this.rebuildGraticule();

        // Wind overlays + contour labels only attach to globe or map groups;
        // in orbit mode they're hidden (orbit view is too zoomed-out for them
        // to read). Parent them to globeGroup as a no-op when in orbit.
        const overlayParent = mode === 'orbit' ? this.globeGroup : this.currentGroup();

        this.particles.object.parent?.remove(this.particles.object);
        this.barbs.object.parent?.remove(this.barbs.object);
        overlayParent.add(this.particles.object);
        overlayParent.add(this.barbs.object);
        this.particles.onProjectionChanged();
        if (this.state.windMode === 'barbs') this.barbs.rebuild(mode);

        if (this.contourLabels) {
            this.contourLabels.group.parent?.remove(this.contourLabels.group);
            overlayParent.add(this.contourLabels.group);
            this.contourLabels.setProjection((lat, lon, r) => this.project(lat, lon, r));
            this.updateField();  // regenerate labels for new projection
        }
        this.applySunVisibility();

        this.configureCamera();
    }

    configureCamera() {
        if (this.state.viewMode === 'globe') {
            this.camera.position.set(...cameraFromView(DEFAULT_VIEW, AXIAL_TILT));
            this.controls.enableRotate = true;
            this.controls.enablePan = false;
            this.controls.minDistance = 1.4;
            this.controls.maxDistance = 8;
        } else if (this.state.viewMode === 'map') {
            this.camera.position.set(0, 0, 3.6);
            this.controls.enableRotate = false;
            this.controls.enablePan = false;      // custom drag handler shifts centre meridian instead
            this.controls.minDistance = 1.2;
            this.controls.maxDistance = 6;
            this.controls.target.set(0, 0, 0);
            this.controls.update();
            return;
        } else if (this.state.viewMode === 'orbit') {
            // Camera above the ecliptic, looking down-and-inward so the
            // student sees the orbit plane, the sun, and Earth's tilted axis
            // all at once.
            this.camera.position.set(ORBIT_RADIUS * 1.4, ORBIT_RADIUS * 1.1, ORBIT_RADIUS * 1.4);
            this.controls.enableRotate = true;
            this.controls.enablePan = false;
            this.controls.minDistance = 2.0;
            this.controls.maxDistance = 14;
        } else {
            this.camera.position.set(0, 0, 3.6);
            this.controls.enableRotate = false;
            this.controls.enablePan = true;
            this.controls.screenSpacePanning = true;
            this.controls.minDistance = 1.2;
            this.controls.maxDistance = 6;
        }
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    // ── state updates ─────────────────────────────────────────────────
    setState(patch) {
        Object.assign(this.state, patch);
        if ('showCoastlines' in patch && this.coastGroup) this.coastGroup.visible = !!patch.showCoastlines;
        if ('showGraticule' in patch && this.gratGroup)   this.gratGroup.visible   = !!patch.showGraticule;
        if ('showContours' in patch && this.contours)     this.contours.setVisible(!!patch.showContours);
        if ('showSun' in patch || 'viewMode' in patch)    this.applySunVisibility();
        if ('month' in patch && this.sun)                 this.sun.update(this.state.month);
        if ('month' in patch && this.orbit)               this.orbit.update(this.state.month, this.spinAngle, this.camera);
        if ('windMode' in patch) this.applyWindMode();
        if ('cmap' in patch) this.applyParticleContrast();
        if ('decompose' in patch) {
            this.applyParticleContrast();
            // Anomaly needs the full 12-month tile set to compute the annual
            // mean; prefetch here so switching modes hurries them along.
            if (patch.decompose === 'anomaly') {
                prefetchField(this.state.field, { level: this.state.level });
            }
        }
        if ('mapCenterLon' in patch) this.applyMapCenterLon();
        if ('showXSection' in patch) {
            const panel = document.getElementById('xsection-panel');
            if (panel) panel.hidden = !patch.showXSection;
        }
        if ('level' in patch || 'month' in patch) this.windCache.stale = true;

        // Eagerly prefetch all 12 months at this (field, level) so the
        // colorbar stabilises quickly once any tile lands.
        if ('field' in patch || 'level' in patch) {
            prefetchField(this.state.field, { level: this.state.level });
            prefetchField('u', { level: this.state.level });
            prefetchField('v', { level: this.state.level });
        }

        // Barbs are static — rebuild when the wind field (or map centering)
        // changes, or when the user switches INTO barbs mode.
        if (this.barbs && this.state.windMode === 'barbs' &&
            ('level' in patch || 'month' in patch || 'windMode' in patch || 'mapCenterLon' in patch)) {
            this.barbs.rebuild(this.state.viewMode);
        }

        this.updateField();
        if (this.state.showXSection) this.updateXSection();
    }

    updateXSection() {
        const canvas = document.getElementById('xs-canvas');
        if (!canvas) return;
        const zm = computeZonalMean(this.state.field, this.state.month);
        renderCrossSection(canvas, zm, this.state.cmap);
        const title = document.getElementById('xs-title');
        if (title) {
            const suffix = zm.type === 'pl' ? '' : `  (${zm.units})`;
            title.textContent = `Zonal mean · ${zm.name}${suffix}`;
        }
    }

    updateField() {
        const { field, level, month, cmap, decompose: mode } = this.state;
        const f = getField(field, { month, level });

        // Apply decomposition mode (total / zonal / eddy / anomaly).
        const decomp = this.applyDecomposition(f, mode);
        const effCmap = decomp.symmetric ? 'RdBu_r' : cmap;

        fillRGBA(this.imageData.data, decomp.values, {
            vmin: decomp.vmin, vmax: decomp.vmax, cmap: effCmap,
        });
        this.ctx.putImageData(this.imageData, 0, 0);
        this.texture.needsUpdate = true;
        if (this.mapTexture) this.mapTexture.needsUpdate = true;
        if (this.earthTexture) this.earthTexture.needsUpdate = true;

        // Decorated field for contour overlay + colorbar — use the transformed
        // values and range so contours track whichever mode is showing.
        const fDecorated = {
            ...f,
            values: decomp.values,
            vmin: decomp.vmin,
            vmax: decomp.vmax,
            decomposeMode: mode,
            isSymmetric: decomp.symmetric,
            effCmap,
        };
        this.updateContours(fDecorated);
        this.updateStatus(f);   // status reflects raw tile, not the transform
        this.emit('field-updated', { field: fDecorated });
    }

    applyDecomposition(f, mode) {
        if (mode === 'total' || !mode) {
            return decompose(f.values, GRID.nlat, GRID.nlon, 'total');
        }
        if (mode === 'anomaly') {
            // Build the 12-month mean from whatever tiles are cached so far.
            // If fewer than all 12 are in, the mean uses what it has and
            // will refine itself when more arrive (each field-loaded event
            // re-triggers updateField).
            const meta = FIELDS[this.state.field] || {};
            const useLevel = meta.type === 'pl' ? this.state.level : null;
            const comp = meta.derived === true
                ? null  // derived fields (wspd) handled below via components
                : annualMeanFrom(
                    (m) => cachedMonth(this.state.field, m, useLevel),
                    GRID.nlat, GRID.nlon,
                );
            return decompose(f.values, GRID.nlat, GRID.nlon, 'anomaly', comp);
        }
        return decompose(f.values, GRID.nlat, GRID.nlon, mode);
    }

    updateContours(f) {
        if (!this.contours) return;
        const meta = FIELDS[this.state.field] || {};
        const interval = meta.contour;
        const hasContours = !!interval;
        if (!hasContours) {
            this.contours.setVisible(false);
            this.contourLabels?.clear();
            return;
        }
        this.contours.setData(f.values);
        this.contours.setInterval(interval);
        // Divergent colormaps → emphasise the zero line. True for the
        // configured cmap (e.g. RdBu_r on u/v) OR any symmetric decomposition.
        const divergent = meta.cmap === 'RdBu_r' || f.isSymmetric;
        this.contours.setEmphasis(0, divergent);
        // Ink tracks EFFECTIVE cmap luminance (eddy/anomaly forces RdBu_r).
        const effCmap = f.effCmap || this.state.cmap;
        const darkBg = meanLuminance(effCmap) < 0.45;
        this.contours.setInk(darkBg ? 0xf4faf7 : 0x0a1712);
        this.contours.setOpacity(darkBg ? 0.70 : 0.85);
        this.contours.setVisible(this.state.showContours);

        if (this.contourLabels) {
            this.contourLabels.update(
                f.values, GRID.nlat, GRID.nlon, interval,
                { viewMode: this.state.viewMode },
            );
            this.contourLabels.setVisible(this.state.showContours);
        }
    }

    updateStatus(f) {
        const el = document.getElementById('sidebar-status');
        if (!el) return;
        if (f.isReal) {
            el.innerHTML = '<strong>ERA5 · 1991–2020</strong>' +
                'Monthly-mean climatology at 1° grid, served from <code>gs://gc-atlas-era5</code>.';
        } else {
            el.innerHTML = '<strong>Loading…</strong>' +
                'Fetching the ERA5 tile for this field. It should render in a moment.';
        }
    }

    // ── mini event bus ────────────────────────────────────────────────
    on(name, fn)     { (this.listeners[name] ||= []).push(fn); }
    emit(name, data) { (this.listeners[name] || []).forEach(fn => fn(data)); }

    // ── UI wiring ────────────────────────────────────────────────────
    bindUI() {
        const fieldSel = document.getElementById('field-select');
        for (const [key, meta] of Object.entries(FIELDS)) {
            fieldSel.appendChild(Object.assign(document.createElement('option'),
                { value: key, textContent: meta.name }));
        }
        fieldSel.value = this.state.field;
        fieldSel.addEventListener('change', () => {
            const field = fieldSel.value;
            const meta = FIELDS[field];
            const patch = { field };
            if (meta.cmap) patch.cmap = meta.cmap;
            if (meta.type === 'pl' && meta.defaultLevel) patch.level = meta.defaultLevel;
            this.setState(patch);
            document.getElementById('cmap-select').value = this.state.cmap;
            document.getElementById('level-select').value = this.state.level;
            this.refreshLevelAvailability();
        });

        const levelSel = document.getElementById('level-select');
        for (const p of LEVELS) {
            levelSel.appendChild(Object.assign(document.createElement('option'),
                { value: p, textContent: `${p} hPa` }));
        }
        levelSel.value = this.state.level;
        levelSel.addEventListener('change', () => this.setState({ level: +levelSel.value }));

        const monthSel = document.getElementById('month-select');
        MONTHS.forEach((m, i) => {
            monthSel.appendChild(Object.assign(document.createElement('option'),
                { value: i + 1, textContent: m }));
        });
        monthSel.value = this.state.month;
        const monthSlider = document.getElementById('month-slider');
        if (monthSlider) monthSlider.value = this.state.month;

        const syncMonthUI = (m) => {
            monthSel.value = m;
            if (monthSlider) monthSlider.value = m;
        };
        this._syncMonthUI = syncMonthUI;

        monthSel.addEventListener('change', () => {
            this.stopPlay();
            const m = +monthSel.value;
            syncMonthUI(m);
            this.setState({ month: m });
        });
        if (monthSlider) {
            monthSlider.addEventListener('input', () => {
                this.stopPlay();
                const m = +monthSlider.value;
                syncMonthUI(m);
                this.setState({ month: m });
            });
        }

        const playBtn = document.getElementById('month-play');
        playBtn.addEventListener('click', () => {
            if (this.playTimer) this.stopPlay();
            else                this.startPlay();
        });

        const cmapSel = document.getElementById('cmap-select');
        for (const c of COLORMAPS) {
            cmapSel.appendChild(Object.assign(document.createElement('option'),
                { value: c, textContent: c }));
        }
        cmapSel.value = this.state.cmap;
        cmapSel.addEventListener('change', () => this.setState({ cmap: cmapSel.value }));

        document.getElementById('toggle-coastlines').addEventListener('change', (e) => {
            this.setState({ showCoastlines: e.target.checked });
        });
        document.getElementById('toggle-graticule').addEventListener('change', (e) => {
            this.setState({ showGraticule: e.target.checked });
        });
        document.getElementById('toggle-contours').addEventListener('change', (e) => {
            this.setState({ showContours: e.target.checked });
        });
        document.getElementById('toggle-sun').addEventListener('change', (e) => {
            this.setState({ showSun: e.target.checked });
        });
        // Wind overlay mode: segmented control (Off / Particles / Barbs)
        document.querySelectorAll('[data-wind-mode]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.getAttribute('data-wind-mode');
                document.querySelectorAll('[data-wind-mode]').forEach((b) =>
                    b.classList.toggle('active', b === btn));
                this.setState({ windMode: mode });
            });
        });
        // Decomposition mode: Total / Zonal / Eddy / Anomaly
        document.querySelectorAll('[data-decompose]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.getAttribute('data-decompose');
                document.querySelectorAll('[data-decompose]').forEach((b) =>
                    b.classList.toggle('active', b === btn));
                this.setState({ decompose: mode });
            });
        });
        // Central-meridian slider (map view only)
        const mapCenterSlider = document.getElementById('map-center-slider');
        const mapCenterValue  = document.getElementById('map-center-value');
        mapCenterSlider?.addEventListener('input', () => {
            const lon = +mapCenterSlider.value;
            mapCenterValue.textContent = `${lon}°`;
            this.setState({ mapCenterLon: lon });
        });
        document.getElementById('toggle-xsection').addEventListener('change', (e) => {
            this.setState({ showXSection: e.target.checked });
        });
        document.getElementById('xs-close').addEventListener('click', () => {
            document.getElementById('toggle-xsection').checked = false;
            this.setState({ showXSection: false });
        });

        // View-mode toggle (Globe | Map | Orbit)
        const btnGlobe = document.getElementById('view-globe');
        const btnMap   = document.getElementById('view-map');
        const btnOrbit = document.getElementById('view-orbit');
        const setActive = (mode) => {
            btnGlobe.classList.toggle('active', mode === 'globe');
            btnMap.classList.toggle('active',   mode === 'map');
            btnOrbit.classList.toggle('active', mode === 'orbit');
        };
        btnGlobe.addEventListener('click', () => { this.setViewMode('globe'); setActive('globe'); });
        btnMap.addEventListener('click',   () => { this.setViewMode('map');   setActive('map'); });
        btnOrbit.addEventListener('click', () => { this.setViewMode('orbit'); setActive('orbit'); });

        // Mobile controls drawer: hamburger toggles the sidebar overlay.
        const hamburger = document.getElementById('sidebar-toggle');
        const sidebar   = document.getElementById('sidebar');
        const backdrop  = document.getElementById('sidebar-backdrop');
        const setDrawer = (open) => {
            sidebar?.classList.toggle('open', open);
            backdrop?.classList.toggle('open', open);
        };
        hamburger?.addEventListener('click', () => {
            setDrawer(!sidebar?.classList.contains('open'));
        });
        backdrop?.addEventListener('click', () => setDrawer(false));
        // Auto-close on any view-mode or field change so the user sees the result.
        const closeOnSelect = () => { if (window.innerWidth <= 820) setDrawer(false); };
        btnGlobe.addEventListener('click', closeOnSelect);
        btnMap.addEventListener('click', closeOnSelect);
        btnOrbit.addEventListener('click', closeOnSelect);

        this.refreshLevelAvailability();
        this.on('field-updated', ({ field }) => this.updateColorbar(field));
    }

    startPlay() {
        const btn = document.getElementById('month-play');
        const monthSel = document.getElementById('month-select');
        if (btn) { btn.textContent = '⏸'; btn.classList.add('playing'); btn.setAttribute('aria-label', 'pause'); }
        // Prefetch the whole seasonal cycle for the current field (and for u/v so
        // the wind particles stay smooth as months advance).
        prefetchField(this.state.field, { level: this.state.level });
        prefetchField('u', { level: this.state.level });
        prefetchField('v', { level: this.state.level });
        this.playTimer = setInterval(() => {
            const next = this.state.month === 12 ? 1 : this.state.month + 1;
            if (this._syncMonthUI) this._syncMonthUI(next);
            this.setState({ month: next });
        }, PLAY_INTERVAL_MS);
    }

    stopPlay() {
        if (!this.playTimer) return;
        clearInterval(this.playTimer);
        this.playTimer = null;
        const btn = document.getElementById('month-play');
        if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); btn.setAttribute('aria-label', 'play through months'); }
    }

    refreshLevelAvailability() {
        const meta = FIELDS[this.state.field];
        const levelSel = document.getElementById('level-select');
        const disabled = meta.type === 'sl';
        levelSel.disabled = disabled;
        const wrap = levelSel.closest('.control-group');
        if (wrap) wrap.classList.toggle('is-disabled', disabled);
    }

    updateColorbar(field) {
        const cb = document.getElementById('colorbar-canvas');
        // Use the effective cmap from the decomposition so the colorbar
        // matches the painted globe (forced to RdBu_r in eddy/anomaly).
        const effCmap = field.effCmap || this.state.cmap;
        if (cb) fillColorbar(cb, effCmap);
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        set('cb-min',   fmtValue(field.vmin));
        set('cb-max',   fmtValue(field.vmax));
        const modeSuffix = {
            zonal:   ' · zonal mean',
            eddy:    ' · eddy',
            anomaly: ' · anomaly',
        }[field.decomposeMode] || '';
        set('cb-title', field.name + modeSuffix);
        set('cb-units', field.units);
    }

    // ── render loop ──────────────────────────────────────────────────
    animate() {
        const tick = () => {
            this.controls.update();
            if (this.state.windMode === 'particles' && this.particles) this.particles.step();
            // Diurnal spin on the mini-Earth in orbit mode — purely cosmetic
            // (the data is monthly climatology, so there's no "real" time of
            // day), but the rotation sells the "this is a planet" effect.
            if (this.state.viewMode === 'orbit' && this.orbit) {
                this.spinAngle = (this.spinAngle + 0.012) % (Math.PI * 2);
                this.orbit.update(this.state.month, this.spinAngle, this.camera);
            }
            this.renderer.render(this.scene, this.camera);
            requestAnimationFrame(tick);
        };
        tick();
    }
}

function fmtValue(v) {
    if (Math.abs(v) >= 1000) return v.toFixed(0);
    if (Math.abs(v) >= 10)   return v.toFixed(1);
    return v.toFixed(2);
}

const mount = document.getElementById('globe-mount');
if (mount) new GlobeApp(mount);
