# DuaScreen Aligner

**Multi-monitor alignment, DPI cursor correction, and physically-continuous wallpapers for Linux (GNOME/X11).**

Mixed-DPI multi-monitor setups suffer from three problems this project fixes:

1. **Monitor seam misalignment** — the logical layout offset doesn't match how the panels physically sit on your desk, so windows and the cursor "jump" when crossing the bezel.
2. **Cursor speed changes** — the pointer covers different physical distance per count on each monitor's pixel density.
3. **Broken spanning wallpapers** — pixel-space spanning makes one image physically discontinuous across different-DPI panels.

## Components

```
┌──────────────────────────────────────────────────────────────┐
│ GNOME Shell Extension                                        │
│  extension.js   panel indicator, async daemon sync,          │
│                 periodic cursor-position sync                │
│  prefs.js       Displays-style arrangement editor:           │
│                 drag + snap, physical (mm) alignment,        │
│                 seam wizard launcher, wallpaper engine       │
│  alignWizard.js standalone fullscreen alignment wizard       │
│                 (physical ruler lines + cursor-click marks)  │
│  displayConfig.js  Mutter DisplayConfig wrapper              │
└───────────────┬──────────────────────────────────────────────┘
                │ DBus (system bus)          │ Mutter (session)
                ▼                            ▼
┌──────────────────────────────┐   VERIFY → PERSISTENT apply
│ Go daemon (root, systemd)    │
│  evdev grab → DPI transform  │
│  → uinput inject             │
│  zero-alloc hot path,        │
│  poll-based reads,           │
│  teardown button release     │
└──────────────────────────────┘
```

## Features

- **Arrangement editor** — GNOME-Displays-style canvas: drag monitors with edge snapping (Ctrl = free), keyboard nudge, primary selector. Layouts are validated by Mutter (VERIFY) before applying — invalid configs can never reach the X server.
- **Physical alignment** — one-click presets (tops/centers/bottoms level) computed from EDID panel sizes, or type the measured mm offset directly. The gap is remembered; the **Align** button reapplies it any time.
- **Align wizard** — both screens show one physical ruler (a line every 40 mm of glass). Adjust until the rulers merge, or hold a card across the bezel and click under its edge on both screens — alignment snaps automatically.
- **DPI cursor correction** — the daemon grabs the physical mouse, scales movement by each monitor's real DPI (primary monitor = baseline), and injects through a virtual device. Zero heap allocations in the hot path.
- **Physically-continuous wallpaper** — the image is stitched in millimeter space: each monitor gets the crop its glass physically covers, at its own pixel density. A straight line in the image stays straight across the bezel.
- **Per-display framing** — click a display and move/zoom/crop its picture independently (buttons, right-drag, Ctrl+scroll). Framing is remembered **per image**; a gallery shows current, last, and suggested wallpapers.

## Install

Requirements: Go 1.22+, GNOME Shell 45–47 (X11 session), `glib-compile-schemas`.

```bash
make build              # daemon + schemas
sudo make install       # daemon binary + DBus policy + extension
sudo systemctl enable --now dua-screen-aligner
gnome-extensions enable dua-screen-aligner@duascreenaligner.github.com
gnome-extensions prefs  dua-screen-aligner@duascreenaligner.github.com
```

Everything is one-time: the layout persists in Mutter, the daemon autostarts at boot, the stitched wallpaper is cached, and per-image framing survives restarts.

## Development

```bash
make test               # go vet + race tests + schema/extension checks
make bench              # zero-allocation benchmarks (expect 0 allocs/op)
make install-extension  # extension only (no root)
make pack-extension     # zip for extensions.gnome.org

# run the align wizard standalone for debugging
gjs -m extension/alignWizard.js

# daemon DBus surface
busctl --system call com.github.duascreenaligner.Daemon \
  /com/github/duascreenaligner/Daemon \
  com.github.duascreenaligner.Daemon GetStatus
```

| Path | Purpose |
|------|---------|
| `daemon/main.go` | event loop, reader-goroutine lifecycle, teardown button release |
| `daemon/evdev.go` | poll-based zero-alloc evdev reads, EVIOCGRAB |
| `daemon/uinput.go` | virtual mouse, bounded non-busy writes |
| `daemon/transform.go` | fixed-point DPI transform, primary-baseline scaling |
| `daemon/xrandr.go` | boot-time layout autodetect (incl. rotation + primary) |
| `daemon/dbus_service.go` | SetLayout / SetEnabled / SetCursorPosition / … |
| `extension/prefs.js` | arrangement editor + wallpaper engine |
| `extension/alignWizard.js` | standalone fullscreen alignment wizard |
| `extension/displayConfig.js` | Mutter GetCurrentState / ApplyMonitorsConfig |

## Uninstall

```bash
sudo systemctl disable --now dua-screen-aligner
sudo rm /usr/local/bin/dua-screen-aligner /etc/dbus-1/system.d/com.github.duascreenaligner.Daemon.conf
gnome-extensions uninstall dua-screen-aligner@duascreenaligner.github.com
```
