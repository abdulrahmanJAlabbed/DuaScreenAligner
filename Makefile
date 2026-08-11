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

# Standalone-app install destinations (user scope, no root needed).
APP_INSTALLDIR  := $(REAL_HOME)/.local/share/dua-screen-aligner
APPS_DIR        := $(REAL_HOME)/.local/share/applications
ICONS_DIR       := $(REAL_HOME)/.local/share/icons/hicolor/scalable/apps
APP_FILES       := editor.js app.js displayConfig.js alignWizard.js

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
	install -m 644 systemd/dua-screen-aligner.service /etc/systemd/system/
	systemctl daemon-reload
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

# Install the standalone desktop app (shares editor.js with the extension).
# User scope — no root. Launch "DuaScreen Aligner" from the app grid.
.PHONY: install-app
install-app:
	@echo "Installing standalone app..."
	mkdir -p $(APP_INSTALLDIR)/schemas
	cp $(addprefix $(EXTENSION_DIR)/,$(APP_FILES)) $(APP_INSTALLDIR)/
	cp $(EXTENSION_DIR)/schemas/*.gschema.xml $(APP_INSTALLDIR)/schemas/
	glib-compile-schemas $(APP_INSTALLDIR)/schemas
	chmod +x $(APP_INSTALLDIR)/app.js
	mkdir -p $(ICONS_DIR)
	cp $(EXTENSION_DIR)/icons/dua-screen-aligner.svg $(ICONS_DIR)/
	@gtk-update-icon-cache -f -t $(REAL_HOME)/.local/share/icons/hicolor 2>/dev/null || true
	mkdir -p $(APPS_DIR)
	sed 's|@APPDIR@|$(APP_INSTALLDIR)|g' \
		$(EXTENSION_DIR)/dua-screen-aligner.desktop.in > $(APPS_DIR)/dua-screen-aligner.desktop
	@update-desktop-database $(APPS_DIR) 2>/dev/null || true
	@echo "Installed. Launch 'DuaScreen Aligner' from your apps (or: gjs -m $(APP_INSTALLDIR)/app.js)."

.PHONY: uninstall-app
uninstall-app:
	rm -rf $(APP_INSTALLDIR)
	rm -f $(APPS_DIR)/dua-screen-aligner.desktop
	rm -f $(ICONS_DIR)/dua-screen-aligner.svg
	@update-desktop-database $(APPS_DIR) 2>/dev/null || true
	@echo "Standalone app removed."

.PHONY: pack-extension
pack-extension:
	@echo "Packing GNOME Shell extension for extensions.gnome.org..."
	mkdir -p $(BUILD_DIR)
	gnome-extensions pack $(EXTENSION_DIR) \
		--extra-source=editor.js \
		--extra-source=displayConfig.js \
		--extra-source=alignWizard.js \
		--extra-source=icons \
		--force -o $(BUILD_DIR)

# Debian package for the daemon (binary + systemd unit + DBus policy).
DEB_VERSION := $(shell git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')
ifeq ($(DEB_VERSION),)
DEB_VERSION := 0.2.0
endif
DEB_DIR     := $(BUILD_DIR)/deb

.PHONY: deb
deb: build
	@echo "Building .deb package..."
	rm -rf $(DEB_DIR)
	mkdir -p $(DEB_DIR)/DEBIAN $(DEB_DIR)/usr/bin \
		$(DEB_DIR)/lib/systemd/system $(DEB_DIR)/etc/dbus-1/system.d
	install -m 755 $(BUILD_DIR)/dua-screen-aligner $(DEB_DIR)/usr/bin/dua-screen-aligner
	sed 's|/usr/local/bin/|/usr/bin/|' systemd/dua-screen-aligner.service \
		> $(DEB_DIR)/lib/systemd/system/dua-screen-aligner.service
	install -m 644 dbus/com.github.duascreenaligner.Daemon.conf \
		$(DEB_DIR)/etc/dbus-1/system.d/
	printf 'Package: dua-screen-aligner\nVersion: %s\nSection: utils\nPriority: optional\nArchitecture: amd64\nDepends: x11-xserver-utils\nMaintainer: DuaScreen Aligner <essore99@gmail.com>\nDescription: Multi-monitor DPI cursor correction daemon\n Pairs with the DuaScreen Aligner GNOME extension to fix cursor speed\n and alignment across monitors with different pixel densities.\n' \
		"$(DEB_VERSION)" > $(DEB_DIR)/DEBIAN/control
	printf '#!/bin/sh\nset -e\nsystemctl daemon-reload\nsystemctl enable --now dua-screen-aligner.service || true\n' \
		> $(DEB_DIR)/DEBIAN/postinst
	printf '#!/bin/sh\nset -e\nsystemctl disable --now dua-screen-aligner.service || true\n' \
		> $(DEB_DIR)/DEBIAN/prerm
	chmod 755 $(DEB_DIR)/DEBIAN/postinst $(DEB_DIR)/DEBIAN/prerm
	dpkg-deb --build --root-owner-group $(DEB_DIR) \
		$(BUILD_DIR)/dua-screen-aligner_$(DEB_VERSION)_amd64.deb

# Everything needed for a release: extension zip + daemon .deb.
.PHONY: dist
dist: pack-extension deb
	@echo "Release artifacts:"
	@ls -la $(BUILD_DIR)/*.zip $(BUILD_DIR)/*.deb $(EXTENSION_UUID).shell-extension.zip 2>/dev/null || true
	@ls -la $(BUILD_DIR)

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
