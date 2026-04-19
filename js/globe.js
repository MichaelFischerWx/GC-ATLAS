// GC-ATLAS — interactive globe renderer (Three.js).
// Mounts on #globe-mount, reads/writes controls in #field-select etc.
// Synthetic fields for now (js/data.js); swap to a Zarr loader when ERA5 lands.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { fillRGBA, fillColorbar, COLORMAPS, meanLuminance } from './colormap.js';
import { getField, FIELDS, LEVELS, THETA_LEVELS, MONTHS, GRID, invalidateIsentropicCache, isThetaOnly } from './data.js';
import { ParticleField } from './particles.js';
import { BarbField } from './barbs.js';
import { ContourField } from './contours.js';
import { ContourLabels } from './contour_labels.js';
import { SunLight } from './sun.js';
import { OrbitScene, ORBIT_RADIUS } from './orbit.js';
import { computeZonalMean, computeArcCrossSection, renderCrossSection, samplePanel } from './cross_section.js';
import { greatCircleArc, latLonToVec3, gcDistanceKm } from './arc.js';
import { loadManifest, onFieldLoaded, isReady as era5Ready, prefetchField, cachedMonth, registerClamps } from './era5.js';
import { decompose, annualMeanFrom, aggregatedDecompositionRange } from './decompose.js';
import { HoverProbe } from './hover.js';
import { computeMassStreamfunction, computeAngularMomentum, computeBruntVaisala, computeGeostrophicWind } from './diagnostics.js';
import { computeEPFlux } from './ep_flux.js';
import { computeLorenzCycle } from './lorenz.js';
import { buildMBudgetView } from './m_budget.js';
import { buildQBudgetView } from './q_budget.js';
import { buildHBudgetView } from './h_budget.js';
import { ParcelField } from './parcels.js';
import { GifExporter, downloadBlob } from './gif_export.js';

const PLAY_INTERVAL_MS = 900;

// Natural Earth 50 m coastline + lakes. Mirrored on GCS so the site doesn't
// re-fetch ~2.4 MB from a third-party CDN on every load. Lakes (Great Lakes,
// Caspian, Victoria, Baikal, Aral, …) draw alongside coastlines using the
// same shared material — a single Coastlines toggle controls both.
const IS_LOCAL_HOST = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const COASTLINE_BASE = IS_LOCAL_HOST
    ? 'data/coastlines'
    : 'https://storage.googleapis.com/gc-atlas-era5/coastlines';
