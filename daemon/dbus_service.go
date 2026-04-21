// dbus_service.go — DBus system bus interface for the DuaScreenAligner daemon.
//
// Exposes the com.github.duascreenaligner.Daemon interface on the system bus,
// allowing the GNOME Shell Extension to push layout configurations, query
// daemon status, and control the correction engine.
//
// The DBus service runs in its own goroutine and communicates with the event
// loop via the shared TransformEngine (atomic pointer swap) and AtomicState.
package main

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/godbus/dbus/v5"
	"github.com/godbus/dbus/v5/introspect"
)

// ============================================================================
// Constants
// ============================================================================

// DBus well-known name and object path for the daemon service.
const (
	dbusName = "com.github.duascreenaligner.Daemon"
	dbusPath = "/com/github/duascreenaligner/Daemon"
	dbusIface = "com.github.duascreenaligner.Daemon"
)

// Version is the daemon build version, injected at compile time via -ldflags.
var Version = "0.1.0-dev"

// ============================================================================
// DBus Introspection XML
// ============================================================================

// introspectXML defines the DBus interface contract for automatic introspection.
// Matches the XML in dbus/com.github.duascreenaligner.Daemon.xml.
const introspectXML = `
<node>
  <interface name="com.github.duascreenaligner.Daemon">
    <method name="SetLayout">
      <arg name="layout" type="s" direction="in"/>
      <arg name="success" type="b" direction="out"/>
    </method>
    <method name="GetStatus">
      <arg name="status" type="s" direction="out"/>
    </method>
    <method name="SetEnabled">
      <arg name="enabled" type="b" direction="in"/>
      <arg name="success" type="b" direction="out"/>
    </method>
    <method name="ReloadDevice">
      <arg name="success" type="b" direction="out"/>
    </method>
    <method name="GetLayout">
      <arg name="layout" type="s" direction="out"/>
    </method>
    <method name="ListDevices">
      <arg name="devices" type="s" direction="out"/>
    </method>
    <property name="Version" type="s" access="read"/>
    <property name="Enabled" type="b" access="read"/>
    <signal name="StatusChanged">
      <arg name="status" type="s"/>
    </signal>
    <signal name="LayoutApplied">
      <arg name="monitorCount" type="i"/>
    </signal>
  </interface>
</node>
`

// ============================================================================
// DBusService
// ============================================================================

// DBusService implements the com.github.duascreenaligner.Daemon interface.
// It holds references to the shared TransformEngine and AtomicState that
// are also used by the event loop goroutine.
type DBusService struct {
	// conn is the active DBus system bus connection.
	conn *dbus.Conn

	// transform is the shared transformation engine.
	// Layout updates from SetLayout() are atomically pushed here.
	transform *TransformEngine

	// state is the shared atomic daemon state.
	state *AtomicState

	// currentLayout stores the last successfully applied layout config
	// for GetLayout() retrieval. Protected by single-writer semantics
	// (only DBus goroutine writes; event loop never reads this field).
	currentLayout *LayoutConfig

	// reloadCh signals the event loop to re-scan and re-grab the device.
	reloadCh chan string
}

// NewDBusService creates and starts the DBus system bus service.
// Requests the well-known name and exports the service object.
//
// Parameters:
//   - transform: the shared TransformEngine for atomic layout updates.
//   - state: the shared AtomicState for status queries.
//   - reloadCh: channel to signal device reload requests to the event loop.
func NewDBusService(transform *TransformEngine, state *AtomicState, reloadCh chan string) (*DBusService, error) {
	// Connect to the system bus. Requires appropriate DBus policy.
	// During development, the session bus can be used instead.
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		// Fallback to session bus for development/testing.
		log.Printf("System bus unavailable, falling back to session bus: %v", err)
		conn, err = dbus.ConnectSessionBus()
		if err != nil {
			return nil, fmt.Errorf("failed to connect to any DBus: %w", err)
		}
	}

	svc := &DBusService{
		conn:      conn,
		transform: transform,
		state:     state,
		reloadCh:  reloadCh,
	}

	// Export the service object with all interface methods.
	if err := conn.Export(svc, dbus.ObjectPath(dbusPath), dbusIface); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to export DBus object: %w", err)
	}

	// Export introspection data for tools like d-feet and busctl.
	if err := conn.Export(
		introspect.NewIntrospectable(&introspect.Node{
			Name: dbusPath,
			Interfaces: []introspect.Interface{
				introspect.IntrospectData,
				{
					Name:    dbusIface,
					Methods: introspect.Methods(svc),
				},
			},
		}),
		dbus.ObjectPath(dbusPath),
		"org.freedesktop.DBus.Introspectable",
	); err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to export introspection: %w", err)
	}

	// Request the well-known bus name.
	reply, err := conn.RequestName(dbusName, dbus.NameFlagDoNotQueue)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("failed to request DBus name %s: %w", dbusName, err)
	}
	if reply != dbus.RequestNameReplyPrimaryOwner {
		conn.Close()
		return nil, fmt.Errorf("DBus name %s already taken", dbusName)
	}

	log.Printf("DBus service registered: %s at %s", dbusName, dbusPath)
	return svc, nil
}

// ============================================================================
// Exported DBus Methods
// ============================================================================

