require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initDatabase } = require('./database/init');

const app = express();
const db = initDatabase();
app.set('db', db);

const IS_VERCEL = !!process.env.VERCEL;

const RANKS = [
  '훈련병', '이등병', '일등병', '상등병', '병장',
  '하사', '중사', '상사', '원사',
  '소위', '중위', '대위',
  '소령', '중령', '대령',
  '준장', '소장', '중장', '대장'
];

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'army-game-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/exam', require('./routes/exam'));
app.use('/api/admin', require('./routes/admin'));

// ==================== REST API for chat (works on both local and Vercel) ====================
const recentMessages = [];
const MAX_RECENT = 50;
const onlineUsers = new Map();

function addRecentMessage(msg) {
  recentMessages.push(msg);
  if (recentMessages.length > MAX_RECENT) recentMessages.shift();
}

app.post('/api/chat', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: '로그인 필요' });
  const { message } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: '메시지 필요' });
  const msg = message.trim().substring(0, 500);
  if (!msg) return res.status(400).json({ error: '빈 메시지' });
  try {
    const snap = await db.ref(`users/${req.session.userId}`).once('value');
    const user = snap.val();
    if (!user) return res.status(404).json({ error: '유저 없음' });
    const chatMsg = {
      nickname: user.nickname,
      rank: RANKS[user.rank_index],
      message: msg,
      isAdmin: !!user.is_admin,
      timestamp: Date.now()
    };
    addRecentMessage(chatMsg);
    await db.ref('chat_messages').push().set({
      user_id: req.session.userId,
      nickname: user.nickname,
      message: msg,
      sent_at: Date.now()
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '전송 실패' });
  }
});

app.get('/api/poll', (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: '로그인 필요' });
  const since = parseInt(req.query.since) || Date.now() - 5000;
  const messages = recentMessages.filter(m => m.timestamp > since);
  const online = Array.from(onlineUsers.values()).map(u => ({ nickname: u.nickname, userId: u.userId }));
  res.json({ messages, online, timestamp: Date.now() });
});

// ==================== Socket.IO (local only, not on Vercel) ====================
let io = null;

if (!IS_VERCEL) {
  const http = require('http');
  const { Server } = require('socket.io');
  const server = http.createServer(app);
  io = new Server(server);

  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
  });

  io.on('connection', (socket) => {
    const sess = socket.request.session;
    if (!sess || !sess.userId) {
      socket.disconnect();
      return;
    }

    const userId = sess.userId;
    onlineUsers.set(userId, {
      socketId: socket.id,
      nickname: sess.nickname,
      userId
    });

    broadcastOnlineUsers();

    socket.on('chat', async (data) => {
      if (!data || !data.message || typeof data.message !== 'string') return;
      const msg = data.message.trim().substring(0, 500);
      if (!msg) return;

      try {
        const snap = await db.ref(`users/${userId}`).once('value');
        const user = snap.val();
        if (!user) return;

        const prisonSnap = await db.ref('prison_records')
          .orderByChild('user_id').equalTo(userId).once('value');
        let isJailed = false;
        prisonSnap.forEach(child => {
          const rec = child.val();
          if (!rec.released && new Date(rec.release_at).getTime() > Date.now()) {
            isJailed = true;
          }
        });

        if (msg.startsWith('/')) {
          if (isJailed) {
            socket.emit('system', '수감 중에는 명령어를 사용할 수 없습니다.');
            return;
          }
          await handleCommand(socket, userId, user, msg);
          return;
        }

        if (isJailed) {
          io.emit('chat', {
            nickname: user.nickname,
            rank: RANKS[user.rank_index],
            message: msg,
            isJailed: true,
            timestamp: Date.now()
          });
          return;
        }

        await db.ref('chat_messages').push().set({
          user_id: userId,
          nickname: user.nickname,
          message: msg,
          sent_at: Date.now()
        });

        const chatMsg = {
          nickname: user.nickname,
          rank: RANKS[user.rank_index],
          message: msg,
          isAdmin: !!user.is_admin,
          timestamp: Date.now()
        };
        addRecentMessage(chatMsg);
        io.emit('chat', chatMsg);
      } catch (err) {
        console.error('Chat error:', err);
      }
    });

    socket.on('position', async (data) => {
      if (!data || typeof data.x !== 'number') return;
      try {
        await db.ref(`users/${userId}/position`).set({
          x: data.x, y: data.y || 0, z: data.z || 0
        });
        const snap = await db.ref(`users/${userId}/rank_index`).once('value');
        socket.broadcast.emit('playerMoved', {
          userId,
          nickname: sess.nickname,
          rankIndex: snap.val() || 0,
          x: data.x, y: data.y || 0, z: data.z || 0
        });
      } catch (err) {}
    });

    socket.on('disconnect', () => {
      onlineUsers.delete(userId);
      io.emit('playerLeft', { userId });
      broadcastOnlineUsers();
    });
  });

  // Prison auto-release (local only)
  setInterval(async () => {
    try {
      const snap = await db.ref('prison_records').orderByChild('released').equalTo(false).once('value');
      if (!snap.exists()) return;
      snap.forEach(child => {
        const rec = child.val();
        if (new Date(rec.release_at).getTime() <= Date.now()) {
          db.ref(`prison_records/${child.key}`).update({ released: true });
          io.emit('system', `${rec.nickname}님이 자동 석방되었습니다.`);
          io.emit('playerReleased', { userId: rec.user_id, nickname: rec.nickname });
        }
      });
    } catch (err) {}
  }, 30000);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`대한민국 육군 게임 서버가 포트 ${PORT}에서 실행 중입니다.`);
    console.log(`http://localhost:${PORT}`);
  });
}

