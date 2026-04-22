// extension.js — GNOME Shell Extension entry point (GNOME 45+ ES Module).
// Fully simplified to display measurements on screen borders only.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ============================================================================
// Measurement Display
// ============================================================================

const MeasurementOverlay = GObject.registerClass(
class MeasurementOverlay extends St.Widget {
    _init() {
        super._init({
            style_class: 'measurement-overlay',
            reactive: false,
        });

        this._createMeasurements();
    }

    _createMeasurements() {
        const monitors = Main.layoutManager.monitors;

        monitors.forEach((monitor) => {
            // Create a container for each monitor's measurements.
            const container = new St.Widget({
                layout_manager: new Clutter.BoxLayout(),
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                reactive: false,
            });

            // Add top measurement.
            const topLabel = new St.Label({
                text: `${monitor.width}px`,
                style_class: 'measurement-label',
            });
            container.add_child(topLabel);

            // Add left measurement.
            const leftLabel = new St.Label({
                text: `${monitor.height}px`,
                style_class: 'measurement-label',
            });
            leftLabel.set_position(0, monitor.height / 2);
            container.add_child(leftLabel);

            this.add_child(container);
        });
    }
});

// ============================================================================
// Extension Entry Point
// ============================================================================

export default class DuaScreenAlignerExtension {
    enable() {
        log('[DuaScreen] Extension enabled');

        try {
            this._overlay = new MeasurementOverlay();
            Main.layoutManager.addChrome(this._overlay);
            log('[DuaScreen] MeasurementOverlay successfully added to the screen.');
        } catch (error) {
            log(`[DuaScreen] Error initializing MeasurementOverlay: ${error.message}`);
        }
    }

    disable() {
        log('[DuaScreen] Extension disabled');
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
            log('[DuaScreen] MeasurementOverlay successfully removed.');
        }
    }
}
