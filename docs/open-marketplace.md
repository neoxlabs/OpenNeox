# OpenNeox GitHub Open Marketplace

OpenNeox can browse plugins and skills from one or more GitHub repositories. The
catalog is downloaded as a repository archive and parsed locally; search,
filtering, and pagination do not require a hosted OpenNeox service.

## Configure Sources

Add a repository in the Plugins page, or set the build-time environment
variables before starting Desktop:

```sh
NEOX_OPEN_MARKETPLACE_REPOSITORY=owner/repository
NEOX_OPEN_MARKETPLACE_REF=main
```

When `NEOX_OPEN_MARKETPLACE_REPOSITORY` is empty, no built-in source is added.
The project does not contain a default marketplace repository address. User
sources are stored at `~/.neox/marketplace-sources.json` with `version: 1`.
Disabling or deleting a source does not uninstall an already installed plugin.
Each source can be refreshed independently. A failed refresh leaves its last
valid local snapshot available.

## Repository Format

Create `.neox/marketplace.json` at the repository root:

```json
{
  "schemaVersion": 1,
  "name": "example-marketplace",
  "displayName": "Example Marketplace",
  "marketplaceVersion": "1.0.0",
  "repository": "https://github.com/owner/repository",
  "minAppVersion": "3.5.0",
  "abilities": [
    {
      "type": "plugin",
      "slug": "example-plugin",
      "name": "Example Plugin",
      "description": "A local-first example plugin.",
      "version": "1.0.0",
      "category": "productivity",
      "tags": ["example"],
      "source": { "path": "plugins/example-plugin" }
    }
  ]
}
```

`type` is `plugin` or `skill`. `slug` must be unique within its type. The
`source.path` must be relative to the repository root and must not contain
parent-directory traversal. A plugin source directory contains the normal
OpenNeox `plugin.json`; it is installed through the same security and manifest
checks as a local plugin. Skill entries are discoverable in the catalog and
are installed through the skill installer rather than being treated as a
plugin.

The JSON Schema is available at `schemas/marketplace.schema.json`. The CLI can
create and validate a manifest:

```sh
neox marketplace init ./my-marketplace
neox marketplace validate ./my-marketplace/.neox/marketplace.json
```

## Private Repositories

Use a GitHub fine-grained PAT with `Contents: Read-only` for the selected
repository. The Desktop application stores the token in the operating system
credential store through `keytar`. It is never written to the source file,
cache snapshot, install ledger, or logs. If GitHub returns a signed archive
redirect, the token is not forwarded to that download host.

## Licensing

OpenNeox-authored marketplace manifests and plugins should use Apache-2.0.
Third-party materials retain their upstream license. In particular,
`apps/cli/vendor/ink/package.json` and
`packages/editor-engine/out/monaco-editor/package.json` remain `MIT`.

---

# OpenNeox GitHub 开源能力市场

OpenNeox 支持从一个或多个 GitHub 仓库浏览插件和技能。客户端下载仓库归档并在本地解析，搜索、筛选和分页都在本地完成，不依赖 OpenNeox 托管服务。

## 配置来源

可以在插件页添加仓库，也可以在启动桌面端前设置构建环境变量：

```sh
NEOX_OPEN_MARKETPLACE_REPOSITORY=owner/repository
NEOX_OPEN_MARKETPLACE_REF=main
```

未设置 `NEOX_OPEN_MARKETPLACE_REPOSITORY` 时不会注册内置来源，项目代码不包含默认市场仓库地址。用户来源保存在 `~/.neox/marketplace-sources.json`，格式版本为 `version: 1`。停用或删除来源不会卸载已经安装的插件；每个来源可以单独刷新，刷新失败时继续展示上一次有效缓存。

## 仓库格式

市场仓库根目录需要放置 `.neox/marketplace.json`。字段包括 `schemaVersion`、`name`、`displayName`、`marketplaceVersion`、`repository`、`minAppVersion` 和 `abilities[]`。`type` 支持 `plugin` 与 `skill`，同一类型内的 `slug` 不能重复，`source.path` 必须是仓库根目录下的相对路径。

插件目录包含标准的 `plugin.json`，安装时复用本地插件的安全扫描和清单校验。技能只作为市场发现条目，安装时走技能安装器，不能当作插件安装。JSON Schema 位于 `schemas/marketplace.schema.json`。

```sh
neox marketplace init ./my-marketplace
neox marketplace validate ./my-marketplace/.neox/marketplace.json
```

## 私有仓库

使用仅拥有目标仓库 `Contents: Read-only` 权限的 GitHub fine-grained PAT。桌面端通过 `keytar` 保存到系统安全存储，不写入来源配置、缓存快照、安装台账或日志。GitHub 返回签名归档重定向时，令牌不会转发到下载地址。

## 许可证

OpenNeox 自有市场清单和插件使用 Apache-2.0；第三方内容保留原始许可证。特别是 `apps/cli/vendor/ink/package.json` 与 `packages/editor-engine/out/monaco-editor/package.json` 必须保持 `MIT`。
