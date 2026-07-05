// extension.js — GNOME Shell extension entry point.
// Syncs settings to the daemon and provides an on-screen monitor editor.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

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

function _fallbackLayout() {
    return {
        monitors: [
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
        ],
    };
}

function _cloneLayout(layout) {
    return JSON.parse(JSON.stringify(layout));
}

function _monitorArea(monitor) {
    return Math.max(1, monitor.width_px) * Math.max(1, monitor.height_px);
}

function _normalizeToOrigin(layout) {
    if (!layout?.monitors?.length)
        return;

    let minX = layout.monitors[0].x;
    let minY = layout.monitors[0].y;
    for (const monitor of layout.monitors) {
        minX = Math.min(minX, monitor.x);
        minY = Math.min(minY, monitor.y);
    }

    for (const monitor of layout.monitors) {
        monitor.x -= minX;
        monitor.y -= minY;
    }
}

function _alignSideBySide(layout) {
    if (!layout?.monitors?.length)
        return;

    layout.monitors.sort((a, b) => a.x - b.x || a.y - b.y);
    let cursorX = 0;
    for (const monitor of layout.monitors) {
        monitor.x = cursorX;
        monitor.y = 0;
        cursorX += monitor.width_px;
    }
}

function _centerSecondaryVertically(layout) {
    if (!layout?.monitors || layout.monitors.length < 2)
        return;

    let mainIndex = 0;
    let bestArea = -1;
    for (let i = 0; i < layout.monitors.length; i++) {
        const area = _monitorArea(layout.monitors[i]);
        if (area > bestArea) {
            bestArea = area;
            mainIndex = i;
        }
    }

    const main = layout.monitors[mainIndex];
    for (let i = 0; i < layout.monitors.length; i++) {
        if (i === mainIndex)
            continue;
        layout.monitors[i].y = Math.round(main.y + (main.height_px - layout.monitors[i].height_px) / 2);
    }
    _normalizeToOrigin(layout);
}

function _smartPortraitLeft(layout) {
    if (!layout?.monitors || layout.monitors.length < 2)
        return false;

    let portraitIndex = 0;
    let portraitRatio = -1;
    let mainIndex = 0;
    let bestArea = -1;

    for (let i = 0; i < layout.monitors.length; i++) {
        const monitor = layout.monitors[i];
        const ratio = monitor.height_px / Math.max(1, monitor.width_px);
        if (ratio > portraitRatio) {
            portraitRatio = ratio;
            portraitIndex = i;
        }

        const area = _monitorArea(monitor);
        if (area > bestArea) {
            bestArea = area;
            mainIndex = i;
        }
    }

    if (portraitIndex === mainIndex) {
        portraitIndex = mainIndex === 0 ? 1 : 0;
    }

    const portrait = layout.monitors[portraitIndex];
    const main = layout.monitors[mainIndex];
    portrait.x = 0;
    portrait.y = 0;
    main.x = portrait.width_px;
    main.y = Math.round((portrait.height_px - main.height_px) / 2);

    let cursorX = main.x + main.width_px;
    for (let i = 0; i < layout.monitors.length; i++) {
        if (i === portraitIndex || i === mainIndex)
            continue;
        const monitor = layout.monitors[i];
        monitor.x = cursorX;
        monitor.y = main.y + Math.round((main.height_px - monitor.height_px) / 2);
        cursorX += monitor.width_px;
    }

    _normalizeToOrigin(layout);
    return true;
}

