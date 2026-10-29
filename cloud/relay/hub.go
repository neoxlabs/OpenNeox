package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Wire-compatible with the Neox relay protocol used by the desktop and mobile apps:
//
//   - v1 text envelope: {"to_device_id","from_device_id","to_endpoint"?,"from_endpoint"?,"nonce","ciphertext","ts"}
//   - v2 binary frame:  [0x00][ver=2][hdrLen u16 BE][hdr JSON {"to","from","to_ep"?,"from_ep"?}][body]
//
// Payloads are end-to-end encrypted with a key that only the paired devices hold
// (X25519 + HKDF at pairing time). The relay never decrypts anything; it routes on the
// headers and forwards the bytes unchanged.

const (
	frameMagic   byte = 0x00
	frameVersion byte = 2
	frameHdrMax       = 4096

	pingInterval = 15 * time.Second
	sendBuffer   = 64
	drainWait    = 10 * time.Second
)

var (
	errTargetOffline   = errors.New("target device offline")
	errEnvelopeInvalid = errors.New("envelope schema invalid")
	errFromForged      = errors.New("sender id does not match connection")
)

// conn is one WebSocket connection. Writes go through the send channel so only
// writeLoop touches the socket.
type conn struct {
	space      string // tenant: derived from the token, devices only see their own space
	deviceID   string
	deviceType string // desktop | mobile
	endpoint   string // "" = main entry; "cli:<id>" / "app:<id>" for extra entries on one device
	ws         *websocket.Conn

	send      chan []byte
	mu        sync.Mutex
	unsent    []byte
	closeOnce sync.Once
	closed    chan struct{}
}

func newConn(space, deviceID, deviceType, endpoint string, ws *websocket.Conn) *conn {
	return &conn{
		space: space, deviceID: deviceID, deviceType: deviceType, endpoint: endpoint, ws: ws,
		send: make(chan []byte, sendBuffer), closed: make(chan struct{}),
	}
}

func (c *conn) key() string { return routeKey(c.deviceID, c.endpoint) }

func routeKey(deviceID, endpoint string) string {
	if endpoint == "" {
		return deviceID
	}
	return deviceID + "#" + endpoint
}

// enqueue is non-blocking. A full buffer means the peer is not reading; drop the
// connection instead of growing memory.
func (c *conn) enqueue(payload []byte) bool {
	select {
	case <-c.closed:
		return false
	default:
	}
	select {
	case <-c.closed:
		return false
	case c.send <- payload:
		return true
	default:
		c.close("send_buffer_full")
		return false
	}
}

// enqueueWait is for backlog delivery: it waits for the writer instead of treating a
// full buffer as a stuck peer.
func (c *conn) enqueueWait(payload []byte, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-c.closed:
		return false
	case c.send <- payload:
		return true
	case <-t.C:
		return false
	}
}

func (c *conn) writeLoop() {
	defer c.close("write_loop_exit")
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	for {
		select {
		case <-c.closed:
			return
		case msg := <-c.send:
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			op := websocket.TextMessage
			if isBinaryFrame(msg) {
				op = websocket.BinaryMessage
			}
			if err := c.ws.WriteMessage(op, msg); err != nil {
				c.mu.Lock()
				c.unsent = msg
				c.mu.Unlock()
				return
			}
		case <-ping.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *conn) close(reason string) {
	c.closeOnce.Do(func() {
		_ = c.ws.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, reason),
			time.Now().Add(2*time.Second))
		_ = c.ws.Close()
		close(c.closed)
	})
}

// leftover returns what was queued but never written, in order. Call after close.
func (c *conn) leftover() [][]byte {
	var out [][]byte
	c.mu.Lock()
	if c.unsent != nil {
		out = append(out, c.unsent)
		c.unsent = nil
	}
	c.mu.Unlock()
	for {
		select {
		case msg := <-c.send:
			out = append(out, msg)
		default:
			return out
		}
	}
}

// hub routes by (space, device_id, endpoint). A new connection for the same key
// displaces the old one.
type hub struct {
	mu    sync.RWMutex
	conns map[string]map[string]*conn
}

func newHub() *hub { return &hub{conns: map[string]map[string]*conn{}} }

