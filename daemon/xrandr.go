// xrandr.go — Auto-detect monitor layout from xrandr output.
//
// Provides a fallback mechanism for detecting monitor geometry at daemon
// startup, without waiting for the GNOME extension to push a layout via DBus.
// Parses the output of `xrandr --query` to extract connected monitors,
// their positions, resolutions, rotations, and physical dimensions.
package main

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// xrandrLineRe matches connected monitor lines in xrandr output.
// Example: "DP-0 connected primary 1920x1080+1080+485 (normal ...) 531mm x 298mm"
// Example: "HDMI-0 connected 1080x1920+0+0 left (normal ...) 598mm x 336mm"
var xrandrLineRe = regexp.MustCompile(
	`^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(\d+)\+(\d+)\s+(\w+)?\s*\(.*?\)\s+(\d+)mm\s+x\s+(\d+)mm`,
)

// scanProcEnviron reads /proc/$pid/environ in chunks to find DISPLAY and
// XAUTHORITY. Avoids loading the full environment (which may contain
// secrets) into memory.
func scanProcEnviron(pid string) (display, xauth string) {
	f, err := os.Open(filepath.Join("/proc", pid, "environ"))
	if err != nil {
		return "", ""
	}
	defer f.Close()

	const bufSize = 4096
	var buf [bufSize]byte
	var carry []byte

	for {
		n, err := f.Read(buf[:])
		if n > 0 {
			data := append(carry, buf[:n]...)
			lastNull := bytes.LastIndexByte(data, 0)
			if lastNull >= 0 {
				carry = make([]byte, len(data)-lastNull-1)
				copy(carry, data[lastNull+1:])
				data = data[:lastNull]
			} else {
				carry = data[:0]
				display = ""
				xauth = ""
				continue
			}

			for _, chunk := range bytes.Split(data, []byte{0}) {
				if bytes.HasPrefix(chunk, []byte("DISPLAY=")) {
					display = string(chunk[8:])
				}
				if bytes.HasPrefix(chunk, []byte("XAUTHORITY=")) {
					xauth = string(chunk[11:])
				}
			}

			if display != "" {
				return display, xauth
			}
		}
		if err != nil && err != io.EOF {
			return "", ""
		}
		if err == io.EOF {
			break
		}
	}

	return display, xauth
}

// DetectLayoutFromXrandr runs `xrandr --query` and parses the output into a
// LayoutConfig. Returns nil if xrandr is not available or produces no usable
// output. This is safe to call even in headless environments.
//
// When running as a root systemd service, discovers DISPLAY and XAUTHORITY
// by scanning /proc for a desktop user's process that has these set.
func DetectLayoutFromXrandr() *LayoutConfig {
	display, xauth := discoverDisplayEnv()
	if display != "" {
		log.Printf("xrandr: found DISPLAY=%s XAUTHORITY=%s", display, xauth)
	}

	var output []byte
	var err error

	if display != "" {
		cmd := exec.Command("xrandr", "--query")
		cmdEnv := os.Environ()
		cmdEnv = append(cmdEnv, "DISPLAY="+display)
		if xauth != "" {
			cmdEnv = append(cmdEnv, "XAUTHORITY="+xauth)
		}
		cmd.Env = cmdEnv
		output, err = cmd.CombinedOutput()
		if err == nil && strings.Contains(string(output), "connected") {
			return parseXrandrOutput(string(output))
		}
		log.Printf("xrandr with discovered env failed: %v", err)
	}

	// Fallback: try common DISPLAY values.
	for _, disp := range []string{":0", ":1"} {
		cmd := exec.Command("xrandr", "--query")
		cmd.Env = append(os.Environ(), "DISPLAY="+disp)
		output, err = cmd.CombinedOutput()
		if err == nil && strings.Contains(string(output), "connected") {
			log.Printf("xrandr: using DISPLAY=%s", disp)
			return parseXrandrOutput(string(output))
		}
	}

	if err != nil {
		log.Printf("xrandr auto-detect unavailable: %v", err)
	}
	return nil
}

// discoverDisplayEnv finds DISPLAY and XAUTHORITY by scanning /proc for
// non-root processes that have DISPLAY set. Uses streaming reads to avoid
// loading full environment files (which may contain secrets) into memory.
func discoverDisplayEnv() (display, xauth string) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return "", ""
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid := entry.Name()
		if pid[0] < '1' || pid[0] > '9' {
			continue
		}

		statusData, err := os.ReadFile(filepath.Join("/proc", pid, "status"))
		if err != nil {
			continue
		}
		isRoot := false
		for _, line := range strings.Split(string(statusData), "\n") {
			if strings.HasPrefix(line, "Uid:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 && fields[1] == "0" {
					isRoot = true
				}
				break
			}
		}
		if isRoot {
			continue
		}

		display, xauth = scanProcEnviron(pid)
		if display != "" {
			return display, xauth
		}
	}
	return "", ""
}


// parseXrandrOutput extracts monitor configurations from raw xrandr output.
func parseXrandrOutput(output string) *LayoutConfig {
	var monitors []MonitorConfig

	for _, line := range strings.Split(output, "\n") {
		m := xrandrLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}

		name := m[1]
		primary := m[2] != ""
		widthPx, _ := strconv.Atoi(m[3])
		heightPx, _ := strconv.Atoi(m[4])
		x, _ := strconv.Atoi(m[5])
		y, _ := strconv.Atoi(m[6])
		rotation := m[7] // "normal", "left", "right", "inverted"
		physW, _ := strconv.Atoi(m[8])
		physH, _ := strconv.Atoi(m[9])

		// For rotated monitors, the physical dimensions reported by xrandr
		// correspond to the un-rotated panel. We need to swap them so that
		// width_mm corresponds to the logical width direction.
		if rotation == "left" || rotation == "right" {
			physW, physH = physH, physW
		}

		monitors = append(monitors, MonitorConfig{
			Name:     name,
			X:        x,
			Y:        y,
			WidthPx:  widthPx,
			HeightPx: heightPx,
			WidthMM:  float64(physW),
			HeightMM: float64(physH),
			Primary:  primary,
		})
	}

	if len(monitors) == 0 {
		return nil
	}

	log.Printf("xrandr auto-detect: found %d monitors", len(monitors))
	for i, m := range monitors {
		log.Printf("  [%d] %s: %dx%d+%d+%d (%.0fmm x %.0fmm, DPI=%.1f)",
			i, m.Name, m.WidthPx, m.HeightPx, m.X, m.Y,
			m.WidthMM, m.HeightMM, m.DPI())
	}

	return &LayoutConfig{
		Monitors: monitors,
	}
}

// FormatLayoutSummary returns a human-readable summary of a layout for logging.
func FormatLayoutSummary(cfg *LayoutConfig) string {
	if cfg == nil || len(cfg.Monitors) == 0 {
		return "<no layout>"
	}
	parts := make([]string, len(cfg.Monitors))
	for i, m := range cfg.Monitors {
		parts[i] = fmt.Sprintf("%s(%dx%d@%.0fdpi)", m.Name, m.WidthPx, m.HeightPx, m.DPI())
	}
	return strings.Join(parts, " | ")
}
