// prefs.js — GNOME-Settings-Displays-style monitor arrangement editor.
//
// A scaled simulation of the desktop: monitors are rounded rectangles with
// number badges that the user drags to arrange. Dragging snaps monitors
// edge-to-edge (GNOME Settings behavior) so the resulting layout is always
// valid for Mutter — no gaps, no overlaps. The wallpaper is rendered as one
// continuous image spanning the whole desktop behind the monitors (dimmed
// outside, bright inside each monitor), so moving a monitor live-previews
// exactly which part of the image that screen will show.
//
// Apply flow (prevents the X-server crash from invalid configs):
//   1. Mutter VERIFY  — reject invalid layouts without touching the screen
//   2. Mutter TEMPORARY apply
//   3. "Keep these settings?" dialog with 20 s auto-revert countdown
//   4. Keep → PERSISTENT apply + push layout to the daemon (async DBus)

import Adw from 'gi://Adw';
import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import * as DisplayConfig from './displayConfig.js';

// Gettext is injected by the host: the GNOME extension passes GNOME's
// translator; the standalone app passes identity. Defaults to identity so
// this module is safe to load before setGettext() runs. All _('…') calls in
// this file are evaluated at runtime (inside methods), never at module load.
let _ = (s) => s;
export function setGettext(fn) { if (typeof fn === 'function') _ = fn; }

const DBUS_NAME = 'com.github.duascreenaligner.Daemon';
const DBUS_PATH = '/com/github/duascreenaligner/Daemon';
const DBUS_IFACE = 'com.github.duascreenaligner.Daemon';

// ---- daemon DBus (always async — never block the prefs UI) ----

function _callDaemonAsync(method, inSig, args, onDone = null) {
    Gio.bus_get(Gio.BusType.SYSTEM, null, (_s, res) => {
        let conn;
        try {
            conn = Gio.bus_get_finish(res);
        } catch (e) {
            if (onDone) onDone(null, e);
            return;
        }
        const params = inSig ? new GLib.Variant(`(${inSig})`, args) : null;
        conn.call(DBUS_NAME, DBUS_PATH, DBUS_IFACE, method,
            params, null, Gio.DBusCallFlags.NONE, -1, null,
            (c, r) => {
                try {
                    const reply = c.call_finish(r);
                    if (onDone) onDone(reply, null);
                } catch (e) {
                    if (onDone) onDone(null, e);
                }
            });
    });
}

// ---- physical size (mm) from xrandr, for DPI ----

function _xrandrMM(text) {
    const mm = {};
    const re = /^(\S+)\s+connected\s+(?:primary\s+)?\d+x\d+\+[-]?\d+\+[-]?\d+\s*(?:\w+\s*)?(?:\(.*?\)\s+)?(\d+)mm\s+x\s+(\d+)mm/im;
    for (const line of text.split('\n')) {
        const m = line.match(re);
        if (m) mm[m[1]] = { wm: Number(m[2]), hm: Number(m[3]) };
    }
    return mm;
}

// ---- detect current system layout ----

function _detectSystem() {
    let mmMap = {};
    try {
        const [ok, stdout] = GLib.spawn_command_line_sync('xrandr --query');
        if (ok && stdout) mmMap = _xrandrMM(new TextDecoder().decode(stdout));
    } catch (e) { /* headless / Wayland without xrandr — DPI falls back to 96 */ }

    const state = DisplayConfig.getCurrentState();
    return state.logical.map(e => {
        const conn = e.connectors[0];
        const sz = DisplayConfig.logicalSize(state.modeByConnector[conn], e.transform);
        let mm = mmMap[conn] || { wm: 0, hm: 0 };
        // xrandr reports the un-rotated panel's physical size. For rotated
        // monitors swap so width_mm matches the logical width — otherwise a
        // portrait monitor's DPI computes wildly wrong (e.g. 46 instead of
        // 82) and the daemon halves the cursor speed on it.
        const rotated = e.transform === 1 || e.transform === 3 ||
            e.transform === 5 || e.transform === 7;
        if (rotated) mm = { wm: mm.hm, hm: mm.wm };
        return {
            name: conn,
            // Stable per-panel identity (EDID vendor:product:serial) so saved
            // per-display settings follow the physical monitor across ports,
            // reboots and OS renumbering — not the socket it plugs into. Falls
            // back to the connector name when the panel exposes no EDID id.
            uid: state.specByConnector[conn] || conn,
            x: Math.round(e.x), y: Math.round(e.y),
            w: sz.width, h: sz.height,
            wm: mm.wm, hm: mm.hm,
            dpi_override: 0,
            primary: Boolean(e.primary),
        };
    });
}

// Stable key for a monitor's saved settings: EDID identity when available,
// else connector name. Central so every persistence path keys the same way.
function _monKey(m) { return (m && (m.uid || m.name)) || '?'; }

// A saved profile may be keyed by the current uid, or (older saves) by the
// connector name. Look up both so upgrades and port changes still resolve.
function _profFor(prof, m) {
    if (!prof) return null;
    return prof[_monKey(m)] || (m && prof[m.name]) || (m && m.uid && prof[m.uid]) || null;
}

// ---- layout math ----

function _bounds(monitors) {
    if (!monitors || !monitors.length) return { mx: 0, my: 0, Mx: 1920, My: 1080, w: 1920, h: 1080 };
    let mx = monitors[0].x, my = monitors[0].y;
    let Mx = mx + monitors[0].w, My = my + monitors[0].h;
    for (const m of monitors) {
        mx = Math.min(mx, m.x); my = Math.min(my, m.y);
        Mx = Math.max(Mx, m.x + m.w); My = Math.max(My, m.y + m.h);
    }
    return { mx, my, Mx, My, w: Math.max(1, Mx - mx), h: Math.max(1, My - my) };
}

function _xf(cw, ch, bds) {
    const pad = 40;
    const uw = Math.max(1, cw - pad * 2), uh = Math.max(1, ch - pad * 2);
    const s = Math.min(uw / bds.w, uh / bds.h);
    return { s, ox: (cw - bds.w * s) / 2, oy: (ch - bds.h * s) / 2, bds };
}

function _toCanvas(m, t) {
    return {
        x: t.ox + (m.x - t.bds.mx) * t.s,
        y: t.oy + (m.y - t.bds.my) * t.s,
        w: Math.max(12, m.w * t.s),
        h: Math.max(12, m.h * t.s),
    };
}

function _hitMon(cx, cy, monitors, t) {
    for (let i = monitors.length - 1; i >= 0; i--) {
        const r = _toCanvas(monitors[i], t);
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return i;
    }
    return -1;
}

function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- snapping (GNOME Settings behavior) ----

function _overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Two rects touch when they share an edge with a non-empty overlap range.
function _touches(a, b) {
    const horiz = (a.x + a.w === b.x || b.x + b.w === a.x) &&
        Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
    const vert = (a.y + a.h === b.y || b.y + b.h === a.y) &&
        Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x);
    return horiz || vert;
}

// Magnetic snapping while dragging: candidate positions attach or align the
// dragged monitor's edges to each other monitor's edges; the nearest
// candidate within `thr` (layout px) wins, per axis.
function _snapPos(mon, others, thr) {
    let sx = null, sy = null, bx = thr, by = thr;
    for (const o of others) {
        const candX = [
            o.x - mon.w,                          // my right edge on o's left
            o.x + o.w,                            // my left edge on o's right
            o.x,                                  // left edges aligned
            o.x + o.w - mon.w,                    // right edges aligned
            o.x + Math.round((o.w - mon.w) / 2),  // centers aligned
        ];
        const candY = [
            o.y - mon.h,
            o.y + o.h,
            o.y,
            o.y + o.h - mon.h,
            o.y + Math.round((o.h - mon.h) / 2),
        ];
        for (const c of candX) { const d = Math.abs(c - mon.x); if (d < bx) { bx = d; sx = c; } }
        for (const c of candY) { const d = Math.abs(c - mon.y); if (d < by) { by = d; sy = c; } }
    }
    return { x: sx !== null ? sx : mon.x, y: sy !== null ? sy : mon.y };
}

