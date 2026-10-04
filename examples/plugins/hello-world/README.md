# hello-world

Minimal plugin — skill + command + tool

## Development

1. Edit `plugin.json` to declare what this plugin ships
   (skills / tools / commands / views / hooks).
2. Install in dev mode (no copy):
   ```bash
   neox /plugins dev $(pwd)
   ```
3. Restart Neox after changes to hot-reload.

## Files

- `plugin.json` — manifest (name, version, declarations)
- `skills/` — SKILL.md prompt modules
- `commands/` — slash command templates
- `tools/` — JS/TS modules exporting `createTools(ctx)`
- `ui/` — optional iframe UI (loaded via `neox-plugin://` protocol)
- `hooks.json` — optional pre/post toolCall shell hooks

See Neox plugin docs for more.
