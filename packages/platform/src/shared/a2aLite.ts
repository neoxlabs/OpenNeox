export const A2A_LITE_VERSION = '0.1';

export type A2AEnvelopeType =
  | 'hello'
  | 'ack'
  | 'ping'
  | 'pong'
  | 'subscribe'
  | 'unsubscribe'
  | 'request'
  | 'response'
  | 'event';

export type A2AError = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

export type A2AEnvelope<TPayload = unknown> = {
  v: string;
  type: A2AEnvelopeType;
  id: string;
  from?: string;
  to?: string;
  ts: number;
  seq?: number;
  traceId?: string;
  payload?: TPayload;
  error?: A2AError;
};

export type A2AHelloPayload = {
  agentId: string;
  sessionId?: string;
  role?: 'supervisor' | 'executor' | 'client';
  capabilities?: string[];
  topics?: string[];
  meta?: Record<string, unknown>;
};

export type A2AAckPayload = {
  agentId: string;
  status?: 'ok' | 'error';
  message?: string;
  capabilities?: string[];
  topics?: string[];
  meta?: Record<string, unknown>;
};

export type A2ACapabilitiesPayload = {
  agentId: string;
  capabilities: string[];
  topics?: string[];
  meta?: Record<string, unknown>;
};

export type A2APingPayload = {
  nonce?: string;
};

export type A2APongPayload = {
  nonce?: string;
};

export type A2ASubscribePayload = {
  agentId?: string;
  topics: string[];
  replace?: boolean;
};

export type A2AUnsubscribePayload = {
  agentId?: string;
  topics: string[];
};

export type A2ARequestPayload = {
  method: string;
  params?: Record<string, unknown>;
};

export type A2AResponsePayload = {
  result?: Record<string, unknown> | null;
};

export type A2AEventPayload = {
  topic: string;
  data?: Record<string, unknown>;
};

export function createEnvelope<TPayload>(
  options: Omit<A2AEnvelope<TPayload>, 'v' | 'ts'>
): A2AEnvelope<TPayload> {
  return {
    v: A2A_LITE_VERSION,
    ts: Date.now(),
    ...options,
  };
}
