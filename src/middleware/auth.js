const isApi = (req) => `${req.baseUrl || ''}${req.path}`.startsWith('/api/');

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  // API calls must fail loudly. Redirecting them to the login page returns a
  // 200 with an HTML body, which the front end silently reads as empty JSON —
  // every screen then renders as if the data were simply missing.
  if (isApi(req)) return res.status(401).json({ error: 'Not signed in' });
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Not permitted' });
    next();
  };
}
