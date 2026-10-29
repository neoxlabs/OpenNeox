import { auth } from './middleware/auth.mjs';
import { rateLimit } from './middleware/rateLimit.mjs';
import { ordersHandler } from './handlers/orders.mjs';
import { toHttpError } from './errors.mjs';

const chain = [auth, rateLimit, ordersHandler];

export function handle(req, res) {
  try {
    let index = 0;
    const next = () => {
      const middleware = chain[index];
      index += 1;
      if (!middleware) return;
      middleware(req, res, next);
    };
    next();
  } catch (error) {
    const { status, body } = toHttpError(error);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
