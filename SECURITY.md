# Security Policy

## Supported versions

Security fixes are developed against the latest commit on the default branch.
Older snapshots may not receive fixes.

## Reporting a vulnerability

Please use GitHub Security Advisories for private vulnerability reports. Do not
open a public issue for an undisclosed vulnerability or include API keys,
tokens, personal data, or deployment credentials in a report.

Include the affected version or commit, the impacted component, reproduction
steps, expected and actual behavior, and any suggested mitigation. We will
acknowledge reports when possible and coordinate disclosure after a fix is
available.

## Security boundaries

OpenNeox is local-first and BYOK. Review provider endpoints, plugin manifests,
MCP servers, shell tools, workspace permissions, and sandbox availability before
using them with sensitive data. The open-source build does not contain a hosted
account or official model gateway that can mediate those risks.
