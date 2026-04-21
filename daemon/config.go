// Package main provides the DuaScreenAligner daemon, a privileged service that
// intercepts physical mouse input via evdev, applies DPI-aware spatial
// transformations for multi-monitor setups, and injects corrected coordinates
// through a virtual uinput device.
package main

import (
	"encoding/json"
	"fmt"
	"sync/atomic"
)

// ============================================================================
// Daemon State
// ============================================================================

// DaemonState represents the operational state of the daemon.
// Stored as an atomic uint32 for lock-free reads from the hot path.
type DaemonState uint32

const (
	// StateUnconfigured means no monitor layout has been received yet.
	StateUnconfigured DaemonState = iota
	// StateRunning means the daemon is actively intercepting and correcting input.
	StateRunning
	// StatePaused means correction is disabled; events pass through unmodified.
	StatePaused
	// StateError means the daemon encountered a fatal error in the input pipeline.
	StateError
)

// String returns the DBus-compatible string representation of a DaemonState.
func (s DaemonState) String() string {
	switch s {
	case StateUnconfigured:
		return "unconfigured"
	case StateRunning:
		return "running"
	case StatePaused:
		return "paused"
	case StateError:
		return "error"
	default:
		return "unknown"
	}
}

// ============================================================================
// Monitor Configuration
// ============================================================================

// MonitorConfig describes a single physical monitor and its position in the
// logical desktop coordinate space. All physical measurements are in
// millimeters; all pixel values are in logical pixels.
type MonitorConfig struct {
	// Name is the human-readable identifier (e.g., "DP-1", "HDMI-2").
	Name string `json:"name"`

	// X and Y define the top-left corner of this monitor in the unified
	// logical coordinate space (pixels).
	X int `json:"x"`
	Y int `json:"y"`

	// WidthPx and HeightPx are the monitor resolution in pixels.
	WidthPx int `json:"width_px"`
	HeightPx int `json:"height_px"`

	// WidthMM and HeightMM are the physical panel dimensions in millimeters.
	// Used to calculate true physical DPI.
	WidthMM float64 `json:"width_mm"`
	HeightMM float64 `json:"height_mm"`

	// DPIOverride, if non-zero, overrides the calculated DPI with a
	// user-specified value. Useful for monitors that report incorrect EDID data.
	DPIOverride float64 `json:"dpi_override,omitempty"`
}

// DPI returns the effective horizontal DPI for this monitor.
// Uses DPIOverride if set; otherwise calculates from pixel width and physical
// width in millimeters. Returns 96.0 as a safe default if physical dimensions
// are unavailable.
func (m *MonitorConfig) DPI() float64 {
	if m.DPIOverride > 0 {
		return m.DPIOverride
	}
	if m.WidthMM <= 0 {
		return 96.0 // Standard fallback DPI
	}
	// DPI = pixels / (mm / 25.4)
	return float64(m.WidthPx) / (m.WidthMM / 25.4)
}

// Bounds returns the bounding rectangle of this monitor in logical coordinates.
// Returns (x_min, y_min, x_max, y_max).
func (m *MonitorConfig) Bounds() (int, int, int, int) {
	return m.X, m.Y, m.X + m.WidthPx, m.Y + m.HeightPx
}

// ContainsPoint checks whether a logical coordinate (px, py) falls within
// this monitor's bounding rectangle.
func (m *MonitorConfig) ContainsPoint(px, py int) bool {
	xMin, yMin, xMax, yMax := m.Bounds()
	return px >= xMin && px < xMax && py >= yMin && py < yMax
}

// ============================================================================
// Layout Configuration
// ============================================================================

// LayoutConfig is the top-level configuration structure received from the
// GNOME extension via DBus. It describes the complete monitor topology and
// the input device to intercept.
type LayoutConfig struct {
	// Monitors is the ordered list of monitor configurations comprising
	// the desktop layout.
	Monitors []MonitorConfig `json:"monitors"`

	// DevicePath is the evdev device file to grab (e.g., "/dev/input/event3").
	// If empty, the daemon will auto-detect the first mouse device.
	DevicePath string `json:"device_path,omitempty"`
}

// ParseLayoutConfig deserializes a JSON string into a LayoutConfig.
// Returns an error if the JSON is malformed or contains no monitors.
func ParseLayoutConfig(jsonStr string) (*LayoutConfig, error) {
	var cfg LayoutConfig
	if err := json.Unmarshal([]byte(jsonStr), &cfg); err != nil {
		return nil, fmt.Errorf("invalid layout JSON: %w", err)
	}
	if len(cfg.Monitors) == 0 {
		return nil, fmt.Errorf("layout must contain at least one monitor")
	}
	return &cfg, nil
}

// ToJSON serializes the LayoutConfig to a compact JSON string.
func (lc *LayoutConfig) ToJSON() (string, error) {
	data, err := json.Marshal(lc)
	if err != nil {
		return "", fmt.Errorf("failed to serialize layout: %w", err)
	}
	return string(data), nil
}

// ============================================================================
// Device Info
// ============================================================================

// DeviceInfo describes a detected evdev input device, used by the
// ListDevices DBus method to let the frontend enumerate available mice.
type DeviceInfo struct {
	// Path is the device file path (e.g., "/dev/input/event5").
	Path string `json:"path"`

	// Name is the human-readable device name from the kernel driver.
	Name string `json:"name"`

	// ByIDPath is the stable symlink path under /dev/input/by-id/, if available.
	ByIDPath string `json:"by_id_path,omitempty"`
}

// ============================================================================
// Atomic State Wrapper
// ============================================================================

// AtomicState provides atomic load/store for DaemonState, enabling lock-free
// status reads from the evdev hot path without synchronization overhead.
type AtomicState struct {
	val uint32
}

// Load atomically reads the current daemon state.
func (a *AtomicState) Load() DaemonState {
	return DaemonState(atomic.LoadUint32(&a.val))
}

// Store atomically sets the daemon state.
func (a *AtomicState) Store(s DaemonState) {
	atomic.StoreUint32(&a.val, uint32(s))
}

// CompareAndSwap atomically updates the state from old to new.
// Returns true if the swap succeeded.
func (a *AtomicState) CompareAndSwap(old, new DaemonState) bool {
	return atomic.CompareAndSwapUint32(&a.val, uint32(old), uint32(new))
}