func (h *hub) register(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	devices := h.conns[c.space]
	if devices == nil {
		devices = map[string]*conn{}
		h.conns[c.space] = devices
	}
	if old := devices[c.key()]; old != nil {
		go old.close("displaced_by_new_conn")
	}
	devices[c.key()] = c
}

func (h *hub) unregister(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	devices := h.conns[c.space]
	if devices == nil {
		return
	}
	if devices[c.key()] == c {
		delete(devices, c.key())
	}
	if len(devices) == 0 {
		delete(h.conns, c.space)
	}
}

func (h *hub) find(space, deviceID, endpoint string) *conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.conns[space][routeKey(deviceID, endpoint)]
}

func (h *hub) filter(space string, keep func(*conn) bool) []*conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var out []*conn
	for _, c := range h.conns[space] {
		if keep(c) {
			out = append(out, c)
		}
	}
	return out
}

// cliEndpoints: extra desktop entries (CLI windows) a phone can attach to.
func (h *hub) cliEndpoints(space string) []*conn {
	return h.filter(space, func(c *conn) bool { return c.endpoint != "" && c.deviceType == "desktop" })
}

func (h *hub) mobiles(space string) []*conn {
	return h.filter(space, func(c *conn) bool { return c.deviceType == "mobile" })
}

func (h *hub) counts() (spaces, devices int) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, d := range h.conns {
		devices += len(d)
	}
	return len(h.conns), devices
}

type envelope struct {
	ToDeviceID   string `json:"to_device_id"`
	FromDeviceID string `json:"from_device_id"`
	ToEndpoint   string `json:"to_endpoint,omitempty"`
	FromEndpoint string `json:"from_endpoint,omitempty"`
	Nonce        string `json:"nonce"`
	Ciphertext   string `json:"ciphertext"`
}

func parseEnvelope(raw []byte) (envelope, error) {
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return env, errEnvelopeInvalid
	}
	if env.ToDeviceID == "" || env.FromDeviceID == "" || env.Nonce == "" || env.Ciphertext == "" {
		return env, errEnvelopeInvalid
	}
	return env, nil
}

// deliverEnvelope routes a v1 text envelope to a connected peer.
func (h *hub) deliverEnvelope(from *conn, raw []byte) (envelope, error) {
	env, err := parseEnvelope(raw)
	if err != nil {
		return env, err
	}
	if env.FromDeviceID != from.deviceID || env.FromEndpoint != from.endpoint {
		return env, errFromForged
	}
	target := h.find(from.space, env.ToDeviceID, env.ToEndpoint)
	if target == nil || !target.enqueue(raw) {
		return env, errTargetOffline
	}
	return env, nil
}

type frameHeader struct {
	To     string `json:"to"`
	From   string `json:"from"`
	ToEp   string `json:"to_ep,omitempty"`
	FromEp string `json:"from_ep,omitempty"`
}

func isBinaryFrame(raw []byte) bool { return len(raw) > 0 && raw[0] == frameMagic }

func parseFrameHeader(raw []byte) (frameHeader, error) {
	var h frameHeader
	if len(raw) < 4 || raw[0] != frameMagic || raw[1] != frameVersion {
		return h, errEnvelopeInvalid
	}
	n := int(binary.BigEndian.Uint16(raw[2:4]))
	if n == 0 || n > frameHdrMax || len(raw) <= 4+n {
		return h, errEnvelopeInvalid
	}
	if err := json.Unmarshal(raw[4:4+n], &h); err != nil || h.To == "" || h.From == "" {
		return h, errEnvelopeInvalid
	}
	return h, nil
}

// deliverFrame routes a v2 binary frame. Binary frames are never queued: the
// receiver re-fetches what it missed when it comes back.
func (h *hub) deliverFrame(from *conn, raw []byte) (frameHeader, error) {
	hdr, err := parseFrameHeader(raw)
	if err != nil {
		return hdr, err
	}
	if hdr.From != from.deviceID || hdr.FromEp != from.endpoint {
		return hdr, errFromForged
	}
	target := h.find(from.space, hdr.To, hdr.ToEp)
	if target == nil || !target.enqueue(raw) {
		return hdr, errTargetOffline
	}
	return hdr, nil
}
