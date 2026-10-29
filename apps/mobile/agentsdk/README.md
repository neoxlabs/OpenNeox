# Neox Agent SDK (Android / 纯 Dart)

手机端本地 Agent 运行时 — 让 Neox App 脱离桌面也能"干活"，不只是聊天。

## 架构

```
┌──────────────────────────────────────────────┐
│ App (宿主)                                    │
│  · LlmConnector 适配: BYOK 三协议 / 订阅网关   │
│  · 设备工具注入 (通知/剪贴板/定位, 可选)        │
│  · AgentEvent → timeline 渲染 + drift 落库    │
├──────────────────────────────────────────────┤
│ neox_agent_sdk (本包, 零 Flutter 依赖)        │
│  · AgentRunner  — 工具调用主循环 (ReAct)      │
│  · ToolRegistry — 工具注册表                  │
│  · 内置工具: http_fetch / workspace_files /   │
│              clock / calculator               │
└──────────────────────────────────────────────┘
```

## 设计要点

- **事件协议对齐**: `AgentEvent.kind` 与 Neox timeline 协议 1:1
  (`agent_text_delta` / `tool_running` / `tool_done` / `agent_turn_done` …)，
  宿主把事件直接灌进现有渲染管线，手机本地 Agent 与桌面 Agent 用同一套 UI。
- **LLM 解耦**: SDK 不绑定任何厂商。宿主实现 `LlmConnector`（流式 + 工具调用聚合），
  BYOK (OpenAI 兼容 / Anthropic / Gemini) 和订阅网关都能接。
- **安全边界**:
  - `http_fetch`: 仅 http/https，SSRF 防护（拒内网/环回/CGNAT），响应截断 256KB。
  - `workspace_files`: 沙箱锁死在宿主给的根目录，拒绝越界路径，单文件 2MB。
  - 循环上限 `maxTurns`（默认 12），到顶强制模型总结；工具输出回灌截断 24KB。
- **取消**: `AgentCancelToken` 贯穿 LLM 流和工具执行，stop 即刻生效。

## 测试

```bash
cd agentsdk && dart test
```
