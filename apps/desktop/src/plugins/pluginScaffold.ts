/**
 * Plugin Scaffold — 生成插件模板工程
 *
 * 支持模板:
 *   - basic:     plugin.json + skills + commands (最常用)
 *   - tool:      plugin.json + tools/index.ts (导出 createTools())
 *   - skill:     纯 skill 插件 (只有 SKILL.md)
 *   - ui-view:   带 iframe UI 面板 (PPT/视频 类插件起点)
 *
 * 生成位置: 传入 targetDir. 若不存在则创建; 若已存在且非空则报错 (除非 force=true).
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export type PluginTemplate = 'basic' | 'tool' | 'skill' | 'ui-view';

export interface ScaffoldOptions {
  /** 插件名 (小写连字符) */
  name: string;
  /** 作者名 */
  author?: string;
  /** 作者邮箱 */
  authorEmail?: string;
  /** 模板类型 */
  template?: PluginTemplate;
  /** 目标目录 (默认 ./${name}) */
  targetDir?: string;
  /** 目标非空时是否强制覆盖 */
  force?: boolean;
  /** 一句话描述 */
  description?: string;
}

export interface ScaffoldResult {
  success: boolean;
  pluginDir: string;
  created: string[];
  error?: string;
}

// ==================== 模板定义 ====================

interface FileSpec {
  path: string;
  content: string;
}

function basicManifest(name: string, description: string, author: string, authorEmail?: string): string {
  return JSON.stringify({
    name,
    version: '0.1.0',
    description,
    author: authorEmail ? { name: author, email: authorEmail } : { name: author },
    category: 'community',
    skills: ['skills'],
    commands: ['commands'],
    permissions: {},
  }, null, 2) + '\n';
}

function toolManifest(name: string, description: string, author: string): string {
  return JSON.stringify({
    name,
    version: '0.1.0',
    description,
    author: { name: author },
    category: 'community',
    tools: ['tools/index.js'],
    permissions: { network: false },
  }, null, 2) + '\n';
}

function skillManifest(name: string, description: string, author: string): string {
  return JSON.stringify({
    name,
    version: '0.1.0',
    description,
    author: { name: author },
    category: 'community',
    skills: ['skills'],
  }, null, 2) + '\n';
}

function uiViewManifest(name: string, description: string, author: string): string {
  return JSON.stringify({
    name,
    version: '0.1.0',
    description,
    author: { name: author },
    category: 'community',
    tools: ['tools/index.js'],
    views: [{
      id: `${name}.main`,
      title: `${name} Panel`,
      location: 'workspace',
      entry: 'ui/index.html',
      icon: 'ui/icon.svg',
    }],
    permissions: { network: true },
  }, null, 2) + '\n';
}

const SAMPLE_SKILL_MD = `---
name: "Example Skill"
description: "This is a sample skill shipped by the plugin."
user-invocable: true
---

# Example Skill

Describe what this skill does here. When the user asks a related question,
Neox will use this content as part of the prompt.

## Usage

Trigger this skill with a question like "help me example".
`;

const SAMPLE_COMMAND_MD = `---
name: /example
description: Example plugin command
category: Plugin
usage: "/example [args...]"
---

You were invoked via /example with the following arguments:

$ARGUMENTS

Please respond with a brief summary of what was passed.
`;

const SAMPLE_TOOL_TS = `/**
 * Plugin tool entry. Exports createTools(ctx) which receives a PluginContext.
 *
 * The Tool interface:
 *   {
 *     name: string,           // unique tool name
 *     description: string,    // shown to the agent model
 *     parameters: JSONSchema, // input schema
 *     function: (args, context) => Promise<string>,
 *   }
 */

export async function createTools(ctx) {
  return [
    {
      name: 'plugin_example_greet',
      description: 'Say hello to someone from the plugin',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Person to greet' },
        },
        required: ['name'],
      },
      function: async ({ name }) => {
        ctx?.logger?.info?.(\`greet called with \${name}\`);
        return \`Hello \${name}, from plugin!\`;
      },
      isReadOnly: true,
    },
  ];
}
`;

