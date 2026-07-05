// transform.go — DPI spatial transformation engine.
//
// This file implements the core math that translates raw mouse movement
// vectors across monitor boundaries with non-matching DPI. The engine
// maintains a virtual cursor position, detects boundary crossings, and
// applies scaling factors derived from physical millimeter dimensions.
//
// All arithmetic in the hot path uses fixed-point integer math to avoid
// float-to-int conversions and heap allocations.
package main

import (
	"sync"
	"sync/atomic"
)

// ============================================================================
// Fixed-Point Constants
// ============================================================================

// fixedShift is the number of fractional bits in fixed-point representation.
// 16 bits gives us 1/65536 precision — more than sufficient for sub-pixel
// cursor positioning while staying within int64 range for multiplication.
const fixedShift = 16

// fixedOne is 1.0 in fixed-point representation.
const fixedOne = 1 << fixedShift

// ============================================================================
// TransformEngine
// ============================================================================

// TransformEngine is the DPI-aware cursor transformation core. It tracks
// a virtual cursor position across the logical desktop, detects when the
// cursor crosses from one monitor to another, and scales the movement
// delta by the ratio of the two monitors' physical DPI values.
//
// Thread Safety: The layout can be atomically swapped via SetLayout()
// (called from the DBus goroutine) while the event loop reads it via
// atomic pointer load. The cursor position is only accessed from the
// event loop goroutine — no locking needed there.
type TransformEngine struct {
	// layout holds the current monitor topology, atomically swapped.
	// Stored as atomic.Pointer[transformLayout] for lock-free reads.
	layout atomic.Pointer[transformLayout]

	// cursorX and cursorY track the virtual cursor position in the
	// unified logical coordinate space. Only accessed from the event
	// loop goroutine (single writer), so no synchronization needed.
	cursorX int
	cursorY int

	// accumX and accumY store the fractional remainder from fixed-point
	// scaling, preventing drift over time. These sub-pixel remainders
	// are carried forward between events.
	accumX int64
	accumY int64

	// currentMonitor caches the index of the monitor the cursor is
	// currently on, avoiding a full scan on every event.
	currentMonitor int

	// enabled controls whether transformation is active.
	// When disabled, events pass through with identity scaling.
	enabled atomic.Bool
}

// transformLayout is the immutable, pre-computed layout snapshot used by
// the hot path. A new instance is created each time the layout changes,
// then atomically swapped in.
type transformLayout struct {
	// monitors is the list of monitors in the layout.
	monitors []MonitorConfig

	// scaleFactors stores each monitor's scaling factor relative to the baseline.
	// scaleFactor[i] = monitor[i].DPI / baselineDPI
	scaleFactors []int64

	// totalBounds defines the bounding rectangle of the entire desktop.
	totalMinX, totalMinY, totalMaxX, totalMaxY int
}

// NewTransformEngine creates a new transformation engine in disabled state.
func NewTransformEngine() *TransformEngine {
	te := &TransformEngine{}
	te.enabled.Store(false)
	return te
}

// SetEnabled enables or disables DPI correction.
func (te *TransformEngine) SetEnabled(enabled bool) {
	te.enabled.Store(enabled)
}

// IsEnabled returns whether DPI correction is active.
func (te *TransformEngine) IsEnabled() bool {
	return te.enabled.Load()
}

// SetLayout atomically installs a new monitor layout. Pre-computes the
// DPI scaling factors so the hot path never does division.
// Safe to call from any goroutine (DBus handler).
func (te *TransformEngine) SetLayout(cfg *LayoutConfig) {
	if cfg == nil || len(cfg.Monitors) == 0 {
		te.layout.Store(nil)
		return
	}

	n := len(cfg.Monitors)
	layout := &transformLayout{
		monitors:     make([]MonitorConfig, n),
		scaleFactors: make([]int64, n),
	}

	// Copy monitors.
	copy(layout.monitors, cfg.Monitors)

	// Use the first monitor's DPI as the baseline (1.0).
	// All other monitors will scale relative to this.
	baselineDPI := layout.monitors[0].DPI()
	if baselineDPI == 0 {
		baselineDPI = 96.0
	}
	baselineFixed := int64(baselineDPI * float64(fixedOne))

	// Pre-compute scaling factors for each monitor.
	// scaleFactor = CurrentMonitorDPI / BaselineDPI
	for i := range layout.monitors {
		dpi := layout.monitors[i].DPI()
		dpiFixed := int64(dpi * float64(fixedOne))
		
		// Fixed-point division: (dpiFixed << fixedShift) / baselineFixed
		layout.scaleFactors[i] = (dpiFixed << fixedShift) / baselineFixed
	}

	// Compute total desktop bounds for cursor clamping.
	layout.totalMinX = layout.monitors[0].X
	layout.totalMinY = layout.monitors[0].Y
	layout.totalMaxX = layout.monitors[0].X + layout.monitors[0].WidthPx
	layout.totalMaxY = layout.monitors[0].Y + layout.monitors[0].HeightPx
	for i := 1; i < n; i++ {
		m := &layout.monitors[i]
		if m.X < layout.totalMinX {
			layout.totalMinX = m.X
		}
		if m.Y < layout.totalMinY {
			layout.totalMinY = m.Y
		}
		if m.X+m.WidthPx > layout.totalMaxX {
			layout.totalMaxX = m.X + m.WidthPx
		}
		if m.Y+m.HeightPx > layout.totalMaxY {
			layout.totalMaxY = m.Y + m.HeightPx
		}
	}

	// Atomically swap the layout pointer.
	te.layout.Store(layout)

	// Initialize cursor to center of first monitor.
	te.cursorX = layout.monitors[0].X + layout.monitors[0].WidthPx/2
	te.cursorY = layout.monitors[0].Y + layout.monitors[0].HeightPx/2
	te.currentMonitor = 0
	te.accumX = 0
	te.accumY = 0
}

