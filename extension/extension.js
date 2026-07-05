// extension.js — GNOME Shell extension entry point.
// Syncs settings to the daemon and provides an on-screen monitor editor.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { getCurrentState, logicalSize, applyPositions, APPLY_PERSISTENT } from './displayConfig.js';

const DBUS_NAME = 'com.github.duascreenaligner.Daemon';
const DBUS_PATH = '/com/github/duascreenaligner/Daemon';
const DBUS_IFACE = 'com.github.duascreenaligner.Daemon';

const BUILTIN_IMAGES = {
    panorama: 'assets/fit-test-panorama.png',
    city: 'assets/fit-test-city.png',
    'desert-coast': 'assets/fit-test-desert-coast.png',
};

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

function _parseXrandrOutput(output) {
    const monitors = [];
    const lineRegex = /^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(\-?\d+)\+(\-?\d+)\s*(\w+)?\s*\(.*?\)\s+(\d+)mm\s+x\s+(\d+)mm/i;

    for (const line of output.split('\n')) {
        const match = line.match(lineRegex);
        if (!match)
            continue;

        let widthMM = Number.parseInt(match[8], 10);
        let heightMM = Number.parseInt(match[9], 10);
        const rotation = match[7] || 'normal';
        if (rotation === 'left' || rotation === 'right') {
            const tmp = widthMM;
            widthMM = heightMM;
            heightMM = tmp;
        }

        monitors.push({
            name: match[1],
            primary: Boolean(match[2]),
            width_px: Number.parseInt(match[3], 10),
            height_px: Number.parseInt(match[4], 10),
            x: Number.parseInt(match[5], 10),
            y: Number.parseInt(match[6], 10),
            width_mm: widthMM,
            height_mm: heightMM,
        });
    }

    monitors.sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)) || a.x - b.x || a.y - b.y);
    return monitors;
}

