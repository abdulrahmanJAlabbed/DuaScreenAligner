#!/usr/bin/env -S gjs -m
// alignWizard.js — Standalone seam-alignment wizard.
//
// Runs as its own gjs process (spawned by prefs.js, or manually for
// debugging: `gjs -m alignWizard.js`). Shows a fullscreen window per
// monitor with one bright green guide line; the user nudges the moving
// side until the line is physically straight across the bezel, then Save
// applies the offset through Mutter (VERIFY first, then PERSISTENT).
//
// Standalone on purpose: the identical widget structure works reliably in
// a plain gjs process, and a crash here can never take the prefs UI down.

import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Cairo from 'cairo';

import * as DisplayConfig from './displayConfig.js';

Gtk.init();
const loop = GLib.MainLoop.new(null, false);

// ---- read applied monitor layout ----

let state;
try {
    state = DisplayConfig.getCurrentState();
} catch (e) {
    printerr(`align-wizard: cannot read display state: ${e.message}`);
    loop.quit();
    imports.system.exit(1);
}

const mons = state.logical.map(e => {
    const sz = DisplayConfig.logicalSize(state.modeByConnector[e.connectors[0]], e.transform);
    return { name: e.connectors[0], x: e.x, y: e.y, w: sz.width, h: sz.height, transform: e.transform };
});

// Physical panel sizes (mm) from xrandr — the guides are drawn in PHYSICAL
// space so that at the correct offset every line pair merges at the bezel
// simultaneously (drawing in pixel space gives different physical spacing
// per monitor and lines can never all match).
function xrandrMM() {
    const mm = {};
    try {
        const [ok, out] = GLib.spawn_command_line_sync('xrandr --query');
        if (ok && out) {
            const text = new TextDecoder().decode(out);
            const re = /^(\S+)\s+connected\s+(?:primary\s+)?\d+x\d+\+[-]?\d+\+[-]?\d+\s*(?:\w+\s*)?(?:\(.*?\)\s+)?(\d+)mm\s+x\s+(\d+)mm/;
            for (const line of text.split('\n')) {
                const m = line.match(re);
                if (m) mm[m[1]] = { wm: Number(m[2]), hm: Number(m[3]) };
            }
        }
    } catch (e) { /* fall back below */ }
    return mm;
}

{
    const mmMap = xrandrMM();
    for (const m of mons) {
        let mm = mmMap[m.name] || null;
        const rotated = m.transform === 1 || m.transform === 3 ||
            m.transform === 5 || m.transform === 7;
        if (mm && rotated) mm = { wm: mm.hm, hm: mm.wm };
        m.wm = mm && mm.wm > 0 ? mm.wm : m.w * 25.4 / 96;
        m.hm = mm && mm.hm > 0 ? mm.hm : m.h * 25.4 / 96;
    }
}

if (mons.length !== 2) {
    printerr('align-wizard: needs exactly two displays');
    imports.system.exit(1);
}

// ---- seam orientation ----

mons.sort((a, b) => a.x - b.x);
let axis = null, fixed = null, moving = null;
if (mons[0].x + mons[0].w === mons[1].x) {
    axis = 'y';
    [fixed, moving] = mons;
} else {
    mons.sort((a, b) => a.y - b.y);
    if (mons[0].y + mons[0].h === mons[1].y) {
        axis = 'x';
        [fixed, moving] = mons;
    }
}
if (!axis) {
    printerr('align-wizard: displays are not touching');
    imports.system.exit(1);
}

const mid = axis === 'y'
    ? Math.round((Math.max(fixed.y, moving.y) + Math.min(fixed.y + fixed.h, moving.y + moving.h)) / 2)
    : Math.round((Math.max(fixed.x, moving.x) + Math.min(fixed.x + fixed.w, moving.x + moving.w)) / 2);

let delta = 0;
const windows = [];

