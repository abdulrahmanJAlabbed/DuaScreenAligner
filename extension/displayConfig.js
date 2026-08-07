// displayConfig.js — Talk to Mutter's DisplayConfig DBus API.
//
// This is the piece that actually moves monitors in the compositor so the
// cursor crosses screen seams at a physically consistent height. Reading the
// current state and re-applying it with new Y offsets is exactly what GNOME
// Settings does; we only change each logical monitor's position.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const BUS_NAME = 'org.gnome.Mutter.DisplayConfig';
const OBJECT_PATH = '/org/gnome/Mutter/DisplayConfig';
const IFACE = 'org.gnome.Mutter.DisplayConfig';

// Apply methods understood by Mutter.
export const APPLY_VERIFY = 0;
export const APPLY_TEMPORARY = 1;
export const APPLY_PERSISTENT = 2;

function _connection() {
    return Gio.bus_get_sync(Gio.BusType.SESSION, null);
}

// GetCurrentState returns the full monitor topology. We unpack it into a
// friendlier shape: the serial (needed to apply), a per-connector map of the
// current mode (id + native pixel size), and the list of logical monitors
// with their position, scale, transform, primary flag, and connectors.
export function getCurrentState() {
    const reply = _connection().call_sync(
        BUS_NAME,
        OBJECT_PATH,
        IFACE,
        'GetCurrentState',
        null,
        new GLib.VariantType('(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})'),
        Gio.DBusCallFlags.NONE,
        -1,
        null
    );

    const [serial, monitors, logicalMonitors, properties] = reply.recursiveUnpack();

    // Stable hardware identity per connector: vendor:product:serial. Unlike
    // the connector name (DP-3, HDMI-1…) this survives a reboot through
    // another OS renumbering the ports — so per-monitor settings can be
    // keyed to the physical panel, not the socket it happens to be in.
    const modeByConnector = {};
    const specByConnector = {};
    for (const [ids, modes] of monitors) {
        const connector = ids[0];
        const [, vendor, product, serial] = ids;
        specByConnector[connector] =
            [vendor, product, serial].filter(s => s && s.length).join(':') || connector;
        let chosen = null;
        for (const mode of modes) {
            const [id, width, height, , , , modeProps] = mode;
            if (modeProps && modeProps['is-current']) {
                chosen = { id, width, height };
                break;
            }
        }
        if (!chosen && modes.length > 0) {
            const [id, width, height] = modes[0];
            chosen = { id, width, height };
        }
        if (chosen)
            modeByConnector[connector] = chosen;
    }

    const logical = logicalMonitors.map(entry => {
        const [x, y, scale, transform, primary, connectors] = entry;
        return {
            x,
            y,
            scale,
            transform,
            primary,
            connectors: connectors.map(c => c[0]),
        };
    });

    let layoutMode = null;
    if (properties && properties['layout-mode'] !== undefined)
        layoutMode = properties['layout-mode'];

    return { serial, modeByConnector, specByConnector, logical, layoutMode };
}

// Returns the logical pixel size of a monitor given its current mode and
// rotation. A 90/270 transform swaps width and height.
export function logicalSize(mode, transform) {
    if (!mode)
        return { width: 0, height: 0 };
    const rotated = transform === 1 || transform === 3 || transform === 5 || transform === 7;
    return rotated
        ? { width: mode.height, height: mode.width }
        : { width: mode.width, height: mode.height };
}

// Re-apply the current configuration with new positions. positionsByConnector
// maps a connector name (e.g. "DP-4") to { x, y }. Everything else — mode,
// scale, transform — is preserved from the current state. If
// primaryConnector is given, that logical monitor becomes primary;
// otherwise the current primary flags are preserved.
export function applyPositions(state, positionsByConnector, method = APPLY_PERSISTENT, primaryConnector = null) {
    const newLogical = state.logical.map(entry => {
        const monitorsPart = entry.connectors.map(connector => {
            const mode = state.modeByConnector[connector];
            return [connector, mode ? mode.id : '', {}];
        });
        const pos = positionsByConnector[entry.connectors[0]] || { x: entry.x, y: entry.y };
        const primary = primaryConnector !== null
            ? entry.connectors.includes(primaryConnector)
            : entry.primary;
        return [
            Math.round(pos.x),
            Math.round(pos.y),
            entry.scale,
            entry.transform,
            primary,
            monitorsPart,
        ];
    });

    const args = new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [
        state.serial,
        method,
        newLogical,
        {},
    ]);

    _connection().call_sync(
        BUS_NAME,
        OBJECT_PATH,
        IFACE,
        'ApplyMonitorsConfig',
        args,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null
    );
}
