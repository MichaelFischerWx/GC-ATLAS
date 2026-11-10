// GC-ATLAS — searchable field picker.
//
// Enhances an existing <select> (the field selector, the contour-overlay
// selector) with a button + popover: a search box, recently used fields, the
// grouped list in two columns with units and a 2-D / 3-D badge, and a footer
// line describing the highlighted field.
//
// The <select> stays the source of truth and stays in the DOM, hidden: the
// picker reads its <optgroup>/<option> children every time it opens (so the
// app's availability filtering in _refreshFieldPickers still decides what is
// listed), and a pick sets select.value and dispatches 'change', so every
// existing listener, URL-state write and _syncUIFromState path is unchanged.
// Programmatic `select.value = …` (URL restore, shortcuts, tours) updates the
// button label through an instance-level value setter.

const VALUE_DESC = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const RECENT_MAX = 5;

let openPicker = null;   // only one popover at a time

function readRecent(key) {
    if (!key) return [];
    try {
        const v = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
    } catch { return []; }
}
function writeRecent(key, list) {
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* private mode etc. */ }
}

/** Lower-case, fold compatibility forms (subscripts, superscripts) and
 *  accents, and unify dashes so "e-p" matches "E−P". */
function norm(s) {
    return String(s || '').toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[−–—]/g, '-');
}

