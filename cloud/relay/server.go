package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	maxMessageBytes = 256 * 1024
	// The server pings every 15s; two missed pongs and the connection is dead.
	readDeadline = 40 * time.Second
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Clients are the Neox apps, not browsers; auth is the bearer token, not Origin.
	CheckOrigin: func(*http.Request) bool { return true },
}

type server struct {
	hub    *hub
	inbox  *inbox
	tokens map[string]string // sha256(token) hex -> space
	logger *slog.Logger
}

// newServer: every token is its own space. Devices that use the same token can reach
// each other; devices with different tokens cannot see each other at all.
func newServer(tokens []string, logger *slog.Logger) *server {
	s := &server{hub: newHub(), inbox: newInbox(), tokens: map[string]string{}, logger: logger}
	for _, t := range tokens {
		sum := sha256.Sum256([]byte(t))
		s.tokens[hex.EncodeToString(sum[:])] = hex.EncodeToString(sum[:8])
	}
	return s
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)
	// The apps dial <base>/relay/api/v1/relay; serve the bare path too so a reverse
	// proxy that strips /relay keeps working.
	mux.HandleFunc("/relay/api/v1/relay", s.handleRelay)
	mux.HandleFunc("/api/v1/relay", s.handleRelay)
	return mux
}

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	spaces, devices := s.hub.counts()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "spaces": spaces, "devices": devices})
}

// spaceFor checks the bearer token in constant time against every configured token.
func (s *server) spaceFor(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return "", false
	}
	sum := sha256.Sum256([]byte(strings.TrimPrefix(h, "Bearer ")))
	got := hex.EncodeToString(sum[:])
	space, found := "", false
	for want, sp := range s.tokens {
		if subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1 {
			space, found = sp, true
		}
	}
	return space, found
}

func validDeviceID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == ':') {
			return false
		}
	}
	return true
}

