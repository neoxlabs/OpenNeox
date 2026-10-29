/**
 * BashOutput with a truncated JSON result must render as a card, not as raw JSON.
 * Seen in a CLI trial: `● BashOut ⎿ {"pid":21517,"command":"npm run dev","display_name":…`.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ToolCard } from '../ToolCard.js';

describe('ToolCard · bash_output', () => {
  it('renders a truncated JSON result as BashOutput(command) with its state', () => {
    const truncated = '{"pid":21517,"command":"npm run dev","display_name":"npm run dev","port":5173,"uptime_sec":53,"status":"running","content":"[web] VITE ready\\n[server] API 已启动';
    const { lastFrame } = render(<ToolCard type={'bash_output' as any} message={truncated} details={truncated} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('BashOutput');
    expect(frame).toContain('npm run dev');
    expect(frame).toContain('running');
    expect(frame).not.toContain('"pid"');
  });
});
