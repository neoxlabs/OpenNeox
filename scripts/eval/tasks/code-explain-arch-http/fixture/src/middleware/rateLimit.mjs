import { RATE_LIMIT } from '../config.mjs';

const hits = new Map();

export function rateLimit(req, res, next) {
  const key = req.socket.remoteAddress;
  const now = Date.now();
  const entry = hits.get(key) ?? { start: now, count: 0 };
  if (now - entry.start > RATE_LIMIT.windowMs) {
    entry.start = now;
    entry.count = 0;
  }
  entry.count += 1;
  hits.set(key, entry);
  if (entry.count > RATE_LIMIT.max) {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'RATE_LIMITED' }));
    return;
  }
  next();
}
