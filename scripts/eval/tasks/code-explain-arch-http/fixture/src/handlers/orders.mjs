import { HttpError } from '../errors.mjs';

export function ordersHandler(req, res) {
  if (req.url !== '/orders') {
    throw new HttpError(404, 'NOT_FOUND');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ orders: [] }));
}
