// evdev_test.go — Tests for the evdev reader using mock input streams.
//
// Creates named pipes (FIFOs) simulating /dev/input/eventX devices,
// writes synthetic InputEvent structs, and validates the reader's
// ability to correctly parse events and handle edge cases.
package main

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
)

// TestInputEventSize verifies that the Go InputEvent struct matches the
// kernel's struct input_event size on the current architecture.
// On 64-bit Linux: sizeof(struct input_event) = 24 bytes.
func TestInputEventSize(t *testing.T) {
	expected := 24 // 64-bit: timeval(16) + type(2) + code(2) + value(4)
	actual := int(unsafe.Sizeof(InputEvent{}))
	if actual != expected {
		t.Fatalf("InputEvent size mismatch: got %d, expected %d (is this a 64-bit system?)", actual, expected)
	}
}

// TestInputEventAlignment verifies the field offsets within InputEvent
// match the kernel struct layout for zero-copy reads.
func TestInputEventAlignment(t *testing.T) {
	var ev InputEvent

	// timeval occupies bytes [0..15]
	timeOffset := unsafe.Offsetof(ev.Time)
	if timeOffset != 0 {
		t.Errorf("Time offset: got %d, expected 0", timeOffset)
	}

	// type is at byte 16
	typeOffset := unsafe.Offsetof(ev.Type)
	if typeOffset != 16 {
		t.Errorf("Type offset: got %d, expected 16", typeOffset)
	}

	// code is at byte 18
	codeOffset := unsafe.Offsetof(ev.Code)
	if codeOffset != 18 {
		t.Errorf("Code offset: got %d, expected 18", codeOffset)
	}

	// value is at byte 20
	valueOffset := unsafe.Offsetof(ev.Value)
	if valueOffset != 20 {
		t.Errorf("Value offset: got %d, expected 20", valueOffset)
	}
}

// TestSerializeDeserializeEvent verifies that SerializeEvent produces bytes
// that can be correctly read back into an InputEvent via the zero-copy path.
func TestSerializeDeserializeEvent(t *testing.T) {
	original := InputEvent{
		Time:  unix.Timeval{Sec: 1234567890, Usec: 123456},
		Type:  EV_REL,
		Code:  REL_X,
		Value: -42,
	}

	// Serialize to bytes (simulates what a real device would produce).
	data := SerializeEvent(&original)
	if len(data) != inputEventSize {
		t.Fatalf("serialized size: got %d, expected %d", len(data), inputEventSize)
	}

	// Deserialize by copying bytes into a new struct (simulates ReadEvent).
	var restored InputEvent
	buf := unsafe.Slice((*byte)(unsafe.Pointer(&restored)), inputEventSize)
	copy(buf, data)

	// Verify all fields match.
	if restored.Time.Sec != original.Time.Sec {
		t.Errorf("Time.Sec: got %d, expected %d", restored.Time.Sec, original.Time.Sec)
	}
	if restored.Time.Usec != original.Time.Usec {
		t.Errorf("Time.Usec: got %d, expected %d", restored.Time.Usec, original.Time.Usec)
	}
	if restored.Type != original.Type {
		t.Errorf("Type: got %d, expected %d", restored.Type, original.Type)
	}
	if restored.Code != original.Code {
		t.Errorf("Code: got %d, expected %d", restored.Code, original.Code)
	}
	if restored.Value != original.Value {
		t.Errorf("Value: got %d, expected %d", restored.Value, original.Value)
	}
}