// Cursor-assisted alignment: the user clicks the SAME physical spot on both
// screens (e.g. under a card held straight across the bezel); the required
// offset is computed and applied instantly.
let clickFixed = null;   // local coord along the guide axis, fixed side
let clickMoving = null;  // local coord along the guide axis, moving side

function kOf(m) {
    return axis === 'y' ? m.hm / m.h : m.wm / m.w;
}

// Find the delta whose seam-mid-anchored physical offset equals target mm.
function deltaForMmOff(target) {
    const aLead = axis === 'y' ? fixed.y : fixed.x;
    const aLen = axis === 'y' ? fixed.h : fixed.w;
    const bLen = axis === 'y' ? moving.h : moving.w;
    const bBase = axis === 'y' ? moving.y : moving.x;
    const kA = kOf(fixed), kB = kOf(moving);
    let lead = bBase + delta;
    for (let i = 0; i < 12; i++) {
        const mid2 = (Math.max(aLead, lead) + Math.min(aLead + aLen, lead + bLen)) / 2;
        const next = mid2 - ((mid2 - aLead) * kA - target) / kB;
        if (Math.abs(next - lead) < 0.5) { lead = next; break; }
        lead = next;
    }
    return Math.round(lead - bBase);
}

function onMark(m, localV) {
    if (m === fixed) clickFixed = localV;
    else clickMoving = localV;
    if (clickFixed !== null && clickMoving !== null) {
        const target = clickFixed * kOf(fixed) - clickMoving * kOf(moving);
        delta = deltaForMmOff(target);
        print(`offset ${delta}`);
    }
    redraw();
}

// ---- actions ----

function redraw() {
    for (const wv of windows) wv.area.queue_draw();
}

function adjust(d) {
    delta += d;
    print(`offset ${delta}`);
    redraw();
}

function finish(save) {
    for (const wv of windows) {
        try { wv.win.destroy(); } catch (e) { /* gone */ }
    }
    if (save && delta !== 0) {
        const pos = {};
        pos[fixed.name] = { x: fixed.x, y: fixed.y };
        pos[moving.name] = axis === 'y'
            ? { x: moving.x, y: moving.y + delta }
            : { x: moving.x + delta, y: moving.y };
        try {
            const s1 = DisplayConfig.getCurrentState();
            DisplayConfig.applyPositions(s1, pos, DisplayConfig.APPLY_VERIFY);
            const s2 = DisplayConfig.getCurrentState();
            DisplayConfig.applyPositions(s2, pos, DisplayConfig.APPLY_PERSISTENT);
            print(`applied ${moving.name} ${axis}+${delta}`);
        } catch (e) {
            printerr(`align-wizard: apply failed: ${e.message}`);
        }
    } else {
        print('cancelled');
    }
    loop.quit();
}

// ---- drawing ----

