const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const router = express.Router();

const RANKS = [
  '훈련병', '이등병', '일등병', '상등병', '병장',
  '하사', '중사', '상사', '원사',
  '소위', '중위', '대위',
  '소령', '중령', '대령',
  '준장', '소장', '중장', '대장'
];

router.get('/users', requireAdmin, async (req, res) => {
  const db = req.app.get('db');
  try {
    const snap = await db.ref('users').once('value');
    const users = [];
    snap.forEach(child => {
      const u = child.val();
      users.push({
        id: child.key,
        username: u.username,
        nickname: u.nickname,
        rank_index: u.rank_index,
        rank: RANKS[u.rank_index],
        position: u.military_position || '',
        affiliation: u.affiliation,
        is_admin: u.is_admin,
        role: u.role,
        created_at: u.created_at,
        last_login: u.last_login
      });
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: '유저 목록 조회 오류' });
  }
});

router.get('/prison', requireAdmin, async (req, res) => {
  const db = req.app.get('db');
  try {
    const snap = await db.ref('prison_records').orderByChild('started_at').limitToLast(50).once('value');
    const records = [];
    snap.forEach(child => {
      records.push({ id: child.key, ...child.val() });
    });
    res.json(records.reverse());
  } catch (err) {
    res.status(500).json({ error: '수감 기록 조회 오류' });
  }
});

router.get('/promotions', requireAdmin, async (req, res) => {
  const db = req.app.get('db');
  try {
    const snap = await db.ref('promotion_records').orderByChild('promoted_at').limitToLast(50).once('value');
    const records = [];
    snap.forEach(child => {
      records.push({ id: child.key, ...child.val() });
    });
    res.json(records.reverse());
  } catch (err) {
    res.status(500).json({ error: '승급 기록 조회 오류' });
  }
});

router.get('/logs', requireAdmin, async (req, res) => {
  const db = req.app.get('db');
  try {
    const snap = await db.ref('command_logs').orderByChild('logged_at').limitToLast(100).once('value');
    const logs = [];
    snap.forEach(child => {
      logs.push({ id: child.key, ...child.val() });
    });
    res.json(logs.reverse());
  } catch (err) {
    res.status(500).json({ error: '로그 조회 오류' });
  }
});

router.post('/promote/:userId', requireAdmin, async (req, res) => {
  const db = req.app.get('db');
  const { reason } = req.body;
  try {
    const snap = await db.ref(`users/${req.params.userId}`).once('value');
    const user = snap.val();
    if (!user) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    if (user.rank_index >= 18) return res.status(400).json({ error: '이미 최고 계급입니다.' });

    const prevRank = user.rank_index;
    const newRank = prevRank + 1;
    await db.ref(`users/${req.params.userId}`).update({ rank_index: newRank });

    await db.ref('promotion_records').push().set({
      user_id: req.params.userId,
      nickname: user.nickname,
      prev_rank_index: prevRank,
      prev_rank: RANKS[prevRank],
      new_rank_index: newRank,
      new_rank: RANKS[newRank],
      type: 'promote',
      reason: reason || '관리자 승급 심사 통과',
      promoted_by: req.session.userId,
      promoter_nickname: req.session.nickname,
      promoted_at: Date.now()
    });

    res.json({
      success: true,
      nickname: user.nickname,
      prevRank: RANKS[prevRank],
      newRank: RANKS[newRank],
      newRankIndex: newRank
    });
  } catch (err) {
    res.status(500).json({ error: '승급 처리 오류' });
  }
});

router.post('/demote/:userId', requireAdmin, async (req, res) => {
  const db = req.app.get('db');
  const { reason } = req.body;
  try {
    const snap = await db.ref(`users/${req.params.userId}`).once('value');
    const user = snap.val();
    if (!user) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    if (user.rank_index <= 0) return res.status(400).json({ error: '이미 최하 계급입니다.' });
    if (user.is_admin) return res.status(400).json({ error: '관리자는 강등할 수 없습니다.' });

    const prevRank = user.rank_index;
    const newRank = prevRank - 1;
    await db.ref(`users/${req.params.userId}`).update({ rank_index: newRank });

    await db.ref('promotion_records').push().set({
      user_id: req.params.userId,
      nickname: user.nickname,
      prev_rank_index: prevRank,
      prev_rank: RANKS[prevRank],
      new_rank_index: newRank,
      new_rank: RANKS[newRank],
      type: 'demote',
      reason: reason || '관리자 강등 처분',
      promoted_by: req.session.userId,
      promoter_nickname: req.session.nickname,
      promoted_at: Date.now()
    });

    res.json({
      success: true,
      nickname: user.nickname,
      prevRank: RANKS[prevRank],
      newRank: RANKS[newRank],
      newRankIndex: newRank
    });
  } catch (err) {
    res.status(500).json({ error: '강등 처리 오류' });
  }
});

