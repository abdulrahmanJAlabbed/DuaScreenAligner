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

function _cloneLayout(layout) {
    return JSON.parse(JSON.stringify(layout));
}

function _normalizeToOrigin(layout) {
    if (!layout || !Array.isArray(layout.monitors) || layout.monitors.length === 0)
        return;

    let minX = layout.monitors[0].x;
    let minY = layout.monitors[0].y;
    for (const monitor of layout.monitors) {
        if (monitor.x < minX)
            minX = monitor.x;
        if (monitor.y < minY)
            minY = monitor.y;
    }

    for (const monitor of layout.monitors) {
        monitor.x -= minX;
        monitor.y -= minY;
    }
}

function _monitorArea(monitor) {
    return Math.max(1, monitor.width_px) * Math.max(1, monitor.height_px);
}

function _smartPortraitLeftCenter(layout) {
    if (!layout || !Array.isArray(layout.monitors) || layout.monitors.length < 2)
        return false;

    const monitors = layout.monitors;
    let portraitIndex = 0;
    let bestPortraitRatio = -1;
    let mainIndex = 0;
    let bestArea = -1;

    for (let i = 0; i < monitors.length; i++) {
        const m = monitors[i];
        const ratio = m.height_px / Math.max(1, m.width_px);
        if (ratio > bestPortraitRatio) {
            bestPortraitRatio = ratio;
            portraitIndex = i;
        }

        const area = _monitorArea(m);
        if (area > bestArea) {
            bestArea = area;
            mainIndex = i;
        }
    }

    if (portraitIndex === mainIndex) {
        for (let i = 0; i < monitors.length; i++) {
            if (i !== mainIndex) {
                portraitIndex = i;
                break;
            }
        }
    }

    const portrait = monitors[portraitIndex];
    const main = monitors[mainIndex];

    portrait.x = 0;
    portrait.y = 0;

    main.x = portrait.width_px;
    main.y = Math.round((portrait.height_px - main.height_px) / 2);

    let cursorX = main.x + main.width_px;
    for (let i = 0; i < monitors.length; i++) {
        if (i === portraitIndex || i === mainIndex)
            continue;

        const monitor = monitors[i];
        monitor.x = cursorX;
        monitor.y = Math.round((main.height_px - monitor.height_px) / 2) + main.y;
        cursorX += monitor.width_px;
    }

    _normalizeToOrigin(layout);
    return true;
}

function _alignSideBySide(layout) {
    if (!layout || !Array.isArray(layout.monitors) || layout.monitors.length === 0)
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
    if (!layout || !Array.isArray(layout.monitors) || layout.monitors.length < 2)
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
}

function _deepUnpackSingle(result, fallback = '') {
    if (!result)
        return fallback;

    const unpacked = result.deepUnpack();
    if (Array.isArray(unpacked) && unpacked.length > 0)
        return unpacked[0];

    return unpacked ?? fallback;
}

