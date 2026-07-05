// transform_test.go — Unit tests for the DPI transformation engine.
//
// Table-driven tests covering:
//   - Same-DPI passthrough (identity transform)
//   - 2x DPI scaling (e.g., 96 DPI → 192 DPI)
//   - Fractional DPI ratios
//   - Diagonal movement across boundaries
//   - Sub-pixel accumulation over multiple events
//   - Edge cases: single monitor, zero DPI, clamping
package main

import (
	"math"
	"testing"
)

// TestMonitorDPI verifies the DPI calculation from physical dimensions.
func TestMonitorDPI(t *testing.T) {
	tests := []struct {
		name     string
		monitor  MonitorConfig
		expected float64
	}{
		{
			name: "standard 24-inch 1080p",
			monitor: MonitorConfig{
				WidthPx: 1920, HeightPx: 1080,
				WidthMM: 527, HeightMM: 296, // ~24" diagonal
			},
			expected: 92.56, // 1920 / (527/25.4) ≈ 92.56
		},
		{
			name: "4K 27-inch",
			monitor: MonitorConfig{
				WidthPx: 3840, HeightPx: 2160,
				WidthMM: 597, HeightMM: 336, // ~27" diagonal
			},
			expected: 163.45, // 3840 / (597/25.4) ≈ 163.45
		},
		{
			name: "DPI override takes precedence",
			monitor: MonitorConfig{
				WidthPx: 1920, HeightPx: 1080,
				WidthMM: 527, HeightMM: 296,
				DPIOverride: 120.0,
			},
			expected: 120.0,
		},
		{
			name: "missing physical dimensions fallback",
			monitor: MonitorConfig{
				WidthPx: 1920, HeightPx: 1080,
				WidthMM: 0, HeightMM: 0,
			},
			expected: 96.0, // Default fallback
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dpi := tc.monitor.DPI()
			if math.Abs(dpi-tc.expected) > 0.5 {
				t.Errorf("DPI: got %.2f, expected %.2f", dpi, tc.expected)
			}
		})
	}
}

// TestTransformSameDPI verifies that movement on a single DPI boundary
// passes through unmodified.
func TestTransformSameDPI(t *testing.T) {
	te := NewTransformEngine()
	te.SetEnabled(true)

	cfg := &LayoutConfig{
		Monitors: []MonitorConfig{
			{Name: "A", X: 0, Y: 0, WidthPx: 1920, HeightPx: 1080, WidthMM: 527, HeightMM: 296},
			{Name: "B", X: 1920, Y: 0, WidthPx: 1920, HeightPx: 1080, WidthMM: 527, HeightMM: 296},
		},
	}
	te.SetLayout(cfg)

	// Movement within monitor A — no scaling expected.
	dx, dy := te.Transform(10, -5)
	if dx != 10 || dy != -5 {
		t.Errorf("Same-DPI passthrough failed: got (%d, %d), expected (10, -5)", dx, dy)
	}
}

// TestTransformSingleMonitor verifies passthrough with only one monitor.
func TestTransformSingleMonitor(t *testing.T) {
	te := NewTransformEngine()
	te.SetEnabled(true)

	cfg := &LayoutConfig{
		Monitors: []MonitorConfig{
			{Name: "Only", X: 0, Y: 0, WidthPx: 2560, HeightPx: 1440, WidthMM: 597, HeightMM: 336},
		},
	}
	te.SetLayout(cfg)

	dx, dy := te.Transform(50, 30)
	if dx != 50 || dy != 30 {
		t.Errorf("Single monitor: got (%d, %d), expected (50, 30)", dx, dy)
	}
}

// TestTransformDisabled verifies that disabled engine passes through.
func TestTransformDisabled(t *testing.T) {
	te := NewTransformEngine()
	te.SetEnabled(false)

	cfg := &LayoutConfig{
		Monitors: []MonitorConfig{
			{Name: "A", X: 0, Y: 0, WidthPx: 1920, HeightPx: 1080, WidthMM: 300, HeightMM: 169},
			{Name: "B", X: 1920, Y: 0, WidthPx: 3840, HeightPx: 2160, WidthMM: 300, HeightMM: 169},
		},
	}
	te.SetLayout(cfg)

	dx, dy := te.Transform(100, 50)
	if dx != 100 || dy != 50 {
		t.Errorf("Disabled passthrough: got (%d, %d), expected (100, 50)", dx, dy)
	}
}

// TestTransformContinuousScaling verifies that movement is scaled
// consistently on each monitor according to its DPI relative to the baseline.
func TestTransformContinuousScaling(t *testing.T) {
	te := NewTransformEngine()
	te.SetEnabled(true)

	// Monitor A (Baseline): 96 DPI
	// Monitor B: 192 DPI (2x baseline)
	cfg := &LayoutConfig{
		Monitors: []MonitorConfig{
			{Name: "A", X: 0, Y: 0, WidthPx: 1920, HeightPx: 1080, DPIOverride: 96},
			{Name: "B", X: 1920, Y: 0, WidthPx: 3840, HeightPx: 2160, DPIOverride: 192},
		},
	}
	te.SetLayout(cfg)

	// 1. Move within Monitor A (96 DPI). Scale = 96/96 = 1.0.
	dx, _ := te.Transform(10, 0)
	if dx != 10 {
		t.Errorf("Monitor A (baseline): got dx=%d, expected 10", dx)
	}

	// 2. Move to Monitor B. Cursor starts at center of A (960, 540).
	// Move right 1000 pixels to reach x=1960 (inside B).
	// On monitor A, 1000 raw -> 1000 corrected.
	te.Transform(1000, 0)

	// 3. Move within Monitor B (192 DPI). Scale = 192/96 = 2.0.
	dx, _ = te.Transform(10, 0)
	if dx != 20 {
		t.Errorf("Monitor B (2x DPI): got dx=%d, expected 20", dx)
	}
}

