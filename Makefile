# ============================================================================
# DuaScreenAligner — Makefile
# ============================================================================
#
# Targets:
#   build            — Compile the Go daemon (stripped binary)
#   test             — Run Go unit tests + validate GNOME extension
#   bench            — Run allocation benchmarks (verify zero-alloc hot path)
#   install          — Install daemon, extension, systemd unit, udev rules
#   install-daemon   — Install only the Go daemon binary and systemd service
#   install-extension — Install only the GNOME Shell extension
#   install-udev     — Install only the udev rules
#   pack-extension   — Create distributable .zip for extensions.gnome.org
#   uninstall        — Remove all installed components
#   pprof            — Run daemon with pprof enabled for memory profiling
#   clean            — Remove build artifacts
#
# ============================================================================

# Project metadata
EXTENSION_UUID  := dua-screen-aligner@duascreenaligner.github.com
VERSION         := $(shell git describe --tags --always --dirty 2>/dev/null || echo "0.1.0-dev")

# Directories
EXTENSION_DIR   := extension
BUILD_DIR       := build

# Install destinations
REAL_USER       := $(or $(SUDO_USER),$(USER))
REAL_HOME       := $(shell getent passwd $(REAL_USER) | cut -d: -f6)
EXTENSION_INSTALLDIR := $(REAL_HOME)/.local/share/gnome-shell/extensions/$(EXTENSION_UUID)

# ============================================================================
# Build Targets
# ============================================================================

.PHONY: build
build:
	@echo "Building GNOME Shell extension..."
	glib-compile-schemas $(EXTENSION_DIR)/schemas

.PHONY: install-extension
install-extension: build
	@echo "Installing GNOME Shell extension..."
	mkdir -p $(EXTENSION_INSTALLDIR)
	cp -r $(EXTENSION_DIR)/* $(EXTENSION_INSTALLDIR)

.PHONY: pack-extension
pack-extension:
	@echo "Packing GNOME Shell extension..."
	cd $(EXTENSION_DIR) && zip -r ../$(BUILD_DIR)/$(EXTENSION_UUID).zip .

.PHONY: clean
clean:
	@echo "Cleaning build artifacts..."
	rm -rf $(BUILD_DIR)
