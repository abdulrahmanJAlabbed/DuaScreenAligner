// prefs.js — Libadwaita/GTK4 Preferences Window for DuaScreen Aligner.
//
// GNOME 45+ Extension Preferences (ES Module). Runs in a separate process
// from gnome-shell; uses GTK4 and Libadwaita widgets exclusively.
//
// Layout:
//   Page 1 — Display Arrangement: Interactive monitor topology map with
//            drag-and-drop positioning, resolution/DPI labels, and
//            proportional scaling. Uses a custom Gtk.DrawingArea with
//            Cairo rendering.
//
//   Page 2 — Device & Behavior: Input device selection, auto-start toggle,
//            per-monitor DPI overrides.
//
//   Page 3 — About: Version info, daemon status, links.
//
// All settings are persisted to GSettings and pushed to the daemon via DBus.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ============================================================================
// Constants
// ============================================================================

const DBUS_NAME = 'com.github.duascreenaligner.Daemon';
const DBUS_PATH = '/com/github/duascreenaligner/Daemon';
const DBUS_IFACE = 'com.github.duascreenaligner.Daemon';

// Monitor map rendering constants.
const MAP_PADDING = 40;          // Padding around the monitor map (px).
const MAP_MIN_HEIGHT = 300;      // Minimum drawing area height (px).
const MONITOR_CORNER_RADIUS = 8; // Rounded corner radius for monitor rects.
const MONITOR_LABEL_SIZE = 11;   // Font size for monitor labels (pt).

// Color palette (Adwaita-inspired).
const COLORS = {
    bg:           [0.122, 0.122, 0.137, 1.0],   // Dark background
    monitorFill:  [0.208, 0.216, 0.235, 1.0],   // Monitor body
    monitorEdge:  [0.294, 0.306, 0.337, 1.0],   // Monitor border
    selected:     [0.208, 0.518, 0.894, 0.8],   // Selected monitor highlight
    selectedEdge: [0.208, 0.518, 0.894, 1.0],   // Selected monitor border
    label:        [0.929, 0.929, 0.929, 1.0],   // Text color
    sublabel:     [0.604, 0.604, 0.620, 1.0],   // Secondary text
    connector:    [0.404, 0.416, 0.447, 0.5],   // Edge connector lines
    dpiHigh:      [0.894, 0.427, 0.243, 0.3],   // High-DPI tint
    dpiLow:       [0.243, 0.694, 0.427, 0.3],   // Low-DPI tint
};

// ============================================================================
// Preferences Entry Point
// ============================================================================

export default class DuaScreenPreferences extends ExtensionPreferences {

    /**
     * fillPreferencesWindow — Populate the Adw.PreferencesWindow.
     *
     * Called by GNOME Shell when the user opens extension preferences.
     * We add three pages: Display Arrangement, Device & Behavior, About.
     *
     * @param {Adw.PreferencesWindow} window - The preferences window to fill.
     */
    fillPreferencesWindow(window) {
        // Load GSettings for this extension.
        const settings = this.getSettings();

        // Set a reasonable default window size for the monitor map.
        window.set_default_size(780, 640);
        window.set_search_enabled(false);

        // ---- Page 1: Display Arrangement ----
        window.add(this._buildDisplayPage(settings, window));

        // ---- Page 2: Device & Behavior ----
        window.add(this._buildDevicePage(settings));

        // ---- Page 3: About ----
        window.add(this._buildAboutPage(settings));
    }

    // ========================================================================
    // Page 1: Display Arrangement
    // ========================================================================

