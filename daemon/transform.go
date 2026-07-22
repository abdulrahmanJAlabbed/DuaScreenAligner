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
// Thread Safety: The layout is atomically swapped via SetLayout() from
// the DBus goroutine and read via atomic pointer load in the hot path.
// Cursor state (position, accumulator, monitor index) is protected by
// cursorMu: the event-loop goroutine acquires it in Transform(), and
// DBus-triggered SetLayout/SetCursorPosition also acquire it.
type TransformEngine struct {
	// layout holds the current monitor topology, atomically swapped.
	// Stored as atomic.Pointer[transformLayout] for lock-free reads.
	layout atomic.Pointer[transformLayout]

	// cursorMu serializes access to all cursor-tracking fields below,
	// protecting against races between the DBus goroutine (SetLayout,
	// SetCursorPosition) and the event-loop goroutine (Transform).
	cursorMu sync.Mutex
	cursorX  int
	cursorY  int
	accumX   int64
	accumY   int64
	currentMonitor int

	// cursorTracked is set once a layout has initialized the cursor.
	// Subsequent SetLayout calls preserve the tracked position when it
	// still falls inside the new layout, so re-applying a layout (e.g.
	// every drag in the prefs editor) doesn't teleport the tracked cursor
	// and glitch the scaling mid-movement.
	cursorTracked bool

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

	// Use the primary monitor's DPI as the baseline (1.0) so the main
	// screen's cursor feel is untouched; fall back to the first monitor.
	baselineIdx := 0
	for i := range layout.monitors {
		if layout.monitors[i].Primary {
			baselineIdx = i
			break
		}
	}
	baselineDPI := layout.monitors[baselineIdx].DPI()
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

	te.cursorMu.Lock()
	inBounds := te.cursorTracked &&
		te.cursorX >= layout.totalMinX && te.cursorX < layout.totalMaxX &&
		te.cursorY >= layout.totalMinY && te.cursorY < layout.totalMaxY
	if inBounds {
		// Keep the tracked position; just re-derive which monitor it is on.
		te.currentMonitor = te.findMonitor(layout, te.cursorX, te.cursorY)
		if te.currentMonitor < 0 {
			te.currentMonitor = 0
		}
	} else {
		// First layout (or cursor now out of bounds): center on monitor[0].
		te.cursorX = layout.monitors[0].X + layout.monitors[0].WidthPx/2
		te.cursorY = layout.monitors[0].Y + layout.monitors[0].HeightPx/2
		te.currentMonitor = 0
	}
	// Scale factors changed; stale sub-pixel remainders are meaningless.
	te.accumX = 0
	te.accumY = 0
	te.cursorTracked = true
	te.cursorMu.Unlock()
}

// SetCursorPosition manually updates the tracked logical cursor position.
// Used by the DBus service to synchronize with the desktop environment's
// actual cursor position, preventing drift.
func (te *TransformEngine) SetCursorPosition(x, y int) {
	layout := te.layout.Load()

	te.cursorMu.Lock()
	defer te.cursorMu.Unlock()

	te.cursorTracked = true

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
	if !te.enabled.Load() {
		return rawDX, rawDY
	}

	layout := te.layout.Load()
	if layout == nil {
		return rawDX, rawDY
	}

	te.cursorMu.Lock()

	monitorIdx := te.currentMonitor
	if monitorIdx < 0 || monitorIdx >= len(layout.monitors) {
		monitorIdx = 0
	}

	scale := layout.scaleFactors[monitorIdx]

	scaledX := int64(rawDX)*scale + te.accumX
	scaledY := int64(rawDY)*scale + te.accumY

	correctedDX := int32(scaledX >> fixedShift)
	correctedDY := int32(scaledY >> fixedShift)

	te.accumX = scaledX - (int64(correctedDX) << fixedShift)
	te.accumY = scaledY - (int64(correctedDY) << fixedShift)

	te.cursorX += int(correctedDX)
	te.cursorY += int(correctedDY)

	te.cursorX = clamp(te.cursorX, layout.totalMinX, layout.totalMaxX-1)
	te.cursorY = clamp(te.cursorY, layout.totalMinY, layout.totalMaxY-1)

	te.currentMonitor = te.findMonitor(layout, te.cursorX, te.cursorY)
	if te.currentMonitor < 0 {
		te.currentMonitor = monitorIdx
	}

	te.cursorMu.Unlock()

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
