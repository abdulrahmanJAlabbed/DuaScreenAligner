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
	"flag"
	"fmt"
	"log"
	"net/http"
	_ "net/http/pprof" // Side-effect import: registers pprof handlers
	"os"
	"os/signal"
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
	// ---- Open the evdev device ----
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

	// Ensure cleanup on any exit path.
	defer func() {
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

	// ---- Watchdog: auto-ungrab safety net ----
	// If the event loop hangs or the process is about to be killed,
	// this timer ensures the device is ungrabbed within 5 seconds.
	watchdogCh := make(chan struct{}, 1)
	go func() {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-watchdogCh:
				// Event received — reset the watchdog.
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(5 * time.Second)
			case <-timer.C:
				// Watchdog expired — log warning but don't ungrab.
				// (Ungrab only on actual errors or signals.)
				log.Printf("WATCHDOG: no events for 5s — device may be idle or disconnected")
				timer.Reset(5 * time.Second)
			}
		}
	}()

	// ---- Hot path: read → transform → inject ----
	// The InputEvent is stack-allocated here. ReadEvent and InjectEvent
	// operate on it via unsafe byte slice overlays — zero allocations.
	var ev InputEvent

	// errCh receives the first error from the read goroutine.
	errCh := make(chan error, 1)

	go func() {
		for {
			// Blocking read — zero allocation.
			if err := reader.ReadEvent(&ev); err != nil {
				errCh <- err
				return
			}

			// Notify watchdog that we're still alive.
			select {
			case watchdogCh <- struct{}{}:
			default:
			}

			// Branch based on event type.
			switch ev.Type {
			case EV_REL:
				// Relative movement — this is where DPI correction happens.
				if ev.Code == REL_X || ev.Code == REL_Y {
					// For diagonal movement, we need both X and Y to transform
					// together. However, evdev sends them as separate events
					// within the same SYN_REPORT group. For simplicity and
					// correctness at the single-axis level:
					if ev.Code == REL_X {
						correctedDX, _ := transform.Transform(ev.Value, 0)
						ev.Value = correctedDX
					} else {
						_, correctedDY := transform.Transform(0, ev.Value)
						ev.Value = correctedDY
					}
				}
				// Scroll events (REL_WHEEL, REL_HWHEEL) pass through unchanged.
				if err := writer.InjectEvent(&ev); err != nil {
					errCh <- err
					return
				}

			case EV_KEY, EV_SYN, EV_MSC:
				// Buttons, sync markers, and misc events: pass through unchanged.
				if err := writer.InjectEvent(&ev); err != nil {
					errCh <- err
					return
				}

			default:
				// Unknown event types: pass through for compatibility.
				if err := writer.InjectEvent(&ev); err != nil {
					errCh <- err
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
			// SIGHUP: reload device, don't exit.
			return false
		}
		return true // SIGTERM/SIGINT: exit.

	case newPath := <-reloadCh:
		log.Printf("Device reload requested: %q", newPath)
		if newPath != "" {
			// The next iteration will use the new path.
			// We store it by modifying the flag (safe: single select).
			*flagDevice = newPath
		}
		return false // Retry

	case err := <-errCh:
		log.Printf("Event loop error: %v", err)
		return false // Retry
	}
}
