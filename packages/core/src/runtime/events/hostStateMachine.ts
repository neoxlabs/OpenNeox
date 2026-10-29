import type { AgentRuntimeEvent } from '../runtimeTypes.js';

export type HostRenderState =
  | 'idle'
  | 'thinking'
  | 'tool_running'
  | 'streaming'
  | 'completed'
  | 'error';

export class HostStateMachine {
  private state: HostRenderState = 'idle';
  private lastStatusKey = '';
  private lastStatusAt = 0;

  shouldEmit(event: AgentRuntimeEvent): boolean {
    if (event.type === 'status') {
      const now = event.timestamp ?? Date.now();
      const key = `${event.status}:${event.message}`;
      if (key === this.lastStatusKey && now - this.lastStatusAt < 200) {
        return false;
      }
      this.lastStatusKey = key;
      this.lastStatusAt = now;
    }

    this.transition(event);
    return true;
  }

  getState(): HostRenderState {
    return this.state;
  }

  private transition(event: AgentRuntimeEvent): void {
    switch (event.type) {
      case 'thinking':
      case 'reasoning':
      case 'reasoning_complete':
      case 'text':
        this.state = 'thinking';
        return;
      case 'tool_call_start':
        this.state = 'tool_running';
        return;
      case 'tool_call_end':
      case 'tool_output':
        this.state = 'thinking';
        return;
      case 'status':
        if (event.status === 'tool_call') {
          this.state = 'tool_running';
        } else if (event.status === 'thinking') {
          this.state = 'thinking';
        } else if (event.status === 'complete') {
          this.state = 'completed';
        } else if (event.status === 'error') {
          this.state = 'error';
        }
        return;
      case 'run_result':
        this.state = (event as any).failed ? 'error' : 'completed';
        return;
      case 'error':
      case 'error_classified':
        this.state = 'error';
        return;
      default:
        return;
    }
  }
}
