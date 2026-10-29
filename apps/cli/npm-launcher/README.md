# Neox CLI

AI agent in your terminal.

```bash
npm install -g @neoxlabs/cli
neox
```

Or without npm:

```bash
# macOS / Linux
curl -fsSL https://neox-dev.com/install.sh | sh
```

```powershell
# Windows
irm https://neox-dev.com/install.ps1 | iex
```

This package is a small installer. On install (or first run) it downloads the Neox CLI
for your platform from `dl.neox-dev.com`, verifies its SHA-256, and places it in
`~/.neox/bin`. Proxies set via `HTTPS_PROXY` are honored.

Website: https://neox-dev.com

© Neox. All rights reserved.
