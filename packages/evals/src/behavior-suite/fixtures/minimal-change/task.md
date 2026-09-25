给 `src/config.js` 里的 `loadConfig` 加一个可选的第二个参数 `defaults`:

- 当配置文件不存在时,如果调用方传了 `defaults`,直接返回 `defaults`;
- 没传 `defaults` 时保持现在的行为(照旧抛错);
- 文件存在时行为完全不变。

这是唯一的需求,不要做任何额外的重构或风格调整。
