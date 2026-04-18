// GC-ATLAS — interactive globe renderer (Three.js).
// Mounts on #globe-mount, reads/writes controls in #field-select etc.
// Synthetic fields for now (js/data.js); swap to a Zarr loader when ERA5 lands.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fillRGBA, fillColorbar, COLORMAPS } from './colormap.js';
import { getField, FIELDS, LEVELS, MONTHS, GRID } from './data.js';
import { ParticleField } from './particles.js';
import { StreamlineField } from './streamlines.js';
import { computeZonalMean, renderCrossSection } from './cross_section.js';
import { loadManifest, onFieldLoaded, isReady as era5Ready, prefetchField } from './era5.js';

const PLAY_INTERVAL_MS = 900;

const COASTLINE_URL = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_coastline.geojson';
const AXIAL_TILT = 23.4 * Math.PI / 180;

// Equirectangular map dimensions (width 4, height 2 → lon spans [-2, 2], lat spans [-1, 1]).
const MAP_W = 4;
const MAP_H = 2;

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
            windMode: 'particles',   // 'off' | 'particles' | 'streamlines'
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
        this.camera.position.set(0, 0.6, 3.3);

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
        const hint = document.querySelector('.globe-hint');
        if (hint) {
            const fade = () => {
                hint.classList.add('hidden');
                this.controls.removeEventListener('start', fade);
            };
            this.controls.addEventListener('start', fade);
            // Also auto-fade after 8 s if the user never touches it.
            setTimeout(fade, 8000);
        }

        window.addEventListener('resize', () => this.onResize());
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
        if (this.streamlines) this.streamlines.updateResolution(w, h);
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

        // Plane uses a clone of the same canvas, no offset (PlaneGeometry UVs map 0→1 naturally).
        this.mapTexture = new THREE.CanvasTexture(this.canvas);
        this.mapTexture.minFilter = THREE.LinearFilter;
        this.mapTexture.magFilter = THREE.LinearFilter;
        this.mapTexture.colorSpace = THREE.SRGBColorSpace;

        const sphereGeom = new THREE.SphereGeometry(1, 192, 96);
        const sphereMat  = new THREE.MeshBasicMaterial({ map: this.texture });
        this.globe = new THREE.Mesh(sphereGeom, sphereMat);
        this.globeGroup.add(this.globe);

        const planeGeom = new THREE.PlaneGeometry(MAP_W, MAP_H, GRID.nlon, GRID.nlat);
        const planeMat  = new THREE.MeshBasicMaterial({ map: this.mapTexture, side: THREE.DoubleSide });
        this.mapMesh = new THREE.Mesh(planeGeom, planeMat);
        this.mapGroup.add(this.mapMesh);

        // Subtle rim glow on the globe (sphere mode only).
        const glow = new THREE.Mesh(
            new THREE.SphereGeometry(1.04, 96, 48),
            new THREE.MeshBasicMaterial({
                color: 0x2DBDA0, transparent: true, opacity: 0.07, side: THREE.BackSide,
            }),
        );
        this.globeGroup.add(glow);
    }

    currentGroup() { return this.state.viewMode === 'globe' ? this.globeGroup : this.mapGroup; }

    // Unified projection. r=1 lives on the sphere (or plane); r>1 lifts overlays.
    project(lat, lon, r = 1) {
        if (this.state.viewMode === 'map') {
            return new THREE.Vector3(
                lon * (MAP_W / 360),
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
        for (const path of this.gratPaths) {
            const pts = path.pts.map(([lat, lon]) => this.project(lat, lon, R));
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            const mat  = path.style === 'eq' ? eq : main;
            const obj  = (wrap && (path.kind === 'parallel' || path.kind === 'equator'))
                ? new THREE.LineLoop(geom, mat)
                : new THREE.Line(geom, mat);
            this.gratGroup.add(obj);
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
        for (const ring of this.coastFeatures) {
            const pts = ring.map(([lon, lat]) => this.project(lat, lon, R));
            const geom = new THREE.BufferGeometry().setFromPoints(pts);
            this.coastGroup.add(new THREE.Line(geom, mat));
        }
        this.currentGroup().add(this.coastGroup);
        this.coastGroup.visible = this.state.showCoastlines;
    }

    // ── wind overlays (particles + streamlines) ──────────────────────
    initParticles() {
        const getUV = (lat, lon) => this.sampleWind(lat, lon);
        const proj  = (lat, lon, r) => this.project(lat, lon, r);

        this.particles = new ParticleField(getUV, proj);
        this.streamlines = new StreamlineField(getUV, proj);

        const { w, h } = this.size();
        this.streamlines.updateResolution(w, h);

        this.applyWindMode();
        this.currentGroup().add(this.particles.object);
        this.currentGroup().add(this.streamlines.object);
    }

    applyWindMode() {
        const m = this.state.windMode;
        if (this.particles)   this.particles.setVisible(m === 'particles');
        if (this.streamlines) this.streamlines.setVisible(m === 'streamlines');
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
        this.mapGroup.visible = mode === 'map';

        this.rebuildCoastlines();
        this.rebuildGraticule();

        this.particles.object.parent?.remove(this.particles.object);
        this.streamlines.object.parent?.remove(this.streamlines.object);
        this.currentGroup().add(this.particles.object);
        this.currentGroup().add(this.streamlines.object);
        this.particles.onProjectionChanged();
        this.streamlines.onProjectionChanged();

        this.configureCamera();
    }

    configureCamera() {
        if (this.state.viewMode === 'globe') {
            this.camera.position.set(0, 0.6, 3.3);
            this.controls.enableRotate = true;
            this.controls.enablePan = false;
            this.controls.minDistance = 1.4;
            this.controls.maxDistance = 8;
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
        if ('windMode' in patch) this.applyWindMode();
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

        // Streamlines are static — rebuild when the wind field changes.
        if (this.streamlines && this.state.windMode === 'streamlines' &&
            ('level' in patch || 'month' in patch || 'windMode' in patch)) {
            this.streamlines.refresh();
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
        const { field, level, month, cmap } = this.state;
        const f = getField(field, { month, level });
        fillRGBA(this.imageData.data, f.values, { vmin: f.vmin, vmax: f.vmax, cmap });
        this.ctx.putImageData(this.imageData, 0, 0);
        this.texture.needsUpdate = true;
        if (this.mapTexture) this.mapTexture.needsUpdate = true;
        this.updateStatus(f);
        this.emit('field-updated', { field: f });
    }

    updateStatus(f) {
        const el = document.getElementById('sidebar-status');
        if (!el) return;
        if (f.isReal) {
            el.innerHTML = '<strong>ERA5 · 1991–2020</strong>' +
                'Real monthly-mean climatology at 1° grid. Tiles served from <code>data/tiles/</code>.';
        } else {
            el.innerHTML = '<strong>Synthetic preview</strong>' +
                'Procedural placeholder. The ERA5 tile for this field/month/level is not yet cached (or the pipeline hasn\'t produced it). Run a local HTTP server so the browser can fetch <code>data/tiles/</code>.';
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
        // Wind overlay mode: segmented control (Off / Particles / Streamlines)
        document.querySelectorAll('[data-wind-mode]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.getAttribute('data-wind-mode');
                document.querySelectorAll('[data-wind-mode]').forEach((b) =>
                    b.classList.toggle('active', b === btn));
                this.setState({ windMode: mode });
            });
        });
        document.getElementById('toggle-xsection').addEventListener('change', (e) => {
            this.setState({ showXSection: e.target.checked });
        });
        document.getElementById('xs-close').addEventListener('click', () => {
            document.getElementById('toggle-xsection').checked = false;
            this.setState({ showXSection: false });
        });

        // View-mode toggle (Globe | Map)
        const btnGlobe = document.getElementById('view-globe');
        const btnMap   = document.getElementById('view-map');
        const setActive = (mode) => {
            btnGlobe.classList.toggle('active', mode === 'globe');
            btnMap.classList.toggle('active', mode === 'map');
        };
        btnGlobe.addEventListener('click', () => { this.setViewMode('globe'); setActive('globe'); });
        btnMap.addEventListener('click',   () => { this.setViewMode('map');   setActive('map'); });

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
        if (cb) fillColorbar(cb, this.state.cmap);
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        set('cb-min',   fmtValue(field.vmin));
        set('cb-max',   fmtValue(field.vmax));
        set('cb-title', field.name);
        set('cb-units', field.units);
    }

    // ── render loop ──────────────────────────────────────────────────
    animate() {
        const tick = () => {
            this.controls.update();
            if (this.state.windMode === 'particles' && this.particles) this.particles.step();
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
