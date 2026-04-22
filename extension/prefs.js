// prefs.js — Simplified Preferences Window for DuaScreen Aligner.
// Removed DBus-related functionality and simplified preferences.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ============================================================================
// Preferences Entry Point
// ============================================================================

export default class DuaScreenPreferences extends ExtensionPreferences {

    /**
     * fillPreferencesWindow — Populate the Adw.PreferencesWindow.
     *
     * Called by GNOME Shell when the user opens extension preferences.
     * This simplified version only provides a basic About page.
     *
     * @param {Adw.PreferencesWindow} window - The preferences window to fill.
     */
    fillPreferencesWindow(window) {
        // Set a default window size.
        window.set_default_size(400, 300);
        window.set_search_enabled(false);

        // ---- About Page ----
        window.add(this._buildAboutPage());
    }

    // ========================================================================
    // About Page
    // ========================================================================

    /**
     * _buildAboutPage — Creates the About page with basic extension info.
     */
    _buildAboutPage() {
        const page = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });

        const group = new Adw.PreferencesGroup();
        page.add(group);

        const label = new Gtk.Label({
            label: '<b>DuaScreen Aligner</b>\n\nA GNOME Shell extension to display measurements on screen borders.',
            use_markup: true,
            wrap: true,
            xalign: 0.5,
        });
        group.add(label);

        return page;
    }
}
