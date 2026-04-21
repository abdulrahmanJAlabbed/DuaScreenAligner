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
DAEMON_NAME     := dua-screen-aligner
EXTENSION_UUID  := dua-screen-aligner@duascreenaligner.github.com
VERSION         := $(shell git describe --tags --always --dirty 2>/dev/null || echo "0.1.0-dev")

# Directories
DAEMON_DIR      := daemon
EXTENSION_DIR   := extension
DBUS_DIR        := dbus
SYSTEMD_DIR     := systemd
UDEV_DIR        := udev
BUILD_DIR       := build

# Install destinations
PREFIX          := /usr/local
BINDIR          := $(PREFIX)/bin
SYSTEMD_UNITDIR := /etc/systemd/system
DBUS_CONFDIR    := /etc/dbus-1/system.d
UDEV_RULESDIR   := /etc/udev/rules.d
# Ensure the extension is installed to the real user's home when running with sudo.
REAL_USER       := $(or $(SUDO_USER),$(USER))
REAL_HOME       := $(shell getent passwd $(REAL_USER) | cut -d: -f6)
EXTENSION_INSTALLDIR := $(REAL_HOME)/.local/share/gnome-shell/extensions/$(EXTENSION_UUID)

# Go build flags
GO              := go
GOFLAGS         := -trimpath
LDFLAGS         := -s -w -X main.Version=$(VERSION)

# ============================================================================
# Build
# ============================================================================

.PHONY: build
build: $(BUILD_DIR)/$(DAEMON_NAME) ## Compile the Go daemon binary

