# @openneox/kernel

> **Neox 的纯发动机** — provider-agnostic agent 引擎。零 Neox 假设:不带 HMAC / native addon / sqlite / routing.json / 内置业务工具 / server / cloud。

应用可以只使用这个引擎直连模型；`@openneox/core` 在它之上提供更完整的
运行时、工具和持久化能力。

## 定位

```
@openneox/kernel   ← 纯引擎: StreamedRunner / 工具派发协议 / provider HTTP / context 压缩 / 事件 / 权限钩子接口 / 模型 profile
        ▲ 依赖
@openneox/core     ← 在 kernel 上加 Neox 专属: HMAC签名 / 内置工具 / sqlite / 项目记忆 / native / routing / server / cloud
        ▲ 依赖
@openneox/sdk      ← 门面: 默认走 kernel(直连模型干净跑), 可选开 core 增强
```

## License

OpenNeox project code is licensed under the Apache License, Version 2.0. See
the repository root `LICENSE` and `NOTICE` files.
