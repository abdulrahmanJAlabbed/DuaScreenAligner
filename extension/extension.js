// extension.js — GNOME Shell extension entry point.
// Syncs the saved layout settings to the daemon over DBus.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const DBUS_NAME = 'com.github.duascreenaligner.Daemon';
const DBUS_PATH = '/com/github/duascreenaligner/Daemon';
const DBUS_IFACE = 'com.github.duascreenaligner.Daemon';

function _callDaemon(method, inSignature, outSignature, args) {
    const connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
    const parameters = new GLib.Variant(`(${inSignature})`, args);
    const replyType = outSignature ? new GLib.VariantType(`(${outSignature})`) : null;

    return connection.call_sync(
        DBUS_NAME,
        DBUS_PATH,
        DBUS_IFACE,
        method,
        parameters,
        replyType,
        Gio.DBusCallFlags.NONE,
        -1,
        null
    );
}

function _deepUnpackBoolean(result) {
    if (!result)
        return false;

    const unpacked = result.deepUnpack();
    return Array.isArray(unpacked) ? Boolean(unpacked[0]) : Boolean(unpacked);
}

export default class DuaScreenAlignerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._syncTimeoutId = 0;

        this._changedIds = [
            this._settings.connect('changed::monitor-layout', () => this._scheduleSync()),
            this._settings.connect('changed::enabled', () => this._scheduleSync()),
            this._settings.connect('changed::input-device', () => this._scheduleSync()),
        ];

        this._scheduleSync();
        log('[DuaScreen] Extension enabled and layout sync scheduled');
    }

    disable() {
        if (this._syncTimeoutId) {
            GLib.source_remove(this._syncTimeoutId);
            this._syncTimeoutId = 0;
        }

        if (this._settings && this._changedIds) {
            for (const id of this._changedIds)
                this._settings.disconnect(id);
        }

        this._changedIds = [];
        this._settings = null;
        log('[DuaScreen] Extension disabled');
    }

    _scheduleSync() {
        if (this._syncTimeoutId)
            return;

        this._syncTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._syncTimeoutId = 0;
            this._syncSettingsToDaemon();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncSettingsToDaemon() {
        if (!this._settings)
            return;

        const layoutJSON = this._settings.get_string('monitor-layout');
        const inputDevice = this._settings.get_string('input-device').trim();
        const enabled = this._settings.get_boolean('enabled');

        if (layoutJSON && layoutJSON.trim().length > 0) {
            try {
                const layout = JSON.parse(layoutJSON);
                if (inputDevice)
                    layout.device_path = inputDevice;

                const result = _callDaemon('SetLayout', 's', 'b', [JSON.stringify(layout)]);
                if (_deepUnpackBoolean(result))
                    log('[DuaScreen] Layout synced to daemon');
            } catch (error) {
                logError(error, '[DuaScreen] Failed to apply layout');
            }
        }

        try {
            _callDaemon('SetEnabled', 'b', 'b', [enabled]);
        } catch (error) {
            logError(error, '[DuaScreen] Failed to update enabled state');
        }
    }
}
