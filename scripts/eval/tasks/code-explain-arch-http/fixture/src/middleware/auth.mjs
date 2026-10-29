export function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'TOKEN_MISSING' }));
    return;
  }
  next();
}
