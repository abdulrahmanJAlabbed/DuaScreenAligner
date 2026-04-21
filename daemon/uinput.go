// uinput.go — Virtual input device creation and event injection via /dev/uinput.
//
// This file creates a virtual mouse device that the compositor treats as a
// real hardware device. Corrected events from the transformation engine are
// injected here. The write path is zero-allocation, mirroring the read path
// in evdev.go.
package main

import (
	"encoding/binary"
	"fmt"
	"unsafe"

	"golang.org/x/sys/unix"
)

// ============================================================================
// uinput ioctl Constants
// ============================================================================

// uinput ioctl request codes from linux/uinput.h.
const (
	// UI_DEV_CREATE creates the virtual device after setup is complete.
	UI_DEV_CREATE = 0x5501

	// UI_DEV_DESTROY tears down the virtual device.
	UI_DEV_DESTROY = 0x5502

	// UI_SET_EVBIT enables an event type (EV_REL, EV_KEY, etc.).
	UI_SET_EVBIT = 0x40045564

	// UI_SET_KEYBIT enables a specific key/button code under EV_KEY.
	UI_SET_KEYBIT = 0x40045565

	// UI_SET_RELBIT enables a specific relative axis code under EV_REL.
	UI_SET_RELBIT = 0x40045566
)

// UINPUT_MAX_NAME_SIZE is the maximum length of the virtual device name.
const UINPUT_MAX_NAME_SIZE = 80

// ============================================================================
// uinput_user_dev Struct
// ============================================================================

// uinputUserDev mirrors the kernel's struct uinput_user_dev.
// This struct is written to /dev/uinput to define the virtual device's
// identity and capabilities before calling UI_DEV_CREATE.
//
// Layout (total 1116 bytes on 64-bit):
//   - name:       [80]byte
//   - id:         input_id (8 bytes: bustype, vendor, product, version as uint16)
//   - ff_effects_max: int32
//   - absmax:     [64]int32
//   - absmin:     [64]int32
//   - absfuzz:    [64]int32
//   - absflat:    [64]int32
type uinputUserDev struct {
	Name          [UINPUT_MAX_NAME_SIZE]byte
	ID            inputID
	FFEffectsMax  int32
	Absmax        [64]int32
	Absmin        [64]int32
	Absfuzz       [64]int32
	Absflat       [64]int32
}

// inputID mirrors struct input_id from linux/input.h.
type inputID struct {
	Bustype uint16
	Vendor  uint16
	Product uint16
	Version uint16
}

// ============================================================================
// UinputWriter — Virtual Device Manager
// ============================================================================

// UinputWriter manages the lifecycle of a virtual mouse device created via
// /dev/uinput. It provides zero-allocation event injection for the hot path.
type UinputWriter struct {
	// fd is the file descriptor for /dev/uinput.
	fd int

	// created tracks whether UI_DEV_CREATE has been called, ensuring
	// proper cleanup via UI_DEV_DESTROY.
	created bool
}

// CreateVirtualMouse opens /dev/uinput, configures a virtual relative mouse
// device with standard button and axis capabilities, and creates it.
//
// The virtual device appears to the system as "DuaScreen Virtual Mouse" and
// supports: REL_X, REL_Y, REL_WHEEL, REL_HWHEEL, BTN_LEFT, BTN_RIGHT,
// BTN_MIDDLE, BTN_SIDE, BTN_EXTRA.
func CreateVirtualMouse() (*UinputWriter, error) {
	// Open the uinput control device for writing.
	fd, err := unix.Open("/dev/uinput", unix.O_WRONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, fmt.Errorf("failed to open /dev/uinput: %w", err)
	}

	w := &UinputWriter{fd: fd}

	// Enable event types: relative axes and keys/buttons.
	if err := w.ioctl(UI_SET_EVBIT, EV_REL); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("UI_SET_EVBIT EV_REL: %w", err)
	}
	if err := w.ioctl(UI_SET_EVBIT, EV_KEY); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("UI_SET_EVBIT EV_KEY: %w", err)
	}
	if err := w.ioctl(UI_SET_EVBIT, EV_SYN); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("UI_SET_EVBIT EV_SYN: %w", err)
	}

	// Enable relative axes: X, Y, scroll wheel, horizontal scroll.
	for _, rel := range []int{REL_X, REL_Y, REL_WHEEL, REL_HWHEEL} {
		if err := w.ioctl(UI_SET_RELBIT, rel); err != nil {
			unix.Close(fd)
			return nil, fmt.Errorf("UI_SET_RELBIT %d: %w", rel, err)
		}
	}

	// Enable mouse buttons.
	for _, btn := range []int{BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA} {
		if err := w.ioctl(UI_SET_KEYBIT, btn); err != nil {
			unix.Close(fd)
			return nil, fmt.Errorf("UI_SET_KEYBIT %d: %w", btn, err)
		}
	}

	// Write the device definition struct to /dev/uinput.
	var dev uinputUserDev
	copy(dev.Name[:], "DuaScreen Virtual Mouse")
	dev.ID.Bustype = 0x03 // BUS_USB
	dev.ID.Vendor = 0x1234
	dev.ID.Product = 0x5678
	dev.ID.Version = 1

	devBytes := (*[unsafe.Sizeof(uinputUserDev{})]byte)(unsafe.Pointer(&dev))[:]
	if _, err := unix.Write(fd, devBytes); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("failed to write uinput_user_dev: %w", err)
	}

	// Create the virtual device — it now appears in /dev/input/.
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), UI_DEV_CREATE, 0); errno != 0 {
		unix.Close(fd)
		return nil, fmt.Errorf("UI_DEV_CREATE failed: %w", errno)
	}
	w.created = true

	return w, nil
}