function drawWizard(cr, w, h, m, isMoving) {
    cr.setSourceRGBA(0.02, 0.02, 0.03, 1);
    cr.paint();

    const d = isMoving ? delta : 0;
    cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);

    // PHYSICAL-SPACE guide lines: one line every 40 mm of real glass,
    // measured from the fixed monitor's top (left) edge. At the correct
    // offset EVERY line pair merges at the bezel at once — the two screens
    // read as one continuous ruler.
    const spacingMM = 40;
    const isMov = m === moving;

    // mm-per-px along the guide axis for this monitor.
    const kThis = axis === 'y' ? m.hm / m.h : m.wm / m.w;
    const kA = axis === 'y' ? fixed.hm / fixed.h : fixed.wm / fixed.w;
    const kB = axis === 'y' ? moving.hm / moving.h : moving.wm / moving.w;

    // Physical offset (mm) of the moving panel's leading edge relative to
    // the fixed panel's, for the current candidate delta — same seam-mid
    // anchor the applied layout will use.
    const movLead = axis === 'y' ? moving.y + delta : moving.x + delta;
    const fixLead = axis === 'y' ? fixed.y : fixed.x;
    const fixLen = axis === 'y' ? fixed.h : fixed.w;
    const movLen = axis === 'y' ? moving.h : moving.w;
    const midL = (Math.max(fixLead, movLead) + Math.min(fixLead + fixLen, movLead + movLen)) / 2;
    const mmOff = (midL - fixLead) * kA - (midL - movLead) * kB;

    // This monitor's physical lead position (fixed anchors at 0).
    const physLead = isMov ? mmOff : 0;
    const physLen = (axis === 'y' ? m.h : m.w) * kThis;

    const cols = [
        [0.20, 1.00, 0.40], [1.00, 0.55, 0.20], [0.35, 0.65, 1.00],
        [1.00, 0.35, 0.75], [1.00, 0.95, 0.30],
    ];
    cr.setFontSize(22);

    const jMin = Math.floor(Math.min(0, physLead) / spacingMM) - 1;
    const jMax = Math.ceil((Math.max(fixLen * kA, physLead + physLen) + spacingMM) / spacingMM) + 1;
    for (let j = jMin; j <= jMax; j++) {
        const Hmm = j * spacingMM;
        const lp = (Hmm - physLead) / kThis; // local px along guide axis
        const limit = axis === 'y' ? h : w;
        if (lp < -4 || lp > limit + 4) continue;

        const c = cols[((j % 5) + 5) % 5];
        const major = j % 5 === 0;
        cr.setSourceRGBA(c[0], c[1], c[2], major ? 1.0 : 0.8);
        cr.setLineWidth(major ? 4 : 2);

        if (axis === 'y') {
            cr.moveTo(0, lp + 0.5);
            cr.lineTo(w, lp + 0.5);
            cr.stroke();
            const label = `${j}`;
            const te = cr.textExtents(label);
            const tx = (m === fixed) ? w - te.width - 14 : 14;
            cr.moveTo(tx, lp - 8);
            cr.showText(label);
        } else {
            cr.moveTo(lp + 0.5, 0);
            cr.lineTo(lp + 0.5, h);
            cr.stroke();
            const ty = (m === fixed) ? h - 14 : 30;
            cr.moveTo(lp + 8, ty);
            cr.showText(`${j}`);
        }
    }

    const arrows = axis === 'y' ? '↑ / ↓' : '← / →';
    cr.setSourceRGBA(1, 1, 1, 0.9);
    cr.setFontSize(20);
    cr.moveTo(40, 64);
    cr.showText(isMoving
        ? `THIS SIDE MOVES — buttons, scroll wheel, or ${arrows} until the two rulers merge into one (all numbers meet)`
        : 'Reference ruler — when aligned, every line continues straight across the bezel');
    cr.setFontSize(16);
    cr.moveTo(40, 96);
    cr.showText('Shift = ×10 with arrow keys. Enter = save, Esc = cancel.');
    cr.moveTo(40, 122);
    cr.showText('TIP: hold a card straight across the bezel and CLICK under its edge on BOTH screens — alignment snaps automatically.');

    // Click markers (white dashed) for cursor-assisted alignment.
    const mark = (m === fixed) ? clickFixed : clickMoving;
    if (mark !== null) {
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.setLineWidth(2);
        cr.setDash([10, 6], 0);
        if (axis === 'y') {
            cr.moveTo(0, mark + 0.5);
            cr.lineTo(w, mark + 0.5);
        } else {
            cr.moveTo(mark + 0.5, 0);
            cr.lineTo(mark + 0.5, h);
        }
        cr.stroke();
        cr.setDash([], 0);
    }

    if (isMoving) {
        const txt = `${delta > 0 ? '+' : ''}${delta}px`;
        cr.setFontSize(48);
        const te = cr.textExtents(txt);
        cr.setSourceRGBA(0.20, 1.0, 0.40, 0.9);
        cr.moveTo((w - te.width) / 2, 170);
        cr.showText(txt);
    }
}

