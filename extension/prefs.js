// prefs.js — Preferences window for DuaScreen Aligner.
// Provides a layout editor and preset helpers for common monitor arrangements.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

function _layoutJSON(monitors, devicePath = '') {
    return JSON.stringify({
        monitors,
        device_path: devicePath,
    }, null, 2);
}

function _portraitLeftMainCenterPreset() {
    return _layoutJSON([
        {
            name: 'Left Portrait',
            x: 0,
            y: 0,
            width_px: 1080,
            height_px: 1920,
            width_mm: 344,
            height_mm: 194,
        },
        {
            name: 'Main Center',
            x: 1080,
            y: 420,
            width_px: 1920,
            height_px: 1080,
            width_mm: 597,
            height_mm: 336,
        },
    ]);
}

function _horizontalPreset() {
    return _layoutJSON([
        {
            name: 'Left',
            x: 0,
            y: 0,
            width_px: 1920,
            height_px: 1080,
            width_mm: 527,
            height_mm: 296,
        },
        {
            name: 'Main',
            x: 1920,
            y: 0,
            width_px: 2560,
            height_px: 1440,
            width_mm: 597,
            height_mm: 336,
        },
    ]);
}

function _stackPreset() {
    return _layoutJSON([
        {
            name: 'Top',
            x: 0,
            y: 0,
            width_px: 2560,
            height_px: 1440,
            width_mm: 597,
            height_mm: 336,
        },
        {
            name: 'Bottom',
            x: 0,
            y: 1440,
            width_px: 1920,
            height_px: 1080,
            width_mm: 527,
            height_mm: 296,
        },
    ]);
}

function _parseXrandrOutput(output) {
    const monitors = [];
    const lineRegex = /^(\S+)\s+connected\s+(?:primary\s+)?(\d+)x(\d+)\+(\-?\d+)\+(\-?\d+)\s*(\w+)?\s*\(.*?\)\s+(\d+)mm\s+x\s+(\d+)mm/i;

    for (const line of output.split('\n')) {
        const match = line.match(lineRegex);
        if (!match)
            continue;

        const name = match[1];
        const widthPx = Number.parseInt(match[2], 10);
        const heightPx = Number.parseInt(match[3], 10);
        const x = Number.parseInt(match[4], 10);
        const y = Number.parseInt(match[5], 10);
        const rotation = match[6] || 'normal';
        let widthMM = Number.parseInt(match[7], 10);
        let heightMM = Number.parseInt(match[8], 10);

        if (rotation === 'left' || rotation === 'right') {
            const tmp = widthMM;
            widthMM = heightMM;
            heightMM = tmp;
        }

        monitors.push({
            name,
            x,
            y,
            width_px: widthPx,
            height_px: heightPx,
            width_mm: widthMM,
            height_mm: heightMM,
        });
    }

    return monitors;
}

function _detectLayoutFromXrandr(devicePath = '') {
    const [ok, stdout, stderr, waitStatus] = GLib.spawn_command_line_sync('xrandr --query');
    if (!ok || waitStatus !== 0) {
        const errorMsg = stderr ? new TextDecoder().decode(stderr).trim() : 'xrandr command failed';
        throw new Error(errorMsg || 'xrandr command failed');
    }

    const text = stdout ? new TextDecoder().decode(stdout) : '';
    const monitors = _parseXrandrOutput(text);
    if (monitors.length === 0)
        throw new Error('No connected monitors detected from xrandr');

    return _layoutJSON(monitors, devicePath);
}