// TestReadEventFromPipe tests that ReadEvent correctly reads from a file
// descriptor that behaves like an evdev device (a named pipe / FIFO).
func TestReadEventFromPipe(t *testing.T) {
	// Create a temporary FIFO to simulate an evdev device.
	tmpDir := t.TempDir()
	fifoPath := filepath.Join(tmpDir, "test-event-device")

	if err := unix.Mkfifo(fifoPath, 0600); err != nil {
		t.Fatalf("Failed to create FIFO: %v", err)
	}

	// Write synthetic events in a goroutine (FIFO blocks until both ends open).
	testEvents := []InputEvent{
		{Time: unix.Timeval{Sec: 100, Usec: 0}, Type: EV_REL, Code: REL_X, Value: 10},
		{Time: unix.Timeval{Sec: 100, Usec: 1}, Type: EV_REL, Code: REL_Y, Value: -5},
		{Time: unix.Timeval{Sec: 100, Usec: 2}, Type: EV_SYN, Code: 0, Value: 0},
		{Time: unix.Timeval{Sec: 101, Usec: 0}, Type: EV_KEY, Code: BTN_LEFT, Value: 1},
		{Time: unix.Timeval{Sec: 101, Usec: 1}, Type: EV_SYN, Code: 0, Value: 0},
	}

	go func() {
		// Open write end of the FIFO.
		wf, err := os.OpenFile(fifoPath, os.O_WRONLY, 0)
		if err != nil {
			t.Errorf("Failed to open FIFO for writing: %v", err)
			return
		}
		defer wf.Close()

		for _, ev := range testEvents {
			data := SerializeEvent(&ev)
			if _, err := wf.Write(data); err != nil {
				t.Errorf("Failed to write event: %v", err)
				return
			}
		}
	}()

	// Open read end via raw fd (simulates OpenEvdev but without ioctl).
	fd, err := unix.Open(fifoPath, unix.O_RDONLY, 0)
	if err != nil {
		t.Fatalf("Failed to open FIFO for reading: %v", err)
	}
	defer unix.Close(fd)

	reader := &EvdevReader{fd: fd, path: fifoPath, name: "test-pipe"}

	// Read and verify each event.
	for i, expected := range testEvents {
		var ev InputEvent
		if err := reader.ReadEvent(&ev); err != nil {
			t.Fatalf("ReadEvent[%d] failed: %v", i, err)
		}

		if ev.Type != expected.Type {
			t.Errorf("Event[%d] Type: got %d, expected %d", i, ev.Type, expected.Type)
		}
		if ev.Code != expected.Code {
			t.Errorf("Event[%d] Code: got %d, expected %d", i, ev.Code, expected.Code)
		}
		if ev.Value != expected.Value {
			t.Errorf("Event[%d] Value: got %d, expected %d", i, ev.Value, expected.Value)
		}
	}
}

// TestDiscoverMouseDevices validates that device discovery doesn't panic
// even when /dev/input/by-id/ doesn't exist or is empty.
func TestDiscoverMouseDevices(t *testing.T) {
	// This test will either find devices or return an error gracefully.
	// It should never panic.
	devices, err := DiscoverMouseDevices()
	if err != nil {
		t.Logf("Device discovery returned error (expected if not running as root): %v", err)
		return
	}
	t.Logf("Found %d mouse devices", len(devices))
	for _, d := range devices {
		t.Logf("  - %s (%s) via %s", d.Name, d.Path, d.ByIDPath)
	}
}

// BenchmarkReadEvent measures the allocation behavior of the evdev read path.
// Expected: 0 allocs/op (zero-allocation hot path verification).
func BenchmarkReadEvent(b *testing.B) {
	// Create a FIFO filled with events.
	tmpDir := b.TempDir()
	fifoPath := filepath.Join(tmpDir, "bench-event-device")
	if err := unix.Mkfifo(fifoPath, 0600); err != nil {
		b.Fatalf("Mkfifo: %v", err)
	}

	// Writer goroutine: continuously write events.
	go func() {
		wf, _ := os.OpenFile(fifoPath, os.O_WRONLY, 0)
		defer wf.Close()

		ev := InputEvent{Type: EV_REL, Code: REL_X, Value: 1}
		data := SerializeEvent(&ev)

		for i := 0; i < b.N+1000; i++ {
			wf.Write(data)
		}
	}()

	fd, err := unix.Open(fifoPath, unix.O_RDONLY, 0)
	if err != nil {
		b.Fatalf("Open FIFO: %v", err)
	}
	defer unix.Close(fd)

	reader := &EvdevReader{fd: fd, path: fifoPath, name: "bench"}
	var ev InputEvent

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		if err := reader.ReadEvent(&ev); err != nil {
			b.Fatalf("ReadEvent: %v", err)
		}
	}
}
