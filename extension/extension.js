// extension.js — Minimal GNOME Shell extension.
// Panel indicator that syncs layout and enabled state to the daemon.
//
// All DBus traffic is asynchronous: this code runs inside the GNOME Shell
// compositor process, and a synchronous call to a stalled daemon would
// freeze the entire desktop.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const DBUS_NAME = 'com.github.duascreenaligner.Daemon';
const DBUS_PATH = '/com/github/duascreenaligner/Daemon';
const DBUS_IFACE = 'com.github.duascreenaligner.Daemon';

// Debounce window for settings-changed → daemon sync. Dragging in the
// prefs editor saves the layout repeatedly; without debouncing each save
// caused a daemon SetLayout (and formerly a device reload → 2s mouse
// dropout + event-stealing race).
const SYNC_DEBOUNCE_MS = 400;

// How often to push the real cursor position to the daemon. The daemon
// integrates raw mouse deltas, but the compositor applies pointer
// acceleration on top — the daemon's tracked position drifts away from the
// real cursor, it mis-detects which monitor the cursor is on, and the DPI
// scale flips at the wrong moments (feels like the mouse DPI randomly
// changing). Periodic SetCursorPosition sync corrects the drift.
const CURSOR_SYNC_MS = 500;

function _callDaemonAsync(method, inSig, args) {
    Gio.bus_get(Gio.BusType.SYSTEM, null, (_src, res) => {
        let conn;
        try {
            conn = Gio.bus_get_finish(res);
        } catch (e) {
            logError(e, `[DuaScreen] system bus unavailable`);
            return;
        }
        const params = inSig ? new GLib.Variant(`(${inSig})`, args) : null;
        conn.call(DBUS_NAME, DBUS_PATH, DBUS_IFACE, method,
            params, null, Gio.DBusCallFlags.NONE, -1, null,
            (c, r) => {
                try {
                    c.call_finish(r);
                } catch (e) {
                    logError(e, `[DuaScreen] daemon call ${method} failed`);
                }
            });
    });
}

export default class DuaScreenAlignerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._syncTimeoutId = 0;

        this._changedIds = [
            this._settings.connect('changed::monitor-layout', () => this._scheduleSync()),
            this._settings.connect('changed::enabled', () => this._scheduleSync()),
        ];

        this._createIndicator();
        this._scheduleSync();
        this._startCursorSync();
        log('[DuaScreen] Extension enabled');
    }

    disable() {
        if (this._syncTimeoutId) {
            GLib.source_remove(this._syncTimeoutId);
            this._syncTimeoutId = 0;
        }

        if (this._cursorSyncId) {
            GLib.source_remove(this._cursorSyncId);
            this._cursorSyncId = 0;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._settings && this._changedIds) {
            for (const id of this._changedIds)
                this._settings.disconnect(id);
        }
        this._changedIds = [];
        this._settings = null;
        log('[DuaScreen] Extension disabled');
    }

    _createIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'DuaScreen Aligner', false);

        const icon = new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon dua-panel-icon',
        });
        this._indicator.add_child(icon);

        this._indicator.menu.addAction('Apply layout', () => this._syncToDaemon());
        this._indicator.menu.addAction('Toggle correction', () => {
            this._settings.set_boolean('enabled', !this._settings.get_boolean('enabled'));
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _startCursorSync() {
        this._lastPtrX = -1;
        this._lastPtrY = -1;
        this._cursorSyncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CURSOR_SYNC_MS, () => {
            const [x, y] = global.get_pointer();
            // Only send when the cursor actually moved — idle desktop costs
            // zero DBus traffic.
            if (x !== this._lastPtrX || y !== this._lastPtrY) {
                this._lastPtrX = x;
                this._lastPtrY = y;
                _callDaemonAsync('SetCursorPosition', 'ii', [x, y]);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _scheduleSync() {
        if (this._syncTimeoutId)
            GLib.source_remove(this._syncTimeoutId);
        this._syncTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_DEBOUNCE_MS, () => {
            this._syncTimeoutId = 0;
            this._syncToDaemon();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncToDaemon() {
        if (!this._settings)
            return;

        const layoutJSON = this._settings.get_string('monitor-layout');
        const enabled = this._settings.get_boolean('enabled');

        if (layoutJSON && layoutJSON.trim().length > 0) {
            try {
                const layout = JSON.parse(layoutJSON);
                if (layout.monitors && Array.isArray(layout.monitors)) {
                    const daemonPayload = {
                        monitors: layout.monitors.map(m => ({
                            name: m.name, x: m.x, y: m.y,
                            width_px: m.width_px, height_px: m.height_px,
                            width_mm: m.width_mm || 0, height_mm: m.height_mm || 0,
                            dpi_override: m.dpi_override || 0,
                            primary: Boolean(m.primary),
                        })),
                        device_path: '',
                    };
                    _callDaemonAsync('SetLayout', 's', [JSON.stringify(daemonPayload)]);
                }
            } catch (error) {
                logError(error, '[DuaScreen] Failed to apply layout');
            }
        }

        _callDaemonAsync('SetEnabled', 'b', [enabled]);
    }
}