async function handleCommand(socket, userId, user, msg) {
  const parts = msg.substring(1).split(' ');
  const cmd = parts[0];

  await db.ref('command_logs').push().set({
    user_id: userId,
    nickname: user.nickname,
    command: msg,
    logged_at: Date.now()
  });

  switch (cmd) {
    case '수감': {
      if (!user.is_admin) {
        socket.emit('system', '수감 명령어는 관리자만 사용할 수 있습니다.');
        return;
      }
      const targetNick = parts[1];
      const minutes = parseInt(parts[2]) || 10;
      const reason = parts.slice(3).join(' ') || '관리자 처분';
      if (!targetNick) {
        socket.emit('system', '사용법: /수감 닉네임 시간(분) 사유');
        return;
      }
      const targetSnap = await db.ref('users').orderByChild('nickname').equalTo(targetNick).once('value');
      if (!targetSnap.exists()) {
        socket.emit('system', `"${targetNick}" 유저를 찾을 수 없습니다.`);
        return;
      }
      let targetId, target;
      targetSnap.forEach(child => { targetId = child.key; target = child.val(); });

      if (target.is_admin) {
        socket.emit('system', '관리자는 수감할 수 없습니다.');
        return;
      }

      const duration = Math.min(Math.max(minutes, 1), 1440);
      const releaseAt = new Date(Date.now() + duration * 60 * 1000).toISOString();

      await db.ref('prison_records').push().set({
        user_id: targetId,
        nickname: target.nickname,
        reason,
        jailed_by: userId,
        jailer_name: user.nickname,
        started_at: new Date().toISOString(),
        release_at: releaseAt,
        released: false
      });

      io.emit('system', `[관리자] ${target.nickname}님이 "${reason}" 사유로 ${duration}분간 수감되었습니다.`);
      io.emit('playerJailed', { userId: targetId, nickname: target.nickname, releaseAt });
      break;
    }

    case '석방': {
      if (!user.is_admin) {
        socket.emit('system', '석방 명령어는 관리자만 사용할 수 있습니다.');
        return;
      }
      const relNick = parts[1];
      if (!relNick) {
        socket.emit('system', '사용법: /석방 닉네임');
        return;
      }
      const relSnap = await db.ref('users').orderByChild('nickname').equalTo(relNick).once('value');
      if (!relSnap.exists()) {
        socket.emit('system', `"${relNick}" 유저를 찾을 수 없습니다.`);
        return;
      }
      let relId;
      relSnap.forEach(child => { relId = child.key; });

      const prisonSnap = await db.ref('prison_records')
        .orderByChild('user_id').equalTo(relId).once('value');
      let released = false;
      prisonSnap.forEach(child => {
        const rec = child.val();
        if (!rec.released) {
          db.ref(`prison_records/${child.key}`).update({ released: true, released_by: userId });
          released = true;
        }
      });

      if (released) {
        io.emit('system', `[관리자] ${relNick}님이 석방되었습니다.`);
        io.emit('playerReleased', { userId: relId, nickname: relNick });
      } else {
        socket.emit('system', `${relNick}님은 현재 수감 상태가 아닙니다.`);
      }
      break;
    }

    case '승급': {
      if (!user.is_admin) {
        socket.emit('system', '승급 명령어는 관리자만 사용할 수 있습니다.');
        return;
      }
      const proNick = parts[1];
      const proReason = parts.slice(2).join(' ') || '관리자 승급 심사 통과';
      if (!proNick) {
        socket.emit('system', '사용법: /승급 닉네임 [사유]');
        return;
      }
      const proSnap = await db.ref('users').orderByChild('nickname').equalTo(proNick).once('value');
      if (!proSnap.exists()) {
        socket.emit('system', `"${proNick}" 유저를 찾을 수 없습니다.`);
        return;
      }
      let proId, proTarget;
      proSnap.forEach(child => { proId = child.key; proTarget = child.val(); });
      if (proTarget.rank_index >= 18) {
        socket.emit('system', `${proNick}님은 이미 최고 계급(대장)입니다.`);
        return;
      }
      const prevIdx = proTarget.rank_index;
      const newIdx = prevIdx + 1;
      await db.ref(`users/${proId}`).update({ rank_index: newIdx });
      await db.ref('promotion_records').push().set({
        user_id: proId, nickname: proTarget.nickname,
        prev_rank_index: prevIdx, prev_rank: RANKS[prevIdx],
        new_rank_index: newIdx, new_rank: RANKS[newIdx],
        type: 'promote', reason: proReason,
        promoted_by: userId, promoter_nickname: user.nickname,
        promoted_at: Date.now()
      });
      io.emit('system', `🎖️ ${proTarget.nickname}님이 ${RANKS[prevIdx]} → ${RANKS[newIdx]}(으)로 승급하였습니다! (사유: ${proReason})`);
      break;
    }

    case '강등': {
      if (!user.is_admin) {
        socket.emit('system', '강등 명령어는 관리자만 사용할 수 있습니다.');
        return;
      }
      const demNick = parts[1];
      const demReason = parts.slice(2).join(' ') || '관리자 강등 처분';
      if (!demNick) {
        socket.emit('system', '사용법: /강등 닉네임 [사유]');
        return;
      }
      const demSnap = await db.ref('users').orderByChild('nickname').equalTo(demNick).once('value');
      if (!demSnap.exists()) {
        socket.emit('system', `"${demNick}" 유저를 찾을 수 없습니다.`);
        return;
      }
      let demId, demTarget;
      demSnap.forEach(child => { demId = child.key; demTarget = child.val(); });
      if (demTarget.is_admin) {
        socket.emit('system', '관리자는 강등할 수 없습니다.');
        return;
      }
      if (demTarget.rank_index <= 0) {
        socket.emit('system', `${demNick}님은 이미 최하 계급(훈련병)입니다.`);
        return;
      }
      const demPrev = demTarget.rank_index;
      const demNew = demPrev - 1;
      await db.ref(`users/${demId}`).update({ rank_index: demNew });
      await db.ref('promotion_records').push().set({
        user_id: demId, nickname: demTarget.nickname,
        prev_rank_index: demPrev, prev_rank: RANKS[demPrev],
        new_rank_index: demNew, new_rank: RANKS[demNew],
        type: 'demote', reason: demReason,
        promoted_by: userId, promoter_nickname: user.nickname,
        promoted_at: Date.now()
      });
      io.emit('system', `⬇️ ${demTarget.nickname}님이 ${RANKS[demPrev]} → ${RANKS[demNew]}(으)로 강등되었습니다. (사유: ${demReason})`);
      break;
    }

    case '도움말':
    case 'help':
    case 'commands':
      socket.emit('system', `━━ 기본 명령어 ━━
/도움말 · /me · /계급 · /접속자 · /위치 · /profile · /status
/inventory · /training · /mission · /schedule · /history · /clear
━━ 군 생활 ━━
/request equipment · /request medical · /request training · /request position
━━ 계급 ━━
/rank list · /rank requirements · /rank status · /rank history · /career
━━ 지휘관 ━━
/command status · /command roster · /command briefing · /command report
━━ 관리자 ━━
/승급 · /강등 · /수감 · /석방 · /공지`);
      break;

    case '계급':
    case 'rank': {
      if (parts[1] === 'list') {
        socket.emit('system', `━━ 전체 계급 ━━\n병사: ${RANKS.slice(0,5).join(' → ')}\n부사관: ${RANKS.slice(5,9).join(' → ')}\n장교: ${RANKS.slice(9,15).join(' → ')}\n장성: ${RANKS.slice(15).join(' → ')}`);
      } else if (parts[1] === 'requirements') {
        socket.emit('system', `━━ 진급 조건 ━━\n모든 진급은 관리자 심사를 통해 이루어집니다.\n• 복무 기간 충족\n• 체력 평가 통과\n• 교육 과정 이수\n• 지휘관 평가\n상세 내용은 인사과에서 확인하세요.`);
      } else if (parts[1] === 'status') {
        socket.emit('system', `현재 계급: ${RANKS[user.rank_index]}\n진급 심사 상태: 관리자에게 문의하세요.`);
      } else if (parts[1] === 'history') {
        const proSnap = await db.ref('promotion_records').orderByChild('user_id').equalTo(userId).once('value');
        let history = '━━ 진급 기록 ━━\n';
        let count = 0;
        proSnap.forEach(child => {
          const r = child.val();
          history += `${r.prev_rank} → ${r.new_rank} (${r.type === 'promote' ? '승급' : '강등'}) — ${r.reason}\n`;
          count++;
        });
        socket.emit('system', count > 0 ? history : '진급 기록이 없습니다.');
      } else {
        socket.emit('system', `${user.nickname} — ${RANKS[user.rank_index]} (${user.affiliation})`);
      }
      break;
    }

    case 'me':
    case 'profile': {
      const rankTier = user.rank_index <= 4 ? '병사' : user.rank_index <= 8 ? '부사관' : user.rank_index <= 14 ? '장교' : '장성';
      const pos = user.military_position || '없음';
      socket.emit('system', `━━ 내 정보 ━━\n이름: ${user.nickname}\n계급: ${RANKS[user.rank_index]} (${rankTier})\n보직: ${pos}\n소속: ${user.affiliation}\n관리자: ${user.is_admin ? '예' : '아니오'}`);
      break;
    }

    case '접속자': {
      const list = Array.from(onlineUsers.values()).map(u => u.nickname).join(', ');
      socket.emit('system', `접속자 (${onlineUsers.size}명): ${list}`);
      break;
    }

    case '위치':
      socket.emit('system', '현재 위치는 화면 상단에 표시됩니다.');
      break;

    case 'status':
      socket.emit('system', `━━ 상태 ━━\n계급: ${RANKS[user.rank_index]}\n소속: ${user.affiliation}\n보직: ${user.military_position || '없음'}\n체력: 100%\n피로도: 0%`);
      break;

    case 'inventory':
      socket.emit('system', '━━ 장비 목록 ━━\n• 전투복 1벌\n• 전투화 1켤레\n• 전투모 1개\n• 개인장구 1세트\n장비실에서 추가 장비를 수령할 수 있습니다.');
      break;

    case 'training':
      socket.emit('system', '━━ 훈련 현황 ━━\n종합 훈련장에서 훈련에 참여할 수 있습니다.\n[E]키를 눌러 건물에 입장하세요.\n• 달리기 · 팔굽혀펴기 · 윗몸일으키기 · 턱걸이\n• 장애물 통과 · 사격 훈련 · 종합 체력 평가');
      break;

    case 'mission':
      socket.emit('system', '━━ 임무 목록 ━━\n현재 배정된 임무가 없습니다.\n지휘관의 명령을 기다려주세요.');
      break;

    case 'schedule':
      socket.emit('system', '━━ 일과표 ━━\n06:00 기상\n06:30 아침 체력단련\n08:00 아침식사\n09:00 오전교육/훈련\n12:00 점심식사\n13:00 오후교육/훈련\n17:00 개인정비\n18:00 저녁식사\n19:00 자유시간\n22:00 점호\n22:30 취침');
      break;

    case 'notifications':
      socket.emit('system', '알림이 없습니다.');
      break;

    case 'history':
      socket.emit('system', '기록을 조회하려면 기록보관실에 방문하세요.\n/rank history 로 진급 기록을 볼 수 있습니다.');
      break;

    case 'clear':
      socket.emit('clearChat');
      break;

    case 'career':
      socket.emit('system', `━━ 군 경력 ━━\n이름: ${user.nickname}\n현재 계급: ${RANKS[user.rank_index]}\n보직: ${user.military_position || '없음'}\n소속: ${user.affiliation}`);
      break;

    case 'request': {
      const reqType = parts[1];
      if (!reqType) {
        socket.emit('system', '사용법: /request [equipment|medical|training|position]');
        break;
      }
      const reqNames = { equipment: '장비 지급', medical: '진료', training: '훈련 참가', position: '보직 지원' };
      socket.emit('system', `[신청] ${reqNames[reqType] || reqType} 요청이 접수되었습니다. 관리자가 검토할 예정입니다.`);
      break;
    }

    case 'command': {
      const subCmd = parts[1];
      if (!subCmd) { socket.emit('system', '사용법: /command [status|roster|briefing|report|announcement]'); break; }
      if (user.rank_index < 5 && !user.is_admin) {
        socket.emit('system', '지휘관 명령어는 부사관 이상만 사용할 수 있습니다.');
        break;
      }
      switch(subCmd) {
        case 'status': socket.emit('system', `━━ 부대 현황 ━━\n현재 접속: ${onlineUsers.size}명\n부대 상태: 정상`); break;
        case 'roster': {
          const userList = Array.from(onlineUsers.values()).map(u => u.nickname).join(', ');
          socket.emit('system', `━━ 인원 현황 ━━\n접속 인원: ${onlineUsers.size}명\n${userList}`);
          break;
        }
        case 'briefing': socket.emit('system', '현재 예정된 브리핑이 없습니다.'); break;
        case 'report': socket.emit('system', '보고서 기능은 작전회의실에서 이용할 수 있습니다.'); break;
        case 'announcement': {
          if (user.rank_index < 9 && !user.is_admin) { socket.emit('system', '부대 공지는 장교 이상만 가능합니다.'); break; }
          const ann = parts.slice(2).join(' ');
          if (!ann) { socket.emit('system', '사용법: /command announcement 내용'); break; }
          io.emit('system', `[${RANKS[user.rank_index]} ${user.nickname}] ${ann}`);
          break;
        }
        default: socket.emit('system', '알 수 없는 지휘관 명령어입니다.');
      }
      break;
    }

    case 'mp': {
      const mpSub = parts[1];
      if (!mpSub) { socket.emit('system', '사용법: /mp [status|duty|case]'); break; }
      switch(mpSub) {
        case 'status': socket.emit('system', '━━ MP 근무 상태 ━━\n현재 근무 중인 헌병이 없습니다.'); break;
        case 'duty': socket.emit('system', '근무 일정은 군사경찰실에서 확인하세요.'); break;
        case 'case': socket.emit('system', '사건 접수/검색은 군사경찰실에서 이용하세요.'); break;
        default: socket.emit('system', '알 수 없는 MP 명령어입니다.');
      }
      break;
    }

    case 'logistics': {
      const logSub = parts[1];
      if (!logSub) { socket.emit('system', '사용법: /logistics [inventory|equipment|request|vehicle]'); break; }
      switch(logSub) {
        case 'inventory': socket.emit('system', '━━ 보급품 재고 ━━\n보급창고에서 확인하세요.'); break;
        case 'equipment': socket.emit('system', '장비 현황은 장비실에서 확인하세요.'); break;
        case 'request': socket.emit('system', '보급 요청이 접수되었습니다.'); break;
        case 'vehicle': socket.emit('system', '차량 현황은 차량 정비고에서 확인하세요.'); break;
        default: socket.emit('system', '알 수 없는 군수 명령어입니다.');
      }
      break;
    }

    case 'personnel': {
      const perSub = parts[1];
      if (!perSub) { socket.emit('system', '사용법: /personnel [profile|assignment|record]'); break; }
      switch(perSub) {
        case 'profile': socket.emit('system', '인사 조회는 인사과에서 이용하세요.'); break;
        case 'assignment': socket.emit('system', '보직 현황은 인사과에서 확인하세요.'); break;
        case 'record': socket.emit('system', '인사 기록은 인사과에서 확인하세요.'); break;
        default: socket.emit('system', '알 수 없는 인사 명령어입니다.');
      }
      break;
    }

    case 'hq': {
      if (user.rank_index < 14 && !user.is_admin) {
        socket.emit('system', '사령부 명령어는 대령 이상만 사용할 수 있습니다.');
        break;
      }
      const hqSub = parts[1];
      if (!hqSub) { socket.emit('system', '사용법: /hq [status|units|personnel|reports|directive|audit]'); break; }
      switch(hqSub) {
        case 'status': socket.emit('system', `━━ 사령부 현황 ━━\n접속 인원: ${onlineUsers.size}명\n부대 상태: 정상`); break;
        case 'units': socket.emit('system', '━━ 예하 부대 ━━\n현재 부대 구성 정보가 없습니다.'); break;
        case 'personnel': socket.emit('system', '인원 현황은 인사과에서 확인하세요.'); break;
        case 'reports': socket.emit('system', '보고서 목록이 비어있습니다.'); break;
        case 'directive': {
          const dir = parts.slice(2).join(' ');
          if (!dir) { socket.emit('system', '사용법: /hq directive 내용'); break; }
          io.emit('system', `[사령부 지시] ${dir}`);
          break;
        }
        case 'audit': socket.emit('system', '감사 기록은 기록보관실에서 확인하세요.'); break;
        default: socket.emit('system', '알 수 없는 사령부 명령어입니다.');
      }
      break;
    }

    case 'building': {
      const buildingName = parts[1];
      const action = parts.slice(2).join(' ');
      socket.emit('system', `[${buildingName}] ${action} — 처리 완료`);
      break;
    }

    case '공지': {
      if (!user.is_admin) {
        socket.emit('system', '공지 명령어는 관리자만 사용할 수 있습니다.');
        return;
      }
      const notice = parts.slice(1).join(' ');
      if (!notice) {
        socket.emit('system', '사용법: /공지 메시지');
        return;
      }
      io.emit('system', `[공지] ${notice}`);
      break;
    }

    case 'unit':
      socket.emit('system', `━━ 소속 부대 ━━\n소속: ${user.affiliation}\n보직: ${user.military_position || '없음'}`);
      break;

    default:
      socket.emit('system', `알 수 없는 명령어입니다. /도움말을 입력하세요.`);
  }
}

function broadcastOnlineUsers() {
  if (!io) return;
  const users = Array.from(onlineUsers.values()).map(u => ({
    nickname: u.nickname,
    userId: u.userId
  }));
  io.emit('onlineUsers', users);
}

module.exports = app;