// ---- input ----

function onKey(kv, st) {
    const step = (st & Gdk.ModifierType.SHIFT_MASK) ? 10 : 1;
    switch (kv) {
        case Gdk.KEY_Up: if (axis === 'y') { adjust(step); return true; } return false;
        case Gdk.KEY_Down: if (axis === 'y') { adjust(-step); return true; } return false;
        case Gdk.KEY_Left: if (axis === 'x') { adjust(step); return true; } return false;
        case Gdk.KEY_Right: if (axis === 'x') { adjust(-step); return true; } return false;
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
            finish(true);
            return true;
        case Gdk.KEY_Escape:
            finish(false);
            return true;
        default:
            return false;
    }
}

// ---- windows ----

const display = Gdk.Display.get_default();
const gmons = display.get_monitors();
function findG(m) {
    for (let i = 0; i < gmons.get_n_items(); i++) {
        const g = gmons.get_item(i);
        const geo = g.get_geometry();
        if (geo.x === m.x && geo.y === m.y) return g;
    }
    return null;
}

function mkBtn(label, css, cb) {
    const b = new Gtk.Button({ label });
    if (css) b.add_css_class(css);
    b.connect('clicked', cb);
    return b;
}

for (const m of [fixed, moving]) {
    const isMoving = m === moving;
    const win = new Gtk.Window({ decorated: false });
    const area = new Gtk.DrawingArea({ hexpand: true, vexpand: true, focusable: true });
    area.set_draw_func((_a, cr, w, h) => drawWizard(cr, w, h, m, isMoving));

    const overlay = new Gtk.Overlay();
    overlay.set_child(area);
    const ctrls = new Gtk.Box({
        spacing: 10,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.END,
        margin_bottom: 60,
    });
    ctrls.add_css_class('toolbar');
    ctrls.add_css_class('osd');
    if (isMoving) {
        const lbl = axis === 'y' ? ['▲ 10', '▲ 1', '▼ 1', '▼ 10'] : ['◀ 10', '◀ 1', '▶ 1', '▶ 10'];
        ctrls.append(mkBtn(lbl[0], null, () => adjust(10)));
        ctrls.append(mkBtn(lbl[1], null, () => adjust(1)));
        ctrls.append(mkBtn(lbl[2], null, () => adjust(-1)));
        ctrls.append(mkBtn(lbl[3], null, () => adjust(-10)));
        ctrls.append(mkBtn('Save', 'suggested-action', () => finish(true)));
    }
    ctrls.append(mkBtn('Cancel', 'destructive-action', () => finish(false)));
    overlay.add_overlay(ctrls);
    win.set_child(overlay);

    const key = new Gtk.EventControllerKey();
    key.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    key.connect('key-pressed', (_c, kv, _kc, st) => onKey(kv, st));
    win.add_controller(key);

    const scroll = new Gtk.EventControllerScroll();
    scroll.set_flags(Gtk.EventControllerScrollFlags.VERTICAL);
    scroll.connect('scroll', (_c, _dx, dy) => {
        adjust(dy < 0 ? 1 : -1);
        return true;
    });
    win.add_controller(scroll);

    // Cursor-assisted marking: click the same physical spot on each screen.
    const mark = new Gtk.GestureClick();
    mark.connect('pressed', (_g, _n, cx, cy) => {
        onMark(m, axis === 'y' ? cy : cx);
    });
    area.add_controller(mark);

    win.connect('close-request', () => {
        finish(false);
        return true;
    });

    win.present();
    const g = findG(m);
    if (g) win.fullscreen_on_monitor(g);
    else win.fullscreen();
    if (isMoving) area.grab_focus();
    windows.push({ win, area });
}

// Safety: never trap the user — auto-cancel after 3 minutes of no save.
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 180, () => {
    if (windows.some(wv => wv.win.get_visible?.() ?? false)) finish(false);
    return false;
});

loop.run();
