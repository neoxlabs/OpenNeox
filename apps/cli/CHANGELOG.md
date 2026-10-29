# @neoxlabs/cli

## 2.1.0

### Minor Changes

- 7a39cd9: # 🚀 Neox Agent SDK · First Monorepo Release v2.1.0

  **从单仓 2.0.98 到 4 包 monorepo 架构**。11 步 P0-P11 完整交付。

  ## 这次 release 包含

  ### 🏗️ 架构重构

  - **单仓 → monorepo 4 包**:`@neoxlabs/core`(闭源 engine)+ `@neoxlabs/cli`(开源 CLI)+ `@neoxlabs/sdk`(开源 SDK)+ `neox-desktop`(闭源 Electron)
  - **workspace symlink** 本地开发零协调成本 · 各包独立版本管理(changesets)
  - **流水线分离**:`release-npm.yml`(Ubuntu · core/cli/sdk publish) vs `release-desktop.yml`(macOS/Windows · dmg/nsis)
  - **公开仓镜像**:`MK-CO/neox-cli`、`MK-CO/neox-sdk` 自动 subtree sync · 私有 mono 永远是 single source of truth

  ### ✨ 新增

  - `@neoxlabs/sdk@0.1.0-alpha.0` 首发 · `Agent` / `tool()` / `createSession` / `provider` API 骨架 · 24 个单测 · 5 个 examples
  - Fortress 路径规整到 `apps/desktop/src/fortress/`
  - Electron main 走 tsup bundle(替代老的 tsc + reorganize 脆弱链)

  ### 🧹 清理

  - 4 个跨层泄漏点全部归位(startupProfiler、apiPreconnect、completionAlerts sound、protocolModels)
  - `sdk/index.ts` 去 electron 运行时污染(Node-only public API)
  - 老 `publish.yml`(CLI tag-triggered)归档,被 changesets 取代

  ### 📖 文档

  - `内部设计文档` · 产品 / 仓库 / 发布策略
  - `内部设计文档` · P0-P11 执行细节
  - `内部设计文档` · SDK v1 完整 API 签名
  - `内部设计文档` · 发版 playbook

### Patch Changes

- Updated dependencies [7a39cd9]
  - @neoxlabs/core@2.1.0
