// Command relay is the self-hosted Neox relay: it lets the Neox mobile app reach
// your own desktop when they are not on the same network.
//
// Configuration (environment):
//
//	RELAY_TOKEN     required. Shared secret the desktop and phone present. Several
//	                tokens may be given comma-separated; each one is an isolated space.
//	RELAY_ADDR      listen address, default ":8089".
//	RELAY_TLS_CERT  optional PEM certificate; with RELAY_TLS_KEY serves HTTPS directly.
//	RELAY_TLS_KEY   optional PEM key.
//
// Without TLS settings it serves plain HTTP; put it behind a TLS reverse proxy
// (see docker-compose.yml) when it is reachable from the internet.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const minTokenLen = 16

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	var tokens []string
	for _, t := range strings.Split(os.Getenv("RELAY_TOKEN"), ",") {
		if t = strings.TrimSpace(t); t != "" {
			tokens = append(tokens, t)
		}
	}
	if len(tokens) == 0 {
		logger.Error("RELAY_TOKEN is not set. Generate one with: openssl rand -hex 24")
		os.Exit(2)
	}
	for _, t := range tokens {
		if len(t) < minTokenLen {
			logger.Error("RELAY_TOKEN is too short", "min_length", minTokenLen)
			os.Exit(2)
		}
	}

	addr := os.Getenv("RELAY_ADDR")
	if addr == "" {
		addr = ":8089"
	}
	s := newServer(tokens, logger)
	srv := &http.Server{Addr: addr, Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.inbox.sweep()
			}
		}
	}()

	cert, key := os.Getenv("RELAY_TLS_CERT"), os.Getenv("RELAY_TLS_KEY")
	go func() {
		var err error
		logger.Info("relay listening", "addr", addr, "tls", cert != "", "spaces", len(tokens))
		if cert != "" && key != "" {
			err = srv.ListenAndServeTLS(cert, key)
		} else {
			err = srv.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen failed", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
}
