# ============================================================================
# DuaScreenAligner — Makefile
# ============================================================================
#
# Targets:
#   build             — Compile the Go daemon + GSettings schemas
#   test              — Run Go unit tests (race detector) + validate extension
#   bench             — Run allocation benchmarks (verify zero-alloc hot path)
#   install           — Install daemon + extension
#   install-daemon    — Install daemon binary and restart the systemd service
#   install-extension — Install only the GNOME Shell extension
#   pack-extension    — Create distributable .zip for extensions.gnome.org
#   pprof             — Run daemon with pprof enabled for memory profiling
#   clean             — Remove build artifacts
#
# ============================================================================

# Project metadata
EXTENSION_UUID  := dua-screen-aligner@duascreenaligner.github.com
VERSION         := $(shell git describe --tags --always --dirty 2>/dev/null || echo "0.1.0-dev")

# Go toolchain — resolve explicitly because `sudo make` strips the user PATH.
GO := $(shell command -v go 2>/dev/null || echo /usr/local/go/bin/go)

# Directories
DAEMON_DIR      := daemon
EXTENSION_DIR   := extension
BUILD_DIR       := build

# Install destinations
REAL_USER       := $(or $(SUDO_USER),$(USER))
REAL_HOME       := $(shell getent passwd $(REAL_USER) | cut -d: -f6)
EXTENSION_INSTALLDIR := $(REAL_HOME)/.local/share/gnome-shell/extensions/$(EXTENSION_UUID)
BINDIR          := /usr/local/bin
SERVICE_NAME    := dua-screen-aligner

# ============================================================================
# Build Targets
# ============================================================================

.PHONY: build
build:
	@echo "Building Go daemon..."
	mkdir -p $(BUILD_DIR)
	cd $(DAEMON_DIR) && $(GO) build -trimpath \
		-ldflags "-s -w -X main.Version=$(VERSION)" \
		-o ../$(BUILD_DIR)/dua-screen-aligner .
	@echo "Compiling GSettings schemas..."
	glib-compile-schemas --strict $(EXTENSION_DIR)/schemas

.PHONY: test
test:
	cd $(DAEMON_DIR) && $(GO) vet ./... && $(GO) test -race ./...
	glib-compile-schemas --strict $(EXTENSION_DIR)/schemas
	gnome-extensions validate $(EXTENSION_DIR) || true

.PHONY: bench
bench:
	cd $(DAEMON_DIR) && $(GO) test -bench=. -benchmem -run='^$$' ./...

# ============================================================================
# Install Targets
# ============================================================================

.PHONY: install
install: install-daemon install-extension

# Alias for the common misspelling.
.PHONY: install-deamon
install-deamon: install-daemon

.PHONY: install-daemon
install-daemon: build
	@echo "Installing daemon binary..."
	install -m 755 $(BUILD_DIR)/dua-screen-aligner $(BINDIR)/dua-screen-aligner
	install -m 644 dbus/com.github.duascreenaligner.Daemon.conf /etc/dbus-1/system.d/
	@if systemctl is-enabled $(SERVICE_NAME) >/dev/null 2>&1; then \
		echo "Restarting $(SERVICE_NAME)..."; \
		systemctl restart $(SERVICE_NAME); \
	else \
		echo "Service not enabled; enable with: systemctl enable --now $(SERVICE_NAME)"; \
	fi

.PHONY: install-extension
install-extension:
	@echo "Installing GNOME Shell extension..."
	glib-compile-schemas --strict $(EXTENSION_DIR)/schemas
	mkdir -p $(EXTENSION_INSTALLDIR)
	cp -r $(EXTENSION_DIR)/* $(EXTENSION_INSTALLDIR)

.PHONY: pack-extension
pack-extension:
	@echo "Packing GNOME Shell extension..."
	mkdir -p $(BUILD_DIR)
	cd $(EXTENSION_DIR) && zip -r ../$(BUILD_DIR)/$(EXTENSION_UUID).zip .

# ============================================================================
# Development
# ============================================================================

.PHONY: pprof
pprof: build
	sudo $(BUILD_DIR)/dua-screen-aligner --pprof-addr=localhost:6060 --log-level=debug

.PHONY: clean
clean:
	@echo "Cleaning build artifacts..."
	rm -rf $(BUILD_DIR) $(DAEMON_DIR)/build
