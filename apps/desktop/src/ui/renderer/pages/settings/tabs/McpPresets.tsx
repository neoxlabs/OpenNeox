import React from 'react';
import { pluginLogoUrl } from '../../plugins/pluginBrandAssets';

export interface McpPreset {
  id: string;
  name: string;
  desc: string;
  /** 本地命令 */
  command?: string;
  args?: string[];
  /** 远程地址 (Streamable HTTP) */
  url?: string;
  /** 要填的环境变量: 名字 → 说明 (值留空让用户填) */
  keys?: Record<string, string>;
  /** 命令行参数里要用户填的占位 (飞书的 app id / secret 走参数) */
  argKeys?: string[];
  logo: React.ReactNode;
  region: 'cn' | 'global';
}

const home = () => (window as any).neox?.osInfo?.homedir || '~';

/* 没有现成 logo 的画一个品牌色字标 —— 28 圆角方块, 跟插件页 logo 同一尺寸 */
const Tile: React.FC<{ bg: string; fg?: string; children: React.ReactNode }> = ({ bg, fg = '#fff', children }) => (
  <span className="mcp3-preset__tile" style={{ background: bg, color: fg }}>{children}</span>
);
const Img: React.FC<{ name: string; fallback: React.ReactNode }> = ({ name, fallback }) => {
  const url = pluginLogoUrl(name);
  return url ? <img className="mcp3-preset__img" src={url} alt="" /> : <>{fallback}</>;
};

export function mcpPresets(zh: boolean): McpPreset[] {
  return [
    {
      id: 'playwright', name: 'Playwright', region: 'global',
      desc: zh ? '让 Agent 开浏览器点网页、填表、截图' : 'Drive a real browser: click, fill, screenshot',
      command: 'npx', args: ['-y', '@playwright/mcp@latest'],
      logo: <Img name="playwright" fallback={<Tile bg="#2EAD33">P</Tile>} />,
    },
    {
      id: 'filesystem', name: zh ? '本地文件' : 'Filesystem', region: 'global',
      desc: zh ? '读写你指定的文件夹 (默认「文稿」)' : 'Read & write a folder you choose',
      command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', `${home()}/Documents`],
      logo: <Tile bg="#E8A23A"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z" /></svg></Tile>,
    },
    {
      id: 'context7', name: 'Context7', region: 'global',
      desc: zh ? '查最新的框架 / 库文档, 写代码不再用过时 API' : 'Up-to-date docs for any library',
      url: 'https://mcp.context7.com/mcp',
      logo: <Tile bg="#111">C7</Tile>,
    },
    {
      id: 'deepwiki', name: 'DeepWiki', region: 'global',
      desc: zh ? '问任意 GitHub 开源仓库「这个项目怎么用」' : 'Ask questions about any GitHub repo',
      url: 'https://mcp.deepwiki.com/mcp',
      logo: <Tile bg="#2F6BFF"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round"><path d="M3 3h4.5a1.5 1.5 0 0 1 1.5 1.5V13a1.5 1.5 0 0 0-1.5-1.5H3zM13 3H10.5A1.5 1.5 0 0 0 9 4.5" /></svg></Tile>,
    },
    {
      id: 'sequential-thinking', name: zh ? '分步思考' : 'Sequential Thinking', region: 'global',
      desc: zh ? '复杂问题拆成一步步推理' : 'Break hard problems into steps',
      command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      logo: <Tile bg="#7A5AF5">1·2</Tile>,
    },
    {
      id: 'feishu', name: zh ? '飞书' : 'Feishu / Lark', region: 'cn',
      desc: zh ? '读写飞书文档、多维表格、发消息 (需要应用 ID / Secret)' : 'Docs, Base and messages (app ID / secret)',
      command: 'npx', args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', '<APP_ID>', '-s', '<APP_SECRET>'],
      argKeys: ['<APP_ID>', '<APP_SECRET>'],
      logo: <Tile bg="#3370FF">{zh ? '飞' : 'L'}</Tile>,
    },
    {
      id: 'amap', name: zh ? '高德地图' : 'Amap', region: 'cn',
      desc: zh ? '查地点、路线、天气 (需要高德 Key)' : 'Places, routes, weather (Amap key)',
      command: 'npx', args: ['-y', '@amap/amap-maps-mcp-server'],
      keys: { AMAP_MAPS_API_KEY: zh ? '高德开放平台的 Web 服务 Key' : 'Amap Web Service key' },
      logo: <Tile bg="#1A8CFF">{zh ? '高' : 'A'}</Tile>,
    },
    {
      id: 'notion', name: 'Notion', region: 'global',
      desc: zh ? '搜索、读写 Notion 页面和数据库 (需要 Integration Token)' : 'Search and edit Notion (integration token)',
      command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'],
      keys: { NOTION_TOKEN: 'ntn_…' },
      logo: <Img name="notion" fallback={<Tile bg="#111">N</Tile>} />,
    },
    {
      id: 'github', name: 'GitHub', region: 'global',
      desc: zh ? '查 issue / PR、建 issue (需要 Personal Access Token)' : 'Issues and PRs (personal access token)',
      command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
      keys: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_…' },
      logo: <Img name="github" fallback={<Tile bg="#111">G</Tile>} />,
    },
    {
      id: 'slack', name: 'Slack', region: 'global',
      desc: zh ? '读频道、发消息 (需要 Bot Token)' : 'Read channels, post messages (bot token)',
      command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'],
      keys: { SLACK_BOT_TOKEN: 'xoxb-…', SLACK_TEAM_ID: 'T…' },
      logo: <Img name="slack" fallback={<Tile bg="#4A154B">S</Tile>} />,
    },
  ];
}

