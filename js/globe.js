// GC-ATLAS — interactive globe renderer (Three.js).
// Mounts on #globe-mount, reads/writes controls in #field-select etc.
// Synthetic fields for now (js/data.js); swap to a Zarr loader when ERA5 lands.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fillRGBA, fillColorbar, COLORMAPS } from './colormap.js';
import { getField, FIELDS, LEVELS, MONTHS, GRID } from './data.js';
import { ParticleField } from './particles.js';
import { computeZonalMean, renderCrossSection } from './cross_section.js';

const COASTLINE_URL = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_coastline.geojson';
const AXIAL_TILT = 23.4 * Math.PI / 180;

class GlobeApp {
    listeners = {};

    constructor(mount) {
        this.mount = mount;
        this.state = {
            field: 't',
            level: 500,
            month: 1,
            cmap: FIELDS.t.cmap,
            showCoastlines: true,
            showGraticule: true,
            showParticles: true,
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
    }

    // ── globe mesh + data texture ────────────────────────────────────
    initGlobe() {
        this.world = new THREE.Group();
        this.world.rotation.z = AXIAL_TILT;
        this.scene.add(this.world);

        // Data texture is backed by a canvas sized to the data grid.
        this.canvas = document.createElement('canvas');
        this.canvas.width = GRID.nlon;
        this.canvas.height = GRID.nlat;
        this.ctx = this.canvas.getContext('2d');
        this.imageData = this.ctx.createImageData(GRID.nlon, GRID.nlat);

        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.wrapS = THREE.RepeatWrapping;
        this.texture.colorSpace = THREE.SRGBColorSpace;
        // Our data column 0 = lon -180; Three.js SphereGeometry puts u=0 at -X (lon -90
        // in our convention). A 0.25 u-offset aligns Greenwich with +Z (camera default).
        this.texture.offset.x = 0.25;

        const geom = new THREE.SphereGeometry(1, 192, 96);
        const mat = new THREE.MeshBasicMaterial({ map: this.texture });
        this.globe = new THREE.Mesh(geom, mat);
        this.world.add(this.globe);

        // Subtle atmospheric rim glow.
        const glow = new THREE.Mesh(
            new THREE.SphereGeometry(1.04, 96, 48),
            new THREE.MeshBasicMaterial({
                color: 0x2DBDA0, transparent: true, opacity: 0.07, side: THREE.BackSide,
            }),
        );
        this.world.add(glow);
    }

    // ── graticule overlay ─────────────────────────────────────────────
    initGraticule() {
        this.gratGroup = new THREE.Group();
        this.world.add(this.gratGroup);

        const main = new THREE.LineBasicMaterial({ color: 0x2DBDA0, transparent: true, opacity: 0.22 });
        const eq   = new THREE.LineBasicMaterial({ color: 0xE8C26A, transparent: true, opacity: 0.55 });

        const R = 1.006;
        const seg = 180;
        for (let lat = -60; lat <= 60; lat += 30) {
            if (lat === 0) continue;
            const pts = [];
            for (let k = 0; k <= seg; k++) pts.push(this.latLonToXYZ(lat, -180 + 360 * k / seg, R));
            this.gratGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), main));
        }
        { // equator
            const pts = [];
            for (let k = 0; k <= seg; k++) pts.push(this.latLonToXYZ(0, -180 + 360 * k / seg, R));
            this.gratGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), eq));
        }
        for (let lon = -180; lon < 180; lon += 30) {
            const pts = [];
            for (let k = 0; k <= seg; k++) pts.push(this.latLonToXYZ(-90 + 180 * k / seg, lon, R));
            this.gratGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), main));
        }
        this.gratGroup.visible = this.state.showGraticule;
    }

    // ── coastlines overlay (Natural Earth, via jsdelivr) ──────────────
    async initCoastlines() {
        this.coastGroup = new THREE.Group();
        this.world.add(this.coastGroup);
        try {
            const resp = await fetch(COASTLINE_URL);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const gj = await resp.json();
            const mat = new THREE.LineBasicMaterial({
                color: 0xF3EEDC, transparent: true, opacity: 0.55,
            });
            for (const feat of gj.features) {
                const g = feat.geometry;
                if (!g) continue;
                const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
                for (const ring of lines) {
                    const pts = ring.map(([lon, lat]) => this.latLonToXYZ(lat, lon, 1.003));
                    const geom = new THREE.BufferGeometry().setFromPoints(pts);
                    this.coastGroup.add(new THREE.Line(geom, mat));
                }
            }
        } catch (err) {
            console.warn('[globe] coastlines failed to load:', err);
        }
        this.coastGroup.visible = this.state.showCoastlines;
    }

    // ── wind particle overlay ────────────────────────────────────────
    initParticles() {
        this.particles = new ParticleField((lat, lon) => this.sampleWind(lat, lon));
        this.particles.setVisible(this.state.showParticles);
        this.world.add(this.particles.object);
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

    // ── coordinate mapping ────────────────────────────────────────────
    // Convention: lon=0 at +Z (camera default), +X is lon=+90, +Y is north pole.
    latLonToXYZ(lat, lon, r = 1) {
        const phi = lat * Math.PI / 180;
        const lam = lon * Math.PI / 180;
        return new THREE.Vector3(
            r * Math.cos(phi) * Math.sin(lam),
            r * Math.sin(phi),
            r * Math.cos(phi) * Math.cos(lam),
        );
    }

    // ── state updates ─────────────────────────────────────────────────
    setState(patch) {
        Object.assign(this.state, patch);
        if ('showCoastlines' in patch && this.coastGroup) this.coastGroup.visible = !!patch.showCoastlines;
        if ('showGraticule' in patch && this.gratGroup)   this.gratGroup.visible   = !!patch.showGraticule;
        if ('showParticles' in patch && this.particles)   this.particles.setVisible(!!patch.showParticles);
        if ('showXSection' in patch) {
            const panel = document.getElementById('xsection-panel');
            if (panel) panel.hidden = !patch.showXSection;
        }
        if ('level' in patch || 'month' in patch) this.windCache.stale = true;
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
        this.emit('field-updated', { field: f });
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
        monthSel.addEventListener('change', () => this.setState({ month: +monthSel.value }));

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
        document.getElementById('toggle-particles').addEventListener('change', (e) => {
            this.setState({ showParticles: e.target.checked });
        });
        document.getElementById('toggle-xsection').addEventListener('change', (e) => {
            this.setState({ showXSection: e.target.checked });
        });
        document.getElementById('xs-close').addEventListener('click', () => {
            document.getElementById('toggle-xsection').checked = false;
            this.setState({ showXSection: false });
        });

        this.refreshLevelAvailability();
        this.on('field-updated', ({ field }) => this.updateColorbar(field));
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
            if (this.state.showParticles && this.particles) this.particles.step();
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