function _parseXrandrMM(output) {
    const mmMap = {};
    const re = /^(\S+)\s+connected\s+(?:primary\s+)?\d+x\d+\+\-?\d+\+\-?\d+\s*(?:\w+\s*)?(?:\(.*?\)\s+)?(\d+)mm\s+x\s+(\d+)mm/i;
    for (const line of output.split('\n')) {
        const match = line.match(re);
        if (match)
            mmMap[match[1]] = { width_mm: Number(match[2]), height_mm: Number(match[3]) };
    }
    return mmMap;
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

    return { monitors, device_path: devicePath };
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

function _mainMonitorIndex(layout) {
    let mainIndex = 0;
    let bestArea = -1;
    for (let i = 0; i < (layout?.monitors?.length || 0); i++) {
        const area = _monitorArea(layout.monitors[i]);
        if (area > bestArea) {
            bestArea = area;
            mainIndex = i;
        }
    }
    return mainIndex;
}

function _smartPortraitRight(layout) {
    if (!_smartPortraitLeft(layout))
        return false;

    const mainIndex = _mainMonitorIndex(layout);
    const main = layout.monitors[mainIndex];
    const left = layout.monitors.find((monitor, index) => index !== mainIndex && monitor.x === 0) || layout.monitors[0];
    left.x = main.width_px;
    main.x = 0;
    _normalizeToOrigin(layout);
    return true;
}

function _stackVertical(layout) {
    if (!layout?.monitors?.length)
        return;

    const monitors = layout.monitors.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const widest = Math.max(...monitors.map(monitor => monitor.width_px));
    let cursorY = 0;
    for (const monitor of monitors) {
        monitor.x = Math.round((widest - monitor.width_px) / 2);
        monitor.y = cursorY;
        cursorY += monitor.height_px;
    }
    _normalizeToOrigin(layout);
}

function _mainTop(layout) {
    if (!layout?.monitors?.length)
        return;

    const mainIndex = _mainMonitorIndex(layout);
    const main = layout.monitors[mainIndex];
    const others = layout.monitors.filter((monitor, index) => index !== mainIndex)
        .sort((a, b) => a.x - b.x || a.y - b.y);
    main.x = 0;
    main.y = 0;
    let cursorY = main.height_px;
    for (const monitor of others) {
        monitor.x = Math.round((main.width_px - monitor.width_px) / 2);
        monitor.y = cursorY;
        cursorY += monitor.height_px;
    }
    _normalizeToOrigin(layout);
}

function _mainBottom(layout) {
    if (!layout?.monitors || layout.monitors.length < 2) {
        _stackVertical(layout);
        return;
    }

    const mainIndex = _mainMonitorIndex(layout);
    const main = layout.monitors[mainIndex];
    const others = layout.monitors.filter((monitor, index) => index !== mainIndex);
    let cursorY = 0;
    for (const monitor of others) {
        monitor.x = Math.round((main.width_px - monitor.width_px) / 2);
        monitor.y = cursorY;
        cursorY += monitor.height_px;
    }
    main.x = 0;
    main.y = cursorY;
    _normalizeToOrigin(layout);
}

function _gridLayout(layout) {
    if (!layout?.monitors?.length)
        return;

    const monitors = layout.monitors.slice().sort((a, b) => _monitorArea(b) - _monitorArea(a));
    const columns = Math.ceil(Math.sqrt(monitors.length));
    const cellWidth = Math.max(...monitors.map(monitor => monitor.width_px));
    const cellHeight = Math.max(...monitors.map(monitor => monitor.height_px));
    for (let i = 0; i < monitors.length; i++) {
        const column = i % columns;
        const row = Math.floor(i / columns);
        monitors[i].x = column * cellWidth + Math.round((cellWidth - monitors[i].width_px) / 2);
        monitors[i].y = row * cellHeight + Math.round((cellHeight - monitors[i].height_px) / 2);
    }
    _normalizeToOrigin(layout);
}

function _applyRecommendedPreset(layout) {
    if (!layout?.monitors?.length)
        return 'No monitors available.';
    if (layout.monitors.length === 1) {
        _normalizeToOrigin(layout);
        return 'Single monitor normalized.';
    }

    const portraitCount = layout.monitors.filter(monitor => monitor.height_px > monitor.width_px * 1.15).length;
    const landscapeCount = layout.monitors.length - portraitCount;
    if (portraitCount > 0 && landscapeCount > 0) {
        _smartPortraitLeft(layout);
        return 'Recommended portrait-left layout for mixed portrait and landscape screens.';
    }
    if (layout.monitors.length >= 4) {
        _gridLayout(layout);
        return 'Recommended grid layout for four or more screens.';
    }
    _alignSideBySide(layout);
    _centerSecondaryVertically(layout);
    return 'Recommended centered side-by-side layout.';
}

export default class DuaScreenAlignerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._syncTimeoutId = 0;
        this._overlay = null;
        this._selectedMonitorIndex = 0;
        this._dragState = null;
        this._overlayRequestValue = this._settings.get_int('open-overlay-request');

        this._changedIds = [
            this._settings.connect('changed::monitor-layout', () => this._scheduleSync()),
            this._settings.connect('changed::enabled', () => this._scheduleSync()),
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
        const enabled = this._settings.get_boolean('enabled');

        if (layoutJSON && layoutJSON.trim().length > 0) {
            try {
                const layout = JSON.parse(layoutJSON);
                layout.device_path = '';

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
        layout.device_path = '';
        this._settings.set_string('monitor-layout', JSON.stringify(layout, null, 2));
        this._setOverlayStatus(applyNow ? 'Saved and applied layout.' : 'Saved layout.');
        if (applyNow)
            this._syncSettingsToDaemon();
    }

    _desktopBounds() {
        const monitors = Main.layoutManager.monitors?.length ? Main.layoutManager.monitors : [Main.layoutManager.primaryMonitor];
        let minX = monitors[0].x;
        let minY = monitors[0].y;
        let maxX = monitors[0].x + monitors[0].width;
        let maxY = monitors[0].y + monitors[0].height;

        for (const monitor of monitors) {
            minX = Math.min(minX, monitor.x);
            minY = Math.min(minY, monitor.y);
            maxX = Math.max(maxX, monitor.x + monitor.width);
            maxY = Math.max(maxY, monitor.y + monitor.height);
        }

        return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
    }

    _openOverlay() {
        if (this._overlay) {
            global.stage.set_key_focus(this._overlay);
            this._setOverlayStatus('Screen editor is already open.');
            return;
        }

        this._overlayLayout = _cloneLayout(this._loadLayout());
        if (this._selectedMonitorIndex >= this._overlayLayout.monitors.length)
            this._selectedMonitorIndex = 0;

        const monitor = this._desktopBounds();
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
        this._overlay.connect('motion-event', (actor, event) => this._updateMonitorDrag(event));
        this._overlay.connect('button-release-event', (actor, event) => this._finishMonitorDrag(event));

        Main.layoutManager.uiGroup.add_child(this._overlay);
        try {
            this._modalToken = Main.pushModal(this._overlay);
        } catch (error) {
            logError(error, '[DuaScreen] Failed to make screen editor modal');
            this._modalToken = null;
        }
        global.stage.set_key_focus(this._overlay);
        this._buildOverlayChrome(monitor.width, monitor.height);
        this._refreshOverlayMap();
        this._setOverlayStatus('Screen editor open. Select a monitor, then move or auto-align it.');
    }

    _closeOverlay() {
        if (!this._overlay)
            return;

        if (this._modalToken !== undefined) {
            try {
                Main.popModal(this._modalToken ?? this._overlay);
            } catch (error) {
                try {
                    Main.popModal(this._overlay);
                } catch (fallbackError) {
                    logError(fallbackError, '[DuaScreen] Failed to release screen editor modal grab');
                }
            }
            this._modalToken = undefined;
        }

        this._overlay.destroy();
        this._overlay = null;
        this._mapLayer = null;
        this._monitorActors = null;
        this._dragState = null;
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
        left.set_size(226, Math.max(260, height - 172));
        left.add_child(new St.Label({ text: 'Fix mouse crossing', style_class: 'dua-panel-heading' }));
        left.add_child(new St.Label({ text: 'Line up screens so the cursor crosses at the same height.', style_class: 'dua-panel-hint' }));
        left.add_child(this._button('Align tops', () => this._applyAnchorAlignment('tops')));
        left.add_child(this._button('Align centers', () => this._applyAnchorAlignment('centers'), 'dua-tool-button dua-primary-button'));
        left.add_child(this._button('Align bottoms', () => this._applyAnchorAlignment('bottoms')));
        left.add_child(new St.Label({ text: 'Presets', style_class: 'dua-panel-heading' }));
        left.add_child(this._button('Recommended', () => this._applyPreset('recommended')));
        left.add_child(this._button('Match GNOME', () => this._applyPreset('detect')));
        left.add_child(this._button('Side by side', () => this._applyPreset('side-by-side')));
        left.add_child(this._button('Stack', () => this._applyPreset('stack')));
        left.add_child(this._button('Portrait left', () => this._applyPreset('portrait-left')));
        left.add_child(this._button('Portrait right', () => this._applyPreset('portrait-right')));
        left.add_child(this._button('Main top', () => this._applyPreset('main-top')));
        left.add_child(this._button('Main bottom', () => this._applyPreset('main-bottom')));
        left.add_child(this._button('Grid', () => this._applyPreset('grid')));
        this._overlay.add_child(left);

        const right = new St.BoxLayout({ vertical: true, style_class: 'dua-edge-panel' });
        right.set_position(Math.max(260, width - 270), 86);
        right.set_size(252, Math.max(260, height - 172));
        right.add_child(new St.Label({ text: 'Selected screen', style_class: 'dua-panel-heading' }));
        this._selectedLabel = new St.Label({ text: '', style_class: 'dua-selected-label' });
        right.add_child(this._selectedLabel);
        right.add_child(new St.Label({ text: 'Image split', style_class: 'dua-panel-heading' }));
        right.add_child(this._button('Global image', () => this._setCropMode('global')));
        right.add_child(this._button('Edit selected crop', () => this._setCropMode('per-monitor'), 'dua-tool-button dua-primary-button'));
        const zoomRow = new St.BoxLayout({ style_class: 'dua-nudge-row' });
        zoomRow.add_child(this._button('Zoom -', () => this._adjustSelectedCrop(0, 0, -0.08)));
        zoomRow.add_child(this._button('Zoom +', () => this._adjustSelectedCrop(0, 0, 0.08)));
        right.add_child(zoomRow);
        right.add_child(this._button('Image up', () => this._adjustSelectedCrop(0, -24, 0)));
        const imageRow = new St.BoxLayout({ style_class: 'dua-nudge-row' });
        imageRow.add_child(this._button('Image left', () => this._adjustSelectedCrop(-24, 0, 0)));
        imageRow.add_child(this._button('Image right', () => this._adjustSelectedCrop(24, 0, 0)));
        right.add_child(imageRow);
        right.add_child(this._button('Image down', () => this._adjustSelectedCrop(0, 24, 0)));
        right.add_child(this._button('Reset selected crop', () => this._resetSelectedCrop()));
        right.add_child(this._button('Snap monitors to origin', () => {
            _normalizeToOrigin(this._overlayLayout);
            this._refreshOverlayMap();
            this._setOverlayStatus('Normalized monitor layout to top-left origin.');
        }));
        this._overlay.add_child(right);

        this._mapLayer = new St.Widget({ style_class: 'dua-map-surface', reactive: true });
        this._mapLayer.set_position(262, 86);
        this._mapLayer.set_size(Math.max(320, width - 550), Math.max(260, height - 172));
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
        this._monitorActors = [];
        const monitors = this._overlayLayout.monitors;
        const bounds = this._layoutBounds(monitors);
        const [mapWidth, mapHeight] = this._mapLayer.get_size();
        const padding = 28;
        const scale = Math.min((mapWidth - padding * 2) / bounds.width, (mapHeight - padding * 2) / bounds.height);
        const contentWidth = bounds.width * scale;
        const contentHeight = bounds.height * scale;
        const offsetX = Math.max(padding, (mapWidth - contentWidth) / 2);
        const offsetY = Math.max(padding, (mapHeight - contentHeight) / 2);
        this._mapTransform = { scale, offsetX, offsetY, bounds };
        this._applyMapWallpaperStyle();

        for (let i = 0; i < monitors.length; i++) {
            const monitor = monitors[i];
            const actor = new St.Widget({
                style_class: i === this._selectedMonitorIndex ? 'dua-monitor-card dua-monitor-selected' : 'dua-monitor-card',
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            const actorX = offsetX + (monitor.x - bounds.minX) * scale;
            const actorY = offsetY + (monitor.y - bounds.minY) * scale;
            const actorWidth = Math.max(110, monitor.width_px * scale);
            const actorHeight = Math.max(70, monitor.height_px * scale);
            actor.set_position(actorX, actorY);
            actor.set_size(actorWidth, actorHeight);
            actor.style = this._monitorWallpaperStyle(monitor, actorWidth, actorHeight);
            const label = new St.Label({
                text: this._monitorCardText(i, monitor),
                style_class: 'dua-monitor-label',
            });
            actor.add_child(label);
            actor.connect('button-press-event', (button, event) => this._beginMonitorDrag(i, event));
            actor.connect('motion-event', (button, event) => this._updateMonitorDrag(event));
            actor.connect('button-release-event', (button, event) => this._finishMonitorDrag(event));
            this._monitorActors.push({ actor, label });
            this._mapLayer.add_child(actor);
        }

        this._refreshSelectedLabel();
    }

    _monitorCardText(index, monitor) {
        return `${index + 1}. ${monitor.name}\n${monitor.width_px}x${monitor.height_px}\nx ${monitor.x}, y ${monitor.y}`;
    }


    _selectedImagePath() {
        const source = this._settings.get_string('image-source') || 'panorama';
        const localPath = this._settings.get_string('image-local-path');
        if (source === 'local' && localPath)
            return localPath;

        return `${this.path}/${BUILTIN_IMAGES[source] || BUILTIN_IMAGES.panorama}`;
    }

    _selectedImageUri() {
        try {
            return GLib.filename_to_uri(this._selectedImagePath(), null);
        } catch (error) {
            logError(error, '[DuaScreen] Failed to build image URI for overlay preview');
            return '';
        }
    }

    _applyMapWallpaperStyle() {
        const uri = this._selectedImageUri();
        const fit = this._settings.get_string('image-fit-mode') || 'cover';
        let size = 'cover';
        if (fit === 'contain')
            size = 'contain';
        else if (fit === 'stretch')
            size = '100% 100%';

        this._mapLayer.style = `background-color: rgba(0, 0, 0, 0.28); background-image: url("${uri}"); background-size: ${size}; background-repeat: no-repeat; background-position: center;`;
    }

    _imageNaturalSize() {
        const path = this._selectedImagePath();
        if (this._imageSizeCache && this._imageSizeCache.path === path)
            return this._imageSizeCache;

        let width = 16;
        let height = 9;
        try {
            const [format, w, h] = GdkPixbuf.Pixbuf.get_file_info(path);
            if (format && w > 0 && h > 0) {
                width = w;
                height = h;
            }
        } catch (error) {
            logError(error, '[DuaScreen] Failed to read image dimensions for crop preview');
        }

        this._imageSizeCache = { path, width, height };
        return this._imageSizeCache;
    }

    _monitorWallpaperStyle(monitor, cardWidth, cardHeight) {
        if ((this._settings.get_string('image-crop-mode') || 'global') !== 'per-monitor')
            return '';

        const uri = this._selectedImageUri();
        if (!uri)
            return '';

        const crops = this._loadImageCrops();
        const key = monitor.name || `${monitor.width_px}x${monitor.height_px}`;
        const crop = crops[key] || { x: 0, y: 0, scale: 1 };
        const zoom = Math.max(0.3, Math.min(4, Number(crop.scale) || 1));
        const image = this._imageNaturalSize();
        const cover = Math.max(cardWidth / image.width, cardHeight / image.height);
        const drawScale = cover * zoom;
        const drawWidth = image.width * drawScale;
        const drawHeight = image.height * drawScale;
        const factorX = cardWidth / Math.max(1, monitor.width_px);
        const factorY = cardHeight / Math.max(1, monitor.height_px);
        const posX = Math.round((cardWidth - drawWidth) / 2 + (Number(crop.x) || 0) * factorX);
        const posY = Math.round((cardHeight - drawHeight) / 2 + (Number(crop.y) || 0) * factorY);
        return `background-image: url("${uri}"); background-size: ${Math.round(drawWidth)}px ${Math.round(drawHeight)}px; background-position: ${posX}px ${posY}px; background-repeat: no-repeat; background-color: rgba(24, 30, 36, 0.48);`;
    }


    _applyAnchorAlignment(anchor) {
        let state;
        try {
            state = getCurrentState();
        } catch (error) {
            this._setOverlayStatus(`Cannot read display config: ${error.message}`);
            return;
        }

        if (state.logical.length < 2) {
            this._setOverlayStatus('Only one monitor — nothing to align.');
            return;
        }

        const entries = state.logical.map(entry => {
            const mode = state.modeByConnector[entry.connectors[0]];
            const size = logicalSize(mode, entry.transform);
            return {
                entry,
                mode,
                width: size.width,
                height: size.height,
            };
        });
        const sorted = [...entries].sort((a, b) => a.entry.x - b.entry.x || a.entry.y - b.entry.y);
        const ref = sorted[0];

        if (anchor === 'centers') {
            const refCenter = ref.entry.y + ref.height / 2;
            for (const screen of sorted) {
                const newY = Math.round(refCenter - screen.height / 2);
                screen.newY = newY;
            }
        } else {
            const refEdge = anchor === 'bottoms'
                ? ref.entry.y + ref.height
                : ref.entry.y;
            for (const screen of sorted) {
                const newY = anchor === 'bottoms'
                    ? Math.round(refEdge - screen.height)
                    : refEdge;
                screen.newY = newY;
            }
        }

        const positions = {};
        for (const screen of sorted)
            positions[screen.entry.connectors[0]] = { x: screen.entry.x, y: screen.newY };

        try {
            applyPositions(state, positions, APPLY_PERSISTENT);
        } catch (error) {
            this._setOverlayStatus(`Failed to apply: ${error.message}`);
            return;
        }

        this._settings.set_string('wallpaper-anchor', anchor);
        this._overlayLayout = this._reloadLayoutFromXrandr(state, sorted, positions);
        this._selectedMonitorIndex = 0;
        this._refreshOverlayMap();
        this._setOverlayStatus(`Applied ${anchor} alignment. Save to keep.`);
    }

    // Build a fresh overlay-layout payload from the known Mutter state + xrandr
    // mm data so the overlay stays in sync after applying real offsets.
    _reloadLayoutFromXrandr(state, logicalEntries, positionsByConnector) {
        let mmMap = {};
        try {
            const [ok, stdout] = GLib.spawn_command_line_sync('xrandr --query');
            if (ok && stdout) {
                const text = new TextDecoder().decode(stdout);
                mmMap = _parseXrandrMM(text);
            }
        } catch (e) {
            // ok: no mm data, DPI defaults to 96.
        }

        const monitors = logicalEntries.map((screen, i) => {
            const pos = positionsByConnector[screen.entry.connectors[0]] || screen.entry;
            const mm = mmMap[screen.entry.connectors[0]] || { width_mm: 0, height_mm: 0 };
            return {
                name: screen.entry.connectors[0],
                primary: Boolean(screen.entry.primary),
                width_px: screen.width,
                height_px: screen.height,
                x: Math.round(pos.x),
                y: Math.round(pos.y),
                width_mm: mm.width_mm,
                height_mm: mm.height_mm,
            };
        });

        return { monitors, device_path: '' };
    }

    _applyPreset(name) {
        try {
            if (name === 'detect') {
                this._overlayLayout = _detectLayoutFromXrandr();
                this._selectedMonitorIndex = 0;
                this._refreshOverlayMap();
                this._setOverlayStatus('Matched the current GNOME monitor geometry.');
                return;
            }

            if (name === 'recommended')
                this._setOverlayStatus(_applyRecommendedPreset(this._overlayLayout));
            else if (name === 'side-by-side') {
                _alignSideBySide(this._overlayLayout);
                _centerSecondaryVertically(this._overlayLayout);
                this._setOverlayStatus('Applied side-by-side preset.');
            } else if (name === 'stack') {
                _stackVertical(this._overlayLayout);
                this._setOverlayStatus('Applied stacked preset.');
            } else if (name === 'portrait-left') {
                _smartPortraitLeft(this._overlayLayout);
                this._setOverlayStatus('Applied portrait-left preset.');
            } else if (name === 'portrait-right') {
                _smartPortraitRight(this._overlayLayout);
                this._setOverlayStatus('Applied portrait-right preset.');
            } else if (name === 'main-top') {
                _mainTop(this._overlayLayout);
                this._setOverlayStatus('Applied main-top preset.');
            } else if (name === 'main-bottom') {
                _mainBottom(this._overlayLayout);
                this._setOverlayStatus('Applied main-bottom preset.');
            } else if (name === 'grid') {
                _gridLayout(this._overlayLayout);
                this._setOverlayStatus('Applied grid preset.');
            }
            this._refreshOverlayMap();
        } catch (error) {
            this._setOverlayStatus(`Preset failed: ${error.message}`);
        }
    }

    _eventCoords(event) {
        const coords = event.get_coords();
        return { x: coords[0], y: coords[1] };
    }

    _beginMonitorDrag(index, event) {
        if (!this._mapTransform)
            return Clutter.EVENT_PROPAGATE;

        const coords = this._eventCoords(event);
        const monitor = this._overlayLayout.monitors[index];
        const wasSelected = this._selectedMonitorIndex === index;
        this._selectedMonitorIndex = index;
        this._dragState = {
            index,
            startStageX: coords.x,
            startStageY: coords.y,
            startX: monitor.x,
            startY: monitor.y,
        };
        if (!wasSelected)
            this._refreshOverlayMap();
        this._refreshSelectedLabel();
        this._setOverlayStatus(`Dragging ${monitor.name}. Release to keep the new position.`);
        return Clutter.EVENT_STOP;
    }

    _updateMonitorDrag(event) {
        if (!this._dragState || !this._mapTransform)
            return Clutter.EVENT_PROPAGATE;

        const coords = this._eventCoords(event);
        const { scale, offsetX, offsetY, bounds } = this._mapTransform;
        const monitor = this._overlayLayout.monitors[this._dragState.index];
        monitor.x = Math.round(this._dragState.startX + (coords.x - this._dragState.startStageX) / scale);
        monitor.y = Math.round(this._dragState.startY + (coords.y - this._dragState.startStageY) / scale);

        const entry = this._monitorActors?.[this._dragState.index];
        if (entry) {
            entry.actor.set_position(
                offsetX + (monitor.x - bounds.minX) * scale,
                offsetY + (monitor.y - bounds.minY) * scale
            );
            entry.label.text = this._monitorCardText(this._dragState.index, monitor);
        }
        this._refreshSelectedLabel();
        return Clutter.EVENT_STOP;
    }

    _finishMonitorDrag(event) {
        if (!this._dragState)
            return Clutter.EVENT_PROPAGATE;

        const monitor = this._overlayLayout.monitors[this._dragState.index];
        this._dragState = null;
        this._refreshOverlayMap();
        this._setOverlayStatus(`Moved ${monitor.name} to x ${monitor.x}, y ${monitor.y}. Save or Apply when ready.`);
        return Clutter.EVENT_STOP;
    }

    _loadImageCrops() {
        try {
            const parsed = JSON.parse(this._settings.get_string('image-crops') || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            logError(error, '[DuaScreen] Failed to parse image crop settings');
            return {};
        }
    }

    _selectedCropKey() {
        const monitor = this._overlayLayout?.monitors?.[this._selectedMonitorIndex];
        return monitor ? (monitor.name || `${monitor.width_px}x${monitor.height_px}`) : '';
    }

    _setCropMode(mode) {
        this._settings.set_string('image-crop-mode', mode);
        this._refreshOverlayMap();
        this._setOverlayStatus(mode === 'per-monitor' ? 'Editing image crop for the selected screen.' : 'Using one image placement across the whole desktop.');
    }

    _adjustSelectedCrop(dx, dy, dScale) {
        const key = this._selectedCropKey();
        if (!key)
            return;

        this._settings.set_string('image-crop-mode', 'per-monitor');
        const crops = this._loadImageCrops();
        const crop = crops[key] || { x: 0, y: 0, scale: 1 };
        crop.x = Math.round((Number(crop.x) || 0) + dx);
        crop.y = Math.round((Number(crop.y) || 0) + dy);
        crop.scale = Math.max(0.3, Math.min(4, Math.round(((Number(crop.scale) || 1) + dScale) * 100) / 100));
        crops[key] = crop;
        this._settings.set_string('image-crops', JSON.stringify(crops));
        this._refreshSelectedLabel();
        this._setOverlayStatus(`Adjusted image crop for ${key}. Use Set as desktop wallpaper from prefs to render it.`);
    }

    _resetSelectedCrop() {
        const key = this._selectedCropKey();
        if (!key)
            return;

        const crops = this._loadImageCrops();
        delete crops[key];
        this._settings.set_string('image-crops', JSON.stringify(crops));
        this._refreshSelectedLabel();
        this._setOverlayStatus(`Reset image crop for ${key}.`);
    }

    _refreshSelectedLabel() {
        if (!this._selectedLabel || !this._overlayLayout?.monitors?.length)
            return;

        const monitor = this._overlayLayout.monitors[this._selectedMonitorIndex] || this._overlayLayout.monitors[0];
        const cropMode = this._settings.get_string('image-crop-mode') || 'global';
        const crop = this._loadImageCrops()[monitor.name || `${monitor.width_px}x${monitor.height_px}`] || { x: 0, y: 0, scale: 1 };
        this._selectedLabel.text = `${monitor.name}\nX ${monitor.x}  Y ${monitor.y}\n${monitor.width_px}x${monitor.height_px}\nImage: ${cropMode}  zoom ${crop.scale || 1}  x ${crop.x || 0}  y ${crop.y || 0}`;
    }

    _setOverlayStatus(text) {
        if (this._overlayStatusLabel)
            this._overlayStatusLabel.text = text;
    }
}
