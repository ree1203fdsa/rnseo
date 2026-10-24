const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const RANKS = [
  '훈련병', '이등병', '일등병', '상등병', '병장',
  '하사', '중사', '상사', '원사',
  '소위', '중위', '대위',
  '소령', '중령', '대령',
  '준장', '소장', '중장', '대장'
];

router.post('/register', async (req, res) => {
  const db = req.app.get('db');
  const { username, password, nickname } = req.body;

  if (!username || !password || !nickname) {
    return res.status(400).json({ error: '아이디, 비밀번호, 닉네임을 모두 입력해주세요.' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: '아이디는 3~20자여야 합니다.' });
  }
  if (password.length < 4 || password.length > 50) {
    return res.status(400).json({ error: '비밀번호는 4~50자여야 합니다.' });
  }
  if (nickname.length < 2 || nickname.length > 10) {
    return res.status(400).json({ error: '닉네임은 2~10자여야 합니다.' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: '아이디는 영문, 숫자, 밑줄만 사용 가능합니다.' });
  }

  try {
    const usernameSnap = await db.ref('users').orderByChild('username').equalTo(username).once('value');
    if (usernameSnap.exists()) {
      return res.status(400).json({ error: '이미 사용 중인 아이디입니다.' });
    }

    const nickSnap = await db.ref('users').orderByChild('nickname').equalTo(nickname).once('value');
    if (nickSnap.exists()) {
      return res.status(400).json({ error: '이미 사용 중인 닉네임입니다.' });
    }

    const hash = await bcrypt.hash(password, 12);
    const newRef = db.ref('users').push();
    await newRef.set({
      username,
      password_hash: hash,
      nickname,
      rank_index: 0,
      affiliation: '육군',
      is_admin: false,
      role: 'user',
      created_at: Date.now(),
      last_login: Date.now(),
      position: { x: 0, y: 0, z: 0 }
    });

    req.session.userId = newRef.key;
    req.session.username = username;
    req.session.nickname = nickname;

    res.json({
      success: true,
      user: {
        id: newRef.key,
        username,
        nickname,
        rank: RANKS[0],
        rankIndex: 0,
        affiliation: '육군',
        isAdmin: false,
        outfitMode: 'rank',
        position: ''
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: '회원가입 중 오류가 발생했습니다.' });
  }
});

router.post('/login', async (req, res) => {
  const db = req.app.get('db');
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }

  try {
    const snap = await db.ref('users').orderByChild('username').equalTo(username).once('value');
    if (!snap.exists()) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    let userId, user;
    snap.forEach(child => {
      userId = child.key;
      user = child.val();
    });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    await db.ref(`users/${userId}`).update({ last_login: Date.now() });

    req.session.userId = userId;
    req.session.username = user.username;
    req.session.nickname = user.nickname;

    const prison = await getActivePrison(db, userId);

    res.json({
      success: true,
      user: {
        id: userId,
        username: user.username,
        nickname: user.nickname,
        rank: RANKS[user.rank_index],
        rankIndex: user.rank_index,
        affiliation: user.affiliation,
        isAdmin: !!user.is_admin,
        outfitMode: user.outfit_mode || 'rank',
        position: user.military_position || '',
        prison: prison
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: '로그인 중 오류가 발생했습니다.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

router.get('/me', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  const db = req.app.get('db');
  try {
    const snap = await db.ref(`users/${req.session.userId}`).once('value');
    if (!snap.exists()) {
      return res.status(401).json({ error: '유저를 찾을 수 없습니다.' });
    }
    const user = snap.val();
    const prison = await getActivePrison(db, req.session.userId);

    res.json({
      user: {
        id: req.session.userId,
        username: user.username,
        nickname: user.nickname,
        rank: RANKS[user.rank_index],
        rankIndex: user.rank_index,
        affiliation: user.affiliation,
        isAdmin: !!user.is_admin,
        outfitMode: user.outfit_mode || 'rank',
        position: user.military_position || '',
        prison: prison
      }
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: '정보 조회 중 오류가 발생했습니다.' });
  }
});

async function getActivePrison(db, userId) {
  const snap = await db.ref('prison_records')
    .orderByChild('user_id')
    .equalTo(userId)
    .once('value');

  if (!snap.exists()) return null;

  let activePrison = null;
  snap.forEach(child => {
    const record = child.val();
    if (!record.released && new Date(record.release_at).getTime() > Date.now()) {
      activePrison = {
        reason: record.reason,
        releaseAt: record.release_at,
        startedAt: record.started_at
      };
    }
  });
  return activePrison;
}

module.exports = router;
module.exports.RANKS = RANKS;