// After a drag ends, force the dragged monitor into a valid position:
// no overlap with any other monitor, and touching at least one of them.
// This is what guarantees Mutter never sees a crashing configuration.
function _resolvePlacement(mon, others) {
    if (!others.length) return;

    // 1. Push out of any overlap along the axis of least penetration.
    for (let iter = 0; iter < 16; iter++) {
        const o = others.find(v => _overlaps(mon, v));
        if (!o) break;
        const pushL = (mon.x + mon.w) - o.x;
        const pushR = (o.x + o.w) - mon.x;
        const pushU = (mon.y + mon.h) - o.y;
        const pushD = (o.y + o.h) - mon.y;
        const min = Math.min(pushL, pushR, pushU, pushD);
        if (min === pushL) mon.x -= pushL;
        else if (min === pushR) mon.x += pushR;
        else if (min === pushU) mon.y -= pushU;
        else mon.y += pushD;
    }

    // 2. If detached from every monitor, translate to the nearest position
    //    that attaches an edge (clamped so the shared range is >= 1 px).
    if (!others.some(o => _touches(mon, o))) {
        let best = null, bd = Infinity;
        for (const o of others) {
            const cy = _clamp(mon.y, o.y - mon.h + 1, o.y + o.h - 1);
            const cx = _clamp(mon.x, o.x - mon.w + 1, o.x + o.w - 1);
            const cands = [
                { x: o.x - mon.w, y: cy },  // attach left
                { x: o.x + o.w, y: cy },    // attach right
                { x: cx, y: o.y - mon.h },  // attach top
                { x: cx, y: o.y + o.h },    // attach bottom
            ];
            for (const c of cands) {
                if (others.some(v => _overlaps({ ...mon, x: c.x, y: c.y }, v))) continue;
                const d = (c.x - mon.x) ** 2 + (c.y - mon.y) ** 2;
                if (d < bd) { bd = d; best = c; }
            }
        }
        if (best) { mon.x = best.x; mon.y = best.y; }
    }
}

// Normalize the arrangement so the top-left of the bounding box is (0,0).
function _norm(monitors) {
    if (!monitors.length) return;
    let mx = monitors[0].x, my = monitors[0].y;
    for (const m of monitors) { mx = Math.min(mx, m.x); my = Math.min(my, m.y); }
    for (const m of monitors) { m.x -= mx; m.y -= my; }
}

// ---- physical-space wallpaper mapping ----
//
// GNOME's "spanned" wallpaper maps the image by logical PIXELS, so with
// mixed-DPI monitors the picture is physically discontinuous at the seam
// (a straight line in the image bends at the bezel). We fix it by mapping
// the image in PHYSICAL space (millimeters): each monitor samples the
// region of the image that its physical panel area covers, at its own
// pixel density. The seam alignment the user confirmed with the wizard
// anchors the two panels' physical positions.

function _mmPerPx(m) {
    return {
        x: (m.wm > 0 ? m.wm : m.w * 25.4 / 96) / m.w,
        y: (m.hm > 0 ? m.hm : m.h * 25.4 / 96) / m.h,
    };
}