    /**
     * _buildDisplayPage — Creates the monitor topology visualization page.
     *
     * Contains a custom GTK DrawingArea that renders monitors as
     * proportionally-scaled rectangles. Supports drag-and-drop to
     * reposition monitors.
     */
    _buildDisplayPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: _('Displays'),
            icon_name: 'preferences-desktop-display-symbolic',
        });

        // ---- Monitor Map Group ----
        const mapGroup = new Adw.PreferencesGroup({
            title: _('Monitor Arrangement'),
            description: _('Drag monitors to match your physical desk layout. The daemon uses this to correct cursor speed at boundaries.'),
        });
        page.add(mapGroup);

        // Parse the current layout from GSettings, or auto-detect from system.
        let monitors = this._parseMonitors(settings);
        if (monitors.length === 0) {
            monitors = this._detectSystemMonitors();
        }
        // Always auto-detect if count doesn't match what the system reports.
        const systemCount = this._getSystemMonitorCount();
        if (systemCount > 0 && monitors.length !== systemCount) {
            log(`[DuaScreen] Monitor count mismatch (saved: ${monitors.length}, system: ${systemCount}). Re-detecting.`);
            monitors = this._detectSystemMonitors();
        }

        // State for drag interaction.
        let selectedIndex = -1;
        let dragStartX = 0, dragStartY = 0;
        let dragOffsetX = 0, dragOffsetY = 0;
        let isDragging = false;
        let mapScale = 1.0;
        let mapOffsetX = 0, mapOffsetY = 0;

        // ---- Drawing Area ----
        const drawingArea = new Gtk.DrawingArea({
            content_width: 700,
            content_height: MAP_MIN_HEIGHT,
            hexpand: true,
            css_classes: ['card'],
        });

        // Helper: compute scale factor to fit all monitors in the drawing area.
        const computeMapTransform = (width, height) => {
            if (monitors.length === 0) return;

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const m of monitors) {
                minX = Math.min(minX, m.x);
                minY = Math.min(minY, m.y);
                maxX = Math.max(maxX, m.x + m.width_px);
                maxY = Math.max(maxY, m.y + m.height_px);
            }

            const totalW = maxX - minX || 1;
            const totalH = maxY - minY || 1;
            const availW = width - 2 * MAP_PADDING;
            const availH = height - 2 * MAP_PADDING;

            mapScale = Math.min(availW / totalW, availH / totalH, 0.5);
            mapOffsetX = MAP_PADDING + (availW - totalW * mapScale) / 2 - minX * mapScale;
            mapOffsetY = MAP_PADDING + (availH - totalH * mapScale) / 2 - minY * mapScale;
        };

        // Helper: convert monitor logical coords to canvas coords.
        const toCanvas = (mx, my) => [mx * mapScale + mapOffsetX, my * mapScale + mapOffsetY];
        const fromCanvas = (cx, cy) => [(cx - mapOffsetX) / mapScale, (cy - mapOffsetY) / mapScale];

        // Helper: calculate DPI for a monitor.
        const calcDPI = (m) => {
            if (m.dpi_override > 0) return m.dpi_override;
            if (m.width_mm <= 0) return 96;
            return m.width_px / (m.width_mm / 25.4);
        };

        // ---- Cairo Draw Function ----
        drawingArea.set_draw_func((area, cr, width, height) => {
            computeMapTransform(width, height);

            // Background.
            cr.setSourceRGBA(...COLORS.bg);
            cr.rectangle(0, 0, width, height);
            cr.fill();

            // Find DPI range for color coding.
            let minDPI = Infinity, maxDPI = -Infinity;
            for (const m of monitors) {
                const dpi = calcDPI(m);
                minDPI = Math.min(minDPI, dpi);
                maxDPI = Math.max(maxDPI, dpi);
            }
            const dpiRange = maxDPI - minDPI || 1;

            // Draw connector lines between adjacent monitors.
            cr.setSourceRGBA(...COLORS.connector);
            cr.setLineWidth(1);
            for (let i = 0; i < monitors.length; i++) {
                for (let j = i + 1; j < monitors.length; j++) {
                    const a = monitors[i], b = monitors[j];
                    const [ax, ay] = toCanvas(a.x + a.width_px / 2, a.y + a.height_px / 2);
                    const [bx, by] = toCanvas(b.x + b.width_px / 2, b.y + b.height_px / 2);
                    cr.moveTo(ax, ay);
                    cr.lineTo(bx, by);
                    cr.stroke();
                }
            }

            // Draw each monitor.
            monitors.forEach((m, idx) => {
                const [rx, ry] = toCanvas(m.x, m.y);
                const rw = m.width_px * mapScale;
                const rh = m.height_px * mapScale;

                // Rounded rectangle helper.
                const r = MONITOR_CORNER_RADIUS;
                cr.newSubPath();
                cr.arc(rx + rw - r, ry + r, r, -Math.PI / 2, 0);
                cr.arc(rx + rw - r, ry + rh - r, r, 0, Math.PI / 2);
                cr.arc(rx + r, ry + rh - r, r, Math.PI / 2, Math.PI);
                cr.arc(rx + r, ry + r, r, Math.PI, 3 * Math.PI / 2);
                cr.closePath();

                // Fill with DPI-tinted color.
                const dpi = calcDPI(m);
                const dpiNorm = (dpi - minDPI) / dpiRange;
                if (idx === selectedIndex) {
                    cr.setSourceRGBA(...COLORS.selected);
                } else {
                    // Blend between low-DPI (green tint) and high-DPI (orange tint).
                    const baseColor = COLORS.monitorFill;
                    const tint = dpiNorm > 0.5 ? COLORS.dpiHigh : COLORS.dpiLow;
                    cr.setSourceRGBA(
                        baseColor[0] + tint[0] * 0.3,
                        baseColor[1] + tint[1] * 0.3,
                        baseColor[2] + tint[2] * 0.3,
                        1.0
                    );
                }
                cr.fillPreserve();

                // Border.
                cr.setLineWidth(idx === selectedIndex ? 2.5 : 1.5);
                if (idx === selectedIndex) {
                    cr.setSourceRGBA(...COLORS.selectedEdge);
                } else {
                    cr.setSourceRGBA(...COLORS.monitorEdge);
                }
                cr.stroke();

                // Monitor name label.
                cr.setSourceRGBA(...COLORS.label);
                cr.setFontSize(MONITOR_LABEL_SIZE);
                cr.moveTo(rx + 10, ry + 20);
                cr.showText(m.name || `Display ${idx + 1}`);

                // Resolution + DPI sublabel.
                cr.setSourceRGBA(...COLORS.sublabel);
                cr.setFontSize(MONITOR_LABEL_SIZE - 1);
                cr.moveTo(rx + 10, ry + 36);
                cr.showText(`${m.width_px}×${m.height_px}  •  ${Math.round(dpi)} DPI`);

                // Physical size label (if available).
                if (m.width_mm > 0) {
                    cr.moveTo(rx + 10, ry + 50);
                    const diagInches = Math.sqrt(m.width_mm ** 2 + m.height_mm ** 2) / 25.4;
                    cr.showText(`${diagInches.toFixed(1)}″ diagonal`);
                }
            });
        });

        // ---- Drag Gesture for Moving Monitors ----
        const dragGesture = new Gtk.GestureDrag({ button: 1 });

        dragGesture.connect('drag-begin', (_gesture, startX, startY) => {
            const [mx, my] = fromCanvas(startX, startY);

            // Find which monitor was clicked.
            selectedIndex = -1;
            for (let i = monitors.length - 1; i >= 0; i--) {
                const m = monitors[i];
                if (mx >= m.x && mx < m.x + m.width_px &&
                    my >= m.y && my < m.y + m.height_px) {
                    selectedIndex = i;
                    break;
                }
            }

            if (selectedIndex >= 0) {
                isDragging = true;
                const m = monitors[selectedIndex];
                dragOffsetX = mx - m.x;
                dragOffsetY = my - m.y;
                dragStartX = startX;
                dragStartY = startY;
            }

            drawingArea.queue_draw();
        });

        dragGesture.connect('drag-update', (_gesture, offsetX, offsetY) => {
            if (!isDragging || selectedIndex < 0) return;

            // Convert the current drag position (start + offset) to logical coords.
            const [mx, my] = fromCanvas(dragStartX + offsetX, dragStartY + offsetY);

            // Snap to grid (32px logical) for clean alignment.
            const grid = 32;
            monitors[selectedIndex].x = Math.round((mx - dragOffsetX) / grid) * grid;
            monitors[selectedIndex].y = Math.round((my - dragOffsetY) / grid) * grid;

            drawingArea.queue_draw();
        });

        dragGesture.connect('drag-end', () => {
            if (isDragging) {
                isDragging = false;
                // Persist the updated layout.
                this._saveMonitors(settings, monitors);
                this._pushLayoutToDaemon(monitors, settings);
            }
        });

        drawingArea.add_controller(dragGesture);

        // Click gesture for selection without drag.
        const clickGesture = new Gtk.GestureClick({ button: 1 });
        clickGesture.connect('pressed', (_gesture, _n, x, y) => {
            const [mx, my] = fromCanvas(x, y);
            selectedIndex = -1;
            for (let i = monitors.length - 1; i >= 0; i--) {
                const m = monitors[i];
                if (mx >= m.x && mx < m.x + m.width_px &&
                    my >= m.y && my < m.y + m.height_px) {
                    selectedIndex = i;
                    break;
                }
            }
            drawingArea.queue_draw();
        });
        drawingArea.add_controller(clickGesture);

        // Wrap the drawing area in a row-compatible widget.
        const mapRow = new Adw.ActionRow({ activatable: false });
        mapRow.set_child(drawingArea);
        mapGroup.add(mapRow);

        // ---- Per-Monitor DPI Override Group ----
        const dpiGroup = new Adw.PreferencesGroup({
            title: _('Pixel Density Overrides'),
            description: _('Override auto-detected DPI if your display reports incorrect physical dimensions.'),
        });
        page.add(dpiGroup);

        monitors.forEach((m, idx) => {
            const dpi = calcDPI(m);

            const spinRow = new Adw.SpinRow({
                title: m.name || `Display ${idx + 1}`,
                subtitle: `${m.width_px}×${m.height_px} • Auto: ${Math.round(dpi)} DPI`,
                adjustment: new Gtk.Adjustment({
                    value: m.dpi_override || Math.round(dpi),
                    lower: 48,
                    upper: 600,
                    step_increment: 1,
                    page_increment: 10,
                }),
            });

            spinRow.connect('notify::value', () => {
                const newDPI = spinRow.get_value();
                monitors[idx].dpi_override = Math.round(newDPI);
                this._saveMonitors(settings, monitors);
                this._pushLayoutToDaemon(monitors, settings);
                drawingArea.queue_draw();
            });

            dpiGroup.add(spinRow);
        });

        // Apply button.
        const applyGroup = new Adw.PreferencesGroup();
        page.add(applyGroup);

        const applyButton = new Gtk.Button({
            label: _('Apply Layout'),
            css_classes: ['suggested-action', 'pill'],
            halign: Gtk.Align.CENTER,
            margin_top: 12,
        });
        applyButton.connect('clicked', () => {
            this._saveMonitors(settings, monitors);
            this._pushLayoutToDaemon(monitors, settings);
        });

        const applyRow = new Adw.ActionRow({ activatable: false });
        applyRow.set_child(applyButton);
        applyGroup.add(applyRow);

        return page;
    }

    // ========================================================================
    // Page 2: Device & Behavior
    // ========================================================================

    /**
     * _buildDevicePage — Input device selection and behavior toggles.
     */
    _buildDevicePage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Devices'),
            icon_name: 'input-mouse-symbolic',
        });

        // ---- Input Device Group ----
        const deviceGroup = new Adw.PreferencesGroup({
            title: _('Input Device'),
            description: _('Select which mouse device to intercept for DPI correction.'),
        });
        page.add(deviceGroup);

        // Device selection combo row.
        const deviceModel = new Gtk.StringList();
        deviceModel.append(_('Auto-detect'));

        const deviceRow = new Adw.ComboRow({
            title: _('Mouse Device'),
            subtitle: _('Choose the physical mouse for cursor correction'),
            model: deviceModel,
        });
        deviceGroup.add(deviceRow);

        // Populate devices asynchronously via DBus.
        this._queryDevicesAsync(deviceModel, deviceRow, settings);

        // Refresh button.
        const refreshRow = new Adw.ActionRow({
            title: _('Rescan Devices'),
            subtitle: _('Re-detect connected mouse devices'),
            activatable: true,
        });
        refreshRow.add_suffix(new Gtk.Image({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        refreshRow.connect('activated', () => {
            // Clear and repopulate.
            while (deviceModel.get_n_items() > 1) {
                deviceModel.remove(1);
            }
            this._queryDevicesAsync(deviceModel, deviceRow, settings);
        });
        deviceGroup.add(refreshRow);

        // ---- Behavior Group ----
        const behaviorGroup = new Adw.PreferencesGroup({
            title: _('Behavior'),
        });
        page.add(behaviorGroup);

        // Enable correction toggle.
        const enableRow = new Adw.SwitchRow({
            title: _('Enable Cursor Correction'),
            subtitle: _('Apply DPI scaling when moving between displays'),
        });
        settings.bind('enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(enableRow);

        // Auto-start toggle.
        const autoStartRow = new Adw.SwitchRow({
            title: _('Start Automatically'),
            subtitle: _('Launch the correction daemon on login'),
        });
        settings.bind('auto-start', autoStartRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(autoStartRow);

        // Log level.
        const logModel = new Gtk.StringList();
        ['Error', 'Warning', 'Info', 'Debug'].forEach(l => logModel.append(l));

        const logRow = new Adw.ComboRow({
            title: _('Log Verbosity'),
            subtitle: _('Controls daemon diagnostic output level'),
            model: logModel,
        });

        // Map GSettings value to combo index.
        const logLevels = ['error', 'warn', 'info', 'debug'];
        const currentLog = settings.get_string('log-level');
        logRow.set_selected(Math.max(0, logLevels.indexOf(currentLog)));

        logRow.connect('notify::selected', () => {
            const idx = logRow.get_selected();
            if (idx >= 0 && idx < logLevels.length) {
                settings.set_string('log-level', logLevels[idx]);
            }
        });
        behaviorGroup.add(logRow);

        return page;
    }

    // ========================================================================
    // Page 3: About
    // ========================================================================

    /**
     * _buildAboutPage — Version info, daemon status, and links.
     */
    _buildAboutPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });

        const aboutGroup = new Adw.PreferencesGroup({
            title: _('DuaScreen Aligner'),
            description: _('Multi-monitor DPI cursor correction for Linux'),
        });
        page.add(aboutGroup);

        // Version info.
        const versionRow = new Adw.ActionRow({
            title: _('Extension Version'),
            subtitle: '1.0.0',
        });
        versionRow.add_suffix(new Gtk.Image({
            icon_name: 'emblem-system-symbolic',
            valign: Gtk.Align.CENTER,
            opacity: 0.5,
        }));
        aboutGroup.add(versionRow);

        // Daemon version (queried via DBus).
        const daemonVersionRow = new Adw.ActionRow({
            title: _('Daemon Version'),
            subtitle: _('Checking…'),
        });
        aboutGroup.add(daemonVersionRow);

        // Query daemon version.
        this._queryDaemonVersionAsync(daemonVersionRow);

        // Links group.
        const linksGroup = new Adw.PreferencesGroup({
            title: _('Links'),
        });
        page.add(linksGroup);

        const sourceRow = new Adw.ActionRow({
            title: _('Source Code'),
            subtitle: 'github.com/duascreenaligner',
            activatable: true,
        });
        sourceRow.add_suffix(new Gtk.Image({
            icon_name: 'external-link-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        sourceRow.connect('activated', () => {
            Gtk.show_uri(null, 'https://github.com/duascreenaligner/dua-screen-aligner', Gdk.CURRENT_TIME);
        });
        linksGroup.add(sourceRow);

        const issuesRow = new Adw.ActionRow({
            title: _('Report an Issue'),
            subtitle: _('File a bug or feature request'),
            activatable: true,
        });
        issuesRow.add_suffix(new Gtk.Image({
            icon_name: 'external-link-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        issuesRow.connect('activated', () => {
            Gtk.show_uri(null, 'https://github.com/duascreenaligner/dua-screen-aligner/issues', Gdk.CURRENT_TIME);
        });
        linksGroup.add(issuesRow);

        return page;
    }

    // ========================================================================
    // GSettings Helpers
    // ========================================================================

    /**
     * _parseMonitors — Deserialize monitor layout from GSettings JSON.
     */
    _parseMonitors(settings) {
        try {
            const json = settings.get_string('monitor-layout');
            if (!json) return [];
            const data = JSON.parse(json);
            return data.monitors || [];
        } catch (e) {
            log(`[DuaScreen] Failed to parse monitor layout: ${e.message}`);
            return [];
        }
    }

    /**
     * _getSystemMonitorCount — Returns the number of monitors detected by Gdk.
     */
    _getSystemMonitorCount() {
        try {
            const display = Gdk.Display.get_default();
            if (!display) return 0;
            const monitors = display.get_monitors();
            return monitors ? monitors.get_n_items() : 0;
        } catch (e) {
            return 0;
        }
    }

    /**
     * _detectSystemMonitors — Auto-detect monitors from the system.
     * Uses Gdk.Display for positions/sizes and xrandr for physical dimensions.
     */
    _detectSystemMonitors() {
        const result = [];
        try {
            const display = Gdk.Display.get_default();
            if (!display) return result;

            const monitorList = display.get_monitors();
            if (!monitorList) return result;

            // First, try to get physical dimensions from xrandr (more reliable).
            const physDims = this._getPhysicalDimensionsFromXrandr();

            const n = monitorList.get_n_items();
            for (let i = 0; i < n; i++) {
                const mon = monitorList.get_item(i);
                const geom = mon.get_geometry();
                const connector = mon.get_connector() || `Display ${i + 1}`;

                // Get physical dimensions from xrandr data or Gdk.
                let width_mm = 0, height_mm = 0;
                if (physDims[connector]) {
                    width_mm = physDims[connector].width_mm;
                    height_mm = physDims[connector].height_mm;
                } else {
                    width_mm = mon.get_width_mm();
                    height_mm = mon.get_height_mm();
                }

                result.push({
                    name: connector,
                    x: geom.x,
                    y: geom.y,
                    width_px: geom.width,
                    height_px: geom.height,
                    width_mm: width_mm || 0,
                    height_mm: height_mm || 0,
                    dpi_override: 0,
                });
            }

            log(`[DuaScreen] Auto-detected ${result.length} monitors from system`);
            result.forEach((m, i) => {
                const dpi = m.width_mm > 0 ? (m.width_px / (m.width_mm / 25.4)).toFixed(1) : '?';
                log(`[DuaScreen]   [${i}] ${m.name}: ${m.width_px}x${m.height_px}+${m.x}+${m.y} (${m.width_mm}mm x ${m.height_mm}mm, DPI=${dpi})`);
            });
        } catch (e) {
            log(`[DuaScreen] Monitor auto-detect failed: ${e.message}`);
        }
        return result;
    }

    /**
     * _getPhysicalDimensionsFromXrandr — Parse xrandr output for physical dims.
     * Returns a map of { connector: { width_mm, height_mm } }.
     * Handles rotation by swapping dims for left/right rotated monitors.
     */
    _getPhysicalDimensionsFromXrandr() {
        const dims = {};
        try {
            const [ok, stdout] = GLib.spawn_command_line_sync('xrandr --query');
            if (!ok || !stdout) return dims;

            const output = new TextDecoder().decode(stdout);
            const re = /^(\S+)\s+connected\s+(?:primary\s+)?\d+x\d+\+\d+\+\d+\s+(\w+)?\s*\(.*?\)\s+(\d+)mm\s+x\s+(\d+)mm/gm;
            let match;
            while ((match = re.exec(output)) !== null) {
                const name = match[1];
                const rotation = match[2] || 'normal';
                let w = parseInt(match[3], 10);
                let h = parseInt(match[4], 10);
                // Swap dims for rotated monitors.
                if (rotation === 'left' || rotation === 'right') {
                    [w, h] = [h, w];
                }
                dims[name] = { width_mm: w, height_mm: h };
            }
        } catch (e) {
            log(`[DuaScreen] xrandr parse failed: ${e.message}`);
        }
        return dims;
    }

    /**
     * _saveMonitors — Serialize monitor layout to GSettings JSON.
     */
    _saveMonitors(settings, monitors) {
        const layout = {
            monitors: monitors,
            device_path: settings.get_string('input-device'),
        };
        settings.set_string('monitor-layout', JSON.stringify(layout));
    }

    // ========================================================================
    // DBus Communication
    // ========================================================================

    /**
     * _pushLayoutToDaemon — Send the current layout to the daemon via DBus.
     */
    _pushLayoutToDaemon(monitors, settings) {
        const layout = {
            monitors: monitors,
            device_path: settings.get_string('input-device'),
        };
        const json = JSON.stringify(layout);

        this._callDaemonMethod('SetLayout', new GLib.Variant('(s)', [json]),
            (result) => {
                log(`[DuaScreen] Layout applied: ${result}`);
            },
            (error) => {
                log(`[DuaScreen] Failed to apply layout: ${error.message}`);
            }
        );
    }

    /**
     * _queryDevicesAsync — Populate the device combo row via DBus ListDevices.
     */
    _queryDevicesAsync(model, row, settings) {
        this._callDaemonMethod('ListDevices', null,
            (result) => {
                try {
                    const [devicesJson] = result.deep_unpack();
                    const devices = JSON.parse(devicesJson);
                    const savedDevice = settings.get_string('input-device');
                    let selectedIdx = 0;

                    devices.forEach((dev, idx) => {
                        model.append(`${dev.name} (${dev.path})`);
                        if (dev.path === savedDevice) {
                            selectedIdx = idx + 1; // +1 for "Auto-detect"
                        }
                    });

                    row.set_selected(selectedIdx);

                    row.connect('notify::selected', () => {
                        const sel = row.get_selected();
                        if (sel === 0) {
                            settings.set_string('input-device', '');
                        } else if (sel - 1 < devices.length) {
                            settings.set_string('input-device', devices[sel - 1].path);
                        }
                    });
                } catch (e) {
                    log(`[DuaScreen] Failed to parse devices: ${e.message}`);
                }
            },
            (error) => {
                log(`[DuaScreen] ListDevices failed: ${error.message}`);
            }
        );
    }

    /**
     * _queryDaemonVersionAsync — Fetch daemon version via DBus property.
     */
    _queryDaemonVersionAsync(row) {
        this._callDaemonMethod('GetStatus', null,
            (result) => {
                const [status] = result.deep_unpack();
                row.set_subtitle(`Connected (${status})`);
            },
            () => {
                row.set_subtitle(_('Not running'));
            }
        );
    }

    /**
     * _callDaemonMethod — Generic async DBus method call helper.
     * Tries system bus first, then session bus.
     */
    _callDaemonMethod(method, params, onSuccess, onError) {
        const busTypes = [Gio.BusType.SYSTEM, Gio.BusType.SESSION];

        const tryBus = (busIdx) => {
            if (busIdx >= busTypes.length) {
                onError(new Error('All bus connections failed'));
                return;
            }

            Gio.DBusConnection.new_for_address(
                busTypes[busIdx] === Gio.BusType.SYSTEM ? 'unix:path=/var/run/dbus/system_bus_socket' : '',
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                null, null, null
            );

            // Use the simpler Gio.bus_get approach.
            Gio.bus_get(busTypes[busIdx], null, (obj, res) => {
                try {
                    const conn = Gio.bus_get_finish(res);
                    conn.call(
                        DBUS_NAME, DBUS_PATH, DBUS_IFACE,
                        method, params,
                        null, Gio.DBusCallFlags.NONE,
                        5000, null,
                        (conn2, res2) => {
                            try {
                                const result = conn2.call_finish(res2);
                                onSuccess(result);
                            } catch (e) {
                                if (busIdx === 0) tryBus(1);
                                else onError(e);
                            }
                        }
                    );
                } catch (e) {
                    if (busIdx === 0) tryBus(1);
                    else onError(e);
                }
            });
        };

        tryBus(0);
    }
}