export function presetNeedsKey(p: McpPreset): boolean {
  return !!(p.keys && Object.keys(p.keys).length) || !!(p.argKeys && p.argKeys.length);
}

export function presetToConfig(p: McpPreset) {
  return p.url
    ? { id: p.id, name: p.name, transport: 'http' as const, url: p.url, autoConnect: true, enabled: true }
    : { id: p.id, name: p.name, transport: 'stdio' as const, command: p.command, args: p.args, autoConnect: true, enabled: true };
}

export const McpPresetGallery: React.FC<{
  zh: boolean;
  installedIds: Set<string>;
  busyId: string | null;
  onPick: (p: McpPreset) => void;
}> = ({ zh, installedIds, busyId, onPick }) => (
  <div className="mcp3-presets">
    <div className="mcp3-presets__head">
      <b>{zh ? '常用服务' : 'Popular'}</b>
      <span>{zh ? '点一下就装好; 带「要 Key」的填完 Key 再保存' : 'One click to add; ones marked "key" need a key first'}</span>
    </div>
    <div className="mcp3-presets__grid">
      {mcpPresets(zh).map((p) => {
        const installed = installedIds.has(p.id);
        const needsKey = presetNeedsKey(p);
        return (
          <button
            key={p.id}
            type="button"
            className={`mcp3-preset${installed ? ' is-installed' : ''}`}
            disabled={installed || busyId === p.id}
            onClick={() => onPick(p)}
            title={p.desc}
          >
            <span className="mcp3-preset__logo">{p.logo}</span>
            <span className="mcp3-preset__body">
              <span className="mcp3-preset__name">
                {p.name}
                {p.region === 'cn' && <i className="mcp3-preset__tag">{zh ? '国内' : 'CN'}</i>}
              </span>
              <span className="mcp3-preset__desc">{p.desc}</span>
            </span>
            <span className={`mcp3-preset__act${needsKey ? ' is-key' : ''}`}>
              {installed ? (zh ? '已添加' : 'Added')
                : busyId === p.id ? (zh ? '安装中…' : 'Adding…')
                  : needsKey ? (zh ? '要 Key' : 'Key') : (zh ? '添加' : 'Add')}
            </span>
          </button>
        );
      })}
    </div>
  </div>
);