// Physical rectangles (mm) for each monitor. For the two-monitor case the
// shared seam is anchored at the middle of the overlap range — consistent
// with what the align wizard lets the user calibrate.
function _physLayout(monitors) {
    if (monitors.length === 2) {
        let [a, b] = [...monitors].sort((p, q) => p.x - q.x || p.y - q.y);
        const ka = _mmPerPx(a), kb = _mmPerPx(b);
        if (a.x + a.w === b.x) {
            // side-by-side: contact in x, seam-anchored y
            const mid = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2;
            const yB = (mid - a.y) * ka.y - (mid - b.y) * kb.y;
            return [
                { m: a, x: 0, y: 0, w: a.w * ka.x, h: a.h * ka.y },
                { m: b, x: a.w * ka.x, y: yB, w: b.w * kb.x, h: b.h * kb.y },
            ];
        }
        [a, b] = [...monitors].sort((p, q) => p.y - q.y || p.x - q.x);
        const ka2 = _mmPerPx(a), kb2 = _mmPerPx(b);
        if (a.y + a.h === b.y) {
            // stacked: contact in y, seam-anchored x
            const mid = (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2;
            const xB = (mid - a.x) * ka2.x - (mid - b.x) * kb2.x;
            return [
                { m: a, x: 0, y: 0, w: a.w * ka2.x, h: a.h * ka2.y },
                { m: b, x: xB, y: a.h * ka2.y, w: b.w * kb2.x, h: b.h * kb2.y },
            ];
        }
    }
    // Fallback: uniform scale from the first monitor, own physical sizes.
    const k = _mmPerPx(monitors[0]);
    return monitors.map(m => {
        const km = _mmPerPx(m);
        return { m, x: m.x * k.x, y: m.y * k.y, w: m.w * km.x, h: m.h * km.y };
    });
}

// Per-monitor source rectangles (image px) for an image cover-fitted onto
// the physical bounding box. Shared by the live preview and the stitched
// wallpaper composer so what you see is exactly what you get.
function _physSrcRects(monitors, iw, ih) {
    const phys = _physLayout(monitors);
    let bx = phys[0].x, by = phys[0].y, bX = phys[0].x + phys[0].w, bY = phys[0].y + phys[0].h;
    for (const p of phys) {
        bx = Math.min(bx, p.x); by = Math.min(by, p.y);
        bX = Math.max(bX, p.x + p.w); bY = Math.max(bY, p.y + p.h);
    }
    const bw = Math.max(1, bX - bx), bh = Math.max(1, bY - by);
    // image px per mm such that the physical bbox lies inside the image
    const s = Math.min(iw / bw, ih / bh);
    const ox = (iw - bw * s) / 2, oy = (ih - bh * s) / 2;
    return phys.map(p => {
        // Absolute per-display framing (normalized image fractions) wins:
        // the display shows exactly that region of the picture. Affects
        // ONLY the image — monitor layout and mouse transitions untouched.
        const wp = p.m.wp || {};
        if (wp.abs && wp.abs.w > 0 && wp.abs.h > 0) {
            return {
                m: p.m,
                srcX: wp.abs.x * iw, srcY: wp.abs.y * ih,
                srcW: wp.abs.w * iw, srcH: wp.abs.h * ih,
            };
        }
        // Default: physically continuous span.
        return {
            m: p.m,
            srcX: ox + (p.x - bx) * s,
            srcY: oy + (p.y - by) * s,
            srcW: p.w * s,
            srcH: p.h * s,
        };
    });
}

// ---- physical alignment (Little-Big-Mouse-style, mm-based) ----

// The side-by-side pair, or null. a = left monitor, b = right monitor.
function _seamPair(monitors) {
    if (monitors.length !== 2) return null;
    const [a, b] = [...monitors].sort((p, q) => p.x - q.x);
    if (a.x + a.w === b.x) return { a, b };
    return null;
}

// Millimeters the right panel's top edge sits below the left panel's top
// edge, derived from the current pixel layout (seam-mid anchored — the
// same anchor _physLayout uses, so preview/wallpaper/cursor all agree).
function _pxToMmOffset(a, b) {
    const ka = _mmPerPx(a), kb = _mmPerPx(b);
    const mid = (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2;
    return (mid - a.y) * ka.y - (mid - b.y) * kb.y;
}

// Inverse: pixel y for the right monitor so its top edge sits mmOff
// millimeters below the left monitor's top edge. The seam-mid anchor
// depends on the answer, so iterate a few fixed-point rounds (converges
// in 2-3 iterations for any sane geometry).
function _mmOffsetToPx(a, b, mmOff) {
    const ka = _mmPerPx(a), kb = _mmPerPx(b);
    let by = b.y;
    for (let i = 0; i < 10; i++) {
        const mid = (Math.max(a.y, by) + Math.min(a.y + a.h, by + b.h)) / 2;
        const next = mid - ((mid - a.y) * ka.y - mmOff) / kb.y;
        if (Math.abs(next - by) < 0.5) { by = next; break; }
        by = next;
    }
    return Math.round(by);
}

// ---- DPI ----

function _dpi(m) {
    if (m.dpi_override && m.dpi_override > 0) return Math.round(m.dpi_override);
    if (!m.wm || m.wm <= 0) return 96;
    return Math.round(m.w / (m.wm / 25.4));
}

// ======================================================================

// The full editor UI, decoupled from GNOME Shell. Host injects a GSettings
// (extension: getSettings(); app: loaded from the local schema) and a window.
// Works with any Adw.PreferencesWindow — the extension's or the app's.
export class DuaEditor {

    constructor(settings) {
        this._settings = settings;
    }

    fill(window) {
        this._s = this._settings;
        this._win = window;
        this._monitors = [];
        this._wpPath = '';
        this._wpPix = null;
        this._wpHistory = [];
        this._sel = -1;
        this._drag = -1;
        this._ds = null;
        this._monitorRows = [];
        this._primaryGuard = false;

        this._load();
        this._reconcileWithHardware();

        // Auto-refresh the stitched wallpaper on open so it always matches
        // the current arrangement.
        if (this._wpPix) this._applyWallpaper();

        window.set_default_size(980, 740);
        window.set_search_enabled(false);
        window.add(this._build());

        // Re-detect when the monitor configuration changes underneath us —
        // e.g. the user hit "Revert" in the system confirmation dialog.
        try {
            this._sessionBus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
            this._monChangedId = this._sessionBus.signal_subscribe(
                null, 'org.gnome.Mutter.DisplayConfig', 'MonitorsChanged',
                '/org/gnome/Mutter/DisplayConfig', null,
                Gio.DBusSignalFlags.NONE, () => {
                    if (this._drag < 0 && !this._applying) {
                        this._detect(false);
                        // Alignment just changed (wizard, revert, GNOME
                        // Settings…) — restitch the wallpaper to match.
                        if (this._wpPix) this._applyWallpaper();
                        // External sync, not a user edit — don't prompt
                        // "apply changes?" on close because of it.
                        this._dirty = false;
                    }
                });
        } catch (e) { /* non-fatal */ }

        this._dirty = false;
        this._forceClose = false;
        window.connect('close-request', () => {
            if (!this._dirty || this._forceClose) {
                if (this._sessionBus && this._monChangedId) {
                    this._sessionBus.signal_unsubscribe(this._monChangedId);
                    this._monChangedId = 0;
                }
                return false;
            }
            // Unsaved changes: ask instead of losing or half-applying them.
            const dlg = new Adw.MessageDialog({
                transient_for: window,
                modal: true,
                heading: _('Apply your changes?'),
                body: _('You changed the arrangement or wallpaper. Apply them before closing?'),
            });
            dlg.add_response('discard', _('Discard'));
            dlg.add_response('apply', _('Apply & Close'));
            dlg.set_response_appearance('apply', Adw.ResponseAppearance.SUGGESTED);
            dlg.set_response_appearance('discard', Adw.ResponseAppearance.DESTRUCTIVE);
            dlg.set_default_response('apply');
            dlg.set_close_response('discard');
            dlg.connect('response', (_d, resp) => {
                if (resp === 'apply') this._apply();
                this._forceClose = true;
                window.close();
            });
            dlg.present();
            return true; // hold the window while the user decides
        });
    }

    // ---- persistence ----

    _load() {
        try {
            const raw = this._s.get_string('monitor-layout');
            if (!raw || !raw.trim()) return;
            const p = JSON.parse(raw);
            if (p.monitors && Array.isArray(p.monitors)) {
                this._monitors = p.monitors.map(m => ({
                    name: m.name || '?',
                    uid: m.uid || m.name || '?',
                    x: m.x || 0, y: m.y || 0,
                    w: m.width_px || m.w || 1920,
                    h: m.height_px || m.h || 1080,
                    wm: m.width_mm || m.wm || 0,
                    hm: m.height_mm || m.hm || 0,
                    dpi_override: m.dpi_override || 0,
                    primary: Boolean(m.primary),
                    wp: (m.wp && typeof m.wp === 'object')
                        ? {
                            x: m.wp.x || 0, y: m.wp.y || 0, z: m.wp.z || 1,
                            ...(m.wp.abs && m.wp.abs.w > 0 ? { abs: {
                                x: m.wp.abs.x || 0, y: m.wp.abs.y || 0,
                                w: m.wp.abs.w, h: m.wp.abs.h,
                            } } : {}),
                        }
                        : { x: 0, y: 0, z: 1 },
                }));
                this._wpPath = p.wallpaper_image || '';
                this._wpHistory = Array.isArray(p.wallpaper_history) ? p.wallpaper_history : [];
                this._wpProfiles = (p.wallpaper_profiles && typeof p.wallpaper_profiles === 'object')
                    ? p.wallpaper_profiles : {};
                this._alignMM = (typeof p.alignment_mm === 'number') ? p.alignment_mm : null;
                if (this._wpPath) this._wpPix = this._loadImg(this._wpPath);
            }
        } catch (e) {
            logError(e, '[DuaScreen] load layout');
        }
    }

    // Remember the current per-display framing under the current image, so
    // every image keeps its own arrangement and switching restores it.
    _saveFramingToProfile() {
        if (!this._wpPath) return;
        this._wpProfiles = this._wpProfiles || {};
        const prof = {};
        for (const m of this._monitors) {
            if (m.wp && m.wp.abs && m.wp.abs.w > 0)
                prof[_monKey(m)] = { ...m.wp.abs };
        }
        if (Object.keys(prof).length) this._wpProfiles[this._wpPath] = prof;
        else delete this._wpProfiles[this._wpPath];
    }

    _save() {
        this._saveFramingToProfile();
        const payload = {
            monitors: this._monitors.map(m => ({
                name: m.name, uid: m.uid || m.name, x: m.x, y: m.y,
                width_px: m.w, height_px: m.h,
                width_mm: m.wm, height_mm: m.hm,
                dpi_override: m.dpi_override || 0,
                primary: m.primary,
                wp: m.wp || { x: 0, y: 0, z: 1 },
            })),
            device_path: '',
            wallpaper_image: this._wpPath,
            wallpaper_history: this._wpHistory || [],
            wallpaper_profiles: this._wpProfiles || {},
            ...(typeof this._alignMM === 'number' ? { alignment_mm: this._alignMM } : {}),
        };
        this._dirty = true;
        this._s.set_string('monitor-layout', JSON.stringify(payload, null, 2));
    }

    _loadImg(path) {
        if (!path) return null;
        try { return GdkPixbuf.Pixbuf.new_from_file(path); } catch (e) { return null; }
    }

    // Adopt the live hardware when it differs from the saved state, matching
    // each panel by stable EDID identity. This is what makes saved settings
    // portable: on another machine, a new GPU, or swapped ports, the app shows
    // the real monitors and reattaches each panel's remembered framing —
    // instead of trusting connector names baked in on a different box.
    _reconcileWithHardware() {
        let live = [];
        try { live = _detectSystem(); } catch (e) { /* headless — keep saved */ }
        if (!live.length) {
            if (!this._monitors.length) this._detect(false);
            return;
        }
        const key = arr => (arr || []).map(_monKey).sort().join('|');
        if (!this._monitors.length || key(live) !== key(this._monitors)) {
            // _detect() re-reads live hardware and reattaches framing by uid
            // (from the previous monitors and the saved image profile).
            this._detect(false);
        }
    }

    _detect(showMsg = true) {
        try {
            const old = this._monitors || [];
            this._monitors = _detectSystem();
            // Preserve per-monitor picture adjustments across re-detects,
            // matched by stable panel identity so a monitor that moved to a
            // different port keeps its framing. Fall back to connector name
            // (older saved state) and restore from the saved image profile.
            const prof = (this._wpProfiles || {})[this._wpPath];
            for (const m of this._monitors) {
                const prev = old.find(o => _monKey(o) === _monKey(m)) ||
                    old.find(o => o.name === m.name);
                if (prev && prev.wp) {
                    m.wp = prev.wp;
                } else {
                    const a = _profFor(prof, m);
                    m.wp = (a && a.w > 0) ? { x: 0, y: 0, z: 1, abs: { ...a } } : { x: 0, y: 0, z: 1 };
                }
            }
            _norm(this._monitors);
            this._sel = this._monitors.length ? 0 : -1;
            this._save();
            this._refreshAll();
            if (showMsg) this._msg(_('Detected current monitor layout.'));
        } catch (e) {
            if (showMsg) this._msg(_('Detection failed: ') + e.message);
        }
    }

    // ---- UI ----

    _build() {
        const page = new Adw.PreferencesPage({
            title: _('Displays'),
            icon_name: 'video-display-symbolic',
        });

        // -- arrangement group: canvas + toolbar --
        const arrGroup = new Adw.PreferencesGroup({
            title: _('Arrangement'),
            description: _('Drag displays to match your physical setup. Displays snap together edge-to-edge.'),
        });

        const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        card.add_css_class('card');

        this._canvas = new Gtk.DrawingArea({
            hexpand: true, vexpand: true,
            content_width: 860, content_height: 360,
            focusable: true,
        });
        this._canvas.set_draw_func((_a, cr, w, h) => this._render(cr, w, h));
        this._setupGestures();
        card.append(this._canvas);
        arrGroup.add(card);

        // toolbar under the canvas
        const tb = new Gtk.Box({
            spacing: 6,
            margin_top: 10,
            halign: Gtk.Align.CENTER,
        });
        tb.append(this._btn(_('Detect Displays'), 'find-location-symbolic', () => this._detect(),
            _('Re-read your monitors, sizes and DPI from the system.')));
        tb.append(this._btn(_('Align'), 'video-joined-displays-symbolic', () => this._smartAlign(),
            _('Snap the seam to your remembered physical gap, or open the align wizard to set one.')));
        tb.append(this._btn(_('Wallpaper…'), 'image-x-generic-symbolic', () => this._chooseWP(),
            _('Choose an image to span across all displays.')));

        const applyBtn = this._btn(_('Apply'), 'emblem-ok-symbolic', () => this._apply(),
            _('Save this arrangement and restitch the wallpaper to match.'));
        applyBtn.add_css_class('suggested-action');
        tb.append(applyBtn);
        arrGroup.add(tb);

        // Contextual picture controls — appear for the display the user
        // clicked. Move / zoom / fit / span that display's picture.
        this._picBar = new Gtk.Box({ spacing: 6, margin_top: 6, halign: Gtk.Align.CENTER });
        this._picLbl = new Gtk.Label({ label: '' });
        this._picLbl.add_css_class('dim-label');
        this._picBar.append(this._picLbl);
        this._picBtns = [];
        const addPicBtn = (label, icon, cb, tooltip) => {
            const b = this._btn(label, icon, cb, tooltip);
            this._picBar.append(b);
            this._picBtns.push(b);
            return b;
        };
        addPicBtn('◀', null, () => this._nudgePic(-0.06, 0), _('Move this display’s picture left  (Alt+←)'));
        addPicBtn('▶', null, () => this._nudgePic(0.06, 0), _('Move this display’s picture right  (Alt+→)'));
        addPicBtn('▲', null, () => this._nudgePic(0, -0.06), _('Move this display’s picture up  (Alt+↑)'));
        addPicBtn('▼', null, () => this._nudgePic(0, 0.06), _('Move this display’s picture down  (Alt+↓)'));
        addPicBtn('−', null, () => this._zoomPic(1.12), _('Zoom out — show more of the image  (Alt+−, or Ctrl+scroll)'));
        addPicBtn('+', null, () => this._zoomPic(1 / 1.12), _('Zoom in — crop tighter  (Alt++, or Ctrl+scroll)'));
        addPicBtn(_('Fit'), 'zoom-fit-best-symbolic', () => this._picPreset('fit'),
            _('Frame as much of the image as this display’s shape allows.'));
        addPicBtn(_('Span'), 'view-fullscreen-symbolic', () => this._picPreset('span'),
            _('Reset: let this display show its continuous slice of the spanned image.'));
        arrGroup.add(this._picBar);

        this._info = new Gtk.Label({ label: '', xalign: 0.5, margin_top: 6 });
        this._info.add_css_class('dim-label');
        arrGroup.add(this._info);

        page.add(arrGroup);

        // -- wallpaper gallery: current / last / suggestions --
        const wpGroup = new Adw.PreferencesGroup({
            title: _('Wallpaper'),
            description: _('Click an image to span it across your displays. It restitches automatically whenever the alignment changes.'),
        });
        const sc = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            height_request: 132,
        });
        this._galleryBox = new Gtk.Box({
            spacing: 8,
            margin_start: 4, margin_end: 4, margin_top: 4, margin_bottom: 4,
        });
        sc.set_child(this._galleryBox);
        wpGroup.add(sc);
        page.add(wpGroup);

        // -- physical alignment group (mm-based, no eyeballing) --
        const physGroup = new Adw.PreferencesGroup({
            title: _('Physical Alignment'),
            description: _('Uses the panels’ real sizes from EDID. Pick how the monitors sit on your desk, or measure the offset with a ruler and type it in.'),
        });

        const presetRow = new Adw.ActionRow({
            title: _('Panel tops on the desk'),
            subtitle: _('One click — offset computed from physical panel sizes'),
        });
        const presetBox = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
        presetBox.append(this._btn(_('Tops level'), 'go-top-symbolic', () => this._physPreset('tops')));
        presetBox.append(this._btn(_('Centers level'), 'view-restore-symbolic', () => this._physPreset('centers')));
        presetBox.append(this._btn(_('Bottoms level'), 'go-bottom-symbolic', () => this._physPreset('bottoms')));
        presetRow.add_suffix(presetBox);
        physGroup.add(presetRow);

        this._mmRow = new Adw.SpinRow({
            title: _('Right panel top below left panel top'),
            subtitle: _('Millimeters — measure on the desk for an exact match'),
            adjustment: new Gtk.Adjustment({
                lower: -1000, upper: 1000, step_increment: 1, page_increment: 10,
            }),
            digits: 0,
        });
        this._mmGuard = false;
        this._mmRow.connect('notify::value', () => {
            if (this._mmGuard) return;
            const pair = _seamPair(this._monitors);
            if (!pair) return;
            this._alignMM = Math.round(this._mmRow.value);
            pair.b.y = _mmOffsetToPx(pair.a, pair.b, this._mmRow.value);
            _norm(this._monitors);
            this._save();
            this._updateInfo();
            this._syncCanvas();
        });
        physGroup.add(this._mmRow);

        page.add(physGroup);

        // -- settings group: primary + correction --
        const setGroup = new Adw.PreferencesGroup();

        this._primaryRow = new Adw.ComboRow({
            title: _('Primary Display'),
            subtitle: _('Contains the top bar and Activities'),
        });
        this._primaryRow.connect('notify::selected', () => {
            if (this._primaryGuard) return;
            const idx = this._primaryRow.selected;
            if (idx >= 0 && idx < this._monitors.length) {
                for (let i = 0; i < this._monitors.length; i++)
                    this._monitors[i].primary = (i === idx);
                this._save();
                this._syncCanvas();
            }
        });
        setGroup.add(this._primaryRow);

        const corrRow = new Adw.SwitchRow({
            title: _('Cursor Correction'),
            subtitle: _('DPI-aware cursor speed across displays'),
        });
        this._s.bind('enabled', corrRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        setGroup.add(corrRow);

        page.add(setGroup);

        // -- monitor list group --
        this._monGroup = new Adw.PreferencesGroup({ title: _('Displays') });
        page.add(this._monGroup);

        // status line
        const statusGroup = new Adw.PreferencesGroup();
        this._status = new Gtk.Label({ label: '', xalign: 0 });
        this._status.add_css_class('dim-label');
        statusGroup.add(this._status);
        page.add(statusGroup);

        this._refreshAll();
        return page;
    }

    _btn(label, icon, cb, tooltip) {
        const b = new Gtk.Button();
        const bx = new Gtk.Box({ spacing: 4 });
        if (icon) bx.append(new Gtk.Image({ icon_name: icon }));
        bx.append(new Gtk.Label({ label }));
        b.set_child(bx);
        if (tooltip) b.set_tooltip_text(tooltip);
        b.connect('clicked', () => { try { cb(); } catch (e) { this._msg(e.message); } });
        return b;
    }

    _refreshAll() {
        this._rebuildPrimaryRow();
        this._rebuildMonitorRows();
        this._updateInfo();
        this._updateWpButtons();
        this._syncMmRow();
        this._rebuildGallery();
        this._syncCanvas();
    }

    _syncMmRow() {
        if (!this._mmRow) return;
        const pair = _seamPair(this._monitors);
        this._mmRow.sensitive = Boolean(pair);
        if (pair) {
            this._mmGuard = true;
            this._mmRow.value = Math.round(_pxToMmOffset(pair.a, pair.b));
            this._mmGuard = false;
        }
    }

    _physPreset(mode) {
        const pair = _seamPair(this._monitors);
        if (!pair) {
            this._msg(_('Physical presets need two side-by-side displays.'));
            return;
        }
        const { a, b } = pair;
        const hA = a.h * _mmPerPx(a).y;
        const hB = b.h * _mmPerPx(b).y;
        let mmOff = 0;
        if (mode === 'centers') mmOff = (hA - hB) / 2;
        else if (mode === 'bottoms') mmOff = hA - hB;
        this._alignMM = Math.round(mmOff);
        b.y = _mmOffsetToPx(a, b, mmOff);
        _norm(this._monitors);
        this._save();
        this._refreshAll();
        this._msg(_('Physical alignment: ') + mode +
            ` (${Math.round(mmOff)}mm) — ` + _('press Apply to make it real.'));
    }

    _updateWpButtons() {
        // Contextual picture bar follows the selection.
        if (!this._picBar) return;
        const hasSel = this._sel >= 0 && this._sel < this._monitors.length;
        const usable = hasSel && Boolean(this._wpPix);
        for (const b of this._picBtns) b.sensitive = usable;
        this._picLbl.label = hasSel
            ? _('Picture on ') + this._monitors[this._sel].name + '  (Alt+arrows move, Alt+± zoom):'
            : _('Click a display to adjust its picture');
    }

    _rebuildPrimaryRow() {
        if (!this._primaryRow) return;
        this._primaryGuard = true;
        const names = this._monitors.map((m, i) => `${i + 1}  ${m.name}`);
        this._primaryRow.model = Gtk.StringList.new(names);
        const p = this._monitors.findIndex(m => m.primary);
        this._primaryRow.selected = p >= 0 ? p : 0;
        this._primaryGuard = false;
    }

    _rebuildMonitorRows() {
        if (!this._monGroup) return;
        for (const r of this._monitorRows) this._monGroup.remove(r);
        this._monitorRows = [];
        for (let i = 0; i < this._monitors.length; i++) {
            const m = this._monitors[i];
            const row = new Adw.ActionRow({
                title: m.name,
                subtitle: `${m.w} × ${m.h}   ${_dpi(m)} dpi` + (m.primary ? '   ' + _('Primary') : ''),
                activatable: true,
            });
            const badge = new Gtk.Label({ label: `${i + 1}` });
            badge.add_css_class('title-3');
            badge.set_size_request(28, -1);
            row.add_prefix(badge);
            const idx = i;
            row.connect('activated', () => {
                this._sel = idx;
                this._updateInfo();
                this._syncCanvas();
            });
            this._monGroup.add(row);
            this._monitorRows.push(row);
        }
    }

    _updateInfo() {
        this._updateWpButtons();
        if (!this._info) return;
        if (this._sel < 0 || this._sel >= this._monitors.length) {
            this._info.label = _('Click a display to select it. Right-drag or Alt+arrows move its picture; Ctrl+scroll or Alt+± zoom it.');
            return;
        }
        const m = this._monitors[this._sel];
        const a = m.wp && m.wp.abs;
        const wpTxt = (a && a.w > 0)
            ? `   pic: ${Math.round(a.x * 100)}%,${Math.round(a.y * 100)}% ${Math.round(a.w * 100)}×${Math.round(a.h * 100)}%`
            : '';
        this._info.label = `${m.name}   ${_('position')}: ${m.x}, ${m.y}   ${m.w} × ${m.h}   ${_dpi(m)} dpi` + wpTxt;
    }

    // ---- gestures ----

    _setupGestures() {
        const drag = new Gtk.GestureDrag();
        drag.connect('drag-begin', (_g, x, y) => {
            if (!this._monitors.length) return;
            const t = _xf(this._canvas.get_width(), this._canvas.get_height(), _bounds(this._monitors));
            this._drag = _hitMon(x, y, this._monitors, t);
            if (this._drag >= 0) {
                this._ds = { x: this._monitors[this._drag].x, y: this._monitors[this._drag].y };
                // Freeze the canvas transform for the whole drag: recomputing
                // it per-event from bounds that include the moving monitor
                // makes the scale shift under the cursor — rubber-band jitter.
                this._dragT = t;
                this._sel = this._drag;
                this._canvas.grab_focus();
                this._updateInfo();
                this._syncCanvas();
            }
        });
        drag.connect('drag-update', (_g, dx, dy) => {
            if (this._drag < 0 || !this._ds || !this._dragT) return;
            const t = this._dragT;
            const mon = this._monitors[this._drag];
            mon.x = this._ds.x + Math.round(dx / t.s);
            mon.y = this._ds.y + Math.round(dy / t.s);

            // Magnetic snap against the other monitors. Gentle (8 canvas px)
            // so fine positioning along the seam stays possible; hold Ctrl
            // to disable snapping entirely.
            const ctrl = (drag.get_current_event_state() & Gdk.ModifierType.CONTROL_MASK) !== 0;
            if (!ctrl) {
                const others = this._monitors.filter((_m, i) => i !== this._drag);
                const thr = Math.max(2, Math.round(8 / t.s));
                const snapped = _snapPos(mon, others, thr);
                mon.x = snapped.x;
                mon.y = snapped.y;
            }

            this._updateInfo();
            this._syncCanvas();
        });
        drag.connect('drag-end', () => {
            if (this._drag < 0) return;
            const mon = this._monitors[this._drag];
            const others = this._monitors.filter((_m, i) => i !== this._drag);
            _resolvePlacement(mon, others);
            _norm(this._monitors);
            this._drag = -1;
            this._ds = null;
            this._save();
            this._updateInfo();
            this._syncMmRow();
            this._syncCanvas();
        });
        this._canvas.add_controller(drag);

        const click = new Gtk.GestureClick();
        click.connect('pressed', (_g, _n, x, y) => {
            if (!this._monitors.length) return;
            const t = _xf(this._canvas.get_width(), this._canvas.get_height(), _bounds(this._monitors));
            const idx = _hitMon(x, y, this._monitors, t);
            if (idx >= 0) {
                this._sel = idx;
                this._canvas.grab_focus();
                this._updateInfo();
                this._syncCanvas();
            }
        });
        this._canvas.add_controller(click);

        // Right-drag inside a display: grab and move ITS picture (image
        // space). Monitor layout — and mouse transitions — stay untouched.
        const wpDrag = new Gtk.GestureDrag({ button: 3 });
        wpDrag.connect('drag-begin', (_g, x, y) => {
            if (!this._monitors.length || !this._wpPix) return;
            const t = _xf(this._canvas.get_width(), this._canvas.get_height(), _bounds(this._monitors));
            const idx = _hitMon(x, y, this._monitors, t);
            if (idx < 0) return;
            this._ensureAbs(idx);
            const m = this._monitors[idx];
            this._wpDragIdx = idx;
            this._wpDragStart = { ...m.wp.abs };
            this._wpDragR = _toCanvas(m, t);
            this._sel = idx;
            this._updateInfo();
        });
        wpDrag.connect('drag-update', (_g, dx, dy) => {
            if (this._wpDragIdx == null || this._wpDragIdx < 0 || !this._wpDragR) return;
            const m = this._monitors[this._wpDragIdx];
            const a = m.wp.abs, s0 = this._wpDragStart, r = this._wpDragR;
            // Grab semantics: dragging right moves the picture right —
            // the sampled region moves left in the image.
            a.x = _clamp(s0.x - (dx / r.w) * s0.w, 0, 1 - a.w);
            a.y = _clamp(s0.y - (dy / r.h) * s0.h, 0, 1 - a.h);
            this._syncCanvas();
            this._updateInfo();
        });
        wpDrag.connect('drag-end', () => {
            if (this._wpDragIdx == null || this._wpDragIdx < 0) return;
            this._wpDragIdx = -1;
            this._wpDragR = null;
            this._save();
            this._scheduleWpRegen();
        });
        this._canvas.add_controller(wpDrag);

        // Ctrl+scroll over the canvas: zoom the selected display's picture.
        const zoomCtl = new Gtk.EventControllerScroll();
        zoomCtl.set_flags(Gtk.EventControllerScrollFlags.VERTICAL);
        zoomCtl.connect('scroll', (c, _dx, dy) => {
            if (!(c.get_current_event_state() & Gdk.ModifierType.CONTROL_MASK)) return false;
            if (this._sel < 0 || this._sel >= this._monitors.length || !this._wpPix) return true;
            this._ensureAbs(this._sel);
            const a = this._monitors[this._sel].wp.abs;
            const f = dy < 0 ? 1 / 1.07 : 1.07; // scroll up = zoom in = smaller region
            const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
            const aspect = a.h / a.w;
            a.w = _clamp(a.w * f, 0.05, 1);
            a.h = _clamp(a.w * aspect, 0.05, 1);
            a.x = _clamp(cx - a.w / 2, 0, 1 - a.w);
            a.y = _clamp(cy - a.h / 2, 0, 1 - a.h);
            this._syncCanvas();
            this._updateInfo();
            this._save();
            this._scheduleWpRegen();
            return true;
        });
        this._canvas.add_controller(zoomCtl);

        const key = new Gtk.EventControllerKey();
        key.connect('key-pressed', (_c, kv, _kc, st) => {
            if (this._sel < 0 || this._sel >= this._monitors.length) return false;
            const m = this._monitors[this._sel];

            // Alt+arrows / Alt+± adjust the SELECTED display's picture (image
            // framing) instead of moving the monitor — keyboard twin of
            // right-drag and Ctrl+scroll. Layout and mouse transitions untouched.
            if (st & Gdk.ModifierType.ALT_MASK) {
                if (!this._wpPix) return false;
                const d = 0.04;
                switch (kv) {
                    case Gdk.KEY_Left:  this._nudgePic(-d, 0); return true;
                    case Gdk.KEY_Right: this._nudgePic(d, 0); return true;
                    case Gdk.KEY_Up:    this._nudgePic(0, -d); return true;
                    case Gdk.KEY_Down:  this._nudgePic(0, d); return true;
                    case Gdk.KEY_plus:
                    case Gdk.KEY_equal:
                    case Gdk.KEY_KP_Add:      this._zoomPic(1 / 1.08); return true;
                    case Gdk.KEY_minus:
                    case Gdk.KEY_KP_Subtract: this._zoomPic(1.08); return true;
                    default: return false;
                }
            }

            const step = (st & Gdk.ModifierType.SHIFT_MASK) ? 10 : 1;
            switch (kv) {
                case Gdk.KEY_Left: m.x -= step; break;
                case Gdk.KEY_Right: m.x += step; break;
                case Gdk.KEY_Up: m.y -= step; break;
                case Gdk.KEY_Down: m.y += step; break;
                default: return false;
            }
            const others = this._monitors.filter((_m, i) => i !== this._sel);
            // Keyboard nudge must not create overlaps either.
            if (others.some(o => _overlaps(m, o)))
                _resolvePlacement(m, others);
            _norm(this._monitors);
            this._save();
            this._updateInfo();
            this._syncCanvas();
            return true;
        });
        this._canvas.add_controller(key);
    }

    // ---- render ----

    _render(cr, w, h) {
        // Canvas background (recessed dark area like GNOME Settings).
        cr.setSourceRGBA(0.10, 0.10, 0.12, 1.0);
        cr.paint();

        if (!this._monitors.length) {
            cr.setSourceRGBA(1, 1, 1, 0.45);
            cr.setFontSize(14);
            const msg = _('Click “Detect Displays” to load your monitors.');
            const ext = cr.textExtents(msg);
            cr.moveTo((w - ext.width) / 2, h / 2);
            cr.showText(msg);
            return;
        }

        const bds = _bounds(this._monitors);
        const t = _xf(w, h, bds);

        // Continuous wallpaper spanning the whole desktop: dimmed everywhere,
        // full brightness clipped inside each monitor. Dragging a monitor
        // reveals in real time which part of the image it will display.
        if (this._wpPix) {
            // Dim px-space backdrop for context…
            this._drawWallpaper(cr, t, 0.30);
            // …and the truth inside each monitor: the physical-space crop
            // each panel will actually display (same math as the stitched
            // wallpaper written on Apply).
            const rects = _physSrcRects(this._monitors,
                this._wpPix.get_width(), this._wpPix.get_height());
            for (const pr of rects) {
                const r = _toCanvas(pr.m, t);
                cr.save();
                cr.rectangle(r.x, r.y, r.w, r.h);
                cr.clip();
                cr.translate(r.x, r.y);
                cr.scale(r.w / pr.srcW, r.h / pr.srcH);
                cr.translate(-pr.srcX, -pr.srcY);
                Gdk.cairo_set_source_pixbuf(cr, this._wpPix, 0, 0);
                cr.paint();
                cr.restore();
            }
        }

        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);

        for (let i = 0; i < this._monitors.length; i++) {
            const m = this._monitors[i];
            const r = _toCanvas(m, t);
            const sel = i === this._sel;

            // Plain fill when no wallpaper (GNOME-style dark tiles).
            if (!this._wpPix) {
                cr.setSourceRGBA(0.23, 0.23, 0.27, 1.0);
                cr.rectangle(r.x, r.y, r.w, r.h);
                cr.fill();
            }

            // Border: accent blue when selected, subtle otherwise.
            if (sel) cr.setSourceRGBA(0.21, 0.52, 0.89, 1.0);
            else cr.setSourceRGBA(1, 1, 1, 0.35);
            cr.setLineWidth(sel ? 3 : 1.5);
            cr.rectangle(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
            cr.stroke();

            // Centered number badge (like GNOME Settings).
            const rad = Math.min(16, Math.max(10, Math.min(r.w, r.h) * 0.16));
            const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
            cr.setSourceRGBA(1, 1, 1, 0.92);
            cr.arc(cx, cy, rad, 0, 2 * Math.PI);
            cr.fill();
            cr.setSourceRGBA(0.1, 0.1, 0.12, 1.0);
            cr.setFontSize(rad * 1.1);
            const label = `${i + 1}`;
            const te = cr.textExtents(label);
            cr.moveTo(cx - te.width / 2 - te.xBearing, cy - te.height / 2 - te.yBearing);
            cr.showText(label);

            // Primary star marker.
            if (m.primary) {
                cr.setSourceRGBA(1, 1, 1, 0.85);
                cr.setFontSize(11);
                cr.moveTo(r.x + 6, r.y + 14);
                cr.showText('★');
            }
        }
    }

    // Draw the wallpaper cover-fitted to the desktop bounding box.
    _drawWallpaper(cr, t, alpha) {
        const pix = this._wpPix;
        const iw = pix.get_width(), ih = pix.get_height();
        if (!iw || !ih) return;

        const bx = t.ox, by = t.oy;
        const bw = t.bds.w * t.s, bh = t.bds.h * t.s;

        // Cover fit: scale so the image fills the desktop box, center overflow.
        const scale = Math.max(bw / iw, bh / ih);
        const dx = bx + (bw - iw * scale) / 2;
        const dy = by + (bh - ih * scale) / 2;

        cr.save();
        cr.rectangle(bx, by, bw, bh);
        cr.clip();
        cr.translate(dx, dy);
        cr.scale(scale, scale);
        Gdk.cairo_set_source_pixbuf(cr, pix, 0, 0);
        cr.paintWithAlpha(alpha);
        cr.restore();
    }

    // ---- apply (verify → temporary → confirm → persistent) ----

    _primaryName() {
        const p = this._monitors.find(m => m.primary);
        return p ? p.name : (this._monitors[0] ? this._monitors[0].name : null);
    }

    _apply() {
        if (!this._monitors.length) return;
        // Re-entrancy guard: Mutter calls below block the UI briefly, so a
        // double-click on Apply used to queue a second confirmation dialog.
        if (this._applying) return;
        this._applying = true;

        // Belt and braces: re-validate the whole arrangement before Mutter.
        for (let i = 0; i < this._monitors.length; i++) {
            const others = this._monitors.filter((_m, j) => j !== i);
            if (others.some(o => _overlaps(this._monitors[i], o)))
                _resolvePlacement(this._monitors[i], others);
        }
        _norm(this._monitors);
        this._save();
        this._syncCanvas();

        const pos = {};
        for (const m of this._monitors) pos[m.name] = { x: m.x, y: m.y };
        const primary = this._primaryName();

        let state;
        try {
            state = DisplayConfig.getCurrentState();
        } catch (e) {
            this._msg(_('Cannot read display state: ') + e.message);
            this._applying = false;
            return;
        }

        // 1. VERIFY — Mutter rejects invalid configs without touching the
        //    screen. This is the step that prevents the X server crash.
        try {
            DisplayConfig.applyPositions(state, pos, DisplayConfig.APPLY_VERIFY, primary);
        } catch (e) {
            this._msg(_('Layout rejected by Mutter: ') + e.message);
            this._applying = false;
            return;
        }

        // 2. PERSISTENT apply. GNOME Shell itself shows the system
        //    "Keep these display settings?" dialog with countdown and
        //    auto-revert — no dialog of our own (it would double up).
        try {
            const s2 = DisplayConfig.getCurrentState();
            DisplayConfig.applyPositions(s2, pos, DisplayConfig.APPLY_PERSISTENT, primary);
        } catch (e) {
            this._msg(_('Apply failed: ') + e.message);
            this._applying = false;
            return;
        }

        // 3. Set the actual desktop wallpaper, spanned across all monitors,
        //    so the arrangement preview matches reality.
        this._applyWallpaper();
        this._pushToDaemon();
        this._msg(_('Applied — confirm in the system dialog.'));
        this._applying = false;
        this._dirty = false;
    }

    // Stitch a physical-space wallpaper: one PNG sized to the logical
    // desktop, where each monitor's rectangle holds the physically-correct
    // crop at that monitor's own pixel density. GNOME shows it "spanned"
    // 1:1, so the image is continuous across the bezel in the real world —
    // not just in pixel coordinates.
    _composeWallpaper() {
        if (!this._wpPix || !this._monitors.length) return null;
        const iw = this._wpPix.get_width(), ih = this._wpPix.get_height();
        if (!iw || !ih) return null;

        let W = 0, H = 0;
        for (const m of this._monitors) {
            W = Math.max(W, m.x + m.w);
            H = Math.max(H, m.y + m.h);
        }
        const dest = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, W, H);
        dest.fill(0x000000ff);

        for (const pr of _physSrcRects(this._monitors, iw, ih)) {
            const m = pr.m;
            const scaleX = m.w / pr.srcW;
            const scaleY = m.h / pr.srcH;
            this._wpPix.composite(dest,
                m.x, m.y, m.w, m.h,
                m.x - pr.srcX * scaleX, m.y - pr.srcY * scaleY,
                scaleX, scaleY,
                GdkPixbuf.InterpType.BILINEAR, 255);
        }
        return dest;
    }

    _applyWallpaper() {
        if (!this._wpPath) return;
        try {
            const dest = this._composeWallpaper();
            if (!dest) return;

            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'duascreen']);
            GLib.mkdir_with_parents(dir, 0o755);

            // Fresh filename every time — GNOME won't reload an unchanged
            // picture-uri, which made background edits look ignored.
            const path = GLib.build_filenamev([dir, `wallpaper-${Date.now()}.png`]);
            dest.savev(path, 'png', [], []);

            // Sweep older stitched files.
            try {
                const d = Gio.File.new_for_path(dir);
                const en = d.enumerate_children('standard::name',
                    Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = en.next_file(null))) {
                    const name = info.get_name();
                    if (name.startsWith('wallpaper-') && !path.endsWith(name))
                        d.get_child(name).delete(null);
                }
            } catch (e) { /* sweep is best-effort */ }

            const bg = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            const uri = `file://${path}`;
            bg.set_string('picture-uri', uri);
            bg.set_string('picture-uri-dark', uri);
            bg.set_string('picture-options', 'spanned');
        } catch (e) {
            this._msg(_('Could not set wallpaper: ') + e.message);
        }
    }

    _pushToDaemon() {
        const dp = {
            monitors: this._monitors.map(m => ({
                name: m.name, x: m.x, y: m.y,
                width_px: m.w, height_px: m.h,
                width_mm: m.wm || 0, height_mm: m.hm || 0,
                dpi_override: m.dpi_override || 0,
                primary: Boolean(m.primary),
            })),
            device_path: '',
        };
        _callDaemonAsync('SetLayout', 's', [JSON.stringify(dp)], (_r, err) => {
            if (err) this._msg(_('Daemon unreachable: ') + err.message);
        });
        _callDaemonAsync('SetEnabled', 'b', [this._s.get_boolean('enabled')]);
    }

    // ---- seam alignment wizard ----
    //
    // Fixes "monitor seam misalignment": the logical offset between two
    // displays not matching how the panels physically sit on the desk, so
    // windows/wallpaper/cursor jump at the bezel.
    //
    // The wizard runs as a SEPARATE gjs process (alignWizard.js): the same
    // widget structure is proven reliable in a plain gjs process, and a
    // wizard crash can never take the prefs window down. It applies the
    // offset itself (VERIFY → PERSISTENT); our MonitorsChanged subscription
    // refreshes the editor when it lands.

    _startAlignWizard() {
        try {
            const script = GLib.build_filenamev([
                import.meta.url.replace('file://', '').replace(/\/prefs\.js$/, ''),
                'alignWizard.js',
            ]);
            const proc = Gio.Subprocess.new(
                ['gjs', '-m', script],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    if (err && err.trim()) {
                        this._msg(_('Align wizard: ') + err.trim().split('\n').pop());
                    } else if (out && out.includes('applied')) {
                        // Remember the confirmed gap so "Align" can reapply
                        // it with one click from now on.
                        this._detect(false);
                        const pair = _seamPair(this._monitors);
                        if (pair)
                            this._alignMM = Math.round(_pxToMmOffset(pair.a, pair.b));
                        this._save();
                        this._syncMmRow();
                        if (this._wpPix) this._applyWallpaper();
                        this._msg(_('Seam aligned — gap remembered: ') +
                            `${this._alignMM}mm`);
                    } else {
                        this._msg(_('Seam alignment cancelled.'));
                    }
                } catch (e) {
                    this._msg(_('Align wizard failed: ') + e.message);
                }
            });
            this._msg(_('Align the green line across the bezel, then Save.'));
        } catch (e) {
            this._msg(_('Cannot launch align wizard: ') + e.message);
        }
    }


    // ---- wallpaper ----

    _chooseWP() {
        const f = new Gtk.FileFilter();
        f.set_name(_('Images'));
        f.add_pixbuf_formats();
        const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
        filters.append(f);

        const dialog = new Gtk.FileDialog({
            title: _('Choose wallpaper image'),
            modal: true,
            filters,
        });
        dialog.open(this._win, null, (d, res) => {
            let file;
            try {
                file = d.open_finish(res);
            } catch (e) {
                // Dismissed — not an error.
                return;
            }
            const path = file?.get_path();
            if (!path) {
                this._msg(_('Could not resolve a local file path for that image.'));
                return;
            }
            this._setWallpaper(path);
        });
    }

    // Set a wallpaper: load, remember the previous one in history, save,
    // immediately restitch + apply, refresh gallery and preview.
    _setWallpaper(path) {
        const pix = this._loadImg(path);
        if (!pix) {
            this._msg(_('Could not load image: ') + path.split('/').pop());
            return;
        }
        if (this._wpPath && this._wpPath !== path) {
            // Keep the outgoing image's framing before switching.
            this._saveFramingToProfile();
            this._wpHistory = [this._wpPath,
                ...(this._wpHistory || []).filter(p => p !== this._wpPath && p !== path)]
                .slice(0, 5);
        }
        this._wpPath = path;
        this._wpPix = pix;

        // Restore this image's remembered per-display framing (span default).
        const prof = (this._wpProfiles || {})[path];
        for (const m of this._monitors) {
            const a = _profFor(prof, m);
            m.wp = (a && a.w > 0)
                ? { x: 0, y: 0, z: 1, abs: { ...a } }
                : { x: 0, y: 0, z: 1 };
        }
        this._save();
        this._applyWallpaper();
        this._updateWpButtons();
        this._rebuildGallery();
        this._syncCanvas();
        this._msg(_('Wallpaper: ') + path.split('/').pop());
    }

    // Candidate images for the suggestion strip: user Pictures + system
    // backgrounds.
    _listSuggestions() {
        const out = [];
        const dirs = [
            GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']),
            '/usr/share/backgrounds',
        ];
        const exts = ['.jpg', '.jpeg', '.png', '.webp'];
        for (const dir of dirs) {
            try {
                const d = Gio.File.new_for_path(dir);
                const en = d.enumerate_children('standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = en.next_file(null)) && out.length < 12) {
                    if (info.get_file_type() !== Gio.FileType.REGULAR) continue;
                    const n = info.get_name().toLowerCase();
                    if (exts.some(e => n.endsWith(e)))
                        out.push(GLib.build_filenamev([dir, info.get_name()]));
                }
            } catch (e) { /* dir missing — skip */ }
            if (out.length >= 12) break;
        }
        return out;
    }

    _rebuildGallery() {
        if (!this._galleryBox) return;
        let c;
        while ((c = this._galleryBox.get_first_child())) this._galleryBox.remove(c);

        const items = [];
        if (this._wpPath) items.push({ path: this._wpPath, tag: _('Current') });
        for (const p of (this._wpHistory || [])) {
            if (p !== this._wpPath) { items.push({ path: p, tag: _('Last') }); break; }
        }
        for (const p of this._listSuggestions()) {
            if (items.length >= 9) break;
            if (items.some(i => i.path === p)) continue;
            items.push({ path: p, tag: null });
        }

        for (const it of items) {
            let thumb = null;
            try {
                thumb = GdkPixbuf.Pixbuf.new_from_file_at_scale(it.path, 150, 84, true);
            } catch (e) { continue; }
            const btn = new Gtk.Button();
            if (it.tag === _('Current')) btn.add_css_class('suggested-action');
            const bx = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3 });
            const pic = Gtk.Picture.new_for_pixbuf(thumb);
            pic.set_size_request(150, 84);
            bx.append(pic);
            const lbl = new Gtk.Label({
                label: it.tag || it.path.split('/').pop(),
                ellipsize: Pango.EllipsizeMode.END,
                max_width_chars: 16,
            });
            if (!it.tag) lbl.add_css_class('dim-label');
            bx.append(lbl);
            btn.set_child(bx);
            const path = it.path;
            btn.connect('clicked', () => this._setWallpaper(path));
            this._galleryBox.append(btn);
        }
    }

    // ---- helpers ----

    // Debounced wallpaper restitch — pan/zoom fire many events; regenerate
    // the PNG at most twice a second.
    _scheduleWpRegen() {
        if (this._wpRegenId) GLib.source_remove(this._wpRegenId);
        this._wpRegenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._wpRegenId = 0;
            if (this._wpPix) this._applyWallpaper();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Move the selected display's picture by a fraction of its crop.
    _nudgePic(fx, fy) {
        if (this._sel < 0 || !this._wpPix) return;
        this._ensureAbs(this._sel);
        const a = this._monitors[this._sel].wp.abs;
        // ▶ moves the picture right = sampled region moves left.
        a.x = _clamp(a.x - fx * a.w, 0, 1 - a.w);
        a.y = _clamp(a.y - fy * a.h, 0, 1 - a.h);
        this._save();
        this._syncCanvas();
        this._updateInfo();
        this._scheduleWpRegen();
    }

    // Zoom the selected display's picture (f > 1 zooms out).
    _zoomPic(f) {
        if (this._sel < 0 || !this._wpPix) return;
        this._ensureAbs(this._sel);
        const a = this._monitors[this._sel].wp.abs;
        const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
        const aspect = a.h / a.w;
        a.w = _clamp(a.w * f, 0.05, 1);
        a.h = _clamp(a.w * aspect, 0.05, 1);
        a.x = _clamp(cx - a.w / 2, 0, 1 - a.w);
        a.y = _clamp(cy - a.h / 2, 0, 1 - a.h);
        this._save();
        this._syncCanvas();
        this._updateInfo();
        this._scheduleWpRegen();
    }

    // Smart align: reuse the remembered physical gap if the user already
    // defined one; otherwise open the align wizard to define it.
    _smartAlign() {
        const pair = _seamPair(this._monitors);
        if (!pair) {
            this._msg(_('Alignment needs two side-by-side displays.'));
            return;
        }
        if (typeof this._alignMM === 'number') {
            pair.b.y = _mmOffsetToPx(pair.a, pair.b, this._alignMM);
            _norm(this._monitors);
            this._save();
            this._refreshAll();
            this._apply();
            this._msg(_('Applied remembered alignment: ') + `${this._alignMM}mm`);
        } else {
            this._msg(_('No saved alignment yet — opening the align wizard.'));
            this._startAlignWizard();
        }
    }

    // Initialize absolute framing for a monitor from whatever it currently
    // shows, so dragging/zooming starts from the visible state.
    _ensureAbs(idx) {
        const m = this._monitors[idx];
        m.wp = m.wp || {};
        if (m.wp.abs && m.wp.abs.w > 0) return;
        const iw = this._wpPix.get_width(), ih = this._wpPix.get_height();
        const cur = _physSrcRects(this._monitors, iw, ih).find(r => r.m === m);
        m.wp.abs = {
            x: _clamp(cur.srcX / iw, 0, 1),
            y: _clamp(cur.srcY / ih, 0, 1),
            w: _clamp(cur.srcW / iw, 0.05, 1),
            h: _clamp(cur.srcH / ih, 0.05, 1),
        };
        m.wp.abs.x = _clamp(m.wp.abs.x, 0, 1 - m.wp.abs.w);
        m.wp.abs.y = _clamp(m.wp.abs.y, 0, 1 - m.wp.abs.h);
    }

    // One-click framing for the selected display: left/right half of the
    // image, whole image, or back to the continuous span.
    _picPreset(mode) {
        if (this._sel < 0 || this._sel >= this._monitors.length) {
            this._msg(_('Select a display first (click it on the canvas).'));
            return;
        }
        if (!this._wpPix) {
            this._msg(_('Pick a wallpaper first.'));
            return;
        }
        const m = this._monitors[this._sel];
        if (mode === 'span') {
            m.wp = { x: 0, y: 0, z: 1 };
        } else {
            const iw = this._wpPix.get_width(), ih = this._wpPix.get_height();
            const aspect = m.w / m.h; // display aspect
            let srcW, srcH, cx;
            if (mode === 'left' || mode === 'right') {
                srcW = iw / 2;
                srcH = srcW / aspect;
                if (srcH > ih) { srcH = ih; srcW = srcH * aspect; }
                cx = mode === 'left' ? iw / 4 : (3 * iw) / 4;
            } else { // 'fit' — as much of the image as the display aspect allows
                srcW = iw;
                srcH = srcW / aspect;
                if (srcH > ih) { srcH = ih; srcW = srcH * aspect; }
                cx = iw / 2;
            }
            const cy = ih / 2;
            m.wp = m.wp || {};
            m.wp.abs = {
                x: _clamp((cx - srcW / 2) / iw, 0, 1 - srcW / iw),
                y: _clamp((cy - srcH / 2) / ih, 0, 1 - srcH / ih),
                w: srcW / iw,
                h: srcH / ih,
            };
        }
        this._save();
        this._syncCanvas();
        this._updateInfo();
        this._scheduleWpRegen();
        this._msg(`${m.name}: ` + _('picture set to ') + mode);
    }

    // Content-aware auto-framing: find the most "interesting" region of the
    // image for each display (edge-energy saliency — faces, subjects and
    // detail score high; flat sky/background scores low) and frame it.
    // Pure pixel math on a downscaled copy: no external libraries, works on
    // any install.
    _autoFrame() {
        if (!this._wpPix || !this._monitors.length) {
            this._msg(_('Pick a wallpaper first.'));
            return;
        }

        const gw = 144;
        const gh = Math.max(24, Math.round(gw * this._wpPix.get_height() / this._wpPix.get_width()));
        const small = this._wpPix.scale_simple(gw, gh, GdkPixbuf.InterpType.BILINEAR);
        const nch = small.get_n_channels();
        const rs = small.get_rowstride();
        const px = small.get_pixels();

        // Grayscale → edge energy → integral image for O(1) window sums.
        const g = new Float32Array(gw * gh);
        for (let y = 0; y < gh; y++)
            for (let x = 0; x < gw; x++) {
                const o = y * rs + x * nch;
                g[y * gw + x] = px[o] + px[o + 1] + px[o + 2];
            }
        const e = new Float32Array(gw * gh);
        for (let y = 1; y < gh - 1; y++)
            for (let x = 1; x < gw - 1; x++)
                e[y * gw + x] =
                    Math.abs(g[y * gw + x + 1] - g[y * gw + x - 1]) +
                    Math.abs(g[(y + 1) * gw + x] - g[(y - 1) * gw + x]);
        const iw1 = gw + 1;
        const I = new Float64Array(iw1 * (gh + 1));
        for (let y = 0; y < gh; y++) {
            let row = 0;
            for (let x = 0; x < gw; x++) {
                row += e[y * gw + x];
                I[(y + 1) * iw1 + x + 1] = I[y * iw1 + x + 1] + row;
            }
        }
        const winSum = (x, y, w, h) =>
            I[(y + h) * iw1 + x + w] - I[y * iw1 + x + w] -
            I[(y + h) * iw1 + x] + I[y * iw1 + x];

        // Candidate windows per display (display aspect, several zooms).
        const mons = [...this._monitors].sort((a, b) => a.x - b.x);
        const candLists = mons.map(m => {
            const aspect = m.w / m.h;
            const wMax = Math.min(gw, gh * aspect);
            const list = [];
            for (const z of [1.0, 0.8, 0.62, 0.48]) {
                const w = Math.max(8, Math.round(wMax * z));
                const h = Math.max(8, Math.round(w / aspect));
                if (h > gh) continue;
                const step = Math.max(1, Math.round((gw - w) / 24) || 1);
                for (let y = 0; y + h <= gh; y += Math.max(1, Math.round((gh - h) / 12) || 1)) {
                    for (let x = 0; x + w <= gw; x += step) {
                        // Average energy, small bias toward wider shots so
                        // we don't always crop into extreme close-ups.
                        const score = (winSum(x, y, w, h) / (w * h)) * (1 + 0.20 * z);
                        list.push({ x, y, w, h, score, cx: x + w / 2 });
                    }
                }
            }
            list.sort((p, q) => q.score - p.score);
            return list.slice(0, 48);
        });

        // Pick per display. Two displays: best-scoring pair whose windows
        // don't overlap much and whose left-right order matches the desks'.
        let chosen;
        if (mons.length === 2) {
            let best = null, bs = -1;
            for (const c1 of candLists[0]) {
                for (const c2 of candLists[1]) {
                    if (c1.cx > c2.cx) continue; // keep left/right order
                    const ix = Math.max(0, Math.min(c1.x + c1.w, c2.x + c2.w) - Math.max(c1.x, c2.x));
                    const iy = Math.max(0, Math.min(c1.y + c1.h, c2.y + c2.h) - Math.max(c1.y, c2.y));
                    const inter = ix * iy;
                    const overlap = inter / Math.min(c1.w * c1.h, c2.w * c2.h);
                    if (overlap > 0.35) continue;
                    const s = c1.score + c2.score;
                    if (s > bs) { bs = s; best = [c1, c2]; }
                }
            }
            chosen = best || [candLists[0][0], candLists[1][0]];
        } else {
            chosen = candLists.map(l => l[0]);
        }

        for (let i = 0; i < mons.length; i++) {
            const c = chosen[i];
            if (!c) continue;
            mons[i].wp = mons[i].wp || {};
            mons[i].wp.abs = {
                x: _clamp(c.x / gw, 0, 1),
                y: _clamp(c.y / gh, 0, 1),
                w: _clamp(c.w / gw, 0.05, 1),
                h: _clamp(c.h / gh, 0.05, 1),
            };
        }

        this._save();
        this._syncCanvas();
        this._updateInfo();
        this._scheduleWpRegen();
        this._msg(_('Auto-framed each display on the most detailed part of the image.'));
    }

    _syncCanvas() { if (this._canvas) this._canvas.queue_draw(); }
    _msg(s) { if (this._status) this._status.label = s; }
}
