// main.go — Entry point for the DuaScreenAligner daemon.
//
// Orchestrates the full lifecycle:
//   1. Parse CLI flags (device path, pprof address, log level)
//   2. Start the DBus system bus service (receives layout from GNOME extension)
//   3. Open and grab the physical mouse via evdev (EVIOCGRAB)
//   4. Create a virtual mouse via uinput
//   5. Enter the event loop: read → transform → inject
//   6. Handle SIGTERM/SIGINT for graceful shutdown (ungrab + destroy virtual device)
//   7. Optional: expose pprof HTTP server for memory profiling
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// ============================================================================
// CLI Flags
// ============================================================================

var (
	// flagDevice specifies the evdev device path to grab. If empty, auto-detect.
	flagDevice = flag.String("device", "", "evdev device path (e.g., /dev/input/event3). Empty for auto-detect.")

	// flagPprof enables the pprof HTTP server at the given address.
	// Used to verify zero heap allocations in the hot path.
	flagPprof = flag.String("pprof-addr", "", "pprof HTTP server address (e.g., localhost:6060). Empty to disable.")

	// flagLogLevel controls daemon verbosity.
	flagLogLevel = flag.String("log-level", "info", "Log level: debug, info, warn, error")

	// flagVersion prints the version and exits.
	flagVersion = flag.Bool("version", false, "Print version and exit")

	// flagListDevices lists detected mouse devices and exits.
	flagListDevices = flag.Bool("list-devices", false, "List detected mouse devices and exit")
)

// ============================================================================
// Main
// ============================================================================

func main() {
	flag.Parse()

	if *flagVersion {
		fmt.Printf("dua-screen-aligner %s\n", Version)
		os.Exit(0)
	}

	if *flagListDevices {
		devices, err := DiscoverMouseDevices()
		if err != nil {
			log.Fatalf("Failed to discover devices: %v", err)
		}
		fmt.Printf("Detected mouse devices:\n")
		for _, dev := range devices {
			fmt.Printf("  - %s (%s) via %s\n", dev.Name, dev.Path, dev.ByIDPath)
		}
		os.Exit(0)
	}

	log.SetPrefix("[dua-aligner] ")
	log.SetFlags(log.Ltime | log.Lmicroseconds)

	log.Printf("Starting DuaScreenAligner daemon %s", Version)

	// ---- Optional pprof HTTP server for allocation profiling ----
	if *flagPprof != "" {
		go func() {
			log.Printf("pprof server listening on %s", *flagPprof)
			if err := http.ListenAndServe(*flagPprof, nil); err != nil {
				log.Printf("pprof server error: %v", err)
			}
		}()
	}

	// ---- Initialize shared state ----
	state := &AtomicState{}
	state.Store(StateUnconfigured)

	transform := NewTransformEngine()

	// reloadCh carries device-reload requests from DBus to the event loop.
	// Buffer of 1 to prevent blocking the DBus handler.
	reloadCh := make(chan string, 1)

	// ---- Start DBus service ----
	dbusSvc, err := NewDBusService(transform, state, reloadCh)
	if err != nil {
		log.Fatalf("Failed to start DBus service: %v", err)
	}
	defer dbusSvc.Close()

	// ---- Auto-detect monitor layout from xrandr ----
	// Provides an initial layout so DPI correction works immediately,
	// without waiting for the GNOME extension to push a layout via DBus.
	if initialLayout := DetectLayoutFromXrandr(); initialLayout != nil {
		transform.SetLayout(initialLayout)
		transform.SetEnabled(true)
		state.Store(StateRunning)
		dbusSvc.EmitStatusChanged()
		log.Printf("Auto-configured layout: %s", FormatLayoutSummary(initialLayout))
	}

	// ---- Signal handling for graceful shutdown ----
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)

	// ---- Main event loop ----
	// Re-entering loop handles device reconnection after hotplug or errors.
	for {
		exitRequested := runEventLoop(transform, state, dbusSvc, reloadCh, sigCh, *flagDevice)
		if exitRequested {
			log.Printf("Shutting down gracefully")
			return
		}

		// Brief pause before retrying to avoid busy-loop on persistent errors.
		log.Printf("Event loop exited, retrying in 2 seconds...")
		state.Store(StateError)
		dbusSvc.EmitStatusChanged()
		time.Sleep(2 * time.Second)
	}
}

// ============================================================================
// Event Loop
// ============================================================================

