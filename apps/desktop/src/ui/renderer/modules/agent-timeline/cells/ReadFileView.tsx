import React from 'react';
import type { CodeLine } from '../types';
import { FilePathChip } from '../FilePathChip';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { displayWorkspacePath } from '../../../utils/pathUtils';
import { useI18n } from '../../../hooks/useI18n';

function displayPath(path: string, workspacePath?: string): string {
  return displayWorkspacePath(path, workspacePath, { max: 72, headSegments: 1, tailSegments: 3 });
}

export const ReadFileView: React.FC<{
  file: string;
  totalLines?: number;
  offset?: number;
  limit?: number;
  preview?: CodeLine[];
  displayFile?: string;
  fileName?: string;
  directory?: string;
  language?: string;
}> = ({ file, totalLines, offset, limit, preview, displayFile, fileName, directory, language }) => {
  const runtime = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const shownPath = displayFile || displayPath(file, runtime?.workspacePath);
  const shownName = fileName || shownPath.split(/[\/]/).pop() || shownPath || (isZh ? '文件' : 'File');
  const shownDir = directory || (shownPath.includes('/') ? shownPath.slice(0, shownPath.lastIndexOf('/')) : undefined);
  const rangeText =
    typeof offset === 'number'
      ? typeof limit === 'number'
        ? (isZh ? `第 ${offset + 1}–${offset + limit} 行` : `Lines ${offset + 1}–${offset + limit}`)
        : (isZh ? `从第 ${offset + 1} 行起` : `From line ${offset + 1}`)
      : typeof totalLines === 'number'
      ? (isZh ? `共 ${totalLines} 行` : `${totalLines} lines`)
      : undefined;
  return (
    <div className="atl-readfile">
      <div className="atl-readfile__head">
        <span className="atl-readfile__docicon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.25 1.75h5.2L12.75 5v9.25h-8.5z" />
            <path d="M9.35 1.85V5h3.15" />
            <path d="M6 8.25h4M6 10.75h3" />
          </svg>
        </span>
        <div className="atl-readfile__identity">
          <FilePathChip
            path={file}
            display={shownName}
            className="atl-readfile__file"
          />
          {shownDir && <span className="atl-readfile__dir" title={file}>{shownDir}</span>}
        </div>
        <div className="atl-readfile__chips">
          {language && <span className="atl-readfile__chip">{language}</span>}
          {rangeText && <span className="atl-readfile__range">{rangeText}</span>}
        </div>
      </div>
      {preview && preview.length > 0 && (
        <pre className="atl-readfile__preview">
          {preview.map((l, i) => (
            <span key={i} className={l.kind && l.kind !== 'normal' ? l.kind : ''}>
              {l.text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
};