export default class DuaScreenAlignerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._syncTimeoutId = 0;
        this._overlay = null;
        this._selectedMonitorIndex = 0;
        this._overlayRequestValue = this._settings.get_int('open-overlay-request');

        this._changedIds = [
            this._settings.connect('changed::monitor-layout', () => this._scheduleSync()),
            this._settings.connect('changed::enabled', () => this._scheduleSync()),
            this._settings.connect('changed::input-device', () => this._scheduleSync()),
            this._settings.connect('changed::open-overlay-request', () => this._handleOverlayRequest()),
        ];

        this._createIndicator();
        this._scheduleSync();
        log('[DuaScreen] Extension enabled and layout sync scheduled');
    }

    disable() {
        this._closeOverlay();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

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

    _createIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'DuaScreen Aligner', false);
        const icon = new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon dua-panel-icon',
        });
        this._indicator.add_child(icon);
        this._indicator.menu.addAction('Open screen editor', () => this._openOverlay());
        this._indicator.menu.addAction('Apply saved layout', () => this._syncSettingsToDaemon());
        this._indicator.menu.addAction('Toggle correction', () => {
            this._settings.set_boolean('enabled', !this._settings.get_boolean('enabled'));
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    _handleOverlayRequest() {
        const value = this._settings.get_int('open-overlay-request');
        if (value === this._overlayRequestValue)
            return;
        this._overlayRequestValue = value;
        this._openOverlay();
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

    _loadLayout() {
        const text = this._settings.get_string('monitor-layout');
        if (!text || text.trim().length === 0)
            return _fallbackLayout();

        try {
            const layout = JSON.parse(text);
            if (!Array.isArray(layout.monitors) || layout.monitors.length === 0)
                return _fallbackLayout();
            return layout;
        } catch (error) {
            logError(error, '[DuaScreen] Failed to parse saved layout for overlay');
            return _fallbackLayout();
        }
    }

    _saveOverlayLayout(applyNow = false) {
        if (!this._overlayLayout)
            return;

        const layout = _cloneLayout(this._overlayLayout);
        layout.device_path = this._settings.get_string('input-device').trim();
        this._settings.set_string('monitor-layout', JSON.stringify(layout, null, 2));
        this._setOverlayStatus(applyNow ? 'Saved and applied layout.' : 'Saved layout.');
        if (applyNow)
            this._syncSettingsToDaemon();
    }

    _openOverlay() {
        if (this._overlay) {
            this._closeOverlay();
            return;
        }

        this._overlayLayout = _cloneLayout(this._loadLayout());
        if (this._selectedMonitorIndex >= this._overlayLayout.monitors.length)
            this._selectedMonitorIndex = 0;

        const monitor = Main.layoutManager.primaryMonitor;
        this._overlay = new St.Widget({
            style_class: 'dua-editor-overlay',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        this._overlay.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closeOverlay();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        Main.layoutManager.uiGroup.add_child(this._overlay);
        global.stage.set_key_focus(this._overlay);
        this._buildOverlayChrome(monitor.width, monitor.height);
        this._refreshOverlayMap();
        this._setOverlayStatus('Screen editor open. Select a monitor, then move or auto-align it.');
    }

    _closeOverlay() {
        if (!this._overlay)
            return;

        this._overlay.destroy();
        this._overlay = null;
        this._mapLayer = null;
        this._overlayStatusLabel = null;
    }

    _button(label, callback, styleClass = 'dua-tool-button') {
        const button = new St.Button({
            label,
            style_class: styleClass,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        button.connect('clicked', callback);
        return button;
    }

    _buildOverlayChrome(width, height) {
        const header = new St.BoxLayout({ style_class: 'dua-editor-header' });
        header.set_position(18, 14);
        header.set_size(width - 36, 54);
        header.add_child(new St.Label({
            text: 'DuaScreen Aligner',
            style_class: 'dua-editor-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const spacer = new St.Widget({ x_expand: true });
        header.add_child(spacer);
        header.add_child(this._button('Save', () => this._saveOverlayLayout(false)));
        header.add_child(this._button('Apply', () => this._saveOverlayLayout(true), 'dua-tool-button dua-primary-button'));
        header.add_child(this._button('Close', () => this._closeOverlay()));
        this._overlay.add_child(header);

        const left = new St.BoxLayout({ vertical: true, style_class: 'dua-edge-panel' });
        left.set_position(18, 86);
        left.set_size(214, Math.max(260, height - 172));
        left.add_child(new St.Label({ text: 'Auto align', style_class: 'dua-panel-heading' }));
        left.add_child(this._button('Detect in Preferences', () => this._setOverlayStatus('Use Preferences > Detect monitors when xrandr geometry needs refreshing.')));
        left.add_child(this._button('Side by side', () => {
            _alignSideBySide(this._overlayLayout);
            this._refreshOverlayMap();
            this._setOverlayStatus('Auto-aligned monitors side by side.');
        }));
        left.add_child(this._button('Portrait + main', () => {
            if (_smartPortraitLeft(this._overlayLayout)) {
                this._refreshOverlayMap();
                this._setOverlayStatus('Placed portrait screen on the left and centered the main screen.');
            }
        }));
        left.add_child(this._button('Center heights', () => {
            _centerSecondaryVertically(this._overlayLayout);
            this._refreshOverlayMap();
            this._setOverlayStatus('Centered secondary monitors vertically.');
        }));
        this._overlay.add_child(left);

        const right = new St.BoxLayout({ vertical: true, style_class: 'dua-edge-panel' });
        right.set_position(Math.max(250, width - 248), 86);
        right.set_size(230, Math.max(260, height - 172));
        right.add_child(new St.Label({ text: 'Manual move', style_class: 'dua-panel-heading' }));
        this._selectedLabel = new St.Label({ text: '', style_class: 'dua-selected-label' });
        right.add_child(this._selectedLabel);
        right.add_child(this._button('Up', () => this._nudgeSelected(0, -10)));
        const row = new St.BoxLayout({ style_class: 'dua-nudge-row' });
        row.add_child(this._button('Left', () => this._nudgeSelected(-10, 0)));
        row.add_child(this._button('Right', () => this._nudgeSelected(10, 0)));
        right.add_child(row);
        right.add_child(this._button('Down', () => this._nudgeSelected(0, 10)));
        right.add_child(this._button('Snap to origin', () => {
            _normalizeToOrigin(this._overlayLayout);
            this._refreshOverlayMap();
            this._setOverlayStatus('Normalized layout to top-left origin.');
        }));
        this._overlay.add_child(right);

        this._mapLayer = new St.Widget({ style_class: 'dua-map-surface', reactive: true });
        this._mapLayer.set_position(250, 86);
        this._mapLayer.set_size(Math.max(320, width - 516), Math.max(260, height - 172));
        this._overlay.add_child(this._mapLayer);

        const footer = new St.BoxLayout({ style_class: 'dua-editor-footer' });
        footer.set_position(18, Math.max(150, height - 72));
        footer.set_size(width - 36, 54);
        this._overlayStatusLabel = new St.Label({
            text: '',
            style_class: 'dua-status-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        footer.add_child(this._overlayStatusLabel);
        this._overlay.add_child(footer);
    }

    _layoutBounds(monitors) {
        let minX = monitors[0].x;
        let minY = monitors[0].y;
        let maxX = monitors[0].x + monitors[0].width_px;
        let maxY = monitors[0].y + monitors[0].height_px;
        for (const monitor of monitors) {
            minX = Math.min(minX, monitor.x);
            minY = Math.min(minY, monitor.y);
            maxX = Math.max(maxX, monitor.x + monitor.width_px);
            maxY = Math.max(maxY, monitor.y + monitor.height_px);
        }
        return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
    }

    _refreshOverlayMap() {
        if (!this._mapLayer || !this._overlayLayout?.monitors?.length)
            return;

        this._mapLayer.destroy_all_children();
        const monitors = this._overlayLayout.monitors;
        const bounds = this._layoutBounds(monitors);
        const [mapWidth, mapHeight] = this._mapLayer.get_size();
        const padding = 26;
        const scale = Math.min((mapWidth - padding * 2) / bounds.width, (mapHeight - padding * 2) / bounds.height);
        const contentWidth = bounds.width * scale;
        const contentHeight = bounds.height * scale;
        const offsetX = Math.max(padding, (mapWidth - contentWidth) / 2);
        const offsetY = Math.max(padding, (mapHeight - contentHeight) / 2);

        for (let i = 0; i < monitors.length; i++) {
            const monitor = monitors[i];
            const actor = new St.Button({
                label: `${i + 1}. ${monitor.name}\n${monitor.width_px}x${monitor.height_px}\nx ${monitor.x}, y ${monitor.y}`,
                style_class: i === this._selectedMonitorIndex ? 'dua-monitor-card dua-monitor-selected' : 'dua-monitor-card',
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            actor.set_position(
                offsetX + (monitor.x - bounds.minX) * scale,
                offsetY + (monitor.y - bounds.minY) * scale
            );
            actor.set_size(Math.max(110, monitor.width_px * scale), Math.max(70, monitor.height_px * scale));
            actor.connect('clicked', () => {
                this._selectedMonitorIndex = i;
                this._refreshOverlayMap();
                this._setOverlayStatus(`Selected ${monitor.name}.`);
            });
            this._mapLayer.add_child(actor);
        }

        this._refreshSelectedLabel();
    }

    _refreshSelectedLabel() {
        if (!this._selectedLabel || !this._overlayLayout?.monitors?.length)
            return;

        const monitor = this._overlayLayout.monitors[this._selectedMonitorIndex] || this._overlayLayout.monitors[0];
        this._selectedLabel.text = `${monitor.name}\nX ${monitor.x}  Y ${monitor.y}\n${monitor.width_px}x${monitor.height_px}`;
    }

    _nudgeSelected(dx, dy) {
        if (!this._overlayLayout?.monitors?.length)
            return;

        const monitor = this._overlayLayout.monitors[this._selectedMonitorIndex] || this._overlayLayout.monitors[0];
        monitor.x += dx;
        monitor.y += dy;
        this._refreshOverlayMap();
        this._setOverlayStatus(`Moved ${monitor.name} to x ${monitor.x}, y ${monitor.y}.`);
    }

    _setOverlayStatus(text) {
        if (this._overlayStatusLabel)
            this._overlayStatusLabel.text = text;
    }
}
