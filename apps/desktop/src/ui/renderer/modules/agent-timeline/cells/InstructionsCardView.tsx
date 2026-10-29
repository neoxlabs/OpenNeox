import React from 'react';
import { useI18n } from '../../../hooks/useI18n';


interface Source {
  path: string;
  level: 'workspace' | 'parent' | 'user';
  lines: number;
}

interface Failure {
  path: string;
  code: string;
  message: string;
}

interface Props {
  workspace: string;
  sources: Source[];
  failures: Failure[];
  chars: number;
}

/* chip 样式跟 SkillCardView 逐字一致 —— 两张卡挨在一起时必须看不出是两个人写的 */
const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  fontSize: 11,
  lineHeight: '16px',
  borderRadius: 999,
  color: 'var(--fg-secondary, #666)',
  background: 'var(--bg-subtle, rgba(0,0,0,0.04))',
  border: '1px solid var(--border-subtle, rgba(0,0,0,0.06))',
  whiteSpace: 'nowrap',
};

const chipStrong: React.CSSProperties = {
  ...chipStyle,
  color: 'var(--fg-primary, #222)',
  fontWeight: 500,
};

const chipError: React.CSSProperties = {
  ...chipStyle,
  color: 'var(--color-error, #c0392b)',
  background: 'var(--color-error-soft, rgba(214,69,69,0.10))',
  border: '1px solid var(--color-error-border, rgba(214,69,69,0.24))',
};

/** 来源标签 —— 用户语言, 不是内部枚举名 */
const LEVEL_LABEL_ZH: Record<Source['level'], string> = {
  workspace: '项目',
  parent: '上级目录',
  user: '用户全局',
};
const LEVEL_LABEL_EN: Record<Source['level'], string> = {
  workspace: 'Project',
  parent: 'Parent dir',
  user: 'User global',
};

/** 绝对路径在 timeline 里太长; workspace 内的裁成相对, 用户级的裁成 ~/... */
function displayPath(filePath: string, workspace: string): string {
  if (workspace && filePath.startsWith(workspace + '/')) {
    return filePath.slice(workspace.length + 1);
  }
  const home = filePath.match(/^(\/Users\/[^/]+|\/home\/[^/]+)\//);
  if (home) return '~' + filePath.slice(home[1].length);
  return filePath;
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--fg-primary, #222)',
  fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
};

export const InstructionsCardView: React.FC<Props> = ({
  workspace, sources, failures, chars,
}) => {
  const { isZh } = useI18n();
  const levelLabel = isZh ? LEVEL_LABEL_ZH : LEVEL_LABEL_EN;
  const totalLines = sources.reduce((n, s) => n + s.lines, 0);
  return (
    <div className="atl-instructions-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {sources.length > 0 && (
          <span style={chipStrong} title={isZh ? `共 ${totalLines} 行 / ${chars} 字符` : `${totalLines} lines / ${chars} chars total`}>
            {isZh
              ? `${sources.length} 个文件 · ${totalLines} 行`
              : `${sources.length} file${sources.length === 1 ? '' : 's'} · ${totalLines} lines`}
          </span>
        )}
        {failures.length > 0 && (
          <span style={chipError} title={failures.map(f => `${f.path}: ${f.message}`).join('\n')}>
            {isZh ? `读取失败 · ${failures.length}` : `Read failed · ${failures.length}`}
          </span>
        )}
      </div>

      {sources.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {sources.map(s => (
            <div key={s.path} style={rowStyle}>
              <span style={{ flex: '0 0 auto' }} title={s.path}>
                {displayPath(s.path, workspace)}
              </span>
              <span style={chipStyle}>{levelLabel[s.level]}</span>
              <span style={{ color: 'var(--fg-secondary, #666)' }}>{isZh ? `${s.lines} 行` : `${s.lines} lines`}</span>
            </div>
          ))}
        </div>
      )}

      {/* 失败必须点名到文件 + errno —— 只说"失败了"用户没法自己修 (多半是 chmod) */}
      {failures.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {failures.map(f => (
            <div key={f.path} style={{ ...rowStyle, color: 'var(--color-error, #c0392b)' }}>
              <span title={f.path}>{displayPath(f.path, workspace)}</span>
              <span style={chipError}>{f.code}</span>
              <span style={{ color: 'var(--fg-secondary, #666)' }}>{f.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