export class FieldPicker {
    /**
     * @param {HTMLSelectElement} select
     * @param {object} opts
     *   describe(value) → { units, badge, hint, aka } | null
     *   recentKey: localStorage key for recently used values (omit = no recents)
     *   placeholder: search-box placeholder
     *   small: true → compact trigger (matches .select-sm)
     */
    constructor(select, opts = {}) {
        this.select = select;
        this.describe = opts.describe || (() => null);
        this.recentKey = opts.recentKey || null;
        this.placeholder = opts.placeholder || 'Search fields…';
        this.items = [];        // flat list of rendered rows (for keyboard nav)
        this.active = -1;

        // Trigger button, inserted where the select was.
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fp-trigger' + (opts.small || select.classList.contains('select-sm') ? ' fp-sm' : '');
        btn.id = `${select.id}-trigger`;
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.setAttribute('aria-expanded', 'false');
        if (select.title) btn.title = select.title;
        btn.innerHTML = '<span class="fp-trigger-name"></span><span class="fp-trigger-units"></span>';
        select.insertAdjacentElement('afterend', btn);
        select.classList.add('fp-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        this.trigger = btn;
        // Labels that pointed at the select now point at the button.
        document.querySelectorAll(`label[for="${select.id}"]`).forEach(l => { l.htmlFor = btn.id; });

        btn.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
        btn.addEventListener('keydown', (e) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
                e.preventDefault(); e.stopPropagation();
                this.open();
            } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
                // Start typing on the button → open with that character searched.
                e.preventDefault(); e.stopPropagation();
                this.open(e.key);
            }
        });

        // Keep the label in step with programmatic select.value writes.
        const self = this;
        Object.defineProperty(select, 'value', {
            configurable: true,
            get() { return VALUE_DESC.get.call(this); },
            set(v) { VALUE_DESC.set.call(this, v); self.syncLabel(); },
        });
        select.addEventListener('change', () => this.syncLabel());
        this.syncLabel();
    }

    get isOpen() { return !!this.pop; }

    /** Refresh the button text from the select's current option. */
    syncLabel() {
        const opt = this.select.selectedOptions?.[0];
        const name = opt ? opt.textContent : '';
        const d = opt ? this.describe(opt.value) : null;
        this.trigger.querySelector('.fp-trigger-name').textContent = name || '—';
        this.trigger.querySelector('.fp-trigger-units').textContent = d?.units || '';
        this.trigger.disabled = this.select.disabled;
    }

    /** Snapshot of the select's options: [{ group, value, label }]. */
    _options() {
        const out = [];
        for (const child of this.select.children) {
            if (child.tagName === 'OPTGROUP') {
                for (const o of child.children) out.push({ group: child.label, value: o.value, label: o.textContent });
            } else if (child.tagName === 'OPTION') {
                out.push({ group: null, value: child.value, label: child.textContent });
            }
        }
        return out;
    }

    open(initialQuery = '') {
        if (openPicker && openPicker !== this) openPicker.close();
        if (this.pop) return;
        openPicker = this;
        this.opts = this._options();

        const pop = document.createElement('div');
        pop.className = 'fp-pop';
        pop.setAttribute('role', 'dialog');
        pop.innerHTML = `
            <div class="fp-search">
                <svg class="fp-search-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                <input type="text" class="fp-input" spellcheck="false" autocomplete="off"
                       role="combobox" aria-expanded="true" aria-autocomplete="list">
                <kbd class="fp-esc">esc</kbd>
            </div>
            <div class="fp-body" role="listbox"></div>
            <div class="fp-foot"></div>`;
        document.body.appendChild(pop);
        this.pop = pop;
        this.input = pop.querySelector('.fp-input');
        this.body = pop.querySelector('.fp-body');
        this.foot = pop.querySelector('.fp-foot');
        this.input.placeholder = this.placeholder;
        this.input.value = initialQuery;
        this.trigger.setAttribute('aria-expanded', 'true');
        this.trigger.classList.add('is-open');

        this.input.addEventListener('input', () => this._render());
        this.input.addEventListener('keydown', (e) => this._onKey(e));
        this.body.addEventListener('mousemove', (e) => {
            const row = e.target.closest('.fp-item');
            if (row) this._setActive(Number(row.dataset.idx), false);
        });
        this.body.addEventListener('click', (e) => {
            const row = e.target.closest('.fp-item');
            if (row) this._pick(row.dataset.value);
        });
        this._onDocDown = (e) => {
            if (!pop.contains(e.target) && !this.trigger.contains(e.target)) this.close(false);
        };
        this._onReflow = () => this._position();
        document.addEventListener('pointerdown', this._onDocDown, true);
        window.addEventListener('resize', this._onReflow);
        this._scroller = this.trigger.closest('.sidebar');
        // Follow the trigger while the sidebar scrolls; close once it has
        // scrolled out of the sidebar's visible area.
        this._onScroll = () => {
            const r = this.trigger.getBoundingClientRect();
            const box = this._scroller.getBoundingClientRect();
            if (r.bottom < box.top || r.top > box.bottom) this.close(false);
            else this._position();
        };
        this._scroller?.addEventListener('scroll', this._onScroll, { passive: true });

        // Size first, so _render can scroll the current field into view.
        this._position();
        this._render();
        this.input.focus({ preventScroll: true });
        const len = this.input.value.length;
        this.input.setSelectionRange(len, len);
    }

    close(refocus = true) {
        if (!this.pop) return;
        document.removeEventListener('pointerdown', this._onDocDown, true);
        window.removeEventListener('resize', this._onReflow);
        this._scroller?.removeEventListener('scroll', this._onScroll);
        this.pop.remove();
        this.pop = null;
        if (openPicker === this) openPicker = null;
        this.trigger.setAttribute('aria-expanded', 'false');
        this.trigger.classList.remove('is-open');
        if (refocus) this.trigger.focus();
    }

    /** Fixed-position popover under the trigger; wide enough for two
     *  columns, clamped to the viewport (full width on phones). */
    _position() {
        if (!this.pop) return;
        const r = this.trigger.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const margin = 8;
        const width = Math.min(vw - 2 * margin, Math.max(r.width, 560));
        const left = Math.min(Math.max(margin, r.left), vw - width - margin);
        const below = vh - r.bottom - margin;
        const above = r.top - margin;
        const st = this.pop.style;
        st.left = `${left}px`;
        st.width = `${width}px`;
        // Open downward unless there is clearly more room above.
        if (below >= 320 || below >= above) {
            st.top = `${r.bottom + 6}px`;
            st.bottom = '';
            st.maxHeight = `${Math.max(220, Math.min(620, below - 6))}px`;
        } else {
            st.top = '';
            st.bottom = `${vh - r.top + 6}px`;
            st.maxHeight = `${Math.max(220, Math.min(620, above - 6))}px`;
        }
        this.pop.classList.toggle('fp-narrow', width < 480);
    }

    _matches(q) {
        const terms = norm(q).split(/\s+/).filter(Boolean);
        if (!terms.length) return null;
        const scored = [];
        for (const o of this.opts) {
            const d = this.describe(o.value) || {};
            const name = norm(o.label);
            const hay = `${name} ${norm(o.value)} ${norm(d.aka)} ${norm(o.group)} ${norm(d.units)}`;
            let score = 0, ok = true;
            for (const t of terms) {
                if (!hay.includes(t)) { ok = false; break; }
                if (name.startsWith(t)) score += 4;
                else if (new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) score += 3;
                else if (norm(o.value) === t || ` ${norm(d.aka)} `.includes(` ${t} `)) score += 2;
                else score += 1;
            }
            if (ok) scored.push({ o, score });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.map(s => s.o);
    }

    _render() {
        const q = this.input.value.trim();
        const current = this.select.value;
        const body = this.body;
        body.textContent = '';
        this.items = [];

        const addRow = (container, o, { showGroup = false } = {}) => {
            const d = this.describe(o.value) || {};
            const row = document.createElement('div');
            row.className = 'fp-item' + (o.value === current ? ' is-current' : '');
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', o.value === current ? 'true' : 'false');
            row.dataset.value = o.value;
            row.dataset.idx = String(this.items.length);
            row.id = `${this.trigger.id}-opt-${this.items.length}`;
            const name = document.createElement('span');
            name.className = 'fp-name';
            name.textContent = o.label;
            row.appendChild(name);
            if (showGroup && o.group) {
                const g = document.createElement('span');
                g.className = 'fp-group-tag';
                g.textContent = o.group;
                row.appendChild(g);
            }
            if (d.badge) {
                const b = document.createElement('span');
                b.className = 'fp-badge';
                b.textContent = d.badge;
                row.appendChild(b);
            }
            container.appendChild(row);
            this.items.push({ el: row, o });
        };

        if (q) {
            const hits = this._matches(q) || [];
            if (!hits.length) {
                const empty = document.createElement('div');
                empty.className = 'fp-empty';
                empty.textContent = `No field matches “${q}”.`;
                body.appendChild(empty);
            } else {
                const list = document.createElement('div');
                list.className = 'fp-results';
                for (const o of hits) addRow(list, o, { showGroup: true });
                body.appendChild(list);
            }
            this._setActive(this.items.length ? 0 : -1);
            return;
        }

        // Ungrouped options first (e.g. "Same as displayed"), then recents.
        const loose = this.opts.filter(o => o.group == null);
        if (loose.length) {
            const list = document.createElement('div');
            list.className = 'fp-loose';
            for (const o of loose) addRow(list, o);
            body.appendChild(list);
        }
        const byValue = new Map(this.opts.map(o => [o.value, o]));
        const recent = readRecent(this.recentKey).filter(v => byValue.has(v)).slice(0, RECENT_MAX);
        if (recent.length) {
            const sec = document.createElement('div');
            sec.className = 'fp-recent';
            sec.innerHTML = '<div class="fp-group-head">Recent</div>';
            const chips = document.createElement('div');
            chips.className = 'fp-chips';
            for (const v of recent) addRow(chips, byValue.get(v));
            sec.appendChild(chips);
            body.appendChild(sec);
        }
        const cols = document.createElement('div');
        cols.className = 'fp-cols';
        let group = null, sec = null;
        for (const o of this.opts) {
            if (o.group == null) continue;
            if (o.group !== group) {
                group = o.group;
                sec = document.createElement('div');
                sec.className = 'fp-group';
                const head = document.createElement('div');
                head.className = 'fp-group-head';
                head.textContent = group;
                sec.appendChild(head);
                cols.appendChild(sec);
            }
            addRow(sec, o);
        }
        body.appendChild(cols);
        // Start on the current selection, scrolled into view.
        const cur = this.items.findIndex(it => it.o.value === current && !it.el.closest('.fp-chips'));
        this._setActive(cur >= 0 ? cur : 0, false);
        this.items[this.active]?.el.scrollIntoView({ block: 'center' });
    }

    _setActive(i, scroll = true) {
        if (this.active >= 0 && this.items[this.active]) this.items[this.active].el.classList.remove('is-active');
        this.active = i;
        const it = this.items[i];
        if (!it) { this.foot.textContent = ''; this.input.removeAttribute('aria-activedescendant'); return; }
        it.el.classList.add('is-active');
        this.input.setAttribute('aria-activedescendant', it.el.id);
        if (scroll) it.el.scrollIntoView({ block: 'nearest' });
        const d = this.describe(it.o.value) || {};
        this.foot.textContent = '';
        const name = document.createElement('span');
        name.className = 'fp-foot-name';
        name.textContent = it.o.label;
        this.foot.appendChild(name);
        const meta = [d.units, d.levels].filter(Boolean).join(' · ');
        if (meta) {
            const m = document.createElement('span');
            m.className = 'fp-foot-meta';
            m.textContent = meta;
            this.foot.appendChild(m);
        }
        if (d.hint) {
            const h = document.createElement('div');
            h.className = 'fp-foot-hint';
            h.textContent = d.hint;
            this.foot.appendChild(h);
        }
    }

    _onKey(e) {
        const n = this.items.length;
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (n) this._setActive((this.active + 1) % n);
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (n) this._setActive((this.active - 1 + n) % n);
                break;
            case 'Enter':
                e.preventDefault();
                if (this.items[this.active]) this._pick(this.items[this.active].o.value);
                break;
            case 'Escape':
                e.preventDefault(); e.stopPropagation();
                if (this.input.value) { this.input.value = ''; this._render(); }
                else this.close();
                break;
            case 'Tab':
                this.close(false);
                break;
        }
        // Keep the app's global shortcuts (space = play, arrows = month/level)
        // out of the search box.
        e.stopPropagation();
    }

    _pick(value) {
        if (this.recentKey && value) {
            const list = readRecent(this.recentKey).filter(v => v !== value);
            list.unshift(value);
            writeRecent(this.recentKey, list.slice(0, RECENT_MAX + 3));
        }
        const changed = this.select.value !== value;
        this.close();
        if (changed) {
            this.select.value = value;
            this.select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
}
