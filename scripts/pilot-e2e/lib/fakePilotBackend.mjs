/*
 * Pilot 基准集的本机账本桩 (Q-03).
 *
 * 只实现 PilotHome / PilotData 真正会调到的那些接口, 数据全放内存。
 * 它替的是云端控制面 + pilot-data 服务, 不是替 pilot 自己的逻辑:
 * 每轮 instructions、审批卡、成品交付、工具执行器都还是 packages/core 里的真代码。
 */
import { gunzipSync } from 'node:zlib';

const PILOT_PREFIX = '/api/v1/pilot';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readBody(init) {
  const raw = init?.body;
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  let buf;
  if (Buffer.isBuffer(raw)) buf = raw;
  else if (raw instanceof Uint8Array) buf = Buffer.from(raw);
  else if (raw instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(raw));
  else return String(raw);
  const gz = String(init?.headers?.['content-encoding'] ?? init?.headers?.['Content-Encoding'] ?? '') === 'gzip';
  return (gz ? gunzipSync(buf) : buf).toString('utf8');
}

export function createFakePilotBackend(options = {}) {
  const now = options.now ?? (() => Date.now());
  const state = {
    pilot: options.pilot ?? { id: 'p1', name: 'Pilot', persona: '私人助理, 说话直接' },
    timezone: options.timezone ?? 'Asia/Shanghai',
    memories: [...(options.memories ?? [])],
    messages: [...(options.messages ?? [])],
    reports: [],
    reminders: [...(options.reminders ?? [])],
    notifications: [],
    calls: [],
    delivered: [],
    records: [],
    sequence: 0,
  };
  let savedFetch = null;

  const nextId = (prefix) => `${prefix}-${(state.sequence += 1)}`;

  function addReport(body) {
    const id = nextId('card');
    state.reports.push({
      id,
      status: String(body?.status ?? 'done'),
      title: String(body?.title ?? ''),
      summary: String(body?.summary ?? ''),
      options: Array.isArray(body?.options) ? body.options : [],
      urgency: String(body?.urgency ?? 'fyi'),
      action: body?.action ?? null,
      answer: null,
      at: now(),
    });
    return id;
  }

  function handlePilot(url, init) {
    const method = String(init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.slice(PILOT_PREFIX.length);
    const pid = 'p1';

    if (method === 'GET' && path === `/pilots/${pid}/context`) {
      return json({
        pilot: state.pilot,
        memories: state.memories,
        messages: state.messages,
        reports: state.reports,
        reminders: state.reminders,
      });
    }
    if (method === 'POST' && path === `/pilots/${pid}/messages`) {
      const body = JSON.parse(readBody(init) || '{}');
      state.messages.push({
        role: String(body.role ?? 'user'),
        text: String(body.text ?? ''),
        device: body.device ?? null,
        at: now(),
        meta: body.meta ?? null,
      });
      return json({ ok: true });
    }
    if (method === 'POST' && path === `/pilots/${pid}/reports`) {
      const body = JSON.parse(readBody(init) || '{}');
      return json({ id: addReport(body), times: 1 });
    }
    if (method === 'POST' && path === `/pilots/${pid}/notify`) {
      const body = JSON.parse(readBody(init) || '{}');
      state.notifications.push({ title: String(body.title ?? ''), body: String(body.body ?? ''), at: now() });
      return json({ ok: true });
    }
    if (method === 'GET' && path === `/pilots/${pid}/actions`) {
      const actions = state.reports
        .filter((r) => r.status === 'approved' && r.action)
        .map((r) => ({ id: r.id, title: r.title, action: r.action }));
      return json({ actions });
    }
    const actionResult = /^\/reports\/([^/]+)\/action-result$/.exec(path);
    if (method === 'POST' && actionResult) {
      const card = state.reports.find((r) => r.id === decodeURIComponent(actionResult[1]));
      const body = JSON.parse(readBody(init) || '{}');
      if (card) {
        card.actionResult = { ok: Boolean(body.ok), result: String(body.result ?? '') };
        card.status = body.ok ? 'done' : 'failed';
      }
      return json({ ok: true });
    }
    if (method === 'GET' && path === `/pilots/${pid}/reminders`) {
      return json({ reminders: state.reminders });
    }
    if (method === 'POST' && path === `/pilots/${pid}/reminders`) {
      const body = JSON.parse(readBody(init) || '{}');
      const r = { id: nextId('rem'), title: String(body.title ?? ''), at: Number(body.at) || now() };
      state.reminders.push(r);
      return json({ id: r.id, at: r.at });
    }
    if (method === 'POST' && path === `/pilots/${pid}/memories`) {
      const body = JSON.parse(readBody(init) || '{}');
      const m = { id: nextId('mem'), text: String(body.text ?? '') };
      state.memories.push(m);
      return json({ id: m.id });
    }
    const memDelete = /^\/memories\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && memDelete) {
      const id = decodeURIComponent(memDelete[1]);
      state.memories = state.memories.filter((m) => m.id !== id);
      return json({ ok: true });
    }
    if (method === 'POST' && path === `/pilots/${pid}/call`) {
      const body = JSON.parse(readBody(init) || '{}');
      state.calls.push({ reason: String(body.reason ?? ''), opening: String(body.opening ?? '') });
      return json({ ok: true });
    }
    return json({ error: `fake pilot backend: unhandled ${method} ${path}` }, 404);
  }

  function handleData(url, init) {
    const method = String(init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    if (method === 'GET' && path.endsWith('/profile')) {
      return json({ text: String(options.profileText ?? ''), facts: 0 });
    }
    if (method === 'POST' && path.endsWith('/blobs')) {
      const raw = init?.body;
      const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(String(raw ?? ''));
      const name = decodeURIComponent(String(init?.headers?.['x-filename'] ?? 'file'));
      const id = nextId('blob');
      const urlOut = `https://files.example/${id}/${encodeURIComponent(name)}`;
      state.delivered.push({ id, name, size: bytes.length, url: urlOut, mime: String(init?.headers?.['content-type'] ?? '') });
      return json({ id, name, mime: String(init?.headers?.['content-type'] ?? ''), size: bytes.length, url: urlOut });
    }
    if (method === 'POST' && path.endsWith('/records/batch')) {
      const lines = readBody(init).split('\n').filter(Boolean);
      const results = lines.map((line) => {
        const rec = JSON.parse(line);
        state.records.push(rec);
        return { id: rec.id, status: 'ok' };
      });
      return json({ results });
    }
    if (method === 'GET' && path.endsWith('/records')) {
      return json({ records: state.records, next: null });
    }
    if (method === 'GET' && path.endsWith('/facts')) return json({ facts: [] });
    if (method === 'GET' && path.endsWith('/insights')) return json({ insights: [], records: state.records.length });
    if (method === 'GET' && path.endsWith('/timeline')) return json({ day: '', tz: state.timezone, groups: [] });
    if (method === 'GET' && path.endsWith('/types')) return json({ types: [] });
    if (method === 'GET' && path.includes('/metrics/')) return json({ points: [] });
    return json({ error: `fake pilot-data backend: unhandled ${method} ${path}` }, 404);
  }

  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    /* pilot-data 的路径也以 /api/v1/pilot 开头, 先按主机名分开 */
    if (url.hostname === 'pilot-data.local') return handleData(url, init);
    if (url.pathname.startsWith(PILOT_PREFIX)) return handlePilot(url, init);
    return json({ error: `fake backend: unknown host ${url.host}` }, 404);
  };

  return {
    state,
    fetch: fetchImpl,
    install() {
      savedFetch = globalThis.fetch;
      globalThis.fetch = fetchImpl;
    },
    restore() {
      if (savedFetch) globalThis.fetch = savedFetch;
      savedFetch = null;
    },
    /** 模拟用户在卡片上点「批准」 */
    approveReport(id) {
      const card = state.reports.find((r) => r.id === id);
      if (card) card.status = 'approved';
    },
    approveLatestBlocked() {
      const card = [...state.reports].reverse().find((r) => r.status === 'blocked');
      if (card) card.status = 'approved';
      return card ?? null;
    },
    reportById(id) {
      return state.reports.find((r) => r.id === id) ?? null;
    },
  };
}