const SAMPLE_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Plugin UI</title>
  <style>
    body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1e1f22; color: #bcbec4; }
    h1 { font-size: 16px; margin: 0 0 8px; color: #7c9fd4; }
    p, pre { font-size: 13px; margin: 4px 0; }
    pre { background: #2b2d30; padding: 8px; border-radius: 4px; overflow: auto; }
    button { margin-top: 8px; margin-right: 6px; padding: 6px 12px; background: #2b2d30; border: 1px solid #393b40; color: #bcbec4; border-radius: 4px; cursor: pointer; }
    button:hover { background: #393b40; }
  </style>
</head>
<body>
  <h1>Plugin UI</h1>
  <p>This panel is served via <code>neox-plugin://</code>.</p>
  <p>Host bridge demo:</p>
  <button onclick="notifyHost()">Announce size</button>
  <button onclick="demoSave()">Save data</button>
  <button onclick="demoLoad()">Load data</button>
  <pre id="log">ready</pre>

  <script>
    // --- 最小桥接 helper (给插件 UI 调用主进程 API) ---
    function neoxCall(verb, args) {
      return new Promise((resolve, reject) => {
        const callId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        function onReply(e) {
          if (!e?.data || e.data.type !== 'neox.plugin.reply' || e.data.callId !== callId) return;
          window.removeEventListener('message', onReply);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data.result);
        }
        window.addEventListener('message', onReply);
        window.parent.postMessage({ type: 'neox.plugin.invoke', callId, verb, args }, '*');
      });
    }

    function log(msg) { document.getElementById('log').textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2); }

    function notifyHost() {
      const height = document.body.scrollHeight;
      window.parent.postMessage({ type: 'neox.plugin.resize', height }, '*');
      log('resize sent: ' + height);
    }

    async function demoSave() {
      try {
        await neoxCall('writePluginData', { path: 'demo.txt', content: 'hello ' + new Date().toISOString() });
        log('saved to dataDir/demo.txt');
      } catch (err) { log('save error: ' + err.message); }
    }

    async function demoLoad() {
      try {
        const content = await neoxCall('readPluginData', { path: 'demo.txt' });
        log('loaded: ' + content);
      } catch (err) { log('load error: ' + err.message); }
    }

    window.addEventListener('load', notifyHost);
  </script>
</body>
</html>
`;

const SAMPLE_UI_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#7c9fd4">
  <circle cx="8" cy="8" r="7" stroke="#7c9fd4" fill="none" stroke-width="1.5"/>
  <circle cx="8" cy="8" r="2.5" fill="#7c9fd4"/>
</svg>
`;

function sampleReadme(name: string, description: string): string {
  return `# ${name}

${description}

## Development

1. Edit \`plugin.json\` to declare what this plugin ships
   (skills / tools / commands / views / hooks).
2. Install in dev mode (no copy):
   \`\`\`bash
   neox /plugins dev $(pwd)
   \`\`\`
3. Restart Neox after changes to hot-reload.

## Files

- \`plugin.json\` — manifest (name, version, declarations)
- \`skills/\` — SKILL.md prompt modules
- \`commands/\` — slash command templates
- \`tools/\` — JS/TS modules exporting \`createTools(ctx)\`
- \`ui/\` — optional iframe UI (loaded via \`neox-plugin://\` protocol)
- \`hooks.json\` — optional pre/post toolCall shell hooks

See Neox plugin docs for more.
`;
}

// ==================== 模板 → 文件清单 ====================

function getTemplateFiles(opts: Required<Pick<ScaffoldOptions, 'name' | 'description' | 'author'>> & {
  template: PluginTemplate;
  authorEmail?: string;
}): FileSpec[] {
  const { name, description, author, authorEmail, template } = opts;

  switch (template) {
    case 'basic':
      return [
        { path: 'plugin.json', content: basicManifest(name, description, author, authorEmail) },
        { path: 'skills/example/SKILL.md', content: SAMPLE_SKILL_MD },
        { path: 'commands/example.md', content: SAMPLE_COMMAND_MD },
        { path: 'README.md', content: sampleReadme(name, description) },
      ];

    case 'tool':
      return [
        { path: 'plugin.json', content: toolManifest(name, description, author) },
        { path: 'tools/index.js', content: SAMPLE_TOOL_TS },
        { path: 'README.md', content: sampleReadme(name, description) },
      ];

    case 'skill':
      return [
        { path: 'plugin.json', content: skillManifest(name, description, author) },
        { path: 'skills/example/SKILL.md', content: SAMPLE_SKILL_MD },
        { path: 'README.md', content: sampleReadme(name, description) },
      ];

    case 'ui-view':
      return [
        { path: 'plugin.json', content: uiViewManifest(name, description, author) },
        { path: 'tools/index.js', content: SAMPLE_TOOL_TS },
        { path: 'ui/index.html', content: SAMPLE_UI_HTML },
        { path: 'ui/icon.svg', content: SAMPLE_UI_ICON },
        { path: 'README.md', content: sampleReadme(name, description) },
      ];
  }
}

// ==================== 主入口 ====================

export async function scaffoldPlugin(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const name = (options.name || '').trim();
  if (!name) return { success: false, pluginDir: '', created: [], error: 'Plugin name is required' };

  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) {
    return {
      success: false,
      pluginDir: '',
      created: [],
      error: 'Invalid plugin name: lowercase letters / digits / hyphens only, 2-64 chars, must start alphanumeric',
    };
  }

  const targetDir = path.resolve(options.targetDir ?? path.join(process.cwd(), name));

  try {
    const stat = await fs.stat(targetDir).catch(() => null);
    if (stat) {
      const entries = await fs.readdir(targetDir);
      if (entries.length > 0 && !options.force) {
        return {
          success: false,
          pluginDir: targetDir,
          created: [],
          error: `Target directory ${targetDir} is not empty (pass force: true to overwrite)`,
        };
      }
    }
  } catch { /* fs.stat 报错 → 目录不存在, 继续 */ }

  await fs.mkdir(targetDir, { recursive: true });

  const template: PluginTemplate = options.template ?? 'basic';
  const files = getTemplateFiles({
    name,
    description: options.description ?? `My ${name} plugin`,
    author: options.author ?? 'You',
    authorEmail: options.authorEmail,
    template,
  });

  const created: string[] = [];
  for (const spec of files) {
    const absolute = path.join(targetDir, spec.path);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, spec.content, 'utf-8');
    created.push(spec.path);
  }

  return { success: true, pluginDir: targetDir, created };
}
