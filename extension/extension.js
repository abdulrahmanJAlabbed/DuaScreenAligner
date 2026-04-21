// extension.js — GNOME Shell Extension entry point (GNOME 45+ ES Module).
//
// Provides a top-bar panel indicator showing the DuaScreenAligner daemon
// status. Communicates with the daemon via asynchronous DBus calls on the
// system bus. The indicator icon reflects the daemon state:
//   - Active (accent): cursor correction is running
//   - Paused (dim): daemon is running but correction disabled
//   - Error (warning): daemon encountered an error or is not running
//   - Unknown (neutral): daemon status not yet determined
//
// The popup menu provides quick controls: enable/disable toggle, open
// preferences, and a status label.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// ============================================================================
// Constants
// ============================================================================

// DBus coordinates for the daemon service.
const DBUS_NAME = 'com.github.duascreenaligner.Daemon';
const DBUS_PATH = '/com/github/duascreenaligner/Daemon';
const DBUS_IFACE = 'com.github.duascreenaligner.Daemon';

// Polling interval (ms) for daemon status when signal-based updates fail.
const STATUS_POLL_INTERVAL_MS = 5000;

// Icon names for each daemon state (using standard symbolic icons).
const STATE_ICONS = {
    'running':      'display-dual-symbolic',
    'paused':       'display-dual-symbolic',
    'error':        'dialog-warning-symbolic',
    'unconfigured': 'preferences-desktop-display-symbolic',
    'unknown':      'preferences-desktop-display-symbolic',
};

// ============================================================================
// DBus Proxy Interface Definition
// ============================================================================

// XML interface description for GDBusProxy auto-generation.
const DaemonIface = `
<node>
  <interface name="${DBUS_IFACE}">
    <method name="GetStatus">
      <arg type="s" direction="out" name="status"/>
    </method>
    <method name="SetEnabled">
      <arg type="b" direction="in" name="enabled"/>
      <arg type="b" direction="out" name="success"/>
    </method>
    <method name="ReloadDevice">
      <arg type="b" direction="out" name="success"/>
    </method>
    <signal name="StatusChanged">
      <arg type="s" name="status"/>
    </signal>
    <property name="Version" type="s" access="read"/>
    <property name="Enabled" type="b" access="read"/>
  </interface>
</node>
`;

// Generate the proxy wrapper class from the interface XML.
const DaemonProxy = Gio.DBusProxy.makeProxyWrapper(DaemonIface);

// ============================================================================
// Panel Indicator
// ============================================================================

/**
 * DuaScreenIndicator — Top-bar panel button with popup menu.
 *
 * Displays a symbolic icon reflecting daemon state, with a dropdown menu
 * containing: status label, enable/disable toggle, and preferences launcher.
 */
