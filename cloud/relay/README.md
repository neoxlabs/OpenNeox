# Neox relay (self-hosted)

On the same Wi-Fi, the Neox mobile app talks to your desktop directly. To keep
working from anywhere else, the phone and the desktop both connect out to a relay
that forwards their messages. This is that relay. Run it on any VPS you control.

- **End-to-end encrypted.** The phone and the desktop agree on a key when you pair
  them (X25519 + HKDF). The relay only sees ciphertext and routing ids.
- **Stateless.** No database and no accounts. Messages for a device that is offline
  wait in memory for up to 24 hours (200 per device), then they are dropped.
- **One token per household.** Every device that uses the same token can reach the
  others. Several comma-separated tokens give several isolated spaces.

## Run with Docker (automatic HTTPS)

You need a domain pointed at the server and ports 80/443 open.

```bash
cd cloud/relay
echo "RELAY_DOMAIN=relay.example.com" >  .env
echo "RELAY_TOKEN=$(openssl rand -hex 24)" >> .env
docker compose up -d
curl https://relay.example.com/healthz
```

## Run the binary

```bash
cd cloud/relay
go build -o relay .
RELAY_TOKEN=$(openssl rand -hex 24) ./relay            # plain HTTP on :8089
RELAY_TLS_CERT=cert.pem RELAY_TLS_KEY=key.pem ...      # or serve HTTPS directly
```

| Variable | Default | |
|---|---|---|
| `RELAY_TOKEN` | (required) | Shared secret, at least 16 characters. Comma-separate for several spaces. |
| `RELAY_ADDR` | `:8089` | Listen address. |
| `RELAY_TLS_CERT` / `RELAY_TLS_KEY` | | Serve HTTPS without a proxy. |

Use HTTPS whenever the relay is reachable from the internet. The payload is
encrypted either way, but the token travels in a header.

## Connect the apps

1. Desktop: **Settings → Mobile → Self-hosted relay**. Enter the relay URL and token.
2. Pair the phone by scanning the QR code on that page. The QR code carries the relay
   address and token, so the phone needs no extra setup.

## Protocol

`GET /relay/api/v1/relay` (also `/api/v1/relay`) upgrades to a WebSocket. Headers:
`Authorization: Bearer <token>`, `X-Neox-Device-Id`, `X-Neox-Device-Type`
(`desktop` | `mobile`), optional `X-Neox-Endpoint`. Text frames are JSON envelopes
routed by `to_device_id`; binary frames are `[0x00][2][len u16][header JSON][body]`
routed by the header's `to`. Control frames from the relay: `relay_hello`,
`device_offline`, `endpoint_online` / `endpoint_offline`, `relay_error`.
