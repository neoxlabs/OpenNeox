# OpenNeox contributor instructions

OpenNeox is a public monorepo for a local-first AI agent runtime and its CLI.
Keep changes focused, reviewable, and consistent with the existing TypeScript
structure.

## Repository boundaries

- `apps/` contains runnable hosts: the CLI.
- `packages/` contains reusable libraries. Packages must not import from `apps`.
- `plugins/` contains public plugin code.
- `docs/` contains architecture and user/developer documentation. Start at
  `docs/status.md`: it records what is done, what is open, and the repo
  conventions the CI gates enforce.
- Generated output such as `node_modules`, `dist`, `out`, coverage, signing
  files, and local environment files must not be committed.

The public build is local-first and BYOK. Do not add hosted service URLs,
account or subscription flows, fixed provider OAuth client IDs, credentials, or
private deployment details. Use the contracts in `packages/cloud` for optional
capabilities and keep their default behavior disabled.

## Common commands

Use Node.js 20 or newer:

```bash
npm ci
npm run type-check
npm run check:boundaries
npm run check:specifiers
npm test
npm run build
```

## Code and review expectations

- Prefer existing local APIs and patterns over new abstractions.
- Add focused tests for behavior changes and update docs for public interfaces.
- Preserve package dependency direction and third-party license notices.
- Keep comments factual and useful; do not include private provenance or
  deployment information.
- Report security issues privately using the process in `SECURITY.md`.

The vendored Ink package is third-party MIT material. Do not change their
license metadata to the project Apache-2.0 license. OpenNeox-authored files are
Apache-2.0 unless a nearby notice says otherwise.