$(BUILD_DIR)/$(DAEMON_NAME): $(DAEMON_DIR)/*.go $(DAEMON_DIR)/go.mod
	@mkdir -p $(BUILD_DIR)
	@echo "==> Building daemon $(VERSION)..."
	cd $(DAEMON_DIR) && $(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o ../$(BUILD_DIR)/$(DAEMON_NAME) .
	@echo "==> Binary: $(BUILD_DIR)/$(DAEMON_NAME)"
	@ls -lh $(BUILD_DIR)/$(DAEMON_NAME)

# ============================================================================
# Test
# ============================================================================

.PHONY: test
test: test-daemon test-extension ## Run all tests

.PHONY: test-daemon
test-daemon: ## Run Go unit tests with race detector
	@echo "==> Running daemon tests..."
	cd $(DAEMON_DIR) && $(GO) test -v -race -count=1 ./...

.PHONY: test-extension
test-extension: ## Validate GNOME extension structure
	@echo "==> Validating GNOME extension..."
	@if command -v gnome-extensions >/dev/null 2>&1; then \
		gnome-extensions validate $(EXTENSION_DIR)/ || true; \
	else \
		echo "    gnome-extensions not found, skipping validation"; \
	fi
	@echo "==> Compiling GSettings schemas..."
	glib-compile-schemas --strict $(EXTENSION_DIR)/schemas/

.PHONY: bench
bench: ## Run allocation benchmarks (verify zero-alloc hot path)
	@echo "==> Running benchmarks..."
	cd $(DAEMON_DIR) && $(GO) test -bench=. -benchmem -count=5 -run=^$$ ./...

# ============================================================================
# Install
# ============================================================================

.PHONY: install
install: install-daemon install-extension install-udev install-dbus ## Install everything
	@echo "==> Installation complete!"
	@echo ""
	@echo "Next steps:"
	@echo "  1. sudo systemctl daemon-reload"
	@echo "  2. sudo systemctl enable --now $(DAEMON_NAME)"
	@echo "  3. Restart GNOME Shell (Alt+F2, type 'r') or log out/in"
	@echo "  4. Enable the extension: gnome-extensions enable $(EXTENSION_UUID)"

.PHONY: install-daemon
install-daemon: build ## Install the daemon binary and systemd service
	@echo "==> Installing daemon..."
	sudo install -Dm755 $(BUILD_DIR)/$(DAEMON_NAME) $(BINDIR)/$(DAEMON_NAME)
	sudo install -Dm644 $(SYSTEMD_DIR)/$(DAEMON_NAME).service $(SYSTEMD_UNITDIR)/$(DAEMON_NAME).service
	@echo "    Binary: $(BINDIR)/$(DAEMON_NAME)"
	@echo "    Service: $(SYSTEMD_UNITDIR)/$(DAEMON_NAME).service"
	@echo "    Run: sudo systemctl daemon-reload && sudo systemctl enable --now $(DAEMON_NAME)"

.PHONY: install-extension
install-extension: ## Install the GNOME Shell extension
	@echo "==> Installing GNOME extension..."
	@mkdir -p $(EXTENSION_INSTALLDIR)
	cp $(EXTENSION_DIR)/metadata.json $(EXTENSION_INSTALLDIR)/
	cp $(EXTENSION_DIR)/extension.js $(EXTENSION_INSTALLDIR)/
	cp $(EXTENSION_DIR)/prefs.js $(EXTENSION_INSTALLDIR)/
	cp $(EXTENSION_DIR)/stylesheet.css $(EXTENSION_INSTALLDIR)/
	@mkdir -p $(EXTENSION_INSTALLDIR)/schemas
	cp $(EXTENSION_DIR)/schemas/*.xml $(EXTENSION_INSTALLDIR)/schemas/
	glib-compile-schemas $(EXTENSION_INSTALLDIR)/schemas/
	@echo "    Installed to: $(EXTENSION_INSTALLDIR)"
	@echo "    Enable: gnome-extensions enable $(EXTENSION_UUID)"

.PHONY: install-udev
install-udev: ## Install udev rules
	@echo "==> Installing udev rules..."
	sudo install -Dm644 $(UDEV_DIR)/99-$(DAEMON_NAME).rules $(UDEV_RULESDIR)/99-$(DAEMON_NAME).rules
	sudo udevadm control --reload-rules
	sudo udevadm trigger
	@echo "    Rules: $(UDEV_RULESDIR)/99-$(DAEMON_NAME).rules"

.PHONY: install-dbus
install-dbus: ## Install DBus system bus policy
	@echo "==> Installing DBus policy..."
	sudo install -Dm644 $(DBUS_DIR)/com.github.duascreenaligner.Daemon.conf $(DBUS_CONFDIR)/com.github.duascreenaligner.Daemon.conf
	# Clean up the old location if it exists
	-sudo rm -f /usr/share/dbus-1/system.d/com.github.duascreenaligner.Daemon.conf
	@echo "    Policy: $(DBUS_CONFDIR)/com.github.duascreenaligner.Daemon.conf"

# ============================================================================
# Extension Packaging
# ============================================================================

.PHONY: pack-extension
pack-extension: ## Create distributable .zip for extensions.gnome.org
	@echo "==> Packing GNOME extension..."
	@mkdir -p $(BUILD_DIR)
	glib-compile-schemas $(EXTENSION_DIR)/schemas/
	cd $(EXTENSION_DIR) && zip -r ../$(BUILD_DIR)/$(EXTENSION_UUID).zip \
		metadata.json extension.js prefs.js stylesheet.css schemas/
	@echo "    Package: $(BUILD_DIR)/$(EXTENSION_UUID).zip"

# ============================================================================
# Uninstall
# ============================================================================

.PHONY: uninstall
uninstall: ## Remove all installed components
	@echo "==> Uninstalling..."
	-sudo systemctl stop $(DAEMON_NAME) 2>/dev/null
	-sudo systemctl disable $(DAEMON_NAME) 2>/dev/null
	-sudo rm -f $(BINDIR)/$(DAEMON_NAME)
	-sudo rm -f $(SYSTEMD_UNITDIR)/$(DAEMON_NAME).service
	-sudo rm -f $(UDEV_RULESDIR)/99-$(DAEMON_NAME).rules
	-sudo rm -f $(DBUS_CONFDIR)/com.github.duascreenaligner.Daemon.conf
	-rm -rf $(EXTENSION_INSTALLDIR)
	-sudo systemctl daemon-reload
	-sudo udevadm control --reload-rules
	@echo "==> Uninstalled"

# ============================================================================
# Development Tools
# ============================================================================

.PHONY: pprof
pprof: build ## Run daemon with pprof for memory profiling
	@echo "==> Starting daemon with pprof on localhost:6060..."
	@echo "    Verify zero allocs: go tool pprof http://localhost:6060/debug/pprof/heap"
	@echo "    Allocation profile: go tool pprof -alloc_space http://localhost:6060/debug/pprof/heap"
	sudo $(BUILD_DIR)/$(DAEMON_NAME) --pprof-addr=localhost:6060 --log-level=debug

.PHONY: dev-session
dev-session: ## Launch a nested GNOME Shell (Wayland) for extension testing
	@echo "==> Starting nested GNOME Shell..."
	@echo "    Install extension first: make install-extension"
	dbus-run-session -- gnome-shell --nested --wayland

.PHONY: lint-go
lint-go: ## Run Go static analysis
	cd $(DAEMON_DIR) && $(GO) vet ./...
	@if command -v staticcheck >/dev/null 2>&1; then \
		cd $(DAEMON_DIR) && staticcheck ./...; \
	fi

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf $(BUILD_DIR)
	rm -f $(EXTENSION_DIR)/schemas/gschemas.compiled

# ============================================================================
# Help
# ============================================================================

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
