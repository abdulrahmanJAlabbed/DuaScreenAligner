// evdev.go — Zero-allocation evdev input device reader.
//
// This file handles discovery of physical mouse devices under /dev/input/,
// exclusive grab via EVIOCGRAB ioctl, and a hot-path event read loop that
// performs zero heap allocations by reading directly into a stack-allocated
// InputEvent struct through an unsafe byte slice overlay.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

// ============================================================================
// Linux Input Event Constants
// ============================================================================

// EVIOCGRAB is the ioctl request code to grab/ungrab an evdev device.
// When grabbed, the device's events are delivered exclusively to the grabbing
// file descriptor; no other process (including the compositor) receives them.
// Value: _IOW('E', 0x90, int) = 0x40044590 on 64-bit Linux.
const EVIOCGRAB = 0x40044590

// EVIOCGNAME is the ioctl to retrieve the device name string.
// _IOC(_IOC_READ, 'E', 0x06, 256) = 0x80FF4506 with 256-byte buffer.
const EVIOCGNAME = 0x80FF4506

// Event types from linux/input-event-codes.h
const (
	EV_SYN = 0x00 // Synchronization event boundary
	EV_KEY = 0x01 // Key/button press/release
	EV_REL = 0x02 // Relative axis movement (mouse)
	EV_ABS = 0x03 // Absolute axis (tablet, touchscreen)
	EV_MSC = 0x04 // Miscellaneous events
)

// Relative axis codes
const (
	REL_X     = 0x00 // Horizontal mouse movement
	REL_Y     = 0x01 // Vertical mouse movement
	REL_WHEEL = 0x08 // Vertical scroll wheel
	REL_HWHEEL = 0x06 // Horizontal scroll wheel
)

// Button codes
const (
	BTN_LEFT   = 0x110 // Left mouse button
	BTN_RIGHT  = 0x111 // Right mouse button
	BTN_MIDDLE = 0x112 // Middle mouse button
	BTN_SIDE   = 0x113 // Side button (forward)
	BTN_EXTRA  = 0x114 // Extra button (back)
)

// ============================================================================
// Input Event Struct
// ============================================================================

// InputEvent mirrors the kernel's struct input_event (linux/input.h).
// On 64-bit Linux: sizeof(struct input_event) = 24 bytes.
// Layout: struct timeval (16 bytes) + __u16 type + __u16 code + __s32 value.
//
// This struct is intentionally kept as a plain value type to enable
// stack allocation and zero-copy reads in the hot path.
type InputEvent struct {
	Time  unix.Timeval // Timestamp from the kernel
	Type  uint16       // Event type (EV_REL, EV_KEY, etc.)
	Code  uint16       // Event code (REL_X, BTN_LEFT, etc.)
	Value int32        // Event value (delta for REL, 0/1 for KEY)
}

// inputEventSize is the compile-time size of InputEvent in bytes.
// Used to create the read buffer overlay without runtime sizeof calls.
var inputEventSize = int(unsafe.Sizeof(InputEvent{}))

// ============================================================================
// EvdevReader — Physical Device Interface
// ============================================================================

// EvdevReader manages the lifecycle of a physical evdev input device:
// opening, grabbing, reading events, and cleanup.
type EvdevReader struct {
	// fd is the raw file descriptor for the opened /dev/input/eventX device.
	fd int

	// path is the device file path that was opened.
	path string

	// name is the kernel-reported device name (from EVIOCGNAME ioctl).
	name string

	// grabbed tracks whether EVIOCGRAB is currently held, used to ensure
	// cleanup even if the caller forgets to call Ungrab().
	grabbed bool
}

// OpenEvdev opens an evdev device file and retrieves its name.
// Does NOT grab the device — call Grab() separately after confirming
// the device is the correct one.
func OpenEvdev(devicePath string) (*EvdevReader, error) {
	// Open read-only; we only consume events, never write to the physical device.
	fd, err := unix.Open(devicePath, unix.O_RDONLY, 0)
	if err != nil {
		return nil, fmt.Errorf("failed to open %s: %w", devicePath, err)
	}

	// Query the human-readable device name via ioctl.
	nameBuf := make([]byte, 256)
	err = ioctlGetName(fd, nameBuf)
	name := "unknown"
	if err == nil {
		// Trim null bytes from the kernel string.
		name = strings.TrimRight(string(nameBuf), "\x00")
	}

	return &EvdevReader{
		fd:   fd,
		path: devicePath,
		name: name,
	}, nil
}

// ioctlGetName retrieves the device name via EVIOCGNAME ioctl.
func ioctlGetName(fd int, buf []byte) error {
	_, _, errno := unix.Syscall(
		unix.SYS_IOCTL,
		uintptr(fd),
		uintptr(EVIOCGNAME),
		uintptr(unsafe.Pointer(&buf[0])),
	)
	if errno != 0 {
		return errno
	}
	return nil
}

// Name returns the kernel-reported device name.
func (r *EvdevReader) Name() string {
	return r.name
}

// Path returns the device file path.
func (r *EvdevReader) Path() string {
	return r.path
}

