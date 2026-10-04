import type { AgentRuntimeEvent } from './runtimeTypes.js';

export type RuntimeEventTracker = {
  contextUsed: number;
  startTime: number;
  provider: string;
  model: string;
};

export type RuntimeEventSink = {
  name: string;
  handle: (sessionId: string, event: AgentRuntimeEvent, tracker: RuntimeEventTracker) => void;
  shouldForward?: (event: AgentRuntimeEvent, tracker: RuntimeEventTracker) => boolean;
};

export class RuntimeEventHub {
  private sinks: Map<string, RuntimeEventSink> = new Map();

  register(sink: RuntimeEventSink): () => void {
    this.sinks.set(sink.name, sink);
    return () => {
      this.sinks.delete(sink.name);
    };
  }

  has(name: string): boolean {
    return this.sinks.has(name);
  }

  remove(name: string): void {
    this.sinks.delete(name);
  }

  clear(): void {
    this.sinks.clear();
  }

  emit(sessionId: string, event: AgentRuntimeEvent, tracker: RuntimeEventTracker): void {
    if (this.sinks.size === 0) {
      return;
    }
    for (const sink of this.sinks.values()) {
      if (sink.shouldForward && !sink.shouldForward(event, tracker)) {
        continue;
      }
      try {
        sink.handle(sessionId, event, tracker);
      } catch {
        // Ignore sink failures so other channels keep receiving events.
      }
    }
  }
}
