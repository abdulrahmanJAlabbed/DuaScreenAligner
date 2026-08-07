// prefs.js — GNOME Shell extension preferences entry point.
//
// Thin wrapper. The entire editor UI lives in editor.js, shared verbatim with
// the standalone desktop app (app.js). Here we only bridge GNOME's extension
// environment: hand the editor GNOME's gettext and this extension's GSettings,
// then let it fill the preferences window.
import { ExtensionPreferences, gettext } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { DuaEditor, setGettext } from './editor.js';

export default class DuaScreenPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        setGettext(gettext);
        this._editor = new DuaEditor(this.getSettings());
        this._editor.fill(window);
    }
}
