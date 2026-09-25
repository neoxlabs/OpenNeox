import { describe, it, expect, beforeEach } from 'vitest';
import {
  isControlRequest,
  isControlResponse,
  handleControlRequest,
  ControlRequester,
  type ControlRequest,
  type ControlRequestHandlers,
} from '../controlProtocol.js';

describe('Type Guards', () => {
  it('isControlRequest validates correctly', () => {
    expect(isControlRequest({
      type: 'control_request',
      request_id: '123',
      request: { subtype: 'ping' },
    })).toBe(true);

    expect(isControlRequest({ type: 'chat' })).toBe(false);
    expect(isControlRequest(null)).toBe(false);
    expect(isControlRequest({ type: 'control_request' })).toBe(false); // missing request_id
  });

  it('isControlResponse validates correctly', () => {
    expect(isControlResponse({
      type: 'control_response',
      request_id: '123',
      response: { subtype: 'success' },
    })).toBe(true);

    expect(isControlResponse({ type: 'event' })).toBe(false);
  });
});

describe('handleControlRequest', () => {
  const handlers: ControlRequestHandlers = {
    onInitialize: () => ({ pid: 12345, version: '1.0' }),
    onSetModel: (model) => ({ ok: true }),
    onSetPermissionMode: (mode) => mode === 'reject' ? { ok: false, error: 'Rejected' } : { ok: true },
    onInterrupt: () => {},
    onSetMode: (mode) => ({ ok: true }),
    onGetStatus: () => ({ running: true }),
  };

  it('handles initialize', () => {
    const req: ControlRequest = {
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'initialize' },
    };
    const res = handleControlRequest(req, handlers);
    expect(res.response.subtype).toBe('success');
    expect((res.response as any).pid).toBe(12345);
  });

  it('handles ping', () => {
    const req: ControlRequest = {
      type: 'control_request',
      request_id: 'r2',
      request: { subtype: 'ping' },
    };
    const res = handleControlRequest(req, handlers);
    expect(res.response.subtype).toBe('success');
    expect((res.response as any).pong).toBe(true);
  });

  it('handles set_model', () => {
    const req: ControlRequest = {
      type: 'control_request',
      request_id: 'r3',
      request: { subtype: 'set_model', model: 'gpt-4' },
    };
    const res = handleControlRequest(req, handlers);
    expect(res.response.subtype).toBe('success');
  });

  it('returns error for set_model without model param', () => {
    const req: ControlRequest = {
      type: 'control_request',
      request_id: 'r4',
      request: { subtype: 'set_model' },
    };
    const res = handleControlRequest(req, handlers);
    expect(res.response.subtype).toBe('error');
  });

  it('handles set_permission_mode rejection', () => {
    const req: ControlRequest = {
      type: 'control_request',
      request_id: 'r5',
      request: { subtype: 'set_permission_mode', mode: 'reject' },
    };
    const res = handleControlRequest(req, handlers);
    expect(res.response.subtype).toBe('error');
    expect((res.response as any).error).toBe('Rejected');
  });

  it('handles get_status', () => {
    const req: ControlRequest = {
      type: 'control_request',
      request_id: 'r6',
      request: { subtype: 'get_status' },
    };
    const res = handleControlRequest(req, handlers);
    expect(res.response.subtype).toBe('success');
    expect((res.response as any).running).toBe(true);
  });

  it('rejects mutable requests in outbound-only mode', () => {
    const req: ControlRequest = {
      type: 'control_request',
      request_id: 'r7',
      request: { subtype: 'interrupt' },
    };
    const res = handleControlRequest(req, { ...handlers, outboundOnly: true });
    expect(res.response.subtype).toBe('error');
    expect((res.response as any).error).toContain('outbound-only');
  });

  it('allows ping and initialize in outbound-only mode', () => {
    const pingReq: ControlRequest = {
      type: 'control_request',
      request_id: 'r8',
      request: { subtype: 'ping' },
    };
    const res = handleControlRequest(pingReq, { ...handlers, outboundOnly: true });
    expect(res.response.subtype).toBe('success');
  });

  it('handles unknown subtype', () => {
    const req: ControlRequest = {
      type: 'control_request',
      request_id: 'r9',
      request: { subtype: 'unknown_thing' as any },
    };
    const res = handleControlRequest(req, handlers);
    expect(res.response.subtype).toBe('error');
  });
});

describe('ControlRequester', () => {
  let requester: ControlRequester;

  beforeEach(() => {
    requester = new ControlRequester();
  });

  it('creates request with correct structure', () => {
    const req = requester.createRequest('ping');
    expect(req.type).toBe('control_request');
    expect(req.request.subtype).toBe('ping');
    expect(req.request_id).toBeTruthy();
  });

  it('matches response to pending request', async () => {
    const promise = requester.request(
      async (msg) => {
        // Simulate immediate response
        setTimeout(() => {
          requester.handleResponse({
            type: 'control_response',
            request_id: msg.request_id,
            response: { subtype: 'success', pong: true },
          });
        }, 10);
      },
      'ping',
    );

    const response = await promise;
    expect(response.response.subtype).toBe('success');
  });

  it('times out if no response', async () => {
    const promise = requester.request(
      async () => {}, // never responds
      'ping',
      undefined,
      50, // 50ms timeout
    );

    await expect(promise).rejects.toThrow('timed out');
  });

  it('cancelAll rejects all pending', async () => {
    const p1 = requester.request(async () => {}, 'ping', undefined, 5000);
    const p2 = requester.request(async () => {}, 'get_status', undefined, 5000);

    requester.cancelAll('test cancel');

    await expect(p1).rejects.toThrow('test cancel');
    await expect(p2).rejects.toThrow('test cancel');
    expect(requester.pendingCount).toBe(0);
  });

  it('handleResponse returns false for unknown request_id', () => {
    expect(requester.handleResponse({
      type: 'control_response',
      request_id: 'unknown',
      response: { subtype: 'success' },
    })).toBe(false);
  });
});