function _overlapSize(startA, endA, startB, endB) {
    return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function _edgeTransitions(monitors) {
    const transitions = [];

    for (let i = 0; i < monitors.length; i++) {
        for (let j = i + 1; j < monitors.length; j++) {
            const a = monitors[i];
            const b = monitors[j];
            const aRight = a.x + a.width_px;
            const bRight = b.x + b.width_px;
            const aBottom = a.y + a.height_px;
            const bBottom = b.y + b.height_px;

            if (aRight === b.x || bRight === a.x) {
                const overlap = _overlapSize(a.y, aBottom, b.y, bBottom);
                if (overlap > 0) {
                    transitions.push({
                        kind: 'vertical',
                        from: aRight === b.x ? a : b,
                        to: aRight === b.x ? b : a,
                        overlap,
                    });
                }
            }

            if (aBottom === b.y || bBottom === a.y) {
                const overlap = _overlapSize(a.x, aRight, b.x, bRight);
                if (overlap > 0) {
                    transitions.push({
                        kind: 'horizontal',
                        from: aBottom === b.y ? a : b,
                        to: aBottom === b.y ? b : a,
                        overlap,
                    });
                }
            }
        }
    }

    return transitions;
}

function _monitorDpi(monitor) {
    const xDpi = monitor.width_px / Math.max(1, monitor.width_mm / 25.4);
    const yDpi = monitor.height_px / Math.max(1, monitor.height_mm / 25.4);
    return Math.round((xDpi + yDpi) / 2);
}

export default class DuaScreenPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._imageFitMode = 'cover';
        this._imageAspectPreset = 'desktop';
        this._showImagePreview = true;
        this._showCursorPaths = true;

        window.set_default_size(900, 720);
        window.set_search_enabled(false);

        window.add(this._buildOverviewPage());
        window.add(this._buildLayoutPage());
    }

    _buildOverviewPage() {
        const page = new Adw.PreferencesPage({
            title: _('Overview'),
            icon_name: 'preferences-system-symbolic',
        });

        const statusGroup = new Adw.PreferencesGroup({
            title: _('Current state'),
        });

        const statusBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 6,
            margin_bottom: 6,
            hexpand: true,
        });

        this._overviewStatusLabel = new Gtk.Label({
            label: _('Status has not been checked yet.'),
            wrap: true,
            xalign: 0,
            hexpand: true,
        });
        this._overviewStatusLabel.add_css_class('title-4');
        statusBox.append(this._overviewStatusLabel);

        this._layoutStatsLabel = new Gtk.Label({
            label: _('No monitor layout loaded.'),
            wrap: true,
            xalign: 0,
            hexpand: true,
        });
        statusBox.append(this._layoutStatsLabel);

        const statusButtons = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            row_spacing: 8,
            column_spacing: 8,
            max_children_per_line: 3,
            hexpand: true,
        });
        statusButtons.insert(this._makeToolButton(_('Refresh status'), 'view-refresh-symbolic', () => this._refreshDaemonStatus()), -1);
        statusButtons.insert(this._makeToolButton(_('Apply now'), 'emblem-ok-symbolic', () => this._saveAndApplyLayout()), -1);
        statusButtons.insert(this._makeToolButton(_('Find mice'), 'input-mouse-symbolic', () => this._listDevices()), -1);
        statusBox.append(statusButtons);
        statusGroup.add(statusBox);
        page.add(statusGroup);

        const settingsGroup = new Adw.PreferencesGroup({
            title: _('Controls'),
        });

        settingsGroup.add(this._makeSwitchRow(_('Enable correction'), _('DPI-aware cursor motion is sent to the daemon.'), 'enabled'));
        settingsGroup.add(this._makeSwitchRow(_('Start automatically'), _('Launch the daemon on login.'), 'auto-start'));

        const inputRow = new Adw.ActionRow({
            title: _('Mouse device'),
            subtitle: _('Leave empty for auto-detect, or use Find mice to choose a /dev/input/event path.'),
        });
        this._inputDeviceEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: '/dev/input/event5',
            text: this._settings.get_string('input-device'),
        });
        this._inputDeviceEntry.set_width_chars(18);
        this._inputDeviceEntry.connect('changed', () => {
            this._settings.set_string('input-device', this._inputDeviceEntry.text.trim());
        });
        inputRow.add_suffix(this._inputDeviceEntry);
        settingsGroup.add(inputRow);

        page.add(settingsGroup);
        this._refreshLayoutStatsFromSettings();
        this._refreshDaemonStatus();
        return page;
    }

    _buildLayoutPage() {
        const page = new Adw.PreferencesPage({
            title: _('Aligner'),
            icon_name: 'view-grid-symbolic',
        });

        const visualGroup = new Adw.PreferencesGroup({
            title: _('Monitor map'),
            description: _('The preview uses the same coordinates sent to the daemon.'),
        });

        this._previewArea = new Gtk.DrawingArea({
            content_width: 520,
            content_height: 300,
            hexpand: true,
            vexpand: false,
        });
        this._previewArea.set_draw_func((area, cr, width, height) => {
            this._drawLayoutPreview(cr, width, height);
        });
        visualGroup.add(this._previewArea);

        const imageControls = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            row_spacing: 8,
            column_spacing: 8,
            max_children_per_line: 4,
            margin_top: 8,
            hexpand: true,
        });
        imageControls.insert(this._makeComboControl(_('Image'), [
            ['desktop', _('Use desktop shape')],
            ['16:9', _('16:9 photo')],
            ['21:9', _('21:9 ultrawide')],
            ['32:9', _('32:9 superwide')],
            ['4:3', _('4:3 image')],
        ], this._imageAspectPreset, value => {
            this._imageAspectPreset = value;
            this._previewArea.queue_draw();
        }), -1);
        imageControls.insert(this._makeComboControl(_('Fit'), [
            ['cover', _('Fill screens')],
            ['contain', _('Fit whole image')],
            ['stretch', _('Stretch to desktop')],
        ], this._imageFitMode, value => {
            this._imageFitMode = value;
            this._previewArea.queue_draw();
        }), -1);
        imageControls.insert(this._makeSwitchControl(_('Image slices'), this._showImagePreview, value => {
            this._showImagePreview = value;
            this._previewArea.queue_draw();
        }), -1);
        imageControls.insert(this._makeSwitchControl(_('Mouse paths'), this._showCursorPaths, value => {
            this._showCursorPaths = value;
            this._previewArea.queue_draw();
        }), -1);
        visualGroup.add(imageControls);

        const autoButtons = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            row_spacing: 8,
            column_spacing: 8,
            max_children_per_line: 3,
            margin_top: 8,
            margin_bottom: 8,
            hexpand: true,
        });
        autoButtons.insert(this._makeToolButton(_('Detect monitors'), 'find-location-symbolic', () => this._detectCurrentLayout()), -1);
        autoButtons.insert(this._makeToolButton(_('Load JSON'), 'document-open-symbolic', () => this._loadVisualFromBuffer()), -1);
        autoButtons.insert(this._makeToolButton(_('Portrait + main'), 'object-flip-vertical-symbolic', () => this._applySmartPortraitAlignment()), -1);
        autoButtons.insert(this._makeToolButton(_('Side by side'), 'view-dual-symbolic', () => this._applySideBySideAlignment()), -1);
        autoButtons.insert(this._makeToolButton(_('Center heights'), 'align-vertical-center-symbolic', () => this._applyVerticalCentering()), -1);
        autoButtons.insert(this._makeToolButton(_('Horizontal preset'), 'view-dual-symbolic', () => this._setLayoutText(_horizontalPreset())), -1);
        autoButtons.insert(this._makeToolButton(_('Stack preset'), 'view-more-symbolic', () => this._setLayoutText(_stackPreset())), -1);
        autoButtons.insert(this._makeToolButton(_('Save'), 'document-save-symbolic', () => this._saveLayoutOnly()), -1);
        autoButtons.insert(this._makeToolButton(_('Apply'), 'emblem-ok-symbolic', () => this._saveAndApplyLayout()), -1);
        visualGroup.add(autoButtons);
        page.add(visualGroup);

        const transitionGroup = new Adw.PreferencesGroup({
            title: _('Mouse transitions'),
            description: _('Shared edges show where the pointer can pass directly between monitors.'),
        });
        this._transitionListBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            hexpand: true,
        });
        transitionGroup.add(this._transitionListBox);
        page.add(transitionGroup);

        const monitorGroup = new Adw.PreferencesGroup({
            title: _('Screen positions'),
            description: _('Adjust X and Y for each monitor. Resolution and physical size stay in JSON.'),
        });
        this._monitorControlsBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            hexpand: true,
        });
        monitorGroup.add(this._monitorControlsBox);
        page.add(monitorGroup);

        const editorGroup = new Adw.PreferencesGroup({
            title: _('Advanced JSON'),
            description: _('Use this when you need exact geometry, physical millimeters, or more than the visual editor exposes.'),
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
            min_content_height: 180,
            child: layoutView,
        });

        const jsonExpander = new Gtk.Expander({
            label: _('Show raw layout JSON'),
            expanded: false,
            hexpand: true,
        });
        jsonExpander.set_child(scrolled);
        editorGroup.add(jsonExpander);
        page.add(editorGroup);

        const statusGroup = new Adw.PreferencesGroup({
            title: _('Last action'),
        });
        this._statusLabel = new Gtk.Label({
            label: '',
            wrap: true,
            xalign: 0,
            hexpand: true,
        });
        statusGroup.add(this._statusLabel);
        page.add(statusGroup);

        this._loadVisualFromBuffer();
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

    _makeToolButton(label, iconName, onClick) {
        const button = new Gtk.Button({
            label,
            icon_name: iconName,
            halign: Gtk.Align.START,
        });
        button.connect('clicked', () => onClick());
        return button;
    }

    _makeComboControl(label, choices, activeId, onChanged) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.START,
        });
        box.append(new Gtk.Label({ label, xalign: 0 }));

        const combo = new Gtk.ComboBoxText();
        for (const [id, text] of choices)
            combo.append(id, text);
        combo.set_active_id(activeId);
        combo.connect('changed', () => onChanged(combo.get_active_id()));
        box.append(combo);
        return box;
    }

    _makeSwitchControl(label, active, onChanged) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.START,
        });
        box.append(new Gtk.Label({ label, xalign: 0 }));
        const toggle = new Gtk.Switch({ active, valign: Gtk.Align.CENTER });
        toggle.connect('notify::active', () => onChanged(toggle.active));
        box.append(toggle);
        return box;
    }

    _makeButtonRow(title, subtitle, onClick) {
        const row = new Adw.ActionRow({ title, subtitle });
        const button = new Gtk.Button({
            icon_name: 'go-next-symbolic',
            valign: Gtk.Align.CENTER,
        });
        button.set_tooltip_text(title);
        button.connect('clicked', () => onClick());
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }

    _setLayoutText(text) {
        this._layoutBuffer.set_text(text, -1);
        this._loadVisualFromBuffer();
        this._status(_('Preset loaded. Save or apply it to the daemon.'));
    }

    _detectCurrentLayout() {
        try {
            const inputDevice = this._settings.get_string('input-device').trim();
            const detected = _detectLayoutFromXrandr(inputDevice);
            this._layoutBuffer.set_text(detected, -1);
            this._loadVisualFromBuffer();
            this._status(_('Detected current monitor layout from xrandr. Save or apply it to the daemon.'));
        } catch (error) {
            this._status(_('Unable to detect layout: ') + error.message);
        }
    }

    _layoutBounds(monitors) {
        let minX = monitors[0].x;
        let minY = monitors[0].y;
        let maxX = monitors[0].x + monitors[0].width_px;
        let maxY = monitors[0].y + monitors[0].height_px;

        for (const m of monitors) {
            minX = Math.min(minX, m.x);
            minY = Math.min(minY, m.y);
            maxX = Math.max(maxX, m.x + m.width_px);
            maxY = Math.max(maxY, m.y + m.height_px);
        }

        return {
            minX,
            minY,
            maxX,
            maxY,
            width: Math.max(1, maxX - minX),
            height: Math.max(1, maxY - minY),
        };
    }

    _previewTransform(width, height, bounds) {
        const padding = 24;
        const usableWidth = Math.max(1, width - padding * 2);
        const usableHeight = Math.max(1, height - padding * 2);
        const scale = Math.min(usableWidth / bounds.width, usableHeight / bounds.height);
        const offsetX = (width - bounds.width * scale) / 2;
        const offsetY = (height - bounds.height * scale) / 2;

        return { scale, offsetX, offsetY, bounds };
    }

    _toPreviewRect(monitor, transform) {
        return {
            x: transform.offsetX + (monitor.x - transform.bounds.minX) * transform.scale,
            y: transform.offsetY + (monitor.y - transform.bounds.minY) * transform.scale,
            width: Math.max(18, monitor.width_px * transform.scale),
            height: Math.max(18, monitor.height_px * transform.scale),
        };
    }

    _imageAspect(bounds) {
        switch (this._imageAspectPreset) {
        case '16:9':
            return 16 / 9;
        case '21:9':
            return 21 / 9;
        case '32:9':
            return 32 / 9;
        case '4:3':
            return 4 / 3;
        default:
            return bounds.width / bounds.height;
        }
    }

    _imageBounds(bounds) {
        if (this._imageFitMode === 'stretch')
            return { x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height };

        const aspect = this._imageAspect(bounds);
        const desktopAspect = bounds.width / bounds.height;
        let imageWidth = bounds.width;
        let imageHeight = bounds.height;

        if (this._imageFitMode === 'cover') {
            if (aspect > desktopAspect)
                imageWidth = bounds.height * aspect;
            else
                imageHeight = bounds.width / aspect;
        } else if (aspect > desktopAspect) {
            imageHeight = bounds.width / aspect;
        } else {
            imageWidth = bounds.height * aspect;
        }

        return {
            x: bounds.minX + (bounds.width - imageWidth) / 2,
            y: bounds.minY + (bounds.height - imageHeight) / 2,
            width: imageWidth,
            height: imageHeight,
        };
    }

    _layoutRectToPreview(rect, transform) {
        return {
            x: transform.offsetX + (rect.x - transform.bounds.minX) * transform.scale,
            y: transform.offsetY + (rect.y - transform.bounds.minY) * transform.scale,
            width: rect.width * transform.scale,
            height: rect.height * transform.scale,
        };
    }

    _drawImagePattern(cr, imageRect) {
        cr.setSourceRGBA(0.12, 0.27, 0.46, 1.0);
        cr.rectangle(imageRect.x, imageRect.y, imageRect.width, imageRect.height);
        cr.fill();

        const bands = [
            [0.10, 0.43, 0.78, 0.72],
            [0.95, 0.62, 0.20, 0.66],
            [0.20, 0.62, 0.42, 0.62],
            [0.79, 0.28, 0.33, 0.58],
        ];
        const bandWidth = imageRect.width / 7;
        for (let i = 0; i < 7; i++) {
            const color = bands[i % bands.length];
            cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
            cr.rectangle(imageRect.x + i * bandWidth, imageRect.y, bandWidth, imageRect.height);
            cr.fill();
        }

        cr.setSourceRGBA(1, 1, 1, 0.30);
        cr.setLineWidth(2);
        const step = Math.max(28, imageRect.width / 9);
        for (let x = imageRect.x - imageRect.height; x < imageRect.x + imageRect.width; x += step) {
            cr.moveTo(x, imageRect.y + imageRect.height);
            cr.lineTo(x + imageRect.height, imageRect.y);
            cr.stroke();
        }

        cr.setSourceRGBA(1, 1, 1, 0.22);
        cr.arc(imageRect.x + imageRect.width * 0.52, imageRect.y + imageRect.height * 0.48,
            Math.max(18, Math.min(imageRect.width, imageRect.height) * 0.18), 0, Math.PI * 2);
        cr.fill();
    }

    _drawArrow(cr, x1, y1, x2, y2) {
        cr.setSourceRGBA(1.0, 0.72, 0.22, 0.96);
        cr.setLineWidth(2.5);
        cr.moveTo(x1, y1);
        cr.lineTo(x2, y2);
        cr.stroke();

        const angle = Math.atan2(y2 - y1, x2 - x1);
        const size = 8;
        cr.moveTo(x2, y2);
        cr.lineTo(x2 - size * Math.cos(angle - 0.55), y2 - size * Math.sin(angle - 0.55));
        cr.lineTo(x2 - size * Math.cos(angle + 0.55), y2 - size * Math.sin(angle + 0.55));
        cr.closePath();
        cr.fill();
    }

    _drawLayoutPreview(cr, width, height) {
        cr.setSourceRGBA(0.05, 0.06, 0.07, 1.0);
        cr.paint();

        if (!this._visualLayout || !Array.isArray(this._visualLayout.monitors) || this._visualLayout.monitors.length === 0)
            return;

        const monitors = this._visualLayout.monitors;
        const bounds = this._layoutBounds(monitors);
        const transform = this._previewTransform(width, height, bounds);
        const imageRect = this._layoutRectToPreview(this._imageBounds(bounds), transform);

        cr.selectFontFace('Sans', 0, 0);
        cr.setFontSize(11);

        if (this._showImagePreview) {
            cr.save();
            for (const m of monitors) {
                const rect = this._toPreviewRect(m, transform);
                cr.rectangle(rect.x, rect.y, rect.width, rect.height);
            }
            cr.clip();
            this._drawImagePattern(cr, imageRect);
            cr.restore();
        }

        for (let i = 0; i < monitors.length; i++) {
            const m = monitors[i];
            const rect = this._toPreviewRect(m, transform);

            if (!this._showImagePreview) {
                const colors = [
                    [0.15, 0.45, 0.82, 0.72],
                    [0.24, 0.62, 0.40, 0.68],
                    [0.82, 0.40, 0.22, 0.68],
                    [0.56, 0.35, 0.76, 0.68],
                ];
                const color = colors[i % colors.length];
                cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
                cr.rectangle(rect.x, rect.y, rect.width, rect.height);
                cr.fill();
            }

            cr.setSourceRGBA(0, 0, 0, 0.28);
            cr.rectangle(rect.x, rect.y, rect.width, Math.min(42, rect.height));
            cr.fill();

            cr.setSourceRGBA(1, 1, 1, 0.96);
            cr.setLineWidth(1.6);
            cr.rectangle(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
            cr.stroke();

            cr.setSourceRGBA(1, 1, 1, 0.96);
            cr.moveTo(rect.x + 7, rect.y + 16);
            cr.showText(`${i + 1}. ${m.name}`);
            cr.moveTo(rect.x + 7, rect.y + 31);
            cr.showText(`${m.width_px}x${m.height_px}  ${_monitorDpi(m)} DPI`);

            cr.setSourceRGBA(1, 1, 1, 0.72);
            cr.moveTo(rect.x + 7, rect.y + rect.height - 8);
            cr.showText(`x ${m.x}, y ${m.y}`);
        }

        if (this._showCursorPaths) {
            const transitions = _edgeTransitions(monitors);
            for (const transition of transitions) {
                const from = this._toPreviewRect(transition.from, transform);
                const to = this._toPreviewRect(transition.to, transform);

                if (transition.kind === 'vertical') {
                    const edgeX = transition.from.x < transition.to.x ? from.x + from.width : to.x + to.width;
                    const top = Math.max(from.y, to.y);
                    const bottom = Math.min(from.y + from.height, to.y + to.height);
                    const y = top + (bottom - top) / 2;
                    this._drawArrow(cr, edgeX - 28, y, edgeX + 28, y);
                    cr.setSourceRGBA(1, 1, 1, 0.88);
                    cr.moveTo(edgeX + 8, y - 8);
                    cr.showText(`${transition.overlap}px`);
                } else {
                    const edgeY = transition.from.y < transition.to.y ? from.y + from.height : to.y + to.height;
                    const left = Math.max(from.x, to.x);
                    const right = Math.min(from.x + from.width, to.x + to.width);
                    const x = left + (right - left) / 2;
                    this._drawArrow(cr, x, edgeY - 28, x, edgeY + 28);
                    cr.setSourceRGBA(1, 1, 1, 0.88);
                    cr.moveTo(x + 8, edgeY + 14);
                    cr.showText(`${transition.overlap}px`);
                }
            }

            if (transitions.length === 0 && monitors.length > 1) {
                cr.setSourceRGBA(1, 0.72, 0.22, 0.96);
                cr.moveTo(18, height - 18);
                cr.showText('No shared edges: move screens until borders touch for direct cursor travel.');
            }
        }
    }

    _loadVisualFromBuffer() {
        try {
            const parsed = JSON.parse(this._getLayoutText());
            if (!parsed || !Array.isArray(parsed.monitors) || parsed.monitors.length === 0)
                throw new Error('layout must include at least one monitor');

            this._visualLayout = _cloneLayout(parsed);
            this._rebuildMonitorControls();
            this._rebuildTransitionSummary();
            this._refreshLayoutStats(this._visualLayout);
            this._previewArea.queue_draw();
        } catch (error) {
            this._status(_('Cannot load visual editor from JSON: ') + error.message);
        }
    }

    _writeVisualToBuffer() {
        if (!this._visualLayout)
            return;

        const normalized = this._normalizeLayoutPayload(JSON.stringify(this._visualLayout));
        this._layoutBuffer.set_text(normalized, -1);
        this._rebuildTransitionSummary();
        this._refreshLayoutStats(this._visualLayout);
        this._previewArea.queue_draw();
        this._status(_('Visual editor changes written to JSON.'));
    }

    _rebuildMonitorControls() {
        if (!this._monitorControlsBox)
            return;

        let child = this._monitorControlsBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._monitorControlsBox.remove(child);
            child = next;
        }

        if (!this._visualLayout || !Array.isArray(this._visualLayout.monitors))
            return;

        this._visualLayout.monitors.forEach((monitor, index) => {
            this._monitorControlsBox.append(this._createMonitorControlRow(monitor, index));
        });
    }

    _makeSpinControl(label, value, onChanged) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.START,
        });
        box.append(new Gtk.Label({ label, xalign: 0 }));
        const spin = Gtk.SpinButton.new_with_range(-20000, 20000, 1);
        spin.set_value(value);
        spin.set_width_chars(7);
        spin.connect('value-changed', () => onChanged(spin.get_value_as_int()));
        box.append(spin);
        return box;
    }

    _createMonitorControlRow(monitor, index) {
        const row = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 4,
            margin_bottom: 8,
            hexpand: true,
        });

        const title = new Gtk.Label({
            label: `${index + 1}. ${monitor.name}  |  ${monitor.width_px}x${monitor.height_px}  |  ${_monitorDpi(monitor)} DPI`,
            wrap: true,
            xalign: 0,
            hexpand: true,
        });
        title.add_css_class('heading');
        row.append(title);

        const controls = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            row_spacing: 6,
            column_spacing: 10,
            max_children_per_line: 4,
            hexpand: true,
        });
        controls.insert(this._makeSpinControl(_('X'), monitor.x, value => {
            monitor.x = value;
            this._writeVisualToBuffer();
        }), -1);
        controls.insert(this._makeSpinControl(_('Y'), monitor.y, value => {
            monitor.y = value;
            this._writeVisualToBuffer();
        }), -1);
        controls.insert(new Gtk.Label({
            label: `${monitor.width_mm}x${monitor.height_mm} mm`,
            xalign: 0,
            halign: Gtk.Align.START,
        }), -1);
        row.append(controls);

        return row;
    }

    _rebuildTransitionSummary() {
        if (!this._transitionListBox)
            return;

        let child = this._transitionListBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._transitionListBox.remove(child);
            child = next;
        }

        if (!this._visualLayout || !Array.isArray(this._visualLayout.monitors))
            return;

        const transitions = _edgeTransitions(this._visualLayout.monitors);
        if (transitions.length === 0) {
            const label = new Gtk.Label({
                label: _('No touching monitor edges found. Cursor travel needs at least one shared edge.'),
                wrap: true,
                xalign: 0,
                hexpand: true,
            });
            this._transitionListBox.append(label);
            return;
        }

        for (const transition of transitions) {
            const edgeName = transition.kind === 'vertical' ? _('vertical') : _('horizontal');
            const label = new Gtk.Label({
                label: `${transition.from.name} -> ${transition.to.name} | ${transition.overlap}px ${edgeName} edge | ${_monitorDpi(transition.from)} DPI -> ${_monitorDpi(transition.to)} DPI`,
                wrap: true,
                xalign: 0,
                hexpand: true,
            });
            this._transitionListBox.append(label);
        }
    }

    _applySmartPortraitAlignment() {
        if (!this._visualLayout)
            return;

        const changed = _smartPortraitLeftCenter(this._visualLayout);
        if (!changed) {
            this._status(_('Need at least two monitors for smart portrait alignment.'));
            return;
        }

        this._rebuildMonitorControls();
        this._writeVisualToBuffer();
        this._status(_('Applied smart portrait-left + centered-main alignment.'));
    }

    _applySideBySideAlignment() {
        if (!this._visualLayout)
            return;

        _alignSideBySide(this._visualLayout);
        this._rebuildMonitorControls();
        this._writeVisualToBuffer();
        this._status(_('Applied side-by-side alignment.'));
    }

    _applyVerticalCentering() {
        if (!this._visualLayout)
            return;

        _centerSecondaryVertically(this._visualLayout);
        this._rebuildMonitorControls();
        this._writeVisualToBuffer();
        this._status(_('Centered secondary monitors vertically around the main screen.'));
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
            this._loadVisualFromBuffer();
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

            this._loadVisualFromBuffer();
            this._refreshDaemonStatus();
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

    _refreshLayoutStatsFromSettings() {
        try {
            const text = this._settings.get_string('monitor-layout') || _portraitLeftMainCenterPreset();
            this._refreshLayoutStats(JSON.parse(text));
        } catch (error) {
            if (this._layoutStatsLabel)
                this._layoutStatsLabel.label = _('Saved layout cannot be read: ') + error.message;
        }
    }

    _refreshLayoutStats(layout) {
        if (!this._layoutStatsLabel || !layout || !Array.isArray(layout.monitors) || layout.monitors.length === 0)
            return;

        const bounds = this._layoutBounds(layout.monitors);
        const transitions = _edgeTransitions(layout.monitors);
        this._layoutStatsLabel.label = `${layout.monitors.length} screens | desktop ${bounds.width}x${bounds.height}px | ${transitions.length} cursor transitions`;
    }

    _refreshDaemonStatus() {
        try {
            const result = _callDaemon('GetStatus', '', 's', []);
            const daemonStatus = _deepUnpackSingle(result, _('unknown'));
            const correction = this._settings.get_boolean('enabled') ? _('enabled') : _('paused');
            const message = `${_('Daemon')}: ${daemonStatus} | ${_('Correction')}: ${correction}`;

            if (this._overviewStatusLabel)
                this._overviewStatusLabel.label = message;
            this._status(message);
        } catch (error) {
            const message = _('Daemon not reachable: ') + error.message;
            if (this._overviewStatusLabel)
                this._overviewStatusLabel.label = message;
            this._status(message);
        }
    }

    _listDevices() {
        try {
            const result = _callDaemon('ListDevices', '', 's', []);
            const devicesJSON = _deepUnpackSingle(result, '[]');
            const devices = JSON.parse(devicesJSON);

            if (!Array.isArray(devices) || devices.length === 0) {
                this._status(_('No mouse devices returned by the daemon.'));
                return;
            }

            const first = devices[0];
            const firstPath = first.by_id_path || first.path || '';
            if (firstPath && this._inputDeviceEntry) {
                this._inputDeviceEntry.text = firstPath;
                this._settings.set_string('input-device', firstPath);
            }

            const names = devices.slice(0, 3).map(device => `${device.name || _('Mouse')} (${device.by_id_path || device.path})`);
            this._status(`${devices.length} ${_('mouse device(s) found')}: ${names.join('; ')}`);
        } catch (error) {
            this._status(_('Cannot list mouse devices: ') + error.message);
        }
    }

    _status(message) {
        if (this._statusLabel)
            this._statusLabel.label = message;
        if (this._overviewStatusLabel && message)
            this._overviewStatusLabel.label = message;
    }
}