// runEventLoop is the core processing pipeline. It:
//   1. Opens and grabs the evdev device
//   2. Creates the virtual uinput device
//   3. Reads raw events, applies DPI transformation, injects corrected events
//
// Returns true if a termination signal was received (caller should exit),
// or false if the loop should be retried (device error, reload request).
func runEventLoop(
	transform *TransformEngine,
	state *AtomicState,
	dbusSvc *DBusService,
	reloadCh chan string,
	sigCh chan os.Signal,
	defaultDevice string,
) bool {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	devicePath := defaultDevice
	reader, err := FindDeviceByPath(devicePath)
	if err != nil {
		log.Printf("Cannot open evdev device: %v", err)
		state.Store(StateError)
		dbusSvc.EmitStatusChanged()

		// Wait for either a reload signal or a termination signal.
		select {
		case newPath := <-reloadCh:
			if newPath != "" {
				defaultDevice = newPath
			}
			return false // Retry
		case sig := <-sigCh:
			log.Printf("Received signal %v while waiting for device", sig)
			return true // Exit
		}
	}

	log.Printf("Opened device: %s (%s)", reader.Name(), reader.Path())

	// ---- Grab the device for exclusive access ----
	if err := reader.Grab(); err != nil {
		log.Printf("Failed to grab device: %v", err)
		reader.Close()
		return false // Retry
	}
	log.Printf("Device grabbed exclusively")

	// ---- Create the virtual mouse ----
	writer, err := CreateVirtualMouse()
	if err != nil {
		log.Printf("Failed to create virtual mouse: %v", err)
		reader.Close()
		return false // Retry
	}
	log.Printf("Virtual mouse created")

	// wg tracks the reader goroutine. Cleanup MUST wait for it to exit
	// before closing the fds: closing an fd under a live reader lets the
	// kernel reuse the fd number for the next device, and the leaked
	// goroutine then steals events from the new reader — lost button-up
	// events, stuck mouse clicks. The poll-based ReadEvent guarantees the
	// goroutine notices ctx cancellation within ~500ms.
	var wg sync.WaitGroup

	// heldButtons tracks BTN_LEFT..BTN_EXTRA press state so teardown can
	// inject releases. Without this, a button pressed through the virtual
	// mouse whose release arrives while the device is being swapped leaves
	// the X master pointer with a phantom held button — stuck drags, dead
	// clicks. Written only by the reader goroutine; read after wg.Wait()
	// (WaitGroup provides the happens-before edge).
	var heldButtons [BTN_EXTRA - BTN_LEFT + 1]bool

	// Ensure cleanup on any exit path.
	defer func() {
		cancel()
		wg.Wait()
		// Release any buttons still held on the virtual device before
		// destroying it, so the compositor never sees a phantom press.
		released := false
		for i := range heldButtons {
			if heldButtons[i] {
				var rel InputEvent
				rel.Type = EV_KEY
				rel.Code = uint16(BTN_LEFT + i)
				rel.Value = 0
				if err := writer.InjectEvent(&rel); err == nil {
					released = true
					log.Printf("Teardown: released held button 0x%x", rel.Code)
				}
			}
		}
		if released {
			_ = writer.InjectSynReport()
		}
		writer.Close()
		reader.Close()
		log.Printf("Devices closed")
	}()

	// Transition to running (or paused if not yet configured).
	if transform.IsEnabled() {
		state.Store(StateRunning)
	} else {
		state.Store(StatePaused)
	}
	dbusSvc.EmitStatusChanged()

	// ---- Watchdog: idle detection ----
	// Logs a single line when the device goes idle and another when events
	// resume, instead of spamming every 5 seconds.
	watchdogCh := make(chan struct{}, 1)
	go func() {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		idle := false
		for {
			select {
			case <-ctx.Done():
				return
			case <-watchdogCh:
				if idle {
					log.Printf("WATCHDOG: events resumed")
					idle = false
				}
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(5 * time.Second)
			case <-timer.C:
				if !idle {
					log.Printf("WATCHDOG: no events for 5s — device idle or disconnected")
					idle = true
				}
				timer.Reset(5 * time.Second)
			}
		}
	}()

	// ---- Hot path: read → transform → inject ----
	var ev InputEvent

	var batchDX, batchDY int32

	errCh := make(chan error, 1)

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			if err := reader.ReadEvent(&ev); err != nil {
				// Timeout is the shutdown checkpoint, not an error.
				if errors.Is(err, ErrReadTimeout) {
					continue
				}
				select {
				case errCh <- err:
				case <-ctx.Done():
				}
				return
			}

			select {
			case watchdogCh <- struct{}{}:
			default:
			}

			switch ev.Type {
			case EV_REL:
				if ev.Code == REL_X {
					batchDX += ev.Value
				} else if ev.Code == REL_Y {
					batchDY += ev.Value
				} else {
					if err := writer.InjectEvent(&ev); err != nil {
						select {
						case errCh <- err:
						case <-ctx.Done():
						}
						return
					}
				}

			case EV_SYN:
				if ev.Code == 0 {
					if batchDX != 0 || batchDY != 0 {
						correctedDX, correctedDY := transform.Transform(batchDX, batchDY)
						if err := writer.InjectRelativeMove(correctedDX, correctedDY); err != nil {
							select {
							case errCh <- err:
							case <-ctx.Done():
							}
							return
						}
						batchDX = 0
						batchDY = 0
					} else {
						if err := writer.InjectEvent(&ev); err != nil {
							select {
							case errCh <- err:
							case <-ctx.Done():
							}
							return
						}
					}
				} else {
					if err := writer.InjectEvent(&ev); err != nil {
						select {
						case errCh <- err:
						case <-ctx.Done():
						}
						return
					}
				}

			case EV_KEY:
				// Track mouse button state for teardown release injection.
				if ev.Code >= BTN_LEFT && ev.Code <= BTN_EXTRA {
					heldButtons[ev.Code-BTN_LEFT] = ev.Value != 0
				}
				if err := writer.InjectEvent(&ev); err != nil {
					select {
					case errCh <- err:
					case <-ctx.Done():
					}
					return
				}

			default:
				if err := writer.InjectEvent(&ev); err != nil {
					select {
					case errCh <- err:
					case <-ctx.Done():
					}
					return
				}
			}
		}
	}()

	// Wait for termination signal, reload request, or error.
	select {
	case sig := <-sigCh:
		log.Printf("Received signal: %v", sig)
		if sig == syscall.SIGHUP {
			return false
		}
		return true

	case newPath := <-reloadCh:
		log.Printf("Device reload requested: %q", newPath)
		if newPath != "" {
			*flagDevice = newPath
		}
		return false

	case err := <-errCh:
		log.Printf("Event loop error: %v", err)
		return false
	}
}
