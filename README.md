<p align="center">
  <img src="extension/icons/dua-screen-aligner.svg" width="96" alt="DuaScreen Aligner icon">
</p>

<h1 align="center">DuaScreen Aligner</h1>

<p align="center">
  Align mixed-DPI, mixed-orientation monitors — and span one wallpaper
  <em>physically</em> across them, so the image stays continuous across the bezel.
</p>

---

## What it does

Multi-monitor setups with different sizes, resolutions or orientations (say a
portrait panel next to a landscape one) have two annoyances GNOME doesn't solve
on its own:

1. **The wallpaper breaks at the bezel.** GNOME's "spanned" mode maps the image
   by *logical pixels*, so at mixed DPI a straight line in the picture bends
   where the screens meet. DuaScreen Aligner maps the image in **physical space
   (millimeters)** — each display samples the region of the picture its panel
   physically covers, at its own pixel density — so the image is continuous in
   the real world, not just in pixel coordinates.

2. **The cursor jumps at the seam / changes speed between screens.** An optional
   companion daemon corrects pointer speed when crossing a DPI boundary and
   anchors the seam where the panels actually sit on your desk.

Plus a per-display **picture editor**: pan, zoom and crop the wallpaper
independently on each screen (portrait gets its own framing, landscape gets
another), remembered per image.

## Two ways to run it

| | GNOME extension | Standalone app |
|---|---|---|
| Launch | Panel button / Extensions app | App grid → **DuaScreen Aligner** |
| Needs | GNOME Shell, enable + shell reload | Just `gjs` + Adwaita |
| Best for | Living in the panel | Quick edits, no shell fuss |

Both share the exact same editor UI (`editor.js`) — no duplicate code.

## Install

### Standalone app (no root, no shell restart)

```bash
make install-app
```

Then launch **DuaScreen Aligner** from your apps (or `gjs -m
~/.local/share/dua-screen-aligner/app.js`). Remove with `make uninstall-app`.

### GNOME extension

```bash
make install-extension
# then log out/in (or on X11: Alt+F2 → r), and:
gnome-extensions enable dua-screen-aligner@duascreenaligner.github.com
```

### Optional: cursor-correction daemon

The alignment editor and wallpaper features work **without** the daemon. The
daemon only adds cross-DPI cursor-speed correction, and needs root (it grabs
the mouse via `evdev` and re-injects via `uinput`):

```bash
sudo make install-daemon
```

> Note: the daemon takes exclusive control of the mouse. If pointer behaviour
> ever feels wrong, stop it with `sudo systemctl stop dua-screen-aligner` — the
> editor and wallpaper spanning keep working.

## Usage

1. Open the app (or the extension preferences).
2. **Detect Displays** reads your monitors, sizes and DPI.
3. **Align** snaps the seam to the panels' real physical offset (or opens the
   wizard to set it once — it's remembered).
4. **Wallpaper…** picks an image; it's stitched and spanned automatically.
5. Click a display to frame *its* slice of the picture:
   - right-drag or **Alt+arrows** — pan
   - Ctrl+scroll or **Alt+±** — zoom
   - **Fit** / **Span** presets
6. **Apply**.

Per-display framing is keyed to each panel's **EDID identity**
(vendor:product:serial), so your settings follow the physical monitor across
reboots, port changes and OS switches — not the connector it happens to be in.

## Build / develop

```bash
make build      # Go daemon + compile GSettings schemas
make test       # go vet + race tests + schema strict + extension validate
make dist       # extension .zip (for extensions.gnome.org) + daemon .deb
```

Layout:

- `extension/editor.js` — the full editor UI (shared by app + extension)
- `extension/prefs.js` — thin GNOME-extension wrapper over the editor
- `extension/app.js` — standalone Adwaita application entry
- `extension/extension.js` — panel button + daemon sync (extension only)
- `extension/displayConfig.js` — Mutter DisplayConfig (DBus) helpers
- `daemon/` — Go cursor-correction daemon (evdev grab → transform → uinput)

## License

MIT — see [LICENSE](LICENSE).