const COASTLINE_URL = `${COASTLINE_BASE}/ne_50m_coastline.geojson`;
const LAKES_URL     = `${COASTLINE_BASE}/ne_50m_lakes.geojson`;
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
            theta: 330,              // isentropic surface (K) when vCoord='theta'
            vCoord: 'pressure',      // 'pressure' | 'theta'
            month: 1,
            cmap: FIELDS.t.cmap,
            viewMode: 'globe',   // 'globe' | 'map'
            showCoastlines: true,
            showGraticule: true,
            showContours: false,
            showSun: true,
            windMode: 'particles',   // 'off' | 'particles' | 'barbs'
            decompose: 'total',      // 'total' | 'zonal' | 'eddy' | 'anomaly'
            kind: 'mean',            // 'mean' (climatology) | 'std' (inter-annual ±1σ)
            referencePeriod: 'default',  // 'default' (1991-2020) | '1961-1990' | …
            userVmin: null,          // manual colorbar min override; null = auto
            userVmax: null,          // manual colorbar max override; null = auto
            mapCenterLon: 0,         // central meridian for the flat map (-180..180)
            showXSection: false,
            showLorenz: false,
            lorenzRef: 'lorenz',     // 'lorenz' (sorted) | 'simple' (area-mean)
            xsArc: null,             // { start:{lat,lon}, end:{lat,lon} } or null for zonal-mean
            xsDiag: 'field',         // 'field' | 'psi' | 'M' | 'N2' | 'epflux' | 'mbudget'
            mbTerm: 'total',         // 'total' | 'meanY' | 'meanP' | 'eddyY' | 'eddyP' | 'torque'
            mbForm: 'u',             // 'u' (∂[u]/∂t m/s/day) | 'M' (∂[M]/∂t scaled)
            mbMode: '2d',            // '2d' | '1d_mean' (mass-weighted profile) | '1d_int' (∫dp/g, N/m²)
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
        // Register percentile-clamp metadata so spiky fields (vo, d, w, tp)
        // get colorbars based on their bulk distribution rather than isolated
        // topographic / convective extremes.
        registerClamps(FIELDS);
        onFieldLoaded(({ name, month, level, period }) => {
            const s = this.state;
            const levelMatches = (level == null || level === s.level);
            const monthMatches = (month === s.month);
            // Reference-period tile arrival → only matters for the active
            // climate-change-anomaly view at the matching field/month/level.
            if (period && period !== 'default') {
                if (s.referencePeriod === period && s.decompose === 'anomaly'
                        && name === s.field && monthMatches) {
                    this.updateField();
                }
                return;   // don't trigger any of the default-period logic
            }
            const isenActive  = (s.vCoord === 'theta');
            // θ-coord rendering needs T at every level (for the θ cube) plus
            // the chosen field at every level. PV additionally needs u, v.
            const isenNeedsName = isenActive &&
                (name === 't' || name === s.field ||
                 (s.field === 'wspd' && (name === 'u' || name === 'v')) ||
                 (s.field === 'pv'   && name === 'pv') ||
                 (s.field === 'mse'  && (name === 'z' || name === 'q')));
            const feedsCurrentField =
                (name === s.field) ||
                (s.field === 'wspd' && (name === 'u' || name === 'v')) ||
                (s.field === 'pv'   && (name === 't' || name === 'pv')) ||
                (s.field === 'mse'  && (name === 't' || name === 'z' || name === 'q')) ||
                isenNeedsName;

            // PV and θ-coord fields span every pressure level, so don't
            // require level to match — any ingredient arrival could complete
            // the cache.
            const needsLevelMatch = !(
                isenNeedsName ||
                (s.field === 'pv' && (name === 't' || name === 'pv'))
            );
            // MSE in pressure-coord is single-level (only the chosen level matters).
            // In θ-coord it gets caught by isenNeedsName below.
            if (feedsCurrentField && monthMatches && (!needsLevelMatch || levelMatches)) {
                if (s.field === 'pv' || isenActive) invalidateIsentropicCache();
                this.updateField();
            }

            // Anomaly mode needs all 12 months to compute an accurate annual
            // mean; re-render whenever any month of the current field lands
            // so the anomaly sharpens as tiles come in.
            if (feedsCurrentField && levelMatches && !monthMatches &&
                s.decompose === 'anomaly') {
                this.updateField();
            }

            if (name === 'u' || name === 'v' ||
                (isenActive && name === 't')) this.windCache.stale = true;

            if (s.showXSection && feedsCurrentField && monthMatches) this.updateXSection();
            // ψ needs v at every level; M needs u at every level; N² needs T;
            // EP flux needs u, v, w, t. Refresh the panel whenever a relevant
            // tile lands so the diagnostic sharpens as the cache warms up.
            const diagNeeds = (s.xsDiag === 'psi'    && name === 'v')
                           || (s.xsDiag === 'M'      && name === 'u')
                           || (s.xsDiag === 'ug'     && name === 'z')
                           || (s.xsDiag === 'N2'     && name === 't')
                           || (s.xsDiag === 'epflux' && (name === 'u' || name === 'v' || name === 'w' || name === 't'))
                           || (s.xsDiag === 'mbudget' && (name === 'u' || name === 'v' || name === 'w'))
                           || (s.xsDiag === 'qbudget' && (name === 'u' || name === 'v' || name === 'w' || name === 'q'))
                           || (s.xsDiag === 'hbudget' && (name === 'u' || name === 'v' || name === 'w' || name === 't' || name === 'z' || name === 'q'));
            if (s.showXSection && diagNeeds && monthMatches) {
                this.updateXSection();
            }
            // Lorenz cycle needs u, v, w, t at every level for the current month.
            const lorenzIngredient = (name === 'u' || name === 'v' || name === 'w' || name === 't');
            if (s.showLorenz && lorenzIngredient && monthMatches) {
                this.updateLorenz();
            }
        });
        // Prime: ask for the current field, which triggers a fetch.
        this.updateField();
        // The wind overlay (particles / barbs) needs u and v at the current
        // level. The main field isn't necessarily u/v/wspd on first load, so
        // kick those fetches explicitly here — otherwise particles respawn
        // every frame on NaN winds until the user changes level or field.
        prefetchField('u', { level: this.state.level });
        prefetchField('v', { level: this.state.level });
    }

    // ── scene / camera / controls ────────────────────────────────────
    initScene() {
        const { w, h } = this.size();
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 100);
        this.camera.position.set(...cameraFromView(DEFAULT_VIEW, AXIAL_TILT));

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
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

        // Tips card in the bottom-right. Persistent (doesn't fade on
        // interaction) until the user clicks the × — it's a reference for
        // keyboard/mouse controls, not a first-run tutorial.
        this.tipsPanel = document.getElementById('tips-panel');
        this.tipsContent = document.getElementById('tips-content');
        const dismiss = document.getElementById('tips-dismiss');
        dismiss?.addEventListener('click', () => {
            this.tipsPanel?.classList.add('hidden');
        });
        this.updateHintForViewMode();   // populate with the initial view's tips

        // Map-mode drag handler — shifts the central meridian instead of
        // panning the camera (OrbitControls.enablePan = false in map mode).
        this.installMapDrag();
        // Globe-mode shift-drag: draw a great-circle arc for the cross-section.
        this.installArcDrag();

        window.addEventListener('resize', () => this.onResize());
    }

    installArcDrag() {
        const el = this.renderer.domElement;
        const raycaster = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        let dragging = false;
        let startPt = null;

        const pointToLatLon = (e) => {
            const rect = el.getBoundingClientRect();
            ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(ndc, this.camera);

            if (this.state.viewMode === 'globe') {
                if (!this.globe) return null;
                const hits = raycaster.intersectObject(this.globe);
                if (hits.length === 0) return null;
                const local = this.globeGroup.worldToLocal(hits[0].point.clone());
                const n = local.length() || 1;
                return {
                    lat: Math.asin(local.y / n) * 180 / Math.PI,
                    lon: Math.atan2(local.x, local.z) * 180 / Math.PI,
                };
            }
            if (this.state.viewMode === 'map') {
                if (!this.mapMesh) return null;
                const hits = raycaster.intersectObject(this.mapMesh);
                if (hits.length === 0) return null;
                let lon = hits[0].point.x * (360 / MAP_W) + this.state.mapCenterLon;
                const lat = hits[0].point.y * (180 / MAP_H);
                lon = ((lon + 180) % 360 + 360) % 360 - 180;
                if (lat < -90 || lat > 90) return null;
                return { lat, lon };
            }
            return null;   // orbit view doesn't support clicks
        };

        // Alt+click: drop a cluster of Lagrangian parcels at the clicked
        // (lat, lon), defaulting to the upper troposphere. Installed before
        // the shift+drag listener so pointerdown-propagation order is
        // deterministic.
        el.addEventListener('pointerdown', (e) => {
            if (!e.altKey) return;
            if (this.state.viewMode !== 'globe') return;
            const p = pointToLatLon(e);
            if (!p) return;
            e.preventDefault();
            // First-time seed: kick prefetches for u, v, w at every level so
            // the 3D wind cube fills in parallel with the first few steps.
            if (!this.parcels.hasActive()) {
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                }
            }
            this.parcels.seed(p.lat, p.lon, this.state.level);
        });

        el.addEventListener('pointerdown', (e) => {
            if (!e.shiftKey) return;
            // Globe + map both support shift-drag arcs; orbit view doesn't.
            if (this.state.viewMode === 'orbit') return;
            // No arcs in diagnostic modes — they're inherently zonal.
            if (this.state.xsDiag !== 'field') return;
            const p = pointToLatLon(e);
            if (!p) return;
            dragging = true;
            startPt = p;
            // Pause OrbitControls (globe) or the map drag-pan handler so the
            // arc draw doesn't fight the camera/projection drag.
            this.controls.enabled = false;
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            // Open the cross-section panel if it isn't already.
            if (!this.state.showXSection) {
                const chk = document.getElementById('toggle-xsection');
                if (chk) chk.checked = true;
                this.setState({ showXSection: true });
            }
            this.setState({ xsArc: { start: p, end: p } });
        });

        el.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const p = pointToLatLon(e);
            if (!p) return;
            this.setState({ xsArc: { start: startPt, end: p } });
        });

        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            this.controls.enabled = true;
            try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        };
        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);
    }

    installMapDrag() {
        const el = this.renderer.domElement;
        let dragging = false;
        let lastX = 0;
        el.addEventListener('pointerdown', (e) => {
            if (this.state.viewMode !== 'map') return;
            // Skip the pan if the user is shift-dragging (cross-section arc),
            // alt-clicking (Lagrangian parcels — globe-only but cheap to guard
            // here too), or interacting with a panel above the canvas.
            if (e.shiftKey || e.altKey) return;
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
        if (!this.tipsContent) return;
        // Three-row tips card with distinct kbd badges per row. Content
        // swaps with view mode so each view only shows its relevant
        // gestures.
        const rows = {
            globe: [
                { kbd: 'drag',         desc: 'rotate the globe' },
                { kbd: '⇧ + drag',    desc: 'draw cross-section arc' },
                { kbd: '⌥ + click',   desc: 'release parcels' },
                { kbd: 'scroll',       desc: 'zoom' },
            ],
            map: [
                { kbd: 'drag',         desc: 'pan the central meridian' },
                { kbd: 'scroll',       desc: 'zoom' },
            ],
            orbit: [
                { kbd: 'drag',         desc: 'orbit the camera' },
                { kbd: 'scroll',       desc: 'zoom' },
            ],
        }[this.state.viewMode] || [];
        this.tipsContent.innerHTML = rows.map(r =>
            `<div class="tips-row"><span class="tips-kbd">${r.kbd}</span>` +
            `<span class="tips-desc">${r.desc}</span></div>`,
        ).join('');
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
        if (this.arcLineMaterial) this.arcLineMaterial.resolution.set(w, h);
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

        // Lagrangian parcel field (alt-click to seed on globe view).
        this.parcels = new ParcelField();
        this.globeGroup.add(this.parcels.object);

        // Arc for the cross-section feature (shift-drag to draw). Uses Line2
        // (fat lines) so the stroke stays visible at any zoom; WebGL's
        // built-in line rasteriser clamps to 1 px on most drivers. Two small
        // amber spheres mark the endpoints so the direction of the arc reads
        // at a glance.
        this.arcGroup = new THREE.Group();
        this.arcGroup.visible = false;
        this.arcGroup.renderOrder = 7;
        this.arcLineMaterial = new LineMaterial({
            color: 0xFFE27A,
            linewidth: 4,
            worldUnits: false,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
        });
        this.arcLine = new Line2(new LineGeometry(), this.arcLineMaterial);
        this.arcLine.renderOrder = 7;
        this.arcGroup.add(this.arcLine);

        const endpointMat = new THREE.MeshBasicMaterial({
            color: 0xFFC74D, transparent: true, opacity: 0.95, depthTest: false,
        });
        const midpointMat = new THREE.MeshBasicMaterial({
            color: 0xFFE27A, transparent: true, opacity: 0.95, depthTest: false,
        });
        const endpointGeom = new THREE.SphereGeometry(0.018, 16, 12);
        const midpointGeom = new THREE.SphereGeometry(0.013, 16, 12);
        this.arcStartDot = new THREE.Mesh(endpointGeom, endpointMat);
        this.arcEndDot   = new THREE.Mesh(endpointGeom, endpointMat);
        this.arcMidDot   = new THREE.Mesh(midpointGeom, midpointMat);
        this.arcStartDot.renderOrder = 8;
        this.arcEndDot.renderOrder = 8;
        this.arcMidDot.renderOrder = 8;
        this.arcGroup.add(this.arcStartDot);
        this.arcGroup.add(this.arcEndDot);
        this.arcGroup.add(this.arcMidDot);
        this.currentGroup().add(this.arcGroup);

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

        // Hover readout — shows (lat, lon, value) at the cursor. Reads the
        // last-rendered (decomposed) field, not the raw tile, so it matches
        // what the user sees on the globe / map.
        this.hover = new HoverProbe({
            canvas:          this.renderer.domElement,
            camera:          this.camera,
            getViewMode:     () => this.state.viewMode,
            getGlobeMesh:    () => this.globe,
            getMapMesh:      () => this.mapMesh,
            getMapW:         () => MAP_W,
            getMapH:         () => MAP_H,
            getMapCenterLon: () => this.state.mapCenterLon,
            sampleDisplayed: (lat, lon) => this.sampleDisplayed(lat, lon),
            formatLabel:     (lat, lon, v) => this.formatHoverLabel(lat, lon, v),
        });
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

    // ── coastlines + lakes overlay (Natural Earth 50 m, mirrored on GCS) ─
    async initCoastlines() {
        this.coastGroup = new THREE.Group();
        // Walk a GeoJSON geometry into a list of [lon,lat] rings/lines.
        // Coastlines are LineString / MultiLineString; lakes are Polygon /
        // MultiPolygon (we draw the rings as outlines, not filled).
        const ringsOf = (g) => {
            if (!g) return [];
            switch (g.type) {
                case 'LineString':      return [g.coordinates];
                case 'MultiLineString': return g.coordinates;
                case 'Polygon':         return g.coordinates;        // [outer, hole1, …]
                case 'MultiPolygon':    return g.coordinates.flat(); // → list of rings
                default:                return [];
            }
        };
        const fetchFeatures = async (url) => {
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const gj = await resp.json();
                const out = [];
                for (const feat of gj.features) out.push(...ringsOf(feat.geometry));
                return out;
            } catch (err) {
                console.warn(`[globe] failed to load ${url}:`, err);
                return [];
            }
        };
        const [coastRings, lakeRings] = await Promise.all([
            fetchFeatures(COASTLINE_URL),
            fetchFeatures(LAKES_URL),
        ]);
        this.coastFeatures = [...coastRings, ...lakeRings];
        if (this.coastFeatures.length) this.rebuildCoastlines();
    }

    rebuildCoastlines() {
        if (!this.coastFeatures) return;
        this.coastGroup.parent?.remove(this.coastGroup);
        for (const child of this.coastGroup.children) child.geometry.dispose();
        this.coastGroup.clear();

        // Single shared material so applyCoastlineContrast() can flip colour
        // without rebuilding geometry on every cmap change.
        this.coastMat = new THREE.LineBasicMaterial({ transparent: true });
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
                this.coastGroup.add(new THREE.Line(geom, this.coastMat));
            }
        }
        this.currentGroup().add(this.coastGroup);
        this.coastGroup.visible = this.state.showCoastlines;
        this.applyCoastlineContrast();
    }

    applyCoastlineContrast(effCmap) {
        if (!this.coastMat) return;
        // Track the most recent effective cmap so post-rebuild calls (which
        // pass nothing) reuse the last value updateField() handed us.
        if (effCmap) this._coastEffCmap = effCmap;
        const cmap = this._coastEffCmap || this.state.cmap;
        // Match the contour-ink threshold (0.45) and palette so coastlines
        // and contour strokes stay visually consistent on every cmap.
        const darkBg = meanLuminance(cmap) < 0.45;
        this.coastMat.color.setHex(darkBg ? 0xf4faf7 : 0x000000);
        this.coastMat.opacity = darkBg ? 0.70 : 0.88;
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

    // NaN-safe bilinear sample of the currently-displayed field (after
    // decomposition). Returns a number or null when outside the grid.
    sampleDisplayed(lat, lon) {
        const vals = this._displayedValues;
        if (!vals) return null;
        const { nlat, nlon } = GRID;
        const rLat = 90 - lat;
        const rLon = ((lon + 180) % 360 + 360) % 360;
        if (rLat < 0 || rLat > nlat - 1) return null;
        const i0 = Math.floor(rLat);
        const i1 = Math.min(nlat - 1, i0 + 1);
        const j0 = Math.floor(rLon) % nlon;
        const j1 = (j0 + 1) % nlon;
        const fi = rLat - i0;
        const fj = rLon - Math.floor(rLon);
        const v00 = vals[i0 * nlon + j0], v01 = vals[i0 * nlon + j1];
        const v10 = vals[i1 * nlon + j0], v11 = vals[i1 * nlon + j1];
        const corners = [v00, v01, v10, v11];
        if (!corners.every(Number.isFinite)) {
            let s = 0, n = 0;
            for (const v of corners) if (Number.isFinite(v)) { s += v; n += 1; }
            return n > 0 ? s / n : null;
        }
        const vT = v00 * (1 - fj) + v01 * fj;
        const vB = v10 * (1 - fj) + v11 * fj;
        return vT * (1 - fi) + vB * fi;
    }

    formatHoverLabel(lat, lon, v) {
        const meta = FIELDS[this.state.field] || {};
        const latS = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
        const lonS = `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
        const mode = this.state.decompose;
        const modeTag = (mode && mode !== 'total')
            ? `<span class="hv-mode">${mode}</span>` : '';
        return (
            `${latS}<span class="hv-sep">·</span>${lonS}` +
            `<span class="hv-sep">·</span>` +
            `<span class="hv-value">${fmtValue(v)}</span>` +
            `<span class="hv-unit">${meta.units || ''}</span>${modeTag}`
        );
    }

    /** Pointer hover on the cross-section canvas → (lat, p, value) tooltip. */
    bindXSHover() {
        const canvas = document.getElementById('xs-canvas');
        const tip    = document.getElementById('xs-hover');
        if (!canvas || !tip) return;
        // Padding in CSS pixels — must mirror renderCrossSection's calc
        // (which uses padL = 42*DPR etc. in BUFFER pixels; in CSS pixels the
        // numbers are the same since they're proportional to DPR).
        const PAD_L = 42, PAD_R = 10, PAD_T = 10, PAD_B = 26;

        const onMove = (e) => {
            if (!this.state.showXSection) { tip.classList.add('hidden'); return; }
            const zm = this._xsLastZm;
            if (!zm) { tip.classList.add('hidden'); return; }
            const rect = canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const plotW = rect.width  - PAD_L - PAD_R;
            const plotH = rect.height - PAD_T - PAD_B;
            if (cx < PAD_L || cx > PAD_L + plotW || cy < PAD_T || cy > PAD_T + plotH) {
                tip.classList.add('hidden'); return;
            }
            const fracX = (cx - PAD_L) / plotW;
            const fracY = (cy - PAD_T) / plotH;
            const sample = samplePanel(zm, fracX, fracY);
            if (!sample) { tip.classList.add('hidden'); return; }
            tip.innerHTML = this.formatXSHoverLabel(zm, sample);
            // Position; flip to other side of cursor near right/bottom edges.
            const pad = 14;
            const w = tip.offsetWidth || 200;
            const h = tip.offsetHeight || 30;
            let x = e.clientX + pad;
            let y = e.clientY + pad;
            if (x + w > window.innerWidth)  x = e.clientX - w - pad;
            if (y + h > window.innerHeight) y = e.clientY - h - pad;
            tip.style.left = `${x}px`;
            tip.style.top  = `${y}px`;
            tip.classList.remove('hidden');
        };
        canvas.addEventListener('pointermove',  onMove);
        canvas.addEventListener('pointerleave', () => tip.classList.add('hidden'));
    }

    formatXSHoverLabel(zm, sample) {
        const fmt = (v, n = 2) => Number.isFinite(v) ? v.toFixed(n) : '—';
        const latS = `${Math.abs(sample.lat).toFixed(1)}°${sample.lat >= 0 ? 'N' : 'S'}`;
        const parts = [latS];
        if (sample.lon !== undefined) {
            const lonS = `${Math.abs(sample.lon).toFixed(1)}°${sample.lon >= 0 ? 'E' : 'W'}`;
            parts.push(lonS);
        }
        if (sample.p !== undefined) parts.push(`${Math.round(sample.p)} hPa`);
        const valHtml =
            `<span class="hv-value">${fmt(sample.value, 2)}</span>` +
            `<span class="hv-unit">${zm.units || ''}</span>`;
        return parts.join('<span class="hv-sep">·</span>') +
               '<span class="hv-sep">·</span>' + valHtml;
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
        const { month, level, theta, vCoord } = this.state;
        const uF = getField('u', { month, level, coord: vCoord, theta });
        const vF = getField('v', { month, level, coord: vCoord, theta });
        // If the request came back pending (tiles still loading, especially
        // in θ-coord where we need T + u + v at every pressure level), keep
        // the previous cache so particles keep moving with the last good
        // field instead of snapping to NaN. `stale` stays true so we retry
        // on the next tick.
        if (!uF.isReal || !vF.isReal) return;
        this.windCache.u = uF.values;
        this.windCache.v = vF.values;
        this.windCache.nlat = GRID.nlat;
        this.windCache.nlon = GRID.nlon;
        this.windCache.stale = false;
    }

    sampleWind(lat, lon) {
        if (this.windCache.stale) this.refreshWindCache();
        const { u, v, nlat, nlon } = this.windCache;
        if (!u || !v) return null;
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
        if (this.arcGroup) {
            this.arcGroup.parent?.remove(this.arcGroup);
            overlayParent.add(this.arcGroup);
            this.updateArcLine();
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
        if ('field' in patch) {
            // Manual colorbar override almost certainly doesn't apply to the
            // new field — drop it so the user sees the new field's natural
            // range. Persists across level / month / mode changes per design.
            this.state.userVmin = null;
            this.state.userVmax = null;
        }
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
        if ('xsArc' in patch) this.updateArcLine();
        if ('xsDiag' in patch) {
            // Diagnostics sample a specific component field at every
            // pressure level — prefetch them all so the panel fills in
            // quickly when the user switches mode.
            if (patch.xsDiag === 'psi') {
                for (const L of LEVELS) prefetchField('v', { level: L });
            } else if (patch.xsDiag === 'M') {
                for (const L of LEVELS) prefetchField('u', { level: L });
            } else if (patch.xsDiag === 'ug') {
                for (const L of LEVELS) prefetchField('z', { level: L });
            } else if (patch.xsDiag === 'N2') {
                for (const L of LEVELS) prefetchField('t', { level: L });
            } else if (patch.xsDiag === 'epflux') {
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                    prefetchField('t', { level: L });
                }
            } else if (patch.xsDiag === 'mbudget') {
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                }
            } else if (patch.xsDiag === 'qbudget') {
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                    prefetchField('q', { level: L });
                }
                // Surface E-P overlay needs slhf + tp (single-level).
                prefetchField('slhf', {});
                prefetchField('tp',   {});
            } else if (patch.xsDiag === 'hbudget') {
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                    prefetchField('t', { level: L });
                    prefetchField('z', { level: L });
                    prefetchField('q', { level: L });
                }
                // Surface heating overlay: turbulent fluxes + radiation.
                for (const sl of ['slhf','sshf','ssr','str','tisr','ttr']) prefetchField(sl, {});
            }
            // Show / hide the budget sub-controls. Same panel UI is shared
            // across all three budgets — the term labels are generic enough.
            const isBudget = ['mbudget','qbudget','hbudget'].includes(patch.xsDiag);
            const mbCtl = document.getElementById('mb-controls');
            if (mbCtl) mbCtl.hidden = !isBudget;
            // Hide the form toggle for q/h budgets (only meaningful for M).
            const mbFormGroup = document.querySelector('.mb-row-toggles .mb-toggle-group:first-child');
            if (mbFormGroup) mbFormGroup.style.display = (patch.xsDiag === 'mbudget') ? '' : 'none';
            // Re-label the residual-term option per budget context.
            const torqueOpt = document.querySelector('#mb-term-select option[value="torque"]');
            if (torqueOpt) {
                torqueOpt.textContent = patch.xsDiag === 'qbudget' ? 'Implied source (E−P)'
                                       : patch.xsDiag === 'hbudget' ? 'Implied atmospheric heating'
                                       : 'Implied surface torque';
            }
            const mbInfoBtn = document.getElementById('mb-info-btn');
            if (mbInfoBtn) mbInfoBtn.hidden = patch.xsDiag !== 'mbudget';   // popover is M-specific
            const mbInfo = document.getElementById('mb-info');
            if (mbInfo && patch.xsDiag !== 'mbudget') {
                mbInfo.setAttribute('hidden', '');
                mbInfoBtn?.classList.remove('active');
            }
        }
        if ('showXSection' in patch) {
            const panel = document.getElementById('xsection-panel');
            if (panel) panel.hidden = !patch.showXSection;
        }
        if ('showLorenz' in patch) {
            const panel = document.getElementById('lorenz-panel');
            if (panel) panel.hidden = !patch.showLorenz;
            if (patch.showLorenz) {
                // Lorenz needs u, v, w, t at every level — kick a full prefetch.
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                    prefetchField('t', { level: L });
                }
            }
        }
        if ('level' in patch || 'month' in patch || 'vCoord' in patch || 'theta' in patch) this.windCache.stale = true;
        if ('month' in patch && this.parcels) this.parcels.invalidateCube();
        if ('vCoord' in patch || 'theta' in patch) invalidateIsentropicCache();

        // Eagerly prefetch all 12 months at this (field, level) so the
        // colorbar stabilises quickly once any tile lands.
        // Reference-period change: lazy-load the manifest, then prefetch the
        // current field at all 12 months for the reference period.
        if ('referencePeriod' in patch && patch.referencePeriod !== 'default') {
            (async () => {
                const ok = await loadManifest(patch.referencePeriod);
                if (!ok) {
                    console.warn(`[ref-period] manifest unavailable for ${patch.referencePeriod} — falling back to self-anomaly`);
                    return;
                }
                prefetchField(this.state.field, { level: this.state.level, period: patch.referencePeriod });
                if (this.state.decompose === 'anomaly') this.updateField();
            })();
        }
        if ('field' in patch || 'level' in patch || 'vCoord' in patch || 'theta' in patch || 'kind' in patch) {
            const isen = this.state.vCoord === 'theta';
            const kind = this.state.kind;
            prefetchField(this.state.field, { level: this.state.level, kind });
            // If user is in climate-change-anomaly mode, also prefetch the
            // reference period's tiles for the new field/level.
            if (this.state.referencePeriod !== 'default') {
                prefetchField(this.state.field, { level: this.state.level, period: this.state.referencePeriod });
            }
            prefetchField('u', { level: this.state.level });
            prefetchField('v', { level: this.state.level });
            // MSE depends on t, z, q at the chosen level (and at every level
            // when in θ-coord OR when the cross-section panel is open).
            // We prefetch ALL 12 months at the chosen level so the aggregate
            // colorbar stabilises rather than re-shifting as months load —
            // mirrors what prefetchField does automatically for raw tiles.
            if (this.state.field === 'mse') {
                prefetchField('t', { level: this.state.level });
                prefetchField('z', { level: this.state.level });
                prefetchField('q', { level: this.state.level });
                if (this.state.showXSection) {
                    for (const L of LEVELS) {
                        prefetchField('t', { level: L });
                        prefetchField('z', { level: L });
                        prefetchField('q', { level: L });
                    }
                }
            }
            // PV and any θ-coord rendering require T at every pressure level
            // (for the θ cube) plus the chosen field at every level — kick
            // those here so they arrive in parallel. In θ-coord we also
            // prefetch u and v at every level unconditionally, because the
            // wind overlay (particles / barbs) samples isentropic u, v even
            // when the primary field is something else.
            const needsAllLevels = (this.state.field === 'pv') || isen;
            if (needsAllLevels) {
                // Build the list of ingredients we need at every level.
                // PV needs t (for the θ cube) + pv (the canonical Ertel field
                // we now interpolate directly to θ surfaces).
                const ingredients = ['t'];
                if (isen || this.state.field === 'wspd') {
                    ingredients.push('u', 'v');
                }
                if (this.state.field === 'pv') {
                    ingredients.push('pv');
                }
                if (this.state.field === 'mse') {
                    ingredients.push('z', 'q');
                }
                if (FIELDS[this.state.field]?.type === 'pl' &&
                    !['u','v','wspd','pv','t','mse'].includes(this.state.field)) {
                    ingredients.push(this.state.field);
                }
                // Hot path: fetch every level for the CURRENT month first so
                // the view renders asap. Deferring the other 11 months keeps
                // the browser's 6-connection queue focused on what we need
                // right now — the all-months warmup follows in a microtask
                // for the colorbar aggregation + play mode.
                const current = [this.state.month];
                for (const L of LEVELS) {
                    for (const name of ingredients) {
                        prefetchField(name, { level: L, months: current });
                    }
                }
                setTimeout(() => {
                    const others = [1,2,3,4,5,6,7,8,9,10,11,12].filter(m => m !== this.state.month);
                    for (const L of LEVELS) {
                        for (const name of ingredients) {
                            prefetchField(name, { level: L, months: others });
                        }
                    }
                }, 1500);
            }
        }

        // Barbs are static — rebuild when the wind field (or map centering)
        // changes, or when the user switches INTO barbs mode.
        if (this.barbs && this.state.windMode === 'barbs' &&
            ('level' in patch || 'month' in patch || 'windMode' in patch || 'mapCenterLon' in patch)) {
            this.barbs.rebuild(this.state.viewMode);
        }

        this.updateField();
        if (this.state.showXSection) this.updateXSection();
        if (this.state.showLorenz)   this.updateLorenz();
    }

    updateLorenz() {
        const cycle = computeLorenzCycle(this.state.month, this.state.lorenzRef);
        const setText = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
        const setConv = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (!Number.isFinite(val)) { el.textContent = '—'; el.classList.remove('neg'); return; }
            el.textContent = `${val >= 0 ? '+' : ''}${val.toFixed(2)}`;
            el.classList.toggle('neg', val < 0);
        };
        const setReservoir = (id, val) => {
            // Display in MJ/m² (J/m² ÷ 1e6).
            if (!Number.isFinite(val)) { setText(id, '—'); return; }
            const mj = val / 1e6;
            setText(id, mj >= 100 ? mj.toFixed(0) : mj.toFixed(1));
        };
        if (!cycle) {
            setText('lz-PM','…'); setText('lz-PE','…'); setText('lz-KM','…'); setText('lz-KE','…');
            return;
        }
        setReservoir('lz-PM', cycle.reservoirs.PM);
        setReservoir('lz-PE', cycle.reservoirs.PE);
        setReservoir('lz-KM', cycle.reservoirs.KM);
        setReservoir('lz-KE', cycle.reservoirs.KE);
        setConv('lz-c-PMPE', cycle.conversions.C_PM_PE);
        setConv('lz-c-PEKE', cycle.conversions.C_PE_KE);
        setConv('lz-c-KEKM', cycle.conversions.C_KE_KM);
        setConv('lz-c-PMKM', cycle.conversions.C_PM_KM);
        // Arrow widths encode |C| (capped). Flip direction when negative by
        // swapping the line endpoints' marker; simpler: rotate the visible
        // marker via the line's `transform` if needed. For now we leave
        // arrows pointing in canonical direction and let the sign in the
        // label communicate reversal.
        const widthFor = (v) => Number.isFinite(v) ? Math.max(0.8, Math.min(4.5, Math.abs(v) * 0.6)) : 1.2;
        const setArrow = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.setAttribute('stroke-width', widthFor(val).toFixed(2));
        };
        setArrow('lz-arrow-PMPE', cycle.conversions.C_PM_PE);
        setArrow('lz-arrow-PEKE', cycle.conversions.C_PE_KE);
        setArrow('lz-arrow-KEKM', cycle.conversions.C_KE_KM);
        setArrow('lz-arrow-PMKM', cycle.conversions.C_PM_KM);
    }

    updateXSection() {
        const canvas = document.getElementById('xs-canvas');
        if (!canvas) return;
        const { field, month, xsArc, cmap, showContours, xsDiag } = this.state;
        let zm;
        let effCmap = cmap;
        if (xsDiag === 'psi') {
            zm = computeMassStreamfunction(month);
            if (!zm) {
                zm = computeZonalMean(field, month);
            } else {
                effCmap = 'RdBu_r';
                zm.contourInterval = 20;             // 10⁹ kg/s
            }
        } else if (xsDiag === 'M') {
            zm = computeAngularMomentum(month);
            if (!zm) {
                zm = computeZonalMean(field, month);
            } else {
                effCmap = 'viridis';
                zm.contourInterval = 0.5;            // 10⁹ m²/s
            }
        } else if (xsDiag === 'ug') {
            zm = computeGeostrophicWind(month);
            if (!zm) {
                zm = computeZonalMean(field, month);
            } else {
                effCmap = 'RdBu_r';                  // signed: westerly + / easterly −
                zm.contourInterval = 10;             // m/s, matches u contour
            }
        } else if (xsDiag === 'N2') {
            zm = computeBruntVaisala(month);
            if (!zm) {
                zm = computeZonalMean(field, month);
            } else {
                effCmap = 'magma';
                zm.contourInterval = 1;              // 10⁻⁴ s⁻²
            }
        } else if (xsDiag === 'epflux') {
            zm = computeEPFlux(month);
            if (!zm) {
                zm = computeZonalMean(field, month);
            } else {
                effCmap = 'RdBu_r';                  // ∇·F shading: westerly + / easterly −
                zm.contourInterval = 2;              // m s⁻¹ day⁻¹
            }
        } else if (xsDiag === 'mbudget') {
            zm = buildMBudgetView(month, {
                term: this.state.mbTerm,
                form: this.state.mbForm,
                mode: this.state.mbMode,
            });
            if (!zm) {
                zm = computeZonalMean(field, month);
            } else {
                effCmap = 'RdBu_r';
                zm.suppressContours = true;
            }
        } else if (xsDiag === 'qbudget') {
            zm = buildQBudgetView(month, {
                term: this.state.mbTerm,
                form: 'q',
                mode: this.state.mbMode,
            });
            if (!zm) {
                zm = computeZonalMean(field, month);
            } else {
                effCmap = 'RdBu_r';
                zm.suppressContours = true;
            }
        } else if (xsDiag === 'hbudget') {
            zm = buildHBudgetView(month, {
                term: this.state.mbTerm,
                form: 'h',
                mode: this.state.mbMode,
            });
            if (!zm) {
                zm = computeZonalMean(field, month);
            } else {
                effCmap = 'RdBu_r';
                zm.suppressContours = true;
            }
        } else if (xsArc) {
            const arc = greatCircleArc(
                xsArc.start.lat, xsArc.start.lon,
                xsArc.end.lat,   xsArc.end.lon,
                192,
            );
            zm = computeArcCrossSection(field, month, arc);
            if (!zm) { zm = computeZonalMean(field, month); }
        } else {
            zm = computeZonalMean(field, month);
        }
        // Propagate display options into the renderer: gridlines always on,
        // contours gated by the main Contours toggle for field sections,
        // but forced on in diagnostic modes (ψ and M tell their story via
        // isolines — contour slope IS the pedagogy). Diagnostics that flag
        // suppressContours (M-budget) opt out — their data is too noisy after
        // double-derivative amplification for the fwidth-based overlay.
        zm.showContours = zm.suppressContours
            ? false
            : (zm.isDiagnostic ? true : !!showContours);
        if (zm.contourInterval == null) {
            zm.contourInterval = FIELDS[field]?.contour || 0;
        }
        renderCrossSection(canvas, zm, effCmap);
        this.updateXSectionColorbar(zm, effCmap);
        // Stash for the hover handler — it inverse-maps cursor → (lat, p, value).
        this._xsLastZm = zm;
        const title = document.getElementById('xs-title');
        const hint  = document.getElementById('xs-hint');
        const reset = document.getElementById('xs-reset');
        if (title) {
            if (zm.isDiagnostic) {
                title.textContent = `${zm.name}  (${zm.units})`;
            } else if (zm.kind === 'arc') {
                const km = Math.round(zm.distanceKm).toLocaleString();
                const suffix = zm.type === 'pl' ? '' : `  (${zm.units})`;
                title.textContent = `Arc · ${zm.name} · ${km} km${suffix}`;
            } else {
                const suffix = zm.type === 'pl' ? '' : `  (${zm.units})`;
                title.textContent = `Zonal mean · ${zm.name}${suffix}`;
            }
        }
        if (hint) {
            if (zm.isDiagnostic) {
                // Accurate footer per diagnostic.
                const desc = {
                    psi: 'ψ(φ, p) = (2π a cos φ / g) · ∫₀ᵖ [v] dp',
                    M:   'M = (Ω a cos φ + u) · a cos φ · from zonal-mean u',
                    ug:  '[u_g] = -(g/f) · ∂[z]/∂y · masked |φ| < 5° (f → 0)',
                    N2:  'N² = -(g²p / R T θ) · ∂θ/∂p · static stability',
                    epflux: 'F = (-a cos φ [u′v′], a cos φ f [v′θ′] / ∂[θ]/∂p) — stationary eddies; shading: ∇·F (m s⁻¹ day⁻¹)',
                    mbudget: '∂[M]/∂t = -∇·([v][M]) - ∇·([v*M*]) + torque · stationary eddies only · 1° monthly clim',
                }[xsDiag] || 'Zonal-mean diagnostic';
                hint.innerHTML = desc;
            } else if (zm.kind === 'arc') {
                hint.innerHTML = '<span class="xs-kbd">⇧</span> + drag to redraw';
            } else {
                hint.innerHTML = '<span class="xs-kbd">⇧</span> + drag globe to draw an arc';
            }
        }
        if (reset) reset.hidden = zm.kind !== 'arc';
        this.updateArcLine();
    }

    updateXSectionColorbar(zm, cmap) {
        const cb = document.getElementById('xs-cb-canvas');
        if (cb) {
            // Retina-crisp mini bar, same DPR logic as the main canvas.
            const DPR = Math.min(window.devicePixelRatio || 1, 2);
            const cssW = cb.clientWidth || 380;
            const cssH = cb.clientHeight || 10;
            if (cb.width !== cssW * DPR || cb.height !== cssH * DPR) {
                cb.width  = cssW * DPR;
                cb.height = cssH * DPR;
            }
            fillColorbar(cb, cmap);
        }
        const setTxt = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };
        setTxt('xs-cb-min',   fmtValue(zm.vmin));
        setTxt('xs-cb-max',   fmtValue(zm.vmax));
        setTxt('xs-cb-units', zm.units || '');
    }

    updateArcLine() {
        if (!this.arcGroup) return;
        const a = this.state.xsArc;
        if (!a) { this.arcGroup.visible = false; return; }
        const arc = greatCircleArc(a.start.lat, a.start.lon, a.end.lat, a.end.lon, 96);
        const LIFT = 1.015;
        const pts = arc.map(({ lat, lon }) => this.project(lat, lon, LIFT));
        const flat = new Float32Array(pts.length * 3);
        for (let i = 0; i < pts.length; i++) {
            flat[i * 3]     = pts[i].x;
            flat[i * 3 + 1] = pts[i].y;
            flat[i * 3 + 2] = pts[i].z;
        }
        this.arcLine.geometry.dispose();
        this.arcLine.geometry = new LineGeometry();
        this.arcLine.geometry.setPositions(flat);
        this.arcLine.computeLineDistances();
        // Endpoint dots + midpoint marker (aligns with the centre x-tick in
        // the cross-section panel, so users can read off where the centre
        // of the arc sits on the globe).
        const s = this.project(a.start.lat, a.start.lon, LIFT);
        const e = this.project(a.end.lat,   a.end.lon,   LIFT);
        const midIdx = Math.floor(arc.length / 2);
        const m = this.project(arc[midIdx].lat, arc[midIdx].lon, LIFT);
        this.arcStartDot.position.copy(s);
        this.arcEndDot.position.copy(e);
        this.arcMidDot.position.copy(m);
        // Hide the arc line when the panel is closed, in orbit view, or in
        // any diagnostic mode (all diagnostics are zonal).
        this.arcGroup.visible = this.state.showXSection
                              && this.state.viewMode !== 'orbit'
                              && this.state.xsDiag === 'field';
    }

    updateField() {
        const { field, level, theta, vCoord, month, cmap, decompose: mode, kind } = this.state;
        const f = getField(field, { month, level, coord: vCoord, theta, kind });
        this.setLoadingOverlay(!f.isReal);

        // In ±1σ mode we always show 'total' (decomposing a stddev field is
        // meaningless) and force a sequential colormap since std ≥ 0.
        const effMode = (kind === 'std') ? 'total' : mode;
        const decomp = this.applyDecomposition(f, effMode);
        // Manual colorbar overrides — applied after auto-range so user input
        // wins over symmetric/clamp/aggregate logic. Reset on field change.
        const overrideActive = (this.state.userVmin != null) || (this.state.userVmax != null);
        if (this.state.userVmin != null) decomp.vmin = this.state.userVmin;
        if (this.state.userVmax != null) decomp.vmax = this.state.userVmax;
        const effCmap = (kind === 'std')
            ? 'magma'
            : (decomp.symmetric ? 'RdBu_r' : cmap);
        // Stash what's currently painted on the globe for hover sampling.
        this._displayedValues = decomp.values;

        fillRGBA(this.imageData.data, decomp.values, {
            vmin: decomp.vmin, vmax: decomp.vmax, cmap: effCmap,
        });
        this.ctx.putImageData(this.imageData, 0, 0);
        this.texture.needsUpdate = true;
        if (this.mapTexture) this.mapTexture.needsUpdate = true;
        if (this.earthTexture) this.earthTexture.needsUpdate = true;

        // Decorated field for contour overlay + colorbar. The heatmap uses
        // the decomposed values (shading the eddy / anomaly / zonal signal),
        // but contours always track the RAW field so the overlay puts the
        // decomposition signal in the context of the total state — standard
        // "shade anomaly, contour total" synoptic practice.
        const fDecorated = {
            ...f,
            values: decomp.values,        // decomposed — used by the colorbar + panel
            rawValues: f.values,          // original tile values — used by contours
            vmin: decomp.vmin,
            vmax: decomp.vmax,
            decomposeMode: mode,
            isSymmetric: decomp.symmetric,
            effCmap,
        };
        this.updateContours(fDecorated);
        this.applyCoastlineContrast(effCmap);
        this.updateStatus(f);   // status reflects raw tile, not the transform
        this.emit('field-updated', { field: fDecorated });
    }

    setLoadingOverlay(visible) {
        let el = document.getElementById('globe-loading');
        if (!el) {
            el = document.createElement('div');
            el.id = 'globe-loading';
            el.innerHTML = '<div class="globe-loading-card"><div class="globe-loading-spinner"></div><div class="globe-loading-text">Loading ERA5 tiles…</div></div>';
            this.mount.appendChild(el);
        }
        el.classList.toggle('visible', !!visible);
    }

    applyDecomposition(f, mode) {
        if (mode === 'total' || !mode) {
            // Honour the cross-month aggregated vmin/vmax that getField
            // already computed (era5.js aggregateStats for raw fields,
            // aggregateRangeByPrefix for derived). Recomputing per-month range
            // via statsOf would shift the colorbar on every month-scrub.
            // symmetric:false here so effCmap respects the user's cmap choice;
            // the symmetric range itself is enforced upstream in getField for
            // fields with `symmetric: true` in FIELDS metadata.
            return {
                values: f.values,
                vmin: f.vmin, vmax: f.vmax,
                symmetric: false,
                empty: false,
            };
        }

        // Anomaly mode reference: either climate-change (same month from a
        // different base period) or seasonal (12-month annual mean of self).
        // For climate-change mode the per-month aggregator needs the matching
        // month's reference, so we keep both the current-month array (for the
        // inline decompose call) and a per-month fetcher (for the aggregator).
        let annualMean = null;
        let annualMeanForAgg = null;
        if (mode === 'anomaly') {
            if (this.state.vCoord === 'theta') {
                // θ-mode doesn't support anomaly — fall back to total with the
                // same aggregated range as the explicit total path above.
                return { values: f.values, vmin: f.vmin, vmax: f.vmax, symmetric: false, empty: false };
            }
            const meta = FIELDS[this.state.field] || {};
            const useLevel = meta.type === 'pl' ? this.state.level : null;
            const refPeriod = this.state.referencePeriod;
            if (refPeriod !== 'default' && !meta.derived) {
                // Climate-change anomaly: same month from reference period.
                const refField = getField(this.state.field, {
                    month: this.state.month,
                    level: this.state.level,
                    coord: this.state.vCoord,
                    theta: this.state.theta,
                    period: refPeriod,
                });
                annualMean = refField.isReal ? refField.values : null;
                // Per-month reference for the aggregator — without this every
                // pooled month would subtract January's reference, mixing the
                // 30 K seasonal cycle into the climate-change colorbar range.
                annualMeanForAgg = (m) => {
                    const rf = getField(this.state.field, {
                        month: m,
                        level: this.state.level,
                        coord: this.state.vCoord,
                        theta: this.state.theta,
                        period: refPeriod,
                    });
                    return rf.isReal ? rf.values : null;
                };
            } else {
                annualMean = meta.derived === true
                    ? null
                    : annualMeanFrom(
                        (m) => cachedMonth(this.state.field, m, useLevel),
                        GRID.nlat, GRID.nlon,
                    );
                // Self-anomaly: same 12-month mean for every iteration.
                annualMeanForAgg = annualMean;
            }
        }

        const { field, level, vCoord, theta } = this.state;
        const fieldClamp = FIELDS[field]?.clamp ?? null;
        const current = decompose(f.values, GRID.nlat, GRID.nlon, mode, annualMean, { clamp: fieldClamp });

        // Cross-month aggregation for stable colorbar — without this the range
        // shifts every time the user scrubs months because the local extrema
        // change. We pull from getField (uses cached tiles for raw fields,
        // existing _wspdCache/_mseCache/_pvCache entries for derived).
        const range = aggregatedDecompositionRange(
            mode,
            (m) => {
                const fm = getField(field, { month: m, level, coord: vCoord, theta });
                return fm.isReal ? fm : null;
            },
            GRID.nlat, GRID.nlon, annualMeanForAgg,
            { symmetric: !!FIELDS[field]?.symmetric, clamp: fieldClamp },
        );
        if (range) {
            current.vmin = range.vmin;
            current.vmax = range.vmax;
        }
        return current;
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
        // Contour source: the RAW field values always. When a decomposition
        // is on, this means the isolines show the total state overlaid on the
        // shaded eddy / anomaly, which is how textbooks do it.
        const contourValues = f.rawValues || f.values;
        this.contours.setData(contourValues);
        this.contours.setInterval(interval);
        // Zero-line emphasis follows the RAW field's cmap, not the effective
        // one — we're contouring total state, so emphasis tracks u/v-style
        // divergent cmaps specifically.
        const divergent = meta.cmap === 'RdBu_r';
        this.contours.setEmphasis(0, divergent);
        // Ink tracks EFFECTIVE cmap luminance (eddy/anomaly forces RdBu_r).
        const effCmap = f.effCmap || this.state.cmap;
        const darkBg = meanLuminance(effCmap) < 0.45;
        this.contours.setInk(darkBg ? 0xf4faf7 : 0x0a1712);
        this.contours.setOpacity(darkBg ? 0.70 : 0.85);
        this.contours.setVisible(this.state.showContours);

        if (this.contourLabels) {
            this.contourLabels.update(
                contourValues, GRID.nlat, GRID.nlon, interval,
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
        // Build a Map of group → entries to emit one <optgroup> per category,
        // preserving insertion order so the dropdown reads as a guided tour
        // (Dynamics → Moisture → Derived → Surface → fluxes → TOA).
        const groups = new Map();
        for (const [key, meta] of Object.entries(FIELDS)) {
            const g = meta.group || 'Other';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push([key, meta]);
        }
        for (const [groupName, entries] of groups) {
            const og = document.createElement('optgroup');
            og.label = groupName;
            for (const [key, meta] of entries) {
                og.appendChild(Object.assign(document.createElement('option'),
                    { value: key, textContent: meta.name }));
            }
            fieldSel.appendChild(og);
        }
        fieldSel.value = this.state.field;
        fieldSel.addEventListener('change', () => {
            const field = fieldSel.value;
            const meta = FIELDS[field];
            const patch = { field };
            if (meta.cmap) patch.cmap = meta.cmap;
            // Fields flagged thetaOnly (e.g. PV) force θ-coord. Snap
            // state.theta to the field's defaultLevel (interpreted as K)
            // when we switch into θ-coord this way.
            if (isThetaOnly(field)) {
                patch.vCoord = 'theta';
                if (meta.defaultLevel) patch.theta = meta.defaultLevel;
            } else if (meta.type === 'pl' && meta.defaultLevel && this.state.vCoord === 'pressure') {
                patch.level = meta.defaultLevel;
            }
            this.setState(patch);
            document.getElementById('cmap-select').value = this.state.cmap;
            this.refreshVCoordUI();
        });

        const vcoordGroup = document.getElementById('vcoord-toggle');
        if (vcoordGroup) {
            vcoordGroup.querySelectorAll('button').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const vCoord = btn.dataset.coord;
                    if (vCoord === this.state.vCoord) return;
                    // Block switching away from θ if the current field demands it.
                    if (vCoord === 'pressure' && isThetaOnly(this.state.field)) return;
                    this.setState({ vCoord });
                    this.refreshVCoordUI();
                });
            });
        }

        const levelSel = document.getElementById('level-select');
        this.populateLevelSelect();
        levelSel.addEventListener('change', () => {
            const v = +levelSel.value;
            if (this.state.vCoord === 'theta') this.setState({ theta: v });
            else this.setState({ level: v });
        });

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

        // Manual colorbar range — type a number into either input to override,
        // or press the ↺ Auto button to clear. Empty input = clear that side.
        const cbMinEl = document.getElementById('cb-min');
        const cbMaxEl = document.getElementById('cb-max');
        const cbAutoEl = document.getElementById('cb-auto');
        const parseCbInput = (raw) => {
            const s = String(raw ?? '').trim();
            if (s === '' || s === '—') return null;
            const n = Number(s);
            return Number.isFinite(n) ? n : null;
        };
        const commitCbRange = () => {
            let userVmin = parseCbInput(cbMinEl?.value);
            let userVmax = parseCbInput(cbMaxEl?.value);
            // If both set and reversed, swap so min < max — fillRGBA's
            // (v - vmin) / (vmax - vmin) goes negative otherwise and the
            // whole globe collapses to the cmap's first colour.
            if (userVmin != null && userVmax != null && userVmin > userVmax) {
                [userVmin, userVmax] = [userVmax, userVmin];
            }
            this.setState({ userVmin, userVmax });
        };
        cbMinEl?.addEventListener('change', commitCbRange);
        cbMaxEl?.addEventListener('change', commitCbRange);
        // Enter to commit immediately (change fires on blur otherwise).
        for (const el of [cbMinEl, cbMaxEl]) {
            el?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
            });
        }
        cbAutoEl?.addEventListener('click', () => {
            this.setState({ userVmin: null, userVmax: null });
        });

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
        // Anomaly reference period — chooses what Anomaly mode compares against.
        const refSel = document.getElementById('ref-period-select');
        if (refSel) {
            refSel.value = this.state.referencePeriod;
            refSel.addEventListener('change', () => {
                this.setState({ referencePeriod: refSel.value });
            });
        }
        // Mean | ±1σ display toggle. ±1σ disables decomposition (no anomaly
        // of stddev) and forces a sequential colormap.
        document.querySelectorAll('[data-kind]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const kind = btn.getAttribute('data-kind');
                document.querySelectorAll('[data-kind]').forEach((b) =>
                    b.classList.toggle('active', b === btn));
                const decomp = document.getElementById('decompose-group');
                if (decomp) decomp.classList.toggle('is-disabled', kind === 'std');
                this.setState({ kind });
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
        document.getElementById('toggle-lorenz')?.addEventListener('change', (e) => {
            this.setState({ showLorenz: e.target.checked });
            if (e.target.checked) this.updateLorenz();
        });
        document.getElementById('lorenz-close')?.addEventListener('click', () => {
            const cb = document.getElementById('toggle-lorenz');
            if (cb) cb.checked = false;
            this.setState({ showLorenz: false });
        });
        document.getElementById('lorenz-info-btn')?.addEventListener('click', () => {
            const info = document.getElementById('lorenz-info');
            const btn  = document.getElementById('lorenz-info-btn');
            if (!info || !btn) return;
            const open = info.hasAttribute('hidden');
            if (open) { info.removeAttribute('hidden'); btn.classList.add('active'); }
            else      { info.setAttribute('hidden', ''); btn.classList.remove('active'); }
        });
        document.querySelectorAll('input[name="lorenz-ref"]').forEach((radio) => {
            radio.addEventListener('change', (e) => {
                if (!e.target.checked) return;
                this.setState({ lorenzRef: e.target.value });
                if (this.state.showLorenz) this.updateLorenz();
            });
        });
        document.getElementById('xs-reset')?.addEventListener('click', () => {
            this.setState({ xsArc: null });
        });
        document.getElementById('parcels-clear')?.addEventListener('click', () => {
            this.parcels?.clear();
        });
        this.bindGifExport();
        const diagSel = document.getElementById('xs-diag-select');
        if (diagSel) {
            diagSel.value = this.state.xsDiag;
            diagSel.addEventListener('change', () => {
                this.setState({ xsDiag: diagSel.value });
            });
        }
        // M-budget sub-controls — present only when xsDiag === 'mbudget'.
        const mbTermSel = document.getElementById('mb-term-select');
        if (mbTermSel) {
            mbTermSel.value = this.state.mbTerm;
            mbTermSel.addEventListener('change', () => {
                const patch = { mbTerm: mbTermSel.value };
                // "All terms" overlay only makes sense in lat-only mode —
                // auto-flip the mode toggle to keep the UX coherent.
                const inLatOnly = (this.state.mbMode === '1d_mean' || this.state.mbMode === '1d_int');
                if (mbTermSel.value === 'all' && !inLatOnly) {
                    patch.mbMode = '1d_mean';
                    const radio = document.querySelector('input[name="mb-mode"][value="1d_mean"]');
                    if (radio) radio.checked = true;
                }
                this.setState(patch);
            });
        }
        document.querySelectorAll('input[name="mb-form"]').forEach((r) => {
            r.addEventListener('change', (e) => {
                if (e.target.checked) this.setState({ mbForm: e.target.value });
            });
        });
        document.querySelectorAll('input[name="mb-mode"]').forEach((r) => {
            r.addEventListener('change', (e) => {
                if (e.target.checked) this.setState({ mbMode: e.target.value });
            });
        });
        document.getElementById('mb-info-btn')?.addEventListener('click', () => {
            const info = document.getElementById('mb-info');
            const btn  = document.getElementById('mb-info-btn');
            if (!info || !btn) return;
            const open = info.hasAttribute('hidden');
            if (open) { info.removeAttribute('hidden'); btn.classList.add('active'); }
            else      { info.setAttribute('hidden', ''); btn.classList.remove('active'); }
        });
        document.getElementById('xs-close').addEventListener('click', () => {
            // Drop fullscreen state on close — otherwise the .expanded class
            // keeps `display:flex` even with [hidden] set (same CSS specificity,
            // .expanded comes later so it wins). Removing it both fixes the
            // visual close + makes the next open default to compact size.
            const panel = document.getElementById('xsection-panel');
            panel?.classList.remove('expanded');
            document.getElementById('toggle-xsection').checked = false;
            this.setState({ showXSection: false });
        });
        // Expand-to-fullscreen toggle. The DPR-aware renderCrossSection re-sizes
        // the canvas buffer to whatever CSS dimensions it ends up at, so simply
        // toggling the .expanded class and re-rendering on the next tick is
        // enough to get crisp output at the larger size.
        // Hover readout — inverse-maps cursor on xs-canvas to (lat, p, value).
        // Pointer events on the panel don't reach the globe canvas underneath
        // (the panel has solid backdrop + sits in front), so this won't fight
        // the existing globe HoverProbe.
        this.bindXSHover();
        document.getElementById('xs-expand')?.addEventListener('click', () => {
            const panel = document.getElementById('xsection-panel');
            const btn   = document.getElementById('xs-expand');
            if (!panel || !btn) return;
            const expanded = panel.classList.toggle('expanded');
            btn.textContent = expanded ? '⛶' : '⛶';
            btn.setAttribute('title', expanded ? 'Restore' : 'Expand to fullscreen');
            // Defer one frame so the new CSS dimensions settle before redraw.
            requestAnimationFrame(() => {
                if (this.state.showXSection) this.updateXSection();
            });
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

    bindGifExport() {
        const openBtn = document.getElementById('export-gif');
        const modal   = document.getElementById('gif-modal');
        const closeBtn = document.getElementById('gif-close');
        const cancelBtn = document.getElementById('gif-cancel');
        const startBtn = document.getElementById('gif-start');
        const progress = document.getElementById('gif-progress');
        const progressFill = document.getElementById('gif-progress-fill');
        const progressText = document.getElementById('gif-progress-text');
        if (!openBtn || !modal) return;

        const open  = () => { modal.classList.remove('hidden'); progress.classList.add('hidden'); startBtn.disabled = false; startBtn.textContent = 'Capture'; };
        const close = () => { modal.classList.add('hidden'); };

        openBtn.addEventListener('click', open);
        closeBtn.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        const exporter = new GifExporter({
            renderer: this.renderer,
            state: this.state,
            setState: (p) => this.setState(p),
            updateField: () => this.updateField(),
            // "Ready" = the currently-rendered field came back as a real
            // tile, not the pending placeholder.
            getIsReady: () => {
                const { field, level, theta, vCoord, month } = this.state;
                return !!getField(field, { month, level, coord: vCoord, theta }).isReal;
            },
        });

        startBtn.addEventListener('click', async () => {
            const mode = document.querySelector('input[name="gif-mode"]:checked')?.value || 'animated';
            startBtn.disabled = true;
            startBtn.textContent = 'Capturing…';
            progress.classList.remove('hidden');
            progressFill.style.width = '0%';
            progressText.textContent = 'Capturing 0 / 0';

            // Pause monthly auto-play during capture so we don't fight it.
            const wasPlaying = !!this.playTimer;
            if (wasPlaying) this.stopPlay();

            const onProgress = (i, n) => {
                progressFill.style.width = (100 * i / n).toFixed(1) + '%';
                progressText.textContent = `Capturing ${i} / ${n}`;
            };

            try {
                const blob = mode === 'annual'
                    ? await exporter.captureAnnual({ onProgress })
                    : await exporter.captureAnimated({ durationMs: 5000, fps: 15, onProgress });
                progressText.textContent = `Encoding… ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
                const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
                downloadBlob(blob, `gc-atlas-${mode}-${stamp}.gif`);
                progressText.textContent = `Done · ${(blob.size / 1024 / 1024).toFixed(1)} MB`;
                startBtn.textContent = 'Capture again';
                startBtn.disabled = false;
            } catch (err) {
                console.error('[gif] capture failed:', err);
                progressText.textContent = 'Capture failed — see console.';
                startBtn.disabled = false;
                startBtn.textContent = 'Retry';
            }

            if (wasPlaying) this.startPlay();
        });
    }

    populateLevelSelect() {
        const levelSel = document.getElementById('level-select');
        if (!levelSel) return;
        const isen = this.state.vCoord === 'theta';
        const values = isen ? THETA_LEVELS : LEVELS;
        const unit   = isen ? 'K' : 'hPa';
        const current = isen ? this.state.theta : this.state.level;
        levelSel.innerHTML = '';
        for (const v of values) {
            levelSel.appendChild(Object.assign(document.createElement('option'),
                { value: v, textContent: `${v} ${unit}` }));
        }
        // Snap to the nearest legal value if the current one isn't in the menu.
        const closest = values.reduce((best, v) =>
            Math.abs(v - current) < Math.abs(best - current) ? v : best, values[0]);
        levelSel.value = closest;
        if (isen && closest !== current) this.state.theta = closest;
        if (!isen && closest !== current) this.state.level = closest;
    }

    refreshVCoordUI() {
        const meta = FIELDS[this.state.field];
        const levelSel = document.getElementById('level-select');
        const disabled = meta.type === 'sl';
        levelSel.disabled = disabled;
        const wrap = levelSel.closest('.control-group');
        if (wrap) wrap.classList.toggle('is-disabled', disabled);

        this.populateLevelSelect();

        // Update the label on the level group + the segmented toggle buttons.
        const label = document.querySelector('label[for="level-select"], #level-label');
        if (label) label.textContent = (this.state.vCoord === 'theta') ? 'Isentropic level' : 'Pressure level';

        const tgl = document.getElementById('vcoord-toggle');
        if (tgl) {
            tgl.querySelectorAll('button').forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.coord === this.state.vCoord);
                btn.disabled = (btn.dataset.coord === 'pressure' && isThetaOnly(this.state.field));
            });
        }
    }

    // Legacy alias so existing call sites keep working.
    refreshLevelAvailability() { this.refreshVCoordUI(); }

    updateColorbar(field) {
        const cb = document.getElementById('colorbar-canvas');
        // Use the effective cmap from the decomposition so the colorbar
        // matches the painted globe (forced to RdBu_r in eddy/anomaly).
        const effCmap = field.effCmap || this.state.cmap;
        if (cb) fillColorbar(cb, effCmap);
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        // cb-min / cb-max are now <input>s — write to .value (skip when the
        // input is focused so we don't yank a mid-edit cursor) and toggle
        // the override accent style based on which side has a manual value.
        const setInput = (id, text, isOverride) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (document.activeElement !== el) el.value = text;
            el.classList.toggle('is-override', !!isOverride);
        };
        setInput('cb-min', fmtValue(field.vmin), this.state.userVmin != null);
        setInput('cb-max', fmtValue(field.vmax), this.state.userVmax != null);
        const autoBtn = document.getElementById('cb-auto');
        if (autoBtn) autoBtn.classList.toggle('is-active',
            this.state.userVmin != null || this.state.userVmax != null);
        const modeSuffix = {
            zonal:   ' · zonal mean',
            eddy:    ' · eddy',
            anomaly: ' · anomaly',
        }[field.decomposeMode] || '';
        const coordSuffix = (field.type === 'pl')
            ? (this.state.vCoord === 'theta'
                ? ` · θ = ${this.state.theta} K`
                : ` · ${this.state.level} hPa`)
            : '';
        set('cb-title', field.name + coordSuffix + modeSuffix);
        set('cb-units', field.units);
    }

    // ── render loop ──────────────────────────────────────────────────
    animate() {
        const tick = () => {
            this.controls.update();
            if (this.state.windMode === 'particles' && this.particles) this.particles.step();
            // Lagrangian parcels only step when there are active ones and
            // when the globe is the active view.
            if (this.state.viewMode === 'globe' &&
                this.parcels && this.parcels.hasActive()) {
                this.parcels.step(this.state.month);
            }
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