// ioctl is a helper that performs a uinput ioctl with an integer argument.
func (w *UinputWriter) ioctl(request, value int) error {
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(w.fd), uintptr(request), uintptr(value))
	if errno != 0 {
		return errno
	}
	return nil
}

// InjectEvent writes a single input_event to the virtual device.
//
// ZERO-ALLOCATION HOT PATH:
// Uses unsafe.Slice to create a byte view of the caller's stack-allocated
// InputEvent, then writes it directly via unix.Write. No serialization or
// intermediate buffer allocation occurs.
func (w *UinputWriter) InjectEvent(ev *InputEvent) error {
	buf := unsafe.Slice((*byte)(unsafe.Pointer(ev)), inputEventSize)
	_, err := unix.Write(w.fd, buf)
	if err != nil {
		return fmt.Errorf("uinput write error: %w", err)
	}
	return nil
}

// InjectRelativeMove injects a REL_X + REL_Y + SYN_REPORT sequence.
// This is a convenience method wrapping three InjectEvent calls for the
// most common operation: injecting corrected mouse movement.
//
// ZERO-ALLOCATION: Uses a stack-allocated InputEvent and reuses it
// across all three writes.
func (w *UinputWriter) InjectRelativeMove(dx, dy int32) error {
	var ev InputEvent

	// X axis delta
	if dx != 0 {
		ev.Type = EV_REL
		ev.Code = REL_X
		ev.Value = dx
		if err := w.InjectEvent(&ev); err != nil {
			return err
		}
	}

	// Y axis delta
	if dy != 0 {
		ev.Type = EV_REL
		ev.Code = REL_Y
		ev.Value = dy
		if err := w.InjectEvent(&ev); err != nil {
			return err
		}
	}

	// SYN_REPORT marks the end of this logical event group.
	ev.Type = EV_SYN
	ev.Code = 0
	ev.Value = 0
	return w.InjectEvent(&ev)
}

// InjectSynReport writes an EV_SYN/SYN_REPORT event to finalize a batch
// of injected events.
func (w *UinputWriter) InjectSynReport() error {
	var ev InputEvent
	ev.Type = EV_SYN
	ev.Code = 0
	ev.Value = 0
	return w.InjectEvent(&ev)
}

// Close destroys the virtual device and closes the uinput file descriptor.
// Safe to call multiple times.
func (w *UinputWriter) Close() error {
	if w.created {
		unix.Syscall(unix.SYS_IOCTL, uintptr(w.fd), UI_DEV_DESTROY, 0)
		w.created = false
	}
	return unix.Close(w.fd)
}

// ============================================================================
// Event Serialization (for testing; not used in hot path)
// ============================================================================

// SerializeEvent writes an InputEvent to a byte slice in native byte order.
// Used only in test code to create mock evdev streams.
func SerializeEvent(ev *InputEvent) []byte {
	buf := make([]byte, inputEventSize)
	nativeOrder := binary.LittleEndian // x86_64 is little-endian

	// struct timeval: tv_sec (int64) + tv_usec (int64) on 64-bit
	nativeOrder.PutUint64(buf[0:8], uint64(ev.Time.Sec))
	nativeOrder.PutUint64(buf[8:16], uint64(ev.Time.Usec))
	nativeOrder.PutUint16(buf[16:18], ev.Type)
	nativeOrder.PutUint16(buf[18:20], ev.Code)
	nativeOrder.PutUint32(buf[20:24], uint32(ev.Value))

	return buf
}