// SetLayout receives a JSON-encoded monitor topology from the extension,
// parses it, pre-computes the DPI scaling matrix, and atomically installs
// it in the TransformEngine.
//
// DBus signature: SetLayout(s) -> (b)
func (s *DBusService) SetLayout(layoutJSON string) (bool, *dbus.Error) {
	cfg, err := ParseLayoutConfig(layoutJSON)
	if err != nil {
		log.Printf("SetLayout: invalid config: %v", err)
		return false, dbus.NewError(dbusIface+".InvalidLayout", []interface{}{err.Error()})
	}

	// Atomically install the new layout in the transform engine.
	s.transform.SetLayout(cfg)
	s.currentLayout = cfg

	// Signal the event loop to re-scan and re-grab the device (in case the path changed).
	select {
	case s.reloadCh <- cfg.DevicePath:
		log.Printf("SetLayout: applied %d monitors, reload requested for %q", len(cfg.Monitors), cfg.DevicePath)
	default:
		log.Printf("SetLayout: applied %d monitors, reload deferred (busy)", len(cfg.Monitors))
	}

	// Emit LayoutApplied signal.
	s.conn.Emit(dbus.ObjectPath(dbusPath), dbusIface+".LayoutApplied", int32(len(cfg.Monitors)))

	return true, nil
}

// GetStatus returns the current daemon state as a string.
//
// DBus signature: GetStatus() -> (s)
func (s *DBusService) GetStatus() (string, *dbus.Error) {
	return s.state.Load().String(), nil
}

// SetEnabled enables or disables DPI cursor correction without stopping
// the daemon. When disabled, raw events pass through unmodified.
//
// DBus signature: SetEnabled(b) -> (b)
func (s *DBusService) SetEnabled(enabled bool) (bool, *dbus.Error) {
	s.transform.SetEnabled(enabled)

	if enabled {
		s.state.Store(StateRunning)
	} else {
		s.state.Store(StatePaused)
	}

	// Emit StatusChanged signal.
	s.conn.Emit(dbus.ObjectPath(dbusPath), dbusIface+".StatusChanged", s.state.Load().String())

	log.Printf("SetEnabled: correction %s", map[bool]string{true: "enabled", false: "disabled"}[enabled])
	return true, nil
}

// ReloadDevice signals the event loop to re-scan /dev/input/ and re-grab
// the configured mouse device. Useful after hotplugging.
//
// DBus signature: ReloadDevice() -> (b)
func (s *DBusService) ReloadDevice() (bool, *dbus.Error) {
	devicePath := ""
	if s.currentLayout != nil {
		devicePath = s.currentLayout.DevicePath
	}

	select {
	case s.reloadCh <- devicePath:
		log.Printf("ReloadDevice: reload requested for %q", devicePath)
		return true, nil
	default:
		return false, dbus.NewError(dbusIface+".Busy", []interface{}{"reload already in progress"})
	}
}

// GetLayout returns the currently active layout as a JSON string.
// Returns empty string if no layout has been configured.
//
// DBus signature: GetLayout() -> (s)
func (s *DBusService) GetLayout() (string, *dbus.Error) {
	if s.currentLayout == nil {
		return "", nil
	}
	jsonStr, err := s.currentLayout.ToJSON()
	if err != nil {
		return "", dbus.NewError(dbusIface+".SerializeError", []interface{}{err.Error()})
	}
	return jsonStr, nil
}

// ListDevices returns a JSON-encoded array of detected evdev mouse devices.
//
// DBus signature: ListDevices() -> (s)
func (s *DBusService) ListDevices() (string, *dbus.Error) {
	devices, err := DiscoverMouseDevices()
	if err != nil {
		return "[]", dbus.NewError(dbusIface+".ScanError", []interface{}{err.Error()})
	}
	data, err := json.Marshal(devices)
	if err != nil {
		return "[]", dbus.NewError(dbusIface+".SerializeError", []interface{}{err.Error()})
	}
	return string(data), nil
}

// ============================================================================
// DBus Properties (read-only)
// ============================================================================

// Get implements org.freedesktop.DBus.Properties.Get for read-only properties.
func (s *DBusService) Get(iface, property string) (dbus.Variant, *dbus.Error) {
	if iface != dbusIface {
		return dbus.Variant{}, dbus.NewError("org.freedesktop.DBus.Error.UnknownInterface", nil)
	}
	switch property {
	case "Version":
		return dbus.MakeVariant(Version), nil
	case "Enabled":
		return dbus.MakeVariant(s.transform.IsEnabled()), nil
	default:
		return dbus.Variant{}, dbus.NewError("org.freedesktop.DBus.Error.UnknownProperty", nil)
	}
}

// GetAll implements org.freedesktop.DBus.Properties.GetAll.
func (s *DBusService) GetAll(iface string) (map[string]dbus.Variant, *dbus.Error) {
	if iface != dbusIface {
		return nil, dbus.NewError("org.freedesktop.DBus.Error.UnknownInterface", nil)
	}
	return map[string]dbus.Variant{
		"Version": dbus.MakeVariant(Version),
		"Enabled": dbus.MakeVariant(s.transform.IsEnabled()),
	}, nil
}

// Set is not supported (all properties are read-only).
func (s *DBusService) Set(iface, property string, value dbus.Variant) *dbus.Error {
	return dbus.NewError("org.freedesktop.DBus.Error.PropertyReadOnly", nil)
}

// ============================================================================
// Lifecycle
// ============================================================================

// Close disconnects from the DBus system bus and releases the well-known name.
func (s *DBusService) Close() error {
	if s.conn != nil {
		s.conn.ReleaseName(dbusName)
		return s.conn.Close()
	}
	return nil
}

// EmitStatusChanged emits the StatusChanged signal with the current state.
// Called by the main event loop when state transitions occur.
func (s *DBusService) EmitStatusChanged() {
	if s.conn != nil {
		s.conn.Emit(dbus.ObjectPath(dbusPath), dbusIface+".StatusChanged", s.state.Load().String())
	}
}