router.post('/set-rank/:userId', requireAdmin, async (req, res) => {
  const db = req.app.get('db');
  const { rankIndex, reason } = req.body;
  try {
    if (typeof rankIndex !== 'number' || rankIndex < 0 || rankIndex > 18) {
      return res.status(400).json({ error: '유효하지 않은 계급입니다.' });
    }
    const snap = await db.ref(`users/${req.params.userId}`).once('value');
    const user = snap.val();
    if (!user) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });

    const prevRank = user.rank_index;
    await db.ref(`users/${req.params.userId}`).update({ rank_index: rankIndex });

    await db.ref('promotion_records').push().set({
      user_id: req.params.userId,
      nickname: user.nickname,
      prev_rank_index: prevRank,
      prev_rank: RANKS[prevRank],
      new_rank_index: rankIndex,
      new_rank: RANKS[rankIndex],
      type: rankIndex > prevRank ? 'promote' : rankIndex < prevRank ? 'demote' : 'set',
      reason: reason || '관리자 계급 직접 설정',
      promoted_by: req.session.userId,
      promoter_nickname: req.session.nickname,
      promoted_at: Date.now()
    });

    res.json({
      success: true,
      nickname: user.nickname,
      prevRank: RANKS[prevRank],
      newRank: RANKS[rankIndex],
      newRankIndex: rankIndex
    });
  } catch (err) {
    res.status(500).json({ error: '계급 설정 오류' });
  }
});

router.post('/jail/:userId', requireAdmin, async (req, res) => {
  const db = req.app.get('db');
  const { reason, minutes } = req.body;
  try {
    const snap = await db.ref(`users/${req.params.userId}`).once('value');
    const user = snap.val();
    if (!user) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    if (user.is_admin) return res.status(400).json({ error: '관리자는 수감할 수 없습니다.' });

    const duration = Math.min(Math.max(parseInt(minutes) || 10, 1), 1440);
    const releaseAt = new Date(Date.now() + duration * 60 * 1000).toISOString();

    await db.ref('prison_records').push().set({
      user_id: req.params.userId,
      nickname: user.nickname,
      reason: reason || '관리자 처분',
      jailed_by: req.session.userId,
      jailer_name: req.session.nickname,
      started_at: new Date().toISOString(),
      release_at: releaseAt,
      released: false
    });

    await db.ref('jail_events/' + req.params.userId).set({
      type: 'jail',
      reason: reason || '관리자 처분',
      minutes: duration,
      releaseAt: releaseAt,
      timestamp: Date.now()
    });

    res.json({
      success: true,
      nickname: user.nickname,
      reason: reason || '관리자 처분',
      minutes: duration,
      releaseAt
    });
  } catch (err) {
    res.status(500).json({ error: '수감 처리 오류' });
  }
});

router.post('/release/:userId', requireAdmin, async (req, res) => {
  const db = req.app.get('db');
  try {
    const snap = await db.ref('prison_records')
      .orderByChild('user_id').equalTo(req.params.userId).once('value');
    let released = false;
    let nickname = '';
    snap.forEach(child => {
      const rec = child.val();
      if (!rec.released) {
        db.ref(`prison_records/${child.key}`).update({ released: true, released_by: req.session.userId });
        released = true;
        nickname = rec.nickname;
      }
    });
    if (released) {
      await db.ref('jail_events/' + req.params.userId).set({
        type: 'release',
        timestamp: Date.now()
      });
      res.json({ success: true, nickname });
    } else {
      res.status(400).json({ error: '현재 수감 중인 기록이 없습니다.' });
    }
  } catch (err) {
    res.status(500).json({ error: '석방 처리 오류' });
  }
});

router.post('/set-position/:userId', requireAdmin, async (req, res) => {
  const db = req.app.get('db');
  const { position } = req.body;
  try {
    const snap = await db.ref(`users/${req.params.userId}`).once('value');
    const user = snap.val();
    if (!user) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });

    await db.ref(`users/${req.params.userId}`).update({ military_position: position || '' });

    res.json({ success: true, nickname: user.nickname, position });
  } catch (err) {
    res.status(500).json({ error: '보직 설정 오류' });
  }
});

module.exports = router;