// validEndpoint: a desktop may open cli:<id>, a phone app:<id>; id is 1-40 of [A-Za-z0-9-].
func validEndpoint(ep, deviceType string) bool {
	prefix := map[string]string{"desktop": "cli:", "mobile": "app:"}[deviceType]
	if prefix == "" || len(ep) < 5 || len(ep) > 44 || ep[:4] != prefix {
		return false
	}
	for _, r := range ep[4:] {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

func (s *server) handleRelay(w http.ResponseWriter, r *http.Request) {
	space, ok := s.spaceFor(r)
	if !ok {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	deviceID := r.Header.Get("X-Neox-Device-Id")
	deviceType := r.Header.Get("X-Neox-Device-Type")
	if !validDeviceID(deviceID) || (deviceType != "desktop" && deviceType != "mobile") {
		http.Error(w, "missing or invalid device headers", http.StatusBadRequest)
		return
	}
	endpoint := r.Header.Get("X-Neox-Endpoint")
	if endpoint != "" && !validEndpoint(endpoint, deviceType) {
		http.Error(w, "invalid endpoint", http.StatusBadRequest)
		return
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	c := newConn(space, deviceID, deviceType, endpoint, ws)
	s.hub.register(c)
	c.enqueue(helloFrame())
	s.logger.Info("connected", "space", space, "device", deviceID, "type", deviceType, "endpoint", endpoint)

	if endpoint != "" && deviceType == "desktop" {
		s.broadcastEndpoint(c, true)
	}
	if deviceType == "mobile" {
		for _, ep := range s.hub.cliEndpoints(space) {
			c.enqueue(endpointFrame(ep.deviceID, ep.endpoint, true))
		}
	}
	go c.writeLoop()
	// The inbox can hold more than the send buffer (a phone retrying for a day fills it), so
	// drain only once the writer is running and wait for it per message. A plain enqueue here
	// overflowed the buffer, the close put everything back into the inbox, and the desktop
	// reconnected into the same overflow forever.
	if endpoint == "" {
		pending := s.inbox.drain(space, deviceID)
		for i, msg := range pending {
			if !c.enqueueWait(msg, drainWait) {
				for _, rest := range pending[i:] {
					s.inbox.push(space, deviceID, rest)
				}
				break
			}
		}
	}

	s.readLoop(c)

	s.hub.unregister(c)
	c.close("read_loop_exit")
	if endpoint != "" && deviceType == "desktop" && s.hub.find(space, deviceID, endpoint) == nil {
		s.broadcastEndpoint(c, false)
	}
	s.redeliver(c)
	s.logger.Info("disconnected", "space", space, "device", deviceID, "endpoint", endpoint)
}

func (s *server) readLoop(c *conn) {
	c.ws.SetReadLimit(maxMessageBytes)
	_ = c.ws.SetReadDeadline(time.Now().Add(readDeadline))
	c.ws.SetPongHandler(func(string) error {
		return c.ws.SetReadDeadline(time.Now().Add(readDeadline))
	})
	for {
		kind, raw, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		_ = c.ws.SetReadDeadline(time.Now().Add(readDeadline))
		switch kind {
		case websocket.BinaryMessage:
			s.routeFrame(c, raw)
		case websocket.TextMessage:
			s.routeEnvelope(c, raw)
		}
	}
}

func (s *server) routeEnvelope(c *conn, raw []byte) {
	env, err := s.hub.deliverEnvelope(c, raw)
	if err == nil {
		return
	}
	if !errors.Is(err, errTargetOffline) {
		c.enqueue(errorFrame("envelope_invalid", err.Error()))
		return
	}
	if env.ToEndpoint != "" {
		c.enqueue(endpointFrame(env.ToDeviceID, env.ToEndpoint, false))
		return
	}
	// Tell the sender right away, and keep the envelope until the peer reconnects.
	c.enqueue(deviceOfflineFrame(env.ToDeviceID))
	s.inbox.push(c.space, env.ToDeviceID, raw)
}

func (s *server) routeFrame(c *conn, raw []byte) {
	hdr, err := s.hub.deliverFrame(c, raw)
	if err == nil {
		return
	}
	if !errors.Is(err, errTargetOffline) {
		c.enqueue(errorFrame("envelope_invalid", err.Error()))
		return
	}
	if hdr.ToEp != "" {
		c.enqueue(endpointFrame(hdr.To, hdr.ToEp, false))
		return
	}
	c.enqueue(deviceOfflineFrame(hdr.To))
}

// redeliver: messages still queued on a dead connection go to its replacement if
// the device already reconnected, otherwise to the offline inbox (text envelopes only).
func (s *server) redeliver(c *conn) {
	for _, raw := range c.leftover() {
		if next := s.hub.find(c.space, c.deviceID, c.endpoint); next != nil && next != c && next.enqueue(raw) {
			continue
		}
		if c.endpoint == "" && !isBinaryFrame(raw) {
			s.inbox.push(c.space, c.deviceID, raw)
		}
	}
}

func (s *server) broadcastEndpoint(c *conn, online bool) {
	frame := endpointFrame(c.deviceID, c.endpoint, online)
	for _, m := range s.hub.mobiles(c.space) {
		m.enqueue(frame)
	}
}

func controlFrame(fields map[string]any) []byte {
	fields["ts"] = time.Now().UnixMilli()
	b, _ := json.Marshal(fields)
	return b
}

func helloFrame() []byte {
	return controlFrame(map[string]any{"type": "relay_hello", "v": int(frameVersion), "max_frame": maxMessageBytes})
}

func deviceOfflineFrame(deviceID string) []byte {
	return controlFrame(map[string]any{"type": "device_offline", "device_id": deviceID, "message": "target device not connected to relay"})
}

func endpointFrame(deviceID, endpoint string, online bool) []byte {
	t := "endpoint_offline"
	if online {
		t = "endpoint_online"
	}
	return controlFrame(map[string]any{"type": t, "device_id": deviceID, "endpoint": endpoint})
}

func errorFrame(code, msg string) []byte {
	return controlFrame(map[string]any{"type": "relay_error", "code": code, "message": msg})
}