// TestTransformSubPixelAccumulation verifies that sub-pixel remainders
// from fixed-point scaling are accumulated and eventually output.
func TestTransformSubPixelAccumulation(t *testing.T) {
	te := NewTransformEngine()
	te.SetEnabled(true)

	// Monitor A (Baseline): 100 DPI
	// Monitor B: 150 DPI (1.5x baseline)
	cfg := &LayoutConfig{
		Monitors: []MonitorConfig{
			{Name: "A", X: 0, Y: 0, WidthPx: 1000, HeightPx: 1000, DPIOverride: 100},
			{Name: "B", X: 1000, Y: 0, WidthPx: 1000, HeightPx: 1000, DPIOverride: 150},
		},
	}
	te.SetLayout(cfg)

	// Move to Monitor B.
	te.Transform(1200, 0)

	// Send many 1-pixel increments on monitor B (1.5x scale).
	// 1 * 1.5 = 1.5.
	// Event 1: 1.5 -> 1 (acc 0.5)
	// Event 2: 1.5 + 0.5 = 2.0 -> 2 (acc 0)
	// Over 10 events, we expect 15 pixels total.
	totalCorrected := int32(0)
	for i := 0; i < 10; i++ {
		dx, _ := te.Transform(1, 0)
		totalCorrected += dx
	}

	if totalCorrected != 15 {
		t.Errorf("Sub-pixel accumulation: got %d, expected 15", totalCorrected)
	}
}

// TestSetCursorPosition verifies that manual cursor position updates work.
func TestSetCursorPosition(t *testing.T) {
	te := NewTransformEngine()
	te.SetEnabled(true)

	cfg := &LayoutConfig{
		Monitors: []MonitorConfig{
			{Name: "A", X: 0, Y: 0, WidthPx: 1000, HeightPx: 1000, DPIOverride: 100},
			{Name: "B", X: 1000, Y: 0, WidthPx: 1000, HeightPx: 1000, DPIOverride: 200},
		},
	}
	te.SetLayout(cfg)

	// Sync to Monitor B.
	te.SetCursorPosition(1500, 500)

	// Move within Monitor B (2x scale).
	dx, _ := te.Transform(10, 0)
	if dx != 20 {
		t.Errorf("After SetCursorPosition to B, expected 2x scale, got dx=%d", dx)
	}
}

// TestContainsPoint verifies monitor bounds checking.
func TestContainsPoint(t *testing.T) {
	m := MonitorConfig{X: 100, Y: 200, WidthPx: 1920, HeightPx: 1080}

	tests := []struct {
		x, y     int
		expected bool
	}{
		{100, 200, true},           // Top-left corner
		{2019, 1279, true},         // Bottom-right (inclusive)
		{2020, 1280, false},        // Just outside
		{99, 200, false},           // Left of monitor
		{500, 700, true},           // Center area
	}

	for _, tc := range tests {
		got := m.ContainsPoint(tc.x, tc.y)
		if got != tc.expected {
			t.Errorf("ContainsPoint(%d, %d): got %v, expected %v", tc.x, tc.y, got, tc.expected)
		}
	}
}

// TestParseLayoutConfig verifies JSON deserialization of layout configs.
func TestParseLayoutConfig(t *testing.T) {
	validJSON := `{
		"monitors": [
			{"name": "DP-1", "x": 0, "y": 0, "width_px": 1920, "height_px": 1080, "width_mm": 527, "height_mm": 296},
			{"name": "HDMI-1", "x": 1920, "y": 0, "width_px": 3840, "height_px": 2160, "width_mm": 600, "height_mm": 340}
		],
		"device_path": "/dev/input/event5"
	}`

	cfg, err := ParseLayoutConfig(validJSON)
	if err != nil {
		t.Fatalf("ParseLayoutConfig failed: %v", err)
	}

	if len(cfg.Monitors) != 2 {
		t.Fatalf("Expected 2 monitors, got %d", len(cfg.Monitors))
	}
	if cfg.Monitors[0].Name != "DP-1" {
		t.Errorf("Monitor[0].Name: got %q, expected %q", cfg.Monitors[0].Name, "DP-1")
	}
	if cfg.DevicePath != "/dev/input/event5" {
		t.Errorf("DevicePath: got %q, expected %q", cfg.DevicePath, "/dev/input/event5")
	}
}

// TestParseLayoutConfigErrors verifies error handling for invalid inputs.
func TestParseLayoutConfigErrors(t *testing.T) {
	tests := []struct {
		name string
		json string
	}{
		{"empty string", ""},
		{"invalid JSON", "{not json}"},
		{"empty monitors", `{"monitors": []}`},
		{"missing monitors", `{"device_path": "/dev/input/event0"}`},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseLayoutConfig(tc.json)
			if err == nil {
				t.Errorf("Expected error for %q, got nil", tc.name)
			}
		})
	}
}

// BenchmarkTransform measures the performance and allocation behavior
// of the DPI transform hot path.
// Expected: 0 allocs/op.
func BenchmarkTransform(b *testing.B) {
	te := NewTransformEngine()
	te.SetEnabled(true)

	cfg := &LayoutConfig{
		Monitors: []MonitorConfig{
			{Name: "A", X: 0, Y: 0, WidthPx: 1920, HeightPx: 1080, DPIOverride: 96},
			{Name: "B", X: 1920, Y: 0, WidthPx: 3840, HeightPx: 2160, DPIOverride: 192},
		},
	}
	te.SetLayout(cfg)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		te.Transform(5, -3)
	}
}
