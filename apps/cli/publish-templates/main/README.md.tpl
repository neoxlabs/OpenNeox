# Neox CLI

> Professional AI code assistant — agent loop, tool use, multi-provider routing.

```bash
npm install -g @neoxlabs/cli
neox --help
```

## Quick start

```bash
neox                          # 启动交互模式
neox -p "fix the login bug"   # 单次任务
neox --model gpt-5.4 ...      # 指定模型
```

## Configuration

See https://neox.dev/docs for full configuration / authentication / commands.

## How this package is structured

This is a **thin npm wrapper** (20 KB). The actual CLI is a single-file binary
shipped via platform-specific optional dependencies:

- `@neoxlabs/cli-darwin-arm64`
- `@neoxlabs/cli-darwin-x64`
- `@neoxlabs/cli-linux-x64`
- `@neoxlabs/cli-linux-arm64`
- `@neoxlabs/cli-win32-x64`

`npm install` only downloads the binary for your platform (~60-100 MB).

Same distribution model as `@anthropic-ai/claude-code`.

## License

Apache-2.0 · © Neox Labs · source: https://github.com/neoxlabs/OpenNeox
