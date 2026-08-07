#!/usr/bin/env -S gjs -m
// app.js — Standalone desktop-app entry point for DuaScreen Aligner.
//
// Runs the exact same editor UI as the GNOME Shell extension (editor.js), but
// as an ordinary Adwaita application: launch it from the app grid, no shell
// restart, no enable toggle, no vanishing panel button.
//
// The editor's GSettings schema is the extension's schema. We load it from the
// local schemas/ directory next to this script, so the app works whether or
// not the GNOME extension is installed.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import { DuaEditor, setGettext } from './editor.js';

const APP_ID = 'com.github.duascreenaligner.App';
const SCHEMA_ID = 'org.gnome.shell.extensions.dua-screen-aligner';

// Absolute directory containing this script (…/dua-screen-aligner or the
// extension dir), used to locate the compiled schemas/ alongside it.
function scriptDir() {
    const p = GLib.uri_parse(import.meta.url, GLib.UriFlags.NONE).get_path();
    return GLib.path_get_dirname(p);
}

// Load the extension's GSettings schema from the local schemas/ dir, falling
// back to the system default source (in case it's installed system-wide).
function loadSettings() {
    const schemaDir = GLib.build_filenamev([scriptDir(), 'schemas']);
    let source = Gio.SettingsSchemaSource.get_default();
    if (GLib.file_test(GLib.build_filenamev([schemaDir, 'gschemas.compiled']),
                       GLib.FileTest.EXISTS)) {
        source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, source, false);
    }
    const schema = source.lookup(SCHEMA_ID, true);
    if (!schema) {
        throw new Error(
            `GSettings schema ${SCHEMA_ID} not found. Expected a compiled schema in ` +
            `${schemaDir} (run: glib-compile-schemas schemas).`);
    }
    return new Gio.Settings({ settings_schema: schema });
}

const app = new Adw.Application({
    application_id: APP_ID,
    flags: Gio.ApplicationFlags.FLAGS_NONE,
});

app.connect('activate', () => {
    let win = app.get_active_window();
    if (!win) {
        win = new Adw.PreferencesWindow({
            application: app,
            title: 'DuaScreen Aligner',
        });
        // Standalone app has no translation domain wired up: identity gettext.
        setGettext((s) => s);
        try {
            const editor = new DuaEditor(loadSettings());
            editor.fill(win);
        } catch (e) {
            // Surface schema/load failures in a dialog instead of a silent crash.
            const dlg = new Adw.MessageDialog({
                transient_for: win,
                modal: true,
                heading: 'Could not start',
                body: String(e.message || e),
            });
            dlg.add_response('ok', 'OK');
            dlg.connect('response', () => app.quit());
            win.present();
            dlg.present();
            return;
        }
    }
    win.present();
});

app.run([System.programInvocationName, ...ARGV]);