// Grab acquires exclusive access to the evdev device via EVIOCGRAB.
// After grabbing, the compositor (Wayland/X11) will NOT receive events
// from this device — they are only delivered to our file descriptor.
//
// WARNING: If this process crashes without calling Ungrab(), the device
// becomes unresponsive until the fd is closed (which happens automatically
// on process exit, but not on goroutine panics within a surviving process).
func (r *EvdevReader) Grab() error {
	if r.grabbed {
		return nil // Already grabbed; idempotent.
	}
	if err := unix.IoctlSetInt(r.fd, EVIOCGRAB, 1); err != nil {
		return fmt.Errorf("EVIOCGRAB failed on %s: %w", r.path, err)
	}
	r.grabbed = true
	return nil
}

// Ungrab releases the exclusive grab on the evdev device.
// Safe to call multiple times; idempotent.
func (r *EvdevReader) Ungrab() error {
	if !r.grabbed {
		return nil
	}
	if err := unix.IoctlSetInt(r.fd, EVIOCGRAB, 0); err != nil {
		return fmt.Errorf("EVIOCGRAB release failed on %s: %w", r.path, err)
	}
	r.grabbed = false
	return nil
}

// ReadEvent performs a blocking read of a single input_event from the device.
//
// ZERO-ALLOCATION HOT PATH:
// The event is read directly into the caller-provided *InputEvent using an
// unsafe byte slice overlay. No heap allocation occurs — the InputEvent
// should be stack-allocated by the caller.
//
// Returns the number of bytes read (should be inputEventSize) or an error.
// On device disconnect, returns an error wrapping unix.ENODEV.
func (r *EvdevReader) ReadEvent(ev *InputEvent) error {
	// Create a byte slice header that points directly to the InputEvent's
	// memory. This is the key trick: unix.Read fills the struct's bytes
	// without any intermediate buffer allocation.
	buf := unsafe.Slice((*byte)(unsafe.Pointer(ev)), inputEventSize)

	n, err := unix.Read(r.fd, buf)
	if err != nil {
		return fmt.Errorf("evdev read error on %s: %w", r.path, err)
	}
	if n != inputEventSize {
		return fmt.Errorf("partial evdev read: got %d bytes, expected %d", n, inputEventSize)
	}
	return nil
}

// Close releases the grab (if held) and closes the file descriptor.
func (r *EvdevReader) Close() error {
	// Always attempt ungrab before closing to restore device to system.
	_ = r.Ungrab()
	return unix.Close(r.fd)
}

// ============================================================================
// Device Discovery
// ============================================================================

// DiscoverMouseDevices scans /dev/input/by-id/ for symlinks matching
// *-event-mouse, returning a list of DeviceInfo structs with both the
// stable by-id path and the resolved /dev/input/eventX path.
func DiscoverMouseDevices() ([]DeviceInfo, error) {
	byIDDir := "/dev/input/by-id"
	entries, err := os.ReadDir(byIDDir)
	if err != nil {
		return nil, fmt.Errorf("cannot scan %s: %w", byIDDir, err)
	}

	var devices []DeviceInfo
	for _, entry := range entries {
		// Only consider mouse event devices (not the js/joystick variants).
		if !strings.HasSuffix(entry.Name(), "-event-mouse") {
			continue
		}

		byIDPath := filepath.Join(byIDDir, entry.Name())

		// Resolve the symlink to get the actual /dev/input/eventX path.
		resolved, err := filepath.EvalSymlinks(byIDPath)
		if err != nil {
			continue // Skip unresolvable symlinks.
		}

		// Attempt to read the device name.
		name := entry.Name()
		reader, err := OpenEvdev(resolved)
		if err == nil {
			name = reader.Name()
			reader.Close()
		}

		devices = append(devices, DeviceInfo{
			Path:     resolved,
			Name:     name,
			ByIDPath: byIDPath,
		})
	}

	return devices, nil
}

// isKeyboardComposite checks if a device's by-id path suggests it's a
// secondary mouse interface on a keyboard (e.g., macro buttons).
// These devices typically contain "-if01-" or "Keyboard" in the path.
func isKeyboardComposite(byIDPath string) bool {
	lower := strings.ToLower(byIDPath)
	return strings.Contains(lower, "-if01-") ||
		strings.Contains(lower, "-if02-") ||
		strings.Contains(lower, "keyboard") ||
		strings.Contains(lower, "kbd")
}

// FindDeviceByPath locates and opens a specific evdev device, or if path is
// empty, auto-detects the best available mouse device.
//
// Auto-detection prefers standalone mouse devices over keyboard composite
// devices (e.g., a HyperX keyboard with a secondary mouse endpoint).
func FindDeviceByPath(path string) (*EvdevReader, error) {
	if path != "" {
		return OpenEvdev(path)
	}

	// Auto-detect: prefer standalone mice over keyboard composites.
	devices, err := DiscoverMouseDevices()
	if err != nil {
		return nil, err
	}
	if len(devices) == 0 {
		return nil, fmt.Errorf("no mouse devices found in /dev/input/by-id/")
	}

	// Try standalone mice first.
	for _, dev := range devices {
		if !isKeyboardComposite(dev.ByIDPath) {
			return OpenEvdev(dev.Path)
		}
	}

	// Fall back to any mouse device.
	return OpenEvdev(devices[0].Path)
}
