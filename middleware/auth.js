function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  const db = req.app.get('db');
  try {
    const snap = await db.ref(`users/${req.session.userId}`).once('value');
    const user = snap.val();
    if (!user || !user.is_admin || user.role !== 'admin') {
      return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: '권한 확인 중 오류가 발생했습니다.' });
  }
}

module.exports = { requireLogin, requireAdmin };