// SetCursorPosition manually updates the tracked logical cursor position.
// Used by the DBus service to synchronize with the desktop environment's
// actual cursor position, preventing drift.
func (te *TransformEngine) SetCursorPosition(x, y int) {
	layout := te.layout.Load()
	if layout == nil {
		te.cursorX = x
		te.cursorY = y
		return
	}

	te.cursorX = clamp(x, layout.totalMinX, layout.totalMaxX-1)
	te.cursorY = clamp(y, layout.totalMinY, layout.totalMaxY-1)
	
	te.currentMonitor = te.findMonitor(layout, te.cursorX, te.cursorY)
	if te.currentMonitor < 0 {
		te.currentMonitor = 0
	}
}

// Transform applies DPI-aware scaling to a raw mouse movement delta.
//
// ZERO-ALLOCATION HOT PATH:
// This method performs no heap allocations. All math is fixed-point integer
// arithmetic. The layout is read via atomic pointer load.
//
// Parameters:
//   - rawDX, rawDY: raw relative movement from the physical mouse (evdev).
//
// Returns:
//   - correctedDX, correctedDY: the DPI-corrected movement to inject via uinput.
func (te *TransformEngine) Transform(rawDX, rawDY int32) (int32, int32) {
	// Fast path: if disabled or no layout, pass through.
	if !te.enabled.Load() {
		return rawDX, rawDY
	}

	layout := te.layout.Load()
	if layout == nil {
		return rawDX, rawDY
	}

	// 1. Identify current monitor.
	// We use the last known good monitor as the starting point for scaling.
	// In continuous scaling, we scale by the DPI of where we are NOW.
	monitorIdx := te.currentMonitor
	if monitorIdx < 0 || monitorIdx >= len(layout.monitors) {
		monitorIdx = 0
	}

	// 2. Apply scaling factor for the current monitor.
	scale := layout.scaleFactors[monitorIdx]
	
	// Apply fixed-point scaling with accumulator for sub-pixel precision.
	scaledX := int64(rawDX)*scale + te.accumX
	scaledY := int64(rawDY)*scale + te.accumY

	// Extract integer part.
	correctedDX := int32(scaledX >> fixedShift)
	correctedDY := int32(scaledY >> fixedShift)

	// Store fractional remainder.
	te.accumX = scaledX - (int64(correctedDX) << fixedShift)
	te.accumY = scaledY - (int64(correctedDY) << fixedShift)

	// 3. Update internal logical position to detect boundary crossings.
	// We update with CORRECTED deltas because that's what the OS sees.
	te.cursorX += int(correctedDX)
	te.cursorY += int(correctedDY)

	// 4. Clamp to desktop bounds and update monitor cache.
	te.cursorX = clamp(te.cursorX, layout.totalMinX, layout.totalMaxX-1)
	te.cursorY = clamp(te.cursorY, layout.totalMinY, layout.totalMaxY-1)
	
	te.currentMonitor = te.findMonitor(layout, te.cursorX, te.cursorY)
	if te.currentMonitor < 0 {
		te.currentMonitor = monitorIdx // Stay on last known if outside all.
	}

	return correctedDX, correctedDY
}

// findMonitor returns the index of the monitor containing the given point,
// or -1 if the point is outside all monitors. Checks the cached current
// monitor first for the common case (cursor stays on the same screen).
func (te *TransformEngine) findMonitor(layout *transformLayout, x, y int) int {
	// Fast check: cursor usually stays on the same monitor.
	if te.currentMonitor >= 0 && te.currentMonitor < len(layout.monitors) {
		if layout.monitors[te.currentMonitor].ContainsPoint(x, y) {
			return te.currentMonitor
		}
	}

	// Linear scan over all monitors. With typical setups (2-4 monitors),
	// this is faster than any spatial index.
	for i := range layout.monitors {
		if layout.monitors[i].ContainsPoint(x, y) {
			return i
		}
	}

	return -1
}

// clamp restricts v to the range [lo, hi].
func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// ============================================================================
// Pool for layout configs (used by DBus handler, not hot path)
// ============================================================================

// layoutConfigPool recycles LayoutConfig objects to reduce GC pressure
// from repeated DBus SetLayout calls. NOT used in the evdev hot path.
var layoutConfigPool = sync.Pool{
	New: func() interface{} {
		return &LayoutConfig{
			Monitors: make([]MonitorConfig, 0, 4), // Pre-allocate for typical setups.
		}
	},
}
