# DuaScreen Aligner

**Multi-monitor DPI cursor correction for Linux.** Fixes the jarring cursor speed change when moving between monitors with different pixel densities (e.g., a 4K laptop display next to a 1080p external monitor).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    GNOME Shell Extension                 │
│  ┌──────────────┐  ┌─────────────────────────────────┐  │
│  │ Panel        │  │ Preferences (Libadwaita/GTK4)    │  │
│  │ Indicator    │  │  ┌───────────────────────────┐   │  │
│  │ (extension.js│  │  │ Monitor Topology Map      │   │  │
│  │  status icon)│  │  │ (drag & drop alignment)   │   │  │
│  └──────┬───────┘  │  └───────────────────────────┘   │  │
│         │          │  DPI overrides • Device select    │  │
│         │          └──────────────┬────────────────────┘  │
└─────────┼───────────────────────┼────────────────────────┘
          │    DBus (async)        │    DBus (SetLayout)
          ▼                        ▼
┌─────────────────────────────────────────────────────────┐
│                     Go Daemon (root)                     │
│                                                          │
│   /dev/input/eventX ──► evdev.go ──► transform.go ──►    │
│   (EVIOCGRAB)           (read)       (DPI matrix)        │
│                                          │               │
│                                          ▼               │
│                                      uinput.go ──►       │
│                                      (inject)    /dev/    │
│                                                  uinput   │
│   dbus_service.go ◄── config from extension              │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Go 1.22+
- GNOME Shell 45, 46, or 47
- `glib-compile-schemas` (usually in `libglib2.0-dev`)
- Root access (for evdev/uinput)

### Build & Install

```bash
# Build the daemon
make build

# Run tests (includes zero-allocation verification)
make test

# Install everything (daemon + extension + systemd + udev)
make install

# Or install components individually:
make install-daemon      # Binary + systemd service
make install-extension   # GNOME extension + schemas
make install-udev        # Device permission rules
```

### Enable

```bash
# Start the daemon
sudo systemctl enable --now dua-screen-aligner

# Enable the GNOME extension
gnome-extensions enable dua-screen-aligner@duascreenaligner.github.com
```

### Configure

Open GNOME Extensions → DuaScreen Aligner → Preferences, or:

```bash
gnome-extensions prefs dua-screen-aligner@duascreenaligner.github.com
```

## Testing & Validation

### Unit Tests

```bash
# Run all tests with race detector
cd daemon && go test -v -race ./...

# Zero-allocation benchmark (expected: 0 allocs/op)
cd daemon && go test -bench=. -benchmem -count=5 ./...
```

### Memory Profiling (pprof)

```bash
# Start daemon with profiling enabled
make pprof

# In another terminal, verify zero heap allocations in hot path:
go tool pprof http://localhost:6060/debug/pprof/heap
go tool pprof -alloc_space http://localhost:6060/debug/pprof/heap
```

### Extension Validation

```bash
# Validate extension structure
gnome-extensions validate extension/

# Compile schemas (strict mode catches errors)
glib-compile-schemas --strict extension/schemas/

# Test in nested Wayland session (safe, isolated)
make dev-session
```

### Input Latency Measurement

```bash
# Measure event processing latency
sudo perf stat -e cycles,instructions,cache-misses \
  ./build/dua-screen-aligner --device=/dev/input/event3

# Verify virtual device output
sudo evtest  # Select "DuaScreen Virtual Mouse"
```

### DBus Interface Testing

```bash
# Query daemon status
busctl --system call com.github.duascreenaligner.Daemon \
  /com/github/duascreenaligner/Daemon \
  com.github.duascreenaligner.Daemon \
  GetStatus

# Push a test layout
busctl --system call com.github.duascreenaligner.Daemon \
  /com/github/duascreenaligner/Daemon \
  com.github.duascreenaligner.Daemon \
  SetLayout s \
  '{"monitors":[{"name":"DP-1","x":0,"y":0,"width_px":1920,"height_px":1080,"width_mm":527,"height_mm":296},{"name":"HDMI-1","x":1920,"y":0,"width_px":3840,"height_px":2160,"width_mm":600,"height_mm":340}]}'

# List detected devices
busctl --system call com.github.duascreenaligner.Daemon \
  /com/github/duascreenaligner/Daemon \
  com.github.duascreenaligner.Daemon \
  ListDevices

# Enable/disable correction
busctl --system call com.github.duascreenaligner.Daemon \
  /com/github/duascreenaligner/Daemon \
  com.github.duascreenaligner.Daemon \
  SetEnabled b true
```

## File Reference

| File | Purpose |
|------|---------|
| `daemon/main.go` | Entry point, signal handling, event loop orchestration |
| `daemon/evdev.go` | evdev device I/O, EVIOCGRAB, zero-alloc reads |
| `daemon/uinput.go` | Virtual mouse creation, zero-alloc event injection |
| `daemon/transform.go` | DPI transformation matrices, fixed-point math |
| `daemon/dbus_service.go` | DBus system bus interface implementation |
| `daemon/config.go` | Configuration types, JSON serialization |
| `extension/extension.js` | GNOME Shell panel indicator |
| `extension/prefs.js` | Libadwaita preferences with monitor topology map |
| `extension/stylesheet.css` | Panel indicator styling |
| `dbus/*.xml` | DBus introspection contract |
| `systemd/*.service` | systemd unit with security hardening |
| `udev/*.rules` | Device permission rules |

## Uninstall

```bash
make uninstall
```
