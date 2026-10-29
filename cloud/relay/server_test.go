package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const tokenA = "token-a-0123456789abcdef"
const tokenB = "token-b-0123456789abcdef"

func startServer(t *testing.T) *httptest.Server {
	t.Helper()
	s := newServer([]string{tokenA, tokenB}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ts := httptest.NewServer(s.routes())
	t.Cleanup(ts.Close)
	return ts
}

func dial(t *testing.T, ts *httptest.Server, token, deviceID, deviceType string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/relay/api/v1/relay"
	h := http.Header{}
	h.Set("Authorization", "Bearer "+token)
	h.Set("X-Neox-Device-Id", deviceID)
	h.Set("X-Neox-Device-Type", deviceType)
	ws, resp, err := websocket.DefaultDialer.Dial(url, h)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("dial %s: %v (status %d)", deviceID, err, status)
	}
	t.Cleanup(func() { ws.Close() })
	if typ := readControl(t, ws)["type"]; typ != "relay_hello" {
		t.Fatalf("first frame = %v, want relay_hello", typ)
	}
	return ws
}

func read(t *testing.T, ws *websocket.Conn) (int, []byte) {
	t.Helper()
	_ = ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	kind, raw, err := ws.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return kind, raw
}

func readControl(t *testing.T, ws *websocket.Conn) map[string]any {
	t.Helper()
	_, raw := read(t, ws)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("not json: %s", raw)
	}
	return m
}

func envelopeJSON(from, to string) []byte {
	b, _ := json.Marshal(map[string]any{"from_device_id": from, "to_device_id": to, "nonce": "bm9uY2U=", "ciphertext": "Y2lwaGVy", "ts": 1})
	return b
}

func TestRejectsBadToken(t *testing.T) {
	ts := startServer(t)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/relay/api/v1/relay"
	h := http.Header{}
	h.Set("Authorization", "Bearer wrong-token-0123456789")
	h.Set("X-Neox-Device-Id", "d1")
	h.Set("X-Neox-Device-Type", "desktop")
	_, resp, err := websocket.DefaultDialer.Dial(url, h)
	if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got err=%v resp=%v", err, resp)
	}
}

func TestRoutesEnvelopeBetweenDevicesWithSameToken(t *testing.T) {
	ts := startServer(t)
	desk := dial(t, ts, tokenA, "desk1", "desktop")
	phone := dial(t, ts, tokenA, "phone1", "mobile")

	env := envelopeJSON("phone1", "desk1")
	if err := phone.WriteMessage(websocket.TextMessage, env); err != nil {
		t.Fatal(err)
	}
	if _, got := read(t, desk); string(got) != string(env) {
		t.Fatalf("desktop got %s", got)
	}
}

func TestTokensAreIsolated(t *testing.T) {
	ts := startServer(t)
	dial(t, ts, tokenA, "desk1", "desktop")
	phone := dial(t, ts, tokenB, "phone1", "mobile")

	_ = phone.WriteMessage(websocket.TextMessage, envelopeJSON("phone1", "desk1"))
	if m := readControl(t, phone); m["type"] != "device_offline" || m["device_id"] != "desk1" {
		t.Fatalf("want device_offline for desk1, got %v", m)
	}
}

func TestRejectsForgedSender(t *testing.T) {
	ts := startServer(t)
	dial(t, ts, tokenA, "desk1", "desktop")
	phone := dial(t, ts, tokenA, "phone1", "mobile")

	_ = phone.WriteMessage(websocket.TextMessage, envelopeJSON("someone-else", "desk1"))
	if m := readControl(t, phone); m["type"] != "relay_error" {
		t.Fatalf("want relay_error, got %v", m)
	}
}

func TestOfflineEnvelopeIsQueuedUntilReconnect(t *testing.T) {
	ts := startServer(t)
	phone := dial(t, ts, tokenA, "phone1", "mobile")
	env := envelopeJSON("phone1", "desk1")
	_ = phone.WriteMessage(websocket.TextMessage, env)
	if m := readControl(t, phone); m["type"] != "device_offline" {
		t.Fatalf("want device_offline, got %v", m)
	}
	desk := dial(t, ts, tokenA, "desk1", "desktop")
	if _, got := read(t, desk); string(got) != string(env) {
		t.Fatalf("queued envelope not delivered, got %s", got)
	}
}

func TestBacklogLargerThanSendBufferIsDelivered(t *testing.T) {
	ts := startServer(t)
	phone := dial(t, ts, tokenA, "phone1", "mobile")
	env := envelopeJSON("phone1", "desk1")
	n := inboxPerDevice
	for i := 0; i < n; i++ {
		_ = phone.WriteMessage(websocket.TextMessage, env)
		if m := readControl(t, phone); m["type"] != "device_offline" {
			t.Fatalf("want device_offline, got %v", m)
		}
	}
	desk := dial(t, ts, tokenA, "desk1", "desktop")
	for i := 0; i < n; i++ {
		if _, got := read(t, desk); string(got) != string(env) {
			t.Fatalf("message %d: got %s", i, got)
		}
	}
}

func TestRoutesBinaryFrames(t *testing.T) {
	ts := startServer(t)
	desk := dial(t, ts, tokenA, "desk1", "desktop")
	phone := dial(t, ts, tokenA, "phone1", "mobile")

	hdr := []byte(`{"to":"desk1","from":"phone1"}`)
	frame := []byte{frameMagic, frameVersion, 0, 0}
	binary.BigEndian.PutUint16(frame[2:4], uint16(len(hdr)))
	frame = append(append(frame, hdr...), 0xde, 0xad, 0xbe, 0xef)
	_ = phone.WriteMessage(websocket.BinaryMessage, frame)

	kind, got := read(t, desk)
	if kind != websocket.BinaryMessage || string(got) != string(frame) {
		t.Fatalf("desktop got kind=%d %x", kind, got)
	}
}

func TestNewConnectionDisplacesOld(t *testing.T) {
	ts := startServer(t)
	old := dial(t, ts, tokenA, "desk1", "desktop")
	dial(t, ts, tokenA, "desk1", "desktop")
	_ = old.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := old.ReadMessage(); err == nil {
		t.Fatal("old connection should be closed")
	}
}
