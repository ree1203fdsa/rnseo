const express = require('express');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

const RANKS = [
  '훈련병', '이등병', '일등병', '상등병', '병장',
  '하사', '중사', '상사', '원사',
  '소위', '중위', '대위',
  '소령', '중령', '대령',
  '준장', '소장', '중장', '대장'
];

router.get('/my-rank', requireLogin, async (req, res) => {
  const db = req.app.get('db');
  try {
    const snap = await db.ref(`users/${req.session.userId}`).once('value');
    const user = snap.val();
    if (!user) return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });

    const nextIdx = user.rank_index + 1;
    res.json({
      currentRank: RANKS[user.rank_index],
      currentRankIndex: user.rank_index,
      nextRank: nextIdx <= 18 ? RANKS[nextIdx] : null,
      nextRankIndex: nextIdx <= 18 ? nextIdx : null,
      isMaxRank: user.rank_index >= 18
    });
  } catch (err) {
    res.status(500).json({ error: '계급 조회 오류' });
  }
});

router.get('/history', requireLogin, async (req, res) => {
  const db = req.app.get('db');
  try {
    const snap = await db.ref('promotion_records')
      .orderByChild('user_id').equalTo(req.session.userId).once('value');
    const records = [];
    if (snap.exists()) {
      snap.forEach(child => {
        records.push({ id: child.key, ...child.val() });
      });
    }
    records.sort((a, b) => (b.promoted_at || 0) - (a.promoted_at || 0));
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: '승급 기록 조회 오류' });
  }
});

module.exports = router;