export default class DuaScreenPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();

        window.set_default_size(860, 700);
        window.set_search_enabled(false);

        window.add(this._buildOverviewPage());
        window.add(this._buildLayoutPage());
    }

    _buildOverviewPage() {
        const page = new Adw.PreferencesPage({
            title: _('Overview'),
            icon_name: 'preferences-system-symbolic',
        });

        const summaryGroup = new Adw.PreferencesGroup({
            title: _('How it works'),
            description: _('Edit the monitor layout JSON, then save or apply it to the daemon.'),
        });
        summaryGroup.add(new Gtk.Label({
            label: _('Use the preset buttons for a portrait-left + center-main setup, or edit the JSON directly for any number of monitors.'),
            wrap: true,
            xalign: 0,
        }));
        page.add(summaryGroup);

        const settingsGroup = new Adw.PreferencesGroup({
            title: _('Settings'),
        });

        settingsGroup.add(this._makeSwitchRow(_('Enable correction'), _('Toggle DPI-aware cursor correction.'), 'enabled'));
        settingsGroup.add(this._makeSwitchRow(_('Start automatically'), _('Launch the daemon automatically on login.'), 'auto-start'));

        const inputRow = new Adw.ActionRow({
            title: _('Input device path'),
            subtitle: _('Leave empty to let the daemon auto-detect a mouse.'),
        });
        this._inputDeviceEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: '/dev/input/event5',
            text: this._settings.get_string('input-device'),
        });
        this._inputDeviceEntry.connect('changed', () => {
            this._settings.set_string('input-device', this._inputDeviceEntry.text.trim());
        });
        inputRow.add_suffix(this._inputDeviceEntry);
        settingsGroup.add(inputRow);

        page.add(settingsGroup);
        return page;
    }

    _buildLayoutPage() {
        const page = new Adw.PreferencesPage({
            title: _('Layout'),
            icon_name: 'view-grid-symbolic',
        });

        const editorGroup = new Adw.PreferencesGroup({
            title: _('Monitor layout JSON'),
            description: _('The daemon accepts any number of monitors. Each entry needs x, y, width_px, height_px, width_mm, and height_mm.'),
        });

        this._layoutBuffer = new Gtk.TextBuffer();
        const initialLayout = this._settings.get_string('monitor-layout');
        this._layoutBuffer.set_text(initialLayout || _portraitLeftMainCenterPreset(), -1);

        const layoutView = new Gtk.TextView({
            buffer: this._layoutBuffer,
            monospace: true,
            wrap_mode: Gtk.WrapMode.NONE,
            hexpand: true,
            vexpand: true,
        });

        const scrolled = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true,
            min_content_height: 320,
            child: layoutView,
        });
        editorGroup.add(scrolled);
        page.add(editorGroup);

        const actionGroup = new Adw.PreferencesGroup({
            title: _('Actions'),
        });

        actionGroup.add(this._makeButtonRow(_('Detect current monitors'), _('Read monitor geometry from xrandr and fill the editor.'), () => this._detectCurrentLayout()));
        actionGroup.add(this._makeButtonRow(_('Scenario preset'), _('Portrait left + main center'), () => this._setLayoutText(_portraitLeftMainCenterPreset())));
        actionGroup.add(this._makeButtonRow(_('Horizontal preset'), _('Two monitors side by side'), () => this._setLayoutText(_horizontalPreset())));
        actionGroup.add(this._makeButtonRow(_('Vertical stack preset'), _('Two monitors stacked top to bottom'), () => this._setLayoutText(_stackPreset())));
        actionGroup.add(this._makeButtonRow(_('Save layout'), _('Store the JSON in settings so it is reused on next launch.'), () => this._saveLayoutOnly()));
        actionGroup.add(this._makeButtonRow(_('Apply now'), _('Save the JSON and push it to the daemon immediately.'), () => this._saveAndApplyLayout()));

        page.add(actionGroup);

        this._statusLabel = new Gtk.Label({
            label: '',
            wrap: true,
            xalign: 0,
        });
        const statusGroup = new Adw.PreferencesGroup({
            title: _('Status'),
        });
        statusGroup.add(this._statusLabel);
        page.add(statusGroup);

        return page;
    }

    _makeSwitchRow(title, subtitle, key) {
        const row = new Adw.ActionRow({ title, subtitle });
        const toggle = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        this._settings.bind(key, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(toggle);
        row.activatable_widget = toggle;
        return row;
    }

    _makeButtonRow(title, subtitle, onClick) {
        const row = new Adw.ActionRow({ title, subtitle });
        const button = new Gtk.Button({ label: title });
        button.connect('clicked', () => onClick());
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }

    _setLayoutText(text) {
        this._layoutBuffer.set_text(text, -1);
        this._status(_('Preset loaded. Save or apply it to the daemon.'));
    }

    _detectCurrentLayout() {
        try {
            const inputDevice = this._settings.get_string('input-device').trim();
            const detected = _detectLayoutFromXrandr(inputDevice);
            this._layoutBuffer.set_text(detected, -1);
            this._status(_('Detected current monitor layout from xrandr. Save or apply it to the daemon.'));
        } catch (error) {
            this._status(_('Unable to detect layout: ') + error.message);
        }
    }

    _getLayoutText() {
        const startIter = this._layoutBuffer.get_start_iter();
        const endIter = this._layoutBuffer.get_end_iter();
        return this._layoutBuffer.get_text(startIter, endIter, false).trim();
    }

    _validateLayout(text) {
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.monitors) || parsed.monitors.length === 0)
            throw new Error('layout must include at least one monitor');

        return JSON.stringify(parsed, null, 2);
    }

    _saveLayoutOnly() {
        try {
            const normalized = this._normalizeLayoutPayload(this._getLayoutText());
            this._settings.set_string('monitor-layout', normalized);
            this._layoutBuffer.set_text(normalized, -1);
            this._status(_('Layout saved to settings.'));
        } catch (error) {
            this._status(_('Invalid JSON: ') + error.message);
        }
    }

    _saveAndApplyLayout() {
        try {
            const normalized = this._normalizeLayoutPayload(this._getLayoutText());
            this._settings.set_string('monitor-layout', normalized);
            this._layoutBuffer.set_text(normalized, -1);

            _callDaemon('SetLayout', 's', 'b', [normalized]);
            _callDaemon('SetEnabled', 'b', 'b', [this._settings.get_boolean('enabled')]);

            this._status(_('Layout applied to daemon.'));
        } catch (error) {
            this._status(_('Cannot apply layout: ') + error.message);
        }
    }

    _normalizeLayoutPayload(text) {
        const layout = JSON.parse(this._validateLayout(text));
        layout.device_path = this._settings.get_string('input-device').trim();
        return JSON.stringify(layout, null, 2);
    }

    _status(message) {
        if (this._statusLabel)
            this._statusLabel.label = message;
    }
}
