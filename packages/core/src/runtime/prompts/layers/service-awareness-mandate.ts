/**
 * Service Awareness Mandate — 防止重复起 dev server / 后端的强约束层
 *
 * 痛点(用户提出):
 *   用户已经手动起了前端 + 后端, agent 接下来想验证自己的修改, 又跑了一次
 *   `npm run dev` / `uvicorn ...`, 导致端口冲突或者双实例.
 *
 * 这一层是**静态规则**, 进 cache prefix 不破缓存. 真正的"当前活进程"由 LLM 主动调
 * `service_scan()` 拿到 (动态信息进了工具回包, 不进 system prompt).
 *
 * 接进 buildLayeredPrompt 在 verification-mandate 之后, skills 之前 — 跟 verification
 * 配套: verification 说"必须验证", 这一层说"验证别重新起一份服务".
 */

export interface ServiceAwarenessMandate {
  zh: string;
  en: string;
}

export const SERVICE_AWARENESS_MANDATE: ServiceAwarenessMandate = {
  zh: `## 不要重复起服务

启动 dev server / 任何监听端口的命令前 (\`npm run dev\`/\`uvicorn\`/\`docker compose up\` 等), 先查是不是已经在跑 (\`service_scan\`, 不在常驻工具里, 先从工具目录解锁; 拿不到就 \`lsof -iTCP:<端口> -sTCP:LISTEN\`). 已跑的:
- 验证类 → 直接 \`curl\` endpoint, 不重启
- 重启类 → 停掉那个进程 (\`service_adopt\` + \`bash_kill\`, 或 kill 那个 pid) 再起

看到 \`EADDRINUSE\` 不要换端口重试, 那是用户已经在用. dev server 是单例资源.`,
  en: `## No duplicate-spawn services

Before starting any port-listening command (\`npm run dev\`/\`uvicorn\`/\`docker compose up\`...), check whether it's already running (\`service_scan\` — not resident, unlock it from the tool catalog first; otherwise \`lsof -iTCP:<port> -sTCP:LISTEN\`). Already running:
- Verify intent → \`curl\` existing endpoint, don't restart
- Restart intent → stop that process (\`service_adopt\` + \`bash_kill\`, or kill the pid) and spawn fresh

Don't retry with \`--port X+1\` on \`EADDRINUSE\` — user's port is the one that matters. Dev server is single-instance.`,
};

export function buildServiceAwarenessMandate(language: 'zh' | 'en' = 'zh'): string {
  return language === 'zh' ? SERVICE_AWARENESS_MANDATE.zh : SERVICE_AWARENESS_MANDATE.en;
}
