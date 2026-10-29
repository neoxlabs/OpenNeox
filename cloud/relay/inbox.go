package main

import (
	"sync"
	"time"
)

// inbox keeps text envelopes for devices that are offline, in memory only.
// Contents are end-to-end encrypted; the relay cannot read them. Limits keep a
// device that never comes back from growing memory without bound.
const (
	inboxTTL        = 24 * time.Hour
	inboxPerDevice  = 200
	inboxBytesTotal = 64 << 20
)

type queued struct {
	raw []byte
	at  time.Time
}

type inbox struct {
	mu    sync.Mutex
	items map[string][]queued // space + "/" + deviceID
	bytes int
}

func newInbox() *inbox { return &inbox{items: map[string][]queued{}} }

func (b *inbox) push(space, deviceID string, raw []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.bytes+len(raw) > inboxBytesTotal {
		return
	}
	key := space + "/" + deviceID
	q := append(b.items[key], queued{raw: raw, at: time.Now()})
	for len(q) > inboxPerDevice {
		b.bytes -= len(q[0].raw)
		q = q[1:]
	}
	b.items[key] = q
	b.bytes += len(raw)
}

func (b *inbox) drain(space, deviceID string) [][]byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	key := space + "/" + deviceID
	var out [][]byte
	cutoff := time.Now().Add(-inboxTTL)
	for _, item := range b.items[key] {
		b.bytes -= len(item.raw)
		if item.at.After(cutoff) {
			out = append(out, item.raw)
		}
	}
	delete(b.items, key)
	return out
}

// sweep drops expired entries; called periodically from main.
func (b *inbox) sweep() {
	b.mu.Lock()
	defer b.mu.Unlock()
	cutoff := time.Now().Add(-inboxTTL)
	for key, q := range b.items {
		keep := q[:0]
		for _, item := range q {
			if item.at.After(cutoff) {
				keep = append(keep, item)
			} else {
				b.bytes -= len(item.raw)
			}
		}
		if len(keep) == 0 {
			delete(b.items, key)
		} else {
			b.items[key] = keep
		}
	}
}