const DuaScreenIndicator = GObject.registerClass(
class DuaScreenIndicator extends PanelMenu.Button {

    /**
     * _init — Construct the panel button and popup menu.
     *
     * @param {Extension} ext - The parent Extension instance (for getSettings,
     *                          openPreferences, path, etc.)
     */
    _init(ext) {
        super._init(0.0, 'DuaScreen Aligner');

        this._ext = ext;
        this._proxy = null;
        this._proxySignalId = 0;
        this._pollTimerId = 0;
        this._currentStatus = 'unknown';

        // ---- Panel Icon ----
        this._icon = new St.Icon({
            icon_name: STATE_ICONS['unknown'],
            style_class: 'system-status-icon dua-panel-icon',
        });
        this.add_child(this._icon);

        // ---- Popup Menu Items ----
        this._buildMenu();

        // ---- Connect to daemon via async DBus proxy ----
        this._initProxy();

        // ---- Monitor change listener ----
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._pushCurrentLayout();
        });
    }

    /**
     * _buildMenu — Construct the popup menu contents.
     */
    _buildMenu() {
        // Status label (non-interactive, informational).
        this._statusItem = new PopupMenu.PopupMenuItem('Daemon: checking...', {
            reactive: false,
            style_class: 'dua-status-label',
        });
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Enable/Disable toggle switch.
        this._enableToggle = new PopupMenu.PopupSwitchMenuItem('Cursor Correction', false);
        this._enableToggle.connect('toggled', (_item, state) => {
            this._onToggleCorrectionAsync(state);
        });
        this.menu.addMenuItem(this._enableToggle);

        // Reload device action.
        const reloadItem = new PopupMenu.PopupMenuItem('Rescan Input Devices');
        reloadItem.connect('activate', () => {
            this._onReloadDeviceAsync();
        });
        this.menu.addMenuItem(reloadItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Preferences launcher.
        const prefsItem = new PopupMenu.PopupMenuItem('Preferences…');
        prefsItem.connect('activate', () => {
            this._ext.openPreferences();
        });
        this.menu.addMenuItem(prefsItem);
    }

    /**
     * _initProxy — Create an async DBus proxy to the daemon.
     *
     * Uses Gio.DBusProxy.new_for_bus (async) to avoid blocking the shell.
     * Falls back to polling if signal subscription fails.
     */
    _initProxy() {
        try {
            // Attempt system bus first, fall back to session bus.
            this._proxy = new DaemonProxy(
                Gio.DBus.system,
                DBUS_NAME,
                DBUS_PATH,
                (proxy, error) => {
                    if (error) {
                        log(`[DuaScreen] System bus proxy failed, trying session: ${error.message}`);
                        this._trySessionBus();
                        return;
                    }
                    this._onProxyReady();
                }
            );
        } catch (e) {
            log(`[DuaScreen] Proxy creation failed: ${e.message}`);
            this._trySessionBus();
        }
    }

    /**
     * _trySessionBus — Fallback: connect via session bus (for development).
     */
    _trySessionBus() {
        try {
            this._proxy = new DaemonProxy(
                Gio.DBus.session,
                DBUS_NAME,
                DBUS_PATH,
                (_proxy, error) => {
                    if (error) {
                        log(`[DuaScreen] Session bus also failed: ${error.message}`);
                        this._updateUI('error');
                        this._startPolling();
                        return;
                    }
                    this._onProxyReady();
                }
            );
        } catch (e) {
            log(`[DuaScreen] All bus connections failed: ${e.message}`);
            this._updateUI('error');
            this._startPolling();
        }
    }

    /**
     * _onProxyReady — Called when the DBus proxy is successfully created.
     * Subscribes to StatusChanged signals and performs initial status query.
     */
    _onProxyReady() {
        if (!this._proxy) return;

        // Subscribe to the StatusChanged signal for real-time updates.
        this._proxySignalId = this._proxy.connectSignal(
            'StatusChanged',
            (_proxy, _nameOwner, [status]) => {
                this._updateUI(status);
            }
        );

        // Initial status query.
        this._queryStatusAsync();

        // Push initial layout to daemon.
        this._pushCurrentLayout();

        // Start a slow poll as a safety net (signal delivery isn't guaranteed).
        this._startPolling();
    }

    /**
     * _queryStatusAsync — Fetch current daemon status via async DBus call.
     */
    _queryStatusAsync() {
        if (!this._proxy) return;

        this._proxy.GetStatusRemote((result, error) => {
            if (error) {
                this._updateUI('error');
                return;
            }
            const [status] = result;
            this._updateUI(status);
        });
    }

    /**
     * _onToggleCorrectionAsync — Enable/disable correction via DBus.
     *
     * @param {boolean} enabled - New enabled state.
     */
    _onToggleCorrectionAsync(enabled) {
        if (!this._proxy) return;

        this._proxy.SetEnabledRemote(enabled, (result, error) => {
            if (error) {
                log(`[DuaScreen] SetEnabled failed: ${error.message}`);
                // Revert the toggle visually.
                this._enableToggle.setToggleState(!enabled);
            }
        });
    }

    /**
     * _onReloadDeviceAsync — Request device rescan via DBus.
     */
    _onReloadDeviceAsync() {
        if (!this._proxy) return;

        this._proxy.ReloadDeviceRemote((_result, error) => {
            if (error) {
                log(`[DuaScreen] ReloadDevice failed: ${error.message}`);
            }
        });
    }

    /**
     * _pushCurrentLayout — Sync current monitor layout to the daemon.
     * Tries to use saved preferences first, falls back to system geometry.
     */
    _pushCurrentLayout() {
        if (!this._proxy) return;

        const settings = this._ext.getSettings();
        const savedLayoutJson = settings.get_string('monitor-layout');
        let monitors = [];

        try {
            if (savedLayoutJson) {
                monitors = JSON.parse(savedLayoutJson);
            }
        } catch (e) {
            log(`[DuaScreen] Failed to parse saved layout: ${e.message}`);
        }

        // If no saved layout or monitor count mismatch, use system geometry.
        const currentCount = Main.layoutManager.monitors.length;
        if (monitors.length !== currentCount) {
            log(`[DuaScreen] Layout mismatch (saved: ${monitors.length}, actual: ${currentCount}). Using system geometry.`);
            monitors = Main.layoutManager.monitors.map(m => {
                // Get physical dimensions from MonitorManager if possible.
                let width_mm = 0, height_mm = 0;
                try {
                    const monitorManager = Meta.MonitorManager.get();
                    const metaMonitors = monitorManager.get_monitors();
                    if (m.index < metaMonitors.length) {
                        [width_mm, height_mm] = metaMonitors[m.index].get_dimensions();
                    }
                } catch (e) {}

                return {
                    name: `Monitor ${m.index}`,
                    x: m.x,
                    y: m.y,
                    width_px: m.width,
                    height_px: m.height,
                    width_mm: width_mm || 0,
                    height_mm: height_mm || 0,
                    dpi_override: 0
                };
            });
        }

        const layout = {
            monitors: monitors,
            device_path: settings.get_string('input-device'),
        };

        this._proxy.SetLayoutRemote(JSON.stringify(layout), (success, error) => {
            if (error) {
                log(`[DuaScreen] Auto-SetLayout failed: ${error.message}`);
            } else {
                log(`[DuaScreen] Layout synced automatically (${monitors.length} monitors)`);
            }
        });
    }

    /**
     * _startPolling — Begin periodic status polling as a fallback mechanism.
     */
    _startPolling() {
        if (this._pollTimerId) return; // Already polling.

        this._pollTimerId = GLib.timeout_add(
            GLib.PRIORITY_LOW,
            STATUS_POLL_INTERVAL_MS,
            () => {
                this._queryStatusAsync();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    /**
     * _updateUI — Update the panel icon and menu to reflect daemon state.
     *
     * @param {string} status - One of: 'running', 'paused', 'error', 'unconfigured', 'unknown'.
     */
    _updateUI(status) {
        this._currentStatus = status;

        // Update icon.
        const iconName = STATE_ICONS[status] || STATE_ICONS['unknown'];
        this._icon.icon_name = iconName;

        // Update icon style for state indication.
        this._icon.remove_style_class_name('dua-state-running');
        this._icon.remove_style_class_name('dua-state-paused');
        this._icon.remove_style_class_name('dua-state-error');

        if (status === 'running') {
            this._icon.add_style_class_name('dua-state-running');
        } else if (status === 'paused') {
            this._icon.add_style_class_name('dua-state-paused');
        } else if (status === 'error' || status === 'unknown') {
            this._icon.add_style_class_name('dua-state-error');
        }

        // Update status label with user-friendly text.
        const statusLabels = {
            'running':      'Active — correcting cursor',
            'paused':       'Paused — passthrough mode',
            'error':        'Daemon not available',
            'unconfigured': 'Waiting for configuration',
            'unknown':      'Checking daemon status…',
        };
        this._statusItem.label.text = statusLabels[status] || `Status: ${status}`;

        // Update toggle state (don't emit 'toggled' signal).
        this._enableToggle.setToggleState(status === 'running');
        this._enableToggle.setSensitive(status === 'running' || status === 'paused');
    }

    /**
     * destroy — Clean up all resources to prevent memory leaks.
     * Called by GNOME Shell when the extension is disabled.
     */
    destroy() {
        // Remove the status poll timer.
        if (this._pollTimerId) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = 0;
        }

        // Disconnect monitor listener.
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        // Disconnect DBus signal subscription.
        if (this._proxy && this._proxySignalId) {
            this._proxy.disconnectSignal(this._proxySignalId);
            this._proxySignalId = 0;
        }

        // Null out references.
        this._proxy = null;
        this._ext = null;
        this._icon = null;
        this._statusItem = null;
        this._enableToggle = null;

        super.destroy();
    }
});

// ============================================================================
// Extension Entry Point
// ============================================================================

/**
 * DuaScreenAligner Extension — Main extension class.
 *
 * Manages the lifecycle of the panel indicator. Creates it on enable(),
 * destroys it on disable(). Follows GNOME Shell extension best practices
 * for GNOME 45+ (ES Module, Extension base class).
 */
export default class DuaScreenAlignerExtension extends Extension {

    /**
     * enable — Called by GNOME Shell when the extension is activated.
     * Creates the panel indicator and adds it to the system status area.
     */
    enable() {
        log('[DuaScreen] Extension enabled');
        this._indicator = new DuaScreenIndicator(this);
        Main.panel.addToStatusArea('dua-screen-aligner', this._indicator);
    }

    /**
     * disable — Called by GNOME Shell when the extension is deactivated.
     * Destroys the panel indicator and nullifies all references.
     */
    disable() {
        log('[DuaScreen] Extension disabled');
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
