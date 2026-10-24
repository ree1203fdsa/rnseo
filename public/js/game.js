const RANKS = [
  '훈련병','이등병','일등병','상등병','병장',
  '하사','중사','상사','원사',
  '소위','중위','대위',
  '소령','중령','대령',
  '준장','소장','중장','대장'
];

const RANK_TIERS = {
  soldier: [0,1,2,3,4],
  nco: [5,6,7,8],
  officer: [9,10,11,12,13,14],
  general: [15,16,17,18]
};

function getRankTier(idx) {
  if (idx <= 4) return 'soldier';
  if (idx <= 8) return 'nco';
  if (idx <= 14) return 'officer';
  return 'general';
}

function getRankColor(idx) {
  const tier = getRankTier(idx);
  switch(tier) {
    case 'soldier': return { uniform: 0x4a5c3e, helmet: 0x4a5c3e, badge: null };
    case 'nco': return { uniform: 0x3d5030, helmet: 0x3d4a2e, badge: 0xc0a030 };
    case 'officer': return { uniform: 0x2a3a1e, helmet: 0x2a351a, badge: 0xd4af37 };
    case 'general': return { uniform: 0x1a2a10, helmet: 0x1a2510, badge: 0xffd700 };
  }
}

function createUniformTexture(rankIndex) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const palette = rankIndex <= 4
    ? ['#4d5945', '#67654d', '#353d32', '#82765b', '#555b48']
    : ['#3d4935', '#505343', '#30392d', '#68634b', '#454a38'];
  ctx.fillStyle = palette[0];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Deterministic, blocky digital-camouflage patches that tile across the
  // block-shaped arms, legs and torso, like a printed uniform fabric.
  for (let y = 0; y < 128; y += 8) {
    for (let x = 0; x < 128; x += 8) {
      const seed = (x * 17 + y * 31 + x * y * 7) % 23;
      if (seed < 12) continue;
      ctx.fillStyle = palette[seed % palette.length];
      const inset = seed % 3;
      ctx.fillRect(x + inset, y + (seed % 2), 4 + (seed % 5), 3 + (seed % 4));
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapNearestFilter;
  return texture;
}

let currentUser = null;
let socket = null;

// ==================== AUTH ====================
function showLogin() {
  document.getElementById('login-form').style.display = '';
  document.getElementById('register-form').style.display = 'none';
  document.querySelectorAll('.auth-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
}

function showRegister() {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('register-form').style.display = '';
  document.querySelectorAll('.auth-tab').forEach((t, i) => t.classList.toggle('active', i === 1));
}

async function login() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  if (!username || !password) { errEl.textContent = '아이디와 비밀번호를 입력해주세요.'; return; }
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; return; }
    currentUser = data.user;
    enterGame();
  } catch (e) { errEl.textContent = '서버 연결 오류'; }
}

async function register() {
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const nickname = document.getElementById('reg-nickname').value.trim();
  const errEl = document.getElementById('register-error');
  errEl.textContent = '';
  if (!username || !password || !nickname) { errEl.textContent = '모든 항목을 입력해주세요.'; return; }
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, nickname })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error; return; }
    currentUser = data.user;
    enterGame();
  } catch (e) { errEl.textContent = '서버 연결 오류'; }
}

async function logout() {
  cleanupFirebase();
  await fetch('/api/auth/logout', { method: 'POST' });
  if (socket) socket.disconnect();
  currentUser = null;
  exitGame();
}

async function checkSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) { const data = await res.json(); currentUser = data.user; enterGame(); }
  } catch (e) {}
}

async function enterGame() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('game-screen').style.display = 'block';
  if (typeof firebaseDB !== 'undefined' && currentUser && currentUser.id) {
    try {
      const snap = await firebaseDB.ref('users_outfit/' + currentUser.id).once('value');
      if (snap.exists()) currentUser.outfitMode = snap.val().outfitMode || 'rank';
    } catch (e) {}
  }
  updateUserInfo();
  connectSocket();
  initGameWorld();
  if (currentUser.prison) showJailOverlay(currentUser.prison);
}

function exitGame() {
  document.getElementById('game-screen').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
  if (renderer) { renderer.dispose(); renderer = null; }
}

function updateUserInfo() {
  const el = document.getElementById('user-info');
  el.innerHTML = `${currentUser.nickname} <span class="rank-badge">${currentUser.rank}</span> ${currentUser.affiliation}`;
  const adminBtn = document.getElementById('btn-admin');
  if (currentUser.isAdmin) adminBtn.style.display = '';
  else adminBtn.style.display = 'none';
}

// ==================== REALTIME (Firebase + Socket.IO fallback) ====================
let firebaseListenersActive = false;
let lastChatTimestamp = Date.now();

function connectSocket() {
  // Always use Firebase for real-time multiplayer
  if (typeof firebaseDB !== 'undefined') {
    startFirebaseRealtime();
    // Also try Socket.IO if available (for local dev server commands)
    trySocketIO();
    return;
  }
  // Fallback: Socket.IO only
  trySocketIO();
}

function trySocketIO() {
  if (typeof io === 'undefined' || window._noSocketIO) return;
  try {
    socket = io({ transports: ['polling', 'websocket'], reconnectionAttempts: 3, timeout: 5000 });
    socket.on('connect', () => { appendSystem('[연결] 서버 접속 완료'); });
    socket.on('system', (msg) => appendSystem(msg));
    socket.on('openOutfitSelector', () => openOutfitSelector());
    socket.on('playerJailed', (data) => {
      if (data.userId === currentUser.id) showJailOverlay({ reason: '수감됨', releaseAt: data.releaseAt });
    });
    socket.on('playerReleased', (data) => {
      if (data.userId === currentUser.id) hideJailOverlay();
    });
  } catch (e) {}
}

function startFirebaseRealtime() {
  if (firebaseListenersActive) return;
  firebaseListenersActive = true;
  const myId = currentUser.id;

  // Register presence
  const presenceRef = firebaseDB.ref('online/' + myId);
  presenceRef.set({
    nickname: currentUser.nickname,
    rank: currentUser.rank,
    rankIndex: currentUser.rankIndex,
    lastSeen: firebase.database.ServerValue.TIMESTAMP
  });
  presenceRef.onDisconnect().remove();

  // Listen for other players' positions
  firebaseDB.ref('player_positions').on('value', (snap) => {
    const positions = snap.val() || {};
    const seenIds = new Set();
    Object.entries(positions).forEach(([uid, data]) => {
      if (uid === myId) return;
      seenIds.add(uid);
      updateOtherPlayer({
        userId: uid,
        nickname: data.nickname || uid,
        rankIndex: data.rankIndex || 0,
        x: data.x || 0,
        y: data.y || 0,
        z: data.z || 0,
        outfitMode: data.outfitMode || 'rank'
      });
    });
    // Remove players no longer in the list
    Object.keys(otherPlayers).forEach(uid => {
      if (!seenIds.has(uid)) removeOtherPlayer(uid);
    });
  });

  // Listen for online users
  firebaseDB.ref('online').on('value', (snap) => {
    const online = snap.val() || {};
    const users = Object.entries(online).map(([id, u]) => ({
      nickname: u.nickname || id,
      userId: id
    }));
    renderOnlineUsers(users);
  });

  // Listen for new chat messages
  firebaseDB.ref('chat_messages').orderByChild('sent_at').startAt(Date.now()).on('child_added', (snap) => {
    const msg = snap.val();
    if (!msg) return;
    appendChat({
      nickname: msg.nickname,
      rank: msg.rank || '훈련병',
      message: msg.message,
      isAdmin: msg.isAdmin || false,
      timestamp: msg.sent_at
    });
  });

  // Listen for jail/release events targeting this player
  firebaseDB.ref('jail_events/' + myId).on('value', (snap) => {
    const ev = snap.val();
    if (!ev) return;
    if (ev.type === 'jail') {
      showJailOverlay({ reason: ev.reason || '수감됨', releaseAt: ev.releaseAt });
      appendSystem(`[영창] ${ev.reason || '수감되었습니다.'} (${ev.minutes || '?'}분)`);
    } else if (ev.type === 'release') {
      hideJailOverlay();
      appendSystem('[영창] 석방되었습니다.');
    }
  });

  appendSystem('[연결] 실시간 멀티플레이 연결 완료');
}

function sendFirebasePosition() {
  if (!firebaseListenersActive || !player || !currentUser) return;
  firebaseDB.ref('player_positions/' + currentUser.id).set({
    nickname: currentUser.nickname,
    rankIndex: currentUser.rankIndex || 0,
    outfitMode: currentUser.outfitMode || 'rank',
    x: Math.round(player.position.x * 10) / 10,
    y: Math.round(player.position.y * 10) / 10,
    z: Math.round(player.position.z * 10) / 10,
    timestamp: firebase.database.ServerValue.TIMESTAMP
  });
}

function cleanupFirebase() {
  if (!firebaseListenersActive || !currentUser) return;
  firebaseDB.ref('online/' + currentUser.id).remove();
  firebaseDB.ref('player_positions/' + currentUser.id).remove();
  firebaseDB.ref('player_positions').off();
  firebaseDB.ref('online').off();
  firebaseDB.ref('chat_messages').off();
  firebaseListenersActive = false;
}

function openOutfitSelector() {
  const modal = document.getElementById('outfit-modal');
  if (modal) {
    document.getElementById('outfit-status').textContent = '';
    modal.classList.add('active');
  }
}

function closeOutfitSelector() {
  document.getElementById('outfit-modal').classList.remove('active');
}

async function selectOutfit(outfitMode) {
  const status = document.getElementById('outfit-status');
  const allowedOutfits = ['field', 'tactical', 'dress'];
  if (!allowedOutfits.includes(outfitMode)) {
    status.textContent = '올바르지 않은 복장입니다.';
    return;
  }
  if (!currentUser || currentUser.nickname !== '이주람') {
    status.textContent = '대장 이주람만 복장을 변경할 수 있습니다.';
    return;
  }
  status.textContent = '복장을 변경하는 중...';
  try {
    if (typeof firebaseDB !== 'undefined' && currentUser.id) {
      await firebaseDB.ref('users_outfit/' + currentUser.id).set({ outfitMode: outfitMode });
    }
    currentUser.outfitMode = outfitMode;
    const oldPosition = player.position.clone();
    const oldRotation = player.rotation.clone();
    scene.remove(player);
    player = buildSoldierModel(currentUser.rankIndex || 18, true, currentUser.outfitMode);
    player.position.copy(oldPosition);
    player.rotation.copy(oldRotation);
    scene.add(player);
    if (firebaseListenersActive) sendFirebasePosition();
    status.textContent = '복장을 변경했습니다.';
    setTimeout(closeOutfitSelector, 500);
  } catch (e) {
    console.error('Outfit change failed:', e);
    status.textContent = '복장 변경 중 오류가 발생했습니다.';
  }
}

// ==================== CHAT ====================
function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;

  if (msg === '/복장') {
    if (!currentUser || currentUser.nickname !== '이주람') {
      appendSystem('[알림] 복장 변경은 대장 이주람만 사용할 수 있습니다.');
    } else {
      openOutfitSelector();
    }
    input.value = '';
    return;
  } else if (msg.startsWith('/') && socket && socket.connected) {
    socket.emit('chat', { message: msg });
  } else if (msg.startsWith('/')) {
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message: msg })
    }).then(async res => {
      const data = await res.json();
      if (!res.ok) appendSystem(data.error || '[오류] 명령어 처리 실패');
      else if (data.openOutfitSelector) openOutfitSelector();
    }).catch(() => appendSystem('[오류] 명령어 전송 실패'));
  } else if (typeof firebaseDB !== 'undefined') {
    firebaseDB.ref('chat_messages').push().set({
      nickname: currentUser.nickname,
      rank: currentUser.rank,
      message: msg,
      isAdmin: currentUser.isAdmin || false,
      sent_at: firebase.database.ServerValue.TIMESTAMP
    });
  } else {
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message: msg })
    }).catch(() => appendSystem('[오류] 메시지 전송 실패'));
  }
  input.value = '';
}

document.addEventListener('DOMContentLoaded', () => {
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } e.stopPropagation(); });
    chatInput.addEventListener('keyup', (e) => e.stopPropagation());
  }
});

function appendChat(data) {
  const el = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg' + (data.isJailed ? ' jailed' : '') + (data.isAdmin ? ' admin-msg' : '');
  div.innerHTML = `<span class="rank">[${escapeHtml(data.rank)}]</span> <span class="nick">${escapeHtml(data.nickname)}</span>: ${escapeHtml(data.message)}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function appendSystem(msg) {
  const el = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.innerHTML = `[시스템] ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

function renderOnlineUsers(users) {
  const el = document.getElementById('online-users');
  el.innerHTML = users.map(u => `<div class="user-item"><span class="dot"></span><span>${escapeHtml(u.nickname)}</span></div>`).join('');
  const countEl = document.getElementById('online-count');
  if (countEl) countEl.textContent = users.length;
}

function toggleOnline() {
  const el = document.getElementById('online-users');
  el.style.display = el.style.display === 'none' ? '' : 'none';
}

// ==================== JAIL ====================
let jailTimer = null;
function showJailOverlay(prison) {
  document.getElementById('jail-overlay').classList.add('active');
  document.getElementById('jail-info').classList.add('active');
  if (prison.reason) document.getElementById('jail-reason').textContent = prison.reason;
  updateJailTimer(prison.releaseAt);
  if (player) {
    player.position.set(60, 0, -50);
    if (firebaseListenersActive) sendFirebasePosition();
  }
}
function hideJailOverlay() {
  document.getElementById('jail-overlay').classList.remove('active');
  document.getElementById('jail-info').classList.remove('active');
  if (jailTimer) { clearInterval(jailTimer); jailTimer = null; }
  if (player) {
    player.position.set(0, 0, 5);
    if (firebaseListenersActive) sendFirebasePosition();
  }
}
function updateJailTimer(releaseAt) {
  const timerEl = document.getElementById('jail-timer');
  if (jailTimer) clearInterval(jailTimer);
  jailTimer = setInterval(() => {
    const remain = new Date(releaseAt).getTime() - Date.now();
    if (remain <= 0) { timerEl.textContent = '석방 처리 중...'; clearInterval(jailTimer); return; }
    const min = Math.floor(remain / 60000);
    const sec = Math.floor((remain % 60000) / 1000);
    timerEl.textContent = `${min}분 ${sec}초`;
  }, 1000);
}

// ==================== RANK INFO ====================
function openExamModal() {
  const modal = document.getElementById('exam-modal');
  modal.classList.add('active');
  const tier = getRankTier(currentUser.rankIndex);
  const tierName = { soldier: '병사', nco: '부사관', officer: '장교', general: '장성' }[tier];
  const nextIdx = currentUser.rankIndex + 1;
  const nextRank = nextIdx <= 18 ? RANKS[nextIdx] : null;
  let html = `<div style="text-align:center;padding:20px 0;">
    <h3 style="color:var(--text-yellow);margin-bottom:16px;">내 계급 정보</h3>
    <p style="font-size:18px;margin:8px 0;">현재 계급: <strong style="color:var(--text-yellow);font-size:22px;">${currentUser.rank}</strong></p>
    <p style="margin:8px 0;">분류: ${tierName}</p>
    <p style="margin:8px 0;">소속: ${currentUser.affiliation}</p>`;
  if (nextRank) {
    html += `<p style="margin:16px 0;color:var(--gray-light);">다음 계급: ${nextRank}</p>
    <p style="font-size:13px;color:var(--gray-light);">승급은 관리자의 심사를 통해 이루어집니다.</p>`;
  } else {
    html += `<p style="margin:16px 0;color:var(--text-yellow);">최고 계급에 도달하였습니다!</p>`;
  }
  html += `</div>`;
  document.getElementById('exam-info').style.display = '';
  document.getElementById('exam-info').innerHTML = html;
  if (document.getElementById('exam-result')) document.getElementById('exam-result').style.display = 'none';
}

function closeExamModal() { document.getElementById('exam-modal').classList.remove('active'); }

// ==================== ADMIN ====================
function openAdminPanel() {
  if (!currentUser.isAdmin) return;
  document.getElementById('admin-modal').classList.add('active');
  loadAdminTab('users');
}
function closeAdminPanel() { document.getElementById('admin-modal').classList.remove('active'); }

function adminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  if (event && event.target) event.target.classList.add('active');
  loadAdminTab(tab);
}

async function loadAdminTab(tab) {
  const content = document.getElementById('admin-content');
  content.innerHTML = '<p style="text-align:center;padding:20px;">로딩 중...</p>';
  try {
    if (tab === 'users') {
      const res = await fetch('/api/admin/users');
      const users = await res.json();
      content.innerHTML = `<table class="admin-table">
        <tr><th>닉네임</th><th>아이디</th><th>계급</th><th>보직</th><th>소속</th><th>관리자</th><th>액션</th></tr>
        ${users.map(u => `<tr>
          <td>${escapeHtml(u.nickname)}</td><td>${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.rank)}</td><td>${escapeHtml(u.position || '없음')}</td>
          <td>${u.affiliation}</td><td>${u.is_admin ? '예' : '아니오'}</td>
          <td style="white-space:nowrap;">
            ${u.rank_index < 18 ? `<button class="promote-btn" onclick="promoteUser('${u.id}','${escapeHtml(u.nickname)}')">승급</button>` : ''}
            ${u.rank_index > 0 && !u.is_admin ? `<button class="promote-btn" style="background:var(--warning)" onclick="demoteUser('${u.id}','${escapeHtml(u.nickname)}')">강등</button>` : ''}
            ${!u.is_admin ? `<button class="promote-btn" style="background:var(--danger)" onclick="jailUser('${u.id}','${escapeHtml(u.nickname)}')">수감</button>` : ''}
            ${!u.is_admin ? `<button class="promote-btn" style="background:#555" onclick="setPosition('${u.id}','${escapeHtml(u.nickname)}')">보직</button>` : ''}
          </td></tr>`).join('')}
      </table>`;
    } else if (tab === 'prison') {
      const res = await fetch('/api/admin/prison');
      const records = await res.json();
      content.innerHTML = `<table class="admin-table">
        <tr><th>수감자</th><th>사유</th><th>처리자</th><th>시작</th><th>석방예정</th><th>상태</th><th>액션</th></tr>
        ${records.map(r => `<tr>
          <td>${escapeHtml(r.nickname || '')}</td><td>${escapeHtml(r.reason || '')}</td>
          <td>${escapeHtml(r.jailer_name || '')}</td>
          <td>${new Date(r.started_at).toLocaleString('ko')}</td>
          <td>${new Date(r.release_at).toLocaleString('ko')}</td>
          <td>${r.released ? '석방됨' : '수감 중'}</td>
          <td>${!r.released ? `<button class="promote-btn" onclick="releaseUser('${r.user_id}','${escapeHtml(r.nickname)}')">석방</button>` : '-'}</td>
        </tr>`).join('')}
      </table>`;
    } else if (tab === 'promotions') {
      const res = await fetch('/api/admin/promotions');
      const records = await res.json();
      content.innerHTML = `<table class="admin-table">
        <tr><th>대상</th><th>유형</th><th>이전</th><th>변경</th><th>사유</th><th>처리자</th><th>일시</th></tr>
        ${records.map(r => `<tr>
          <td>${escapeHtml(r.nickname || '')}</td>
          <td style="color:${r.type === 'promote' ? 'var(--success)' : 'var(--danger)'}">${r.type === 'promote' ? '승급' : '강등'}</td>
          <td>${escapeHtml(r.prev_rank || '')}</td><td>${escapeHtml(r.new_rank || '')}</td>
          <td>${escapeHtml(r.reason || '')}</td><td>${escapeHtml(r.promoter_nickname || '')}</td>
          <td>${r.promoted_at ? new Date(r.promoted_at).toLocaleString('ko') : ''}</td>
        </tr>`).join('')}
      </table>`;
    } else if (tab === 'logs') {
      const res = await fetch('/api/admin/logs');
      const logs = await res.json();
      content.innerHTML = `<table class="admin-table">
        <tr><th>닉네임</th><th>명령어</th><th>일시</th></tr>
        ${logs.map(l => `<tr>
          <td>${escapeHtml(l.nickname || '')}</td><td>${escapeHtml(l.command)}</td>
          <td>${new Date(l.logged_at).toLocaleString('ko')}</td>
        </tr>`).join('')}
      </table>`;
    } else if (tab === 'commands') {
      content.innerHTML = buildCommandsHTML();
    }
  } catch (e) {
    content.innerHTML = '<p style="color:var(--danger);text-align:center;">데이터 로딩 오류</p>';
  }
}

function buildCommandsHTML() {
  const s = (title, rows) => {
    let h = `<h3 style="color:#c8a84e;margin:12px 0 6px;">[ ${title} ]</h3><table class="admin-table"><tr><th>명령어</th><th>설명</th><th>사용법</th></tr>`;
    rows.forEach(r => { h += `<tr><td${r[3] ? ' style="color:#c8a84e"' : ''}>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`; });
    h += '</table>';
    return h;
  };
  return `<div style="max-height:500px;overflow-y:auto;padding-right:8px;">
    ${s('관리자 전용',[
      ['/승급','유저 승급','/승급 닉네임 [사유]',1],['/강등','유저 강등','/강등 닉네임 [사유]',1],
      ['/수감','영창 수감','/수감 닉네임 시간(분) 사유',1],['/석방','즉시 석방','/석방 닉네임',1],
      ['/공지','전체 공지','/공지 메시지',1],['/admin dashboard','관리자 대시보드','/admin dashboard',1],
      ['/admin players','플레이어 관리','/admin players',1],['/admin ranks','계급 관리','/admin ranks',1],
      ['/admin permissions','권한 설정','/admin permissions',1],['/admin audit','감사 기록','/admin audit',1],
    ])}
    ${s('기본 명령어',[
      ['/help','도움말','/help [명령어]'],['/도움말','명령어 목록','/도움말'],['/commands','사용 가능 명령어','/commands'],
      ['/me','내 정보','/me'],['/rank','계급 정보','/rank'],['/계급','내 계급','/계급'],
      ['/profile','프로필/경력','/profile'],['/unit','소속 부대','/unit'],['/status','상태 확인','/status'],
      ['/mission','임무 목록','/mission'],['/training','훈련 현황','/training'],['/inventory','장비 목록','/inventory'],
      ['/schedule','일과표','/schedule'],['/notifications','알림','/notifications'],['/history','기록 조회','/history'],
      ['/접속자','접속자 목록','/접속자'],['/위치','위치 확인','/위치'],['/clear','채팅 정리','/clear'],
    ])}
    ${s('군 생활 신청',[
      ['/request equipment','장비 지급 요청','/request equipment'],['/request medical','진료 요청','/request medical'],
      ['/request training','훈련 신청','/request training'],['/request position','보직 지원','/request position'],
    ])}
    ${s('계급/진급',[
      ['/rank list','전체 계급','/rank list'],['/rank requirements','진급 조건','/rank requirements'],
      ['/rank status','심사 상태','/rank status'],['/rank history','진급 기록','/rank history'],['/career','군 경력','/career'],
    ])}
    ${s('지휘관',[
      ['/command status','부대 상태','/command status'],['/command roster','인원 현황','/command roster'],
      ['/command mission create','임무 작성','/command mission create'],['/command briefing','브리핑','/command briefing'],
      ['/command report','보고서','/command report'],['/command announcement','부대 공지','/command announcement'],
    ])}
    ${s('교육사령부',[
      ['/training command courses','교육 과정','/training command courses'],['/training command students','교육생','/training command students'],
      ['/training command schedule','교육 일정','/training command schedule'],['/training command report','교육 보고서','/training command report'],
    ])}
    ${s('군사경찰(MP)',[
      ['/mp status','근무 상태','/mp status'],['/mp duty','근무 일정','/mp duty'],
      ['/mp case create','사건 작성','/mp case create'],['/mp case search','사건 검색','/mp case search [사건ID]'],
      ['/mp duty report','근무 보고','/mp duty report'],
    ])}
    ${s('군수사령부',[
      ['/logistics inventory','보급품 재고','/logistics inventory'],['/logistics equipment','장비 현황','/logistics equipment'],
      ['/logistics request','보급 요청','/logistics request'],['/logistics vehicle','차량 현황','/logistics vehicle'],
    ])}
    ${s('인사/참모',[
      ['/personnel profile','인사 조회','/personnel profile [ID]'],['/personnel assignment','보직 현황','/personnel assignment'],
      ['/personnel promotion review','진급 심사','/personnel promotion review [ID]'],['/personnel record','인사 기록','/personnel record'],
    ])}
    ${s('사령부 지휘',[
      ['/hq status','사령부 현황','/hq status'],['/hq units','예하 부대','/hq units'],
      ['/hq personnel','인원 현황','/hq personnel'],['/hq reports','보고서','/hq reports'],
      ['/hq directive create','지시 작성','/hq directive create'],['/hq audit','감사 기록','/hq audit'],
    ])}
  </div>`;
}

async function promoteUser(userId, nickname) {
  const reason = prompt(`${nickname}님을 승급시킵니다.\n승급 사유를 입력하세요:`, '승급 심사 통과');
  if (reason === null) return;
  try {
    const res = await fetch(`/api/admin/promote/${userId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
    const data = await res.json();
    if (res.ok) { alert(`${data.nickname}님이 ${data.prevRank} → ${data.newRank}(으)로 승급되었습니다.`); loadAdminTab('users'); }
    else alert(data.error);
  } catch (e) { alert('승급 처리 오류'); }
}

async function demoteUser(userId, nickname) {
  const reason = prompt(`${nickname}님을 강등시킵니다.\n강등 사유를 입력하세요:`, '규정 위반');
  if (reason === null) return;
  try {
    const res = await fetch(`/api/admin/demote/${userId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
    const data = await res.json();
    if (res.ok) { alert(`${data.nickname}님이 ${data.prevRank} → ${data.newRank}(으)로 강등되었습니다.`); loadAdminTab('users'); }
    else alert(data.error);
  } catch (e) { alert('강등 처리 오류'); }
}

async function jailUser(userId, nickname) {
  const reason = prompt(`${nickname}님을 수감합니다.\n수감 사유를 입력하세요:`, '규정 위반');
  if (reason === null) return;
  const minutes = parseInt(prompt('수감 시간(분):', '10'));
  if (isNaN(minutes) || minutes <= 0) return;
  try {
    const res = await fetch(`/api/admin/jail/${userId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, minutes }) });
    const data = await res.json();
    if (res.ok) { alert(`${data.nickname}님이 ${data.minutes}분간 수감되었습니다.`); loadAdminTab('users'); }
    else alert(data.error);
  } catch (e) { alert('수감 처리 오류'); }
}

async function releaseUser(userId, nickname) {
  if (!confirm(`${nickname}님을 즉시 석방하시겠습니까?`)) return;
  try {
    const res = await fetch(`/api/admin/release/${userId}`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) { alert(`${data.nickname}님이 석방되었습니다.`); loadAdminTab('prison'); }
    else alert(data.error);
  } catch (e) { alert('석방 처리 오류'); }
}

async function setPosition(userId, nickname) {
  const pos = prompt(`${nickname}님의 보직을 설정합니다.\n보직명을 입력하세요:`, '');
  if (pos === null) return;
  try {
    const res = await fetch(`/api/admin/set-position/${userId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: pos }) });
    const data = await res.json();
    if (res.ok) { alert(`${data.nickname}님의 보직이 "${pos}"(으)로 설정되었습니다.`); loadAdminTab('users'); }
    else alert(data.error);
  } catch (e) { alert('보직 설정 오류'); }
}

// ==================== 3D GAME WORLD ====================
let scene, camera, renderer, player;
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false;
let isJumping = false, velocityY = 0;
let yaw = 0, pitch = 0;
let isPointerLocked = false;
const playerSpeed = 0.15;
const gravity = -0.01;
const jumpForce = 0.2;
const otherPlayers = {};
let buildings = [];
let insideBuilding = null;
let buildingGroups = {};
let minimapCtx;
let compassCtx;
let playerHeight = 1.7;
let walkCycle = 0;

// 30 buildings
const LOCATIONS = [
  { id: 1, name: '부대 정문', x: 0, z: -120, w: 16, d: 6, h: 5, color: 0x5a6e4a, type: 'gate' },
  { id: 2, name: '사령부', x: 0, z: 0, w: 22, d: 18, h: 10, color: 0x4a5c3e, type: 'hq' },
  { id: 3, name: '생활관', x: 40, z: 10, w: 24, d: 14, h: 7, color: 0x6b7d5e, type: 'barracks' },
  { id: 4, name: '연병장', x: 0, z: 50, w: 50, d: 40, h: 0.1, color: 0x8b7355, type: 'field' },
  { id: 5, name: '종합 훈련장', x: -50, z: 50, w: 30, d: 20, h: 4, color: 0x5e6e4e, type: 'training' },
  { id: 6, name: '행정실', x: 25, z: -15, w: 14, d: 10, h: 5, color: 0x5a6a4e, type: 'admin_office' },
  { id: 7, name: '영창', x: 60, z: -50, w: 14, d: 12, h: 4, color: 0x8b4513, type: 'prison' },
  { id: 8, name: '군사경찰실', x: 40, z: -50, w: 12, d: 10, h: 5, color: 0x5e5e5e, type: 'mp' },
  { id: 9, name: '보안통제실', x: 15, z: -50, w: 10, d: 8, h: 4, color: 0x4e5e3e, type: 'security' },
  { id: 10, name: '작전회의실', x: -25, z: -15, w: 14, d: 10, h: 5, color: 0x4a5c3e, type: 'briefing' },
  { id: 11, name: '식당', x: 40, z: 35, w: 18, d: 14, h: 5, color: 0x6e7d5e, type: 'mess_hall' },
  { id: 12, name: '의무실', x: -40, z: 10, w: 14, d: 10, h: 4, color: 0xffffff, type: 'medical' },
  { id: 13, name: '장비실', x: -40, z: -15, w: 14, d: 12, h: 5, color: 0x5a5a4e, type: 'equipment' },
  { id: 14, name: '교육관', x: -40, z: 35, w: 16, d: 12, h: 6, color: 0x5a6a4e, type: 'education' },
  { id: 15, name: '차량 정비고', x: 70, z: 20, w: 20, d: 14, h: 6, color: 0x5e5e5e, type: 'garage' },
  { id: 16, name: '통신실', x: -25, z: -40, w: 10, d: 8, h: 5, color: 0x4e6e3e, type: 'comm' },
  { id: 17, name: '사격 훈련장', x: 70, z: -30, w: 30, d: 16, h: 3, color: 0x5e5e5e, type: 'range' },
  { id: 18, name: '경계 초소', x: -90, z: -80, w: 6, d: 6, h: 5, color: 0x6b7d5e, type: 'guard' },
  { id: 19, name: '보급창고', x: 70, z: 50, w: 22, d: 16, h: 6, color: 0x6a6a5a, type: 'supply' },
  { id: 20, name: '행사장', x: -50, z: 80, w: 24, d: 18, h: 6, color: 0x5a6e4a, type: 'event' },
  { id: 21, name: '모집소', x: 20, z: -90, w: 12, d: 8, h: 4, color: 0x6b7d5e, type: 'recruit' },
  { id: 22, name: '사관학교', x: -70, z: 10, w: 18, d: 14, h: 7, color: 0x3d5030, type: 'academy' },
  { id: 23, name: '기록보관실', x: -70, z: -20, w: 12, d: 10, h: 4, color: 0x5a5a4e, type: 'archive' },
  { id: 24, name: '종합상황실', x: 0, z: -25, w: 14, d: 10, h: 5, color: 0x3e4e2e, type: 'situation' },
  { id: 25, name: '지휘관 집무실', x: -15, z: 15, w: 10, d: 8, h: 5, color: 0x2a3a1e, type: 'commander' },
  { id: 26, name: '인사과', x: 15, z: 15, w: 10, d: 8, h: 5, color: 0x5a6a4e, type: 'personnel' },
  { id: 27, name: '면접실', x: -20, z: -70, w: 10, d: 8, h: 4, color: 0x5a6e4a, type: 'interview' },
  { id: 28, name: '간부회의실', x: 20, z: -70, w: 12, d: 10, h: 5, color: 0x4a5c3e, type: 'officer_room' },
  { id: 29, name: '표창실', x: -70, z: -50, w: 10, d: 8, h: 4, color: 0xc8a84e, type: 'award' },
  { id: 30, name: '휴게실', x: -70, z: 40, w: 14, d: 10, h: 4, color: 0x6a5a4e, type: 'lounge' },
  { id: 31, name: '관리자 벙커', x: 0, z: -10, w: 12, d: 10, h: 2, color: 0x1a1a1a, type: 'admin_bunker', underground: true },
];

// Building interaction
let currentBuilding = null;
let interactionModal = null;

let baseModel = null;

function initGameWorld() {
  if (renderer) return;
  const container = document.getElementById('game-canvas');
  const canvas = document.createElement('canvas');
  container.innerHTML = '';
  container.appendChild(canvas);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87CEEB);
  scene.fog = new THREE.Fog(0x87CEEB, 150, 400);

  camera = new THREE.PerspectiveCamera(70, container.clientWidth / container.clientHeight, 0.1, 500);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(50, 80, 30);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 0.5;
  dirLight.shadow.camera.far = 300;
  dirLight.shadow.camera.left = -150;
  dirLight.shadow.camera.right = 150;
  dirLight.shadow.camera.top = 150;
  dirLight.shadow.camera.bottom = -150;
  scene.add(dirLight);

  createGround();
  createBuildings();
  createTrees();
  createFences();
  createPlayer();
  initInventory();
  loadBaseModel();
  loadPrisonModel();

  camera.position.set(0, playerHeight, 5);
  minimapCtx = document.getElementById('minimap-canvas').getContext('2d');
  compassCtx = document.getElementById('compass-canvas').getContext('2d');

  container.addEventListener('click', () => container.requestPointerLock());
  document.addEventListener('pointerlockchange', () => { isPointerLocked = document.pointerLockElement === container; });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', onResize);
  onResize();
  animate();
}

function createGround() {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshPhongMaterial({ color: 0x4a7a3a }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const roadMat = new THREE.MeshPhongMaterial({ color: 0x444444 });
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xeeee44 });
  const sidelineMat = new THREE.MeshBasicMaterial({ color: 0xcccccc });

  // Main roads
  const roads = [
    { x: 0, z: 0, w: 5, d: 300 },
    { x: 0, z: 0, w: 300, d: 5 },
    { x: 0, z: -50, w: 160, d: 4 },
    { x: 50, z: 0, w: 4, d: 200 },
    { x: -50, z: 0, w: 4, d: 200 },
  ];
  roads.forEach(r => {
    const road = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.d), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(r.x, 0.01, r.z);
    scene.add(road);
  });

  for (let i = -140; i < 140; i += 6) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 3), dashMat);
    dash.rotation.x = -Math.PI / 2; dash.position.set(0, 0.015, i);
    scene.add(dash);
    const dashH = new THREE.Mesh(new THREE.PlaneGeometry(3, 0.15), dashMat);
    dashH.rotation.x = -Math.PI / 2; dashH.position.set(i, 0.015, 0);
    scene.add(dashH);
  }

  [-2.4, 2.4].forEach(offset => {
    const l1 = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 300), sidelineMat);
    l1.rotation.x = -Math.PI / 2; l1.position.set(offset, 0.015, 0);
    scene.add(l1);
    const l2 = new THREE.Mesh(new THREE.PlaneGeometry(300, 0.12), sidelineMat);
    l2.rotation.x = -Math.PI / 2; l2.position.set(0, 0.015, offset);
    scene.add(l2);
  });

  // Sidewalks
  const sidewalkMat = new THREE.MeshPhongMaterial({ color: 0x888888 });
  for (let x = -130; x <= 130; x += 20) {
    for (let z = -130; z <= 130; z += 20) {
      if (Math.abs(x) < 4 || Math.abs(z) < 4) continue;
      const sw = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), sidewalkMat);
      sw.rotation.x = -Math.PI / 2; sw.position.set(x, 0.012, z);
      scene.add(sw);
    }
  }
}

function createBuildings() {
  buildings = [];
  LOCATIONS.forEach(loc => {
    const group = new THREE.Group();
    if (loc.type === 'admin_bunker') {
      buildBunkerEntrance(group, loc);
    } else if (loc.type === 'prison') {
      // OBJ model loaded separately via loadPrisonModel()
    } else if (loc.h > 0.5) {
      buildStructure(group, loc);
    } else {
      buildOpenArea(group, loc);
    }
    group.position.set(loc.x, 0, loc.z);
    scene.add(group);
    buildings.push({
      name: loc.name, id: loc.id, type: loc.type,
      minX: loc.x - loc.w / 2, maxX: loc.x + loc.w / 2,
      minZ: loc.z - loc.d / 2, maxZ: loc.z + loc.d / 2,
      height: loc.h, cx: loc.x, cz: loc.z, w: loc.w, d: loc.d,
      enterable: loc.h > 0.5 && loc.type !== 'admin_bunker' && loc.type !== 'prison',
      doorMinX: loc.x - 1.2, doorMaxX: loc.x + 1.2,
      doorZ: loc.z + loc.d / 2
    });
  });
}

function buildBunkerEntrance(group, loc) {
  const darkMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a, shininess: 30 });
  const metalMat = new THREE.MeshPhongMaterial({ color: 0x3a3a3a, shininess: 60 });
  const redMat = new THREE.MeshPhongMaterial({ color: 0xaa2020, emissive: 0x440000 });
  // Concrete pad
  const pad = new THREE.Mesh(new THREE.BoxGeometry(loc.w, 0.15, loc.d), new THREE.MeshPhongMaterial({ color: 0x2a2a2a }));
  pad.position.y = 0.07;
  group.add(pad);
  // Blast door frame
  const frame = new THREE.Mesh(new THREE.BoxGeometry(3, 2.5, 0.3), metalMat);
  frame.position.set(0, 1.25, -loc.d / 2 + 0.15);
  group.add(frame);
  // Door (dark)
  const door = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.0, 0.15), darkMat);
  door.position.set(0, 1.1, -loc.d / 2 + 0.3);
  group.add(door);
  // Card reader (red light)
  const reader = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.08), metalMat);
  reader.position.set(1.5, 1.2, -loc.d / 2 + 0.2);
  group.add(reader);
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), redMat);
  light.position.set(1.5, 1.35, -loc.d / 2 + 0.15);
  group.add(light);
  // Warning stripes
  const stripeMat = new THREE.MeshPhongMaterial({ color: 0xddaa00 });
  for (let i = -1; i <= 1; i += 2) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.5, 0.02), stripeMat);
    stripe.position.set(i * 1.4, 1.25, -loc.d / 2 + 0.1);
    group.add(stripe);
  }
  // Ventilation pipes
  for (let i = -1; i <= 1; i += 2) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 1.5, 8), metalMat);
    pipe.position.set(i * 2.5, 0.75, 0);
    group.add(pipe);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 8), darkMat);
    cap.position.set(i * 2.5, 1.55, 0);
    group.add(cap);
  }
  // Sign
  const signCanvas = createTextCanvas('⚠ 관리자 전용', 256, 48);
  const signTex = new THREE.CanvasTexture(signCanvas);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.5), new THREE.MeshBasicMaterial({ map: signTex, transparent: true }));
  sign.position.set(0, 2.8, -loc.d / 2 + 0.1);
  group.add(sign);
  // Stairs going down
  const stairMat = new THREE.MeshPhongMaterial({ color: 0x333333 });
  for (let s = 0; s < 5; s++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.2, 0.5), stairMat);
    step.position.set(0, -s * 0.2 - 0.1, -loc.d / 2 + 0.8 + s * 0.5);
    group.add(step);
  }
}

function buildStructure(group, loc) {
  const wallColor = new THREE.Color(loc.color);
  const wallThick = 0.3;
  const wallMat = new THREE.MeshPhongMaterial({ color: loc.color, shininess: 10 });
  const wallMatInner = new THREE.MeshPhongMaterial({ color: 0xd8d0c0, shininess: 5 });
  const doorWidth = 2.4;
  const doorHeight = 3.0;

  const exteriorGroup = new THREE.Group();
  exteriorGroup.name = 'exterior';

  // Front wall (with door hole) - two segments on each side of door
  const frontLeftW = (loc.w - doorWidth) / 2;
  const frontLeftWall = new THREE.Mesh(new THREE.BoxGeometry(frontLeftW, loc.h, wallThick), wallMat);
  frontLeftWall.position.set(-loc.w / 2 + frontLeftW / 2, loc.h / 2, loc.d / 2);
  frontLeftWall.castShadow = true;
  exteriorGroup.add(frontLeftWall);
  const frontRightWall = new THREE.Mesh(new THREE.BoxGeometry(frontLeftW, loc.h, wallThick), wallMat);
  frontRightWall.position.set(loc.w / 2 - frontLeftW / 2, loc.h / 2, loc.d / 2);
  frontRightWall.castShadow = true;
  exteriorGroup.add(frontRightWall);
  // Above door
  const aboveDoor = new THREE.Mesh(new THREE.BoxGeometry(doorWidth, loc.h - doorHeight, wallThick), wallMat);
  aboveDoor.position.set(0, doorHeight + (loc.h - doorHeight) / 2, loc.d / 2);
  exteriorGroup.add(aboveDoor);

  // Back wall (solid)
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(loc.w, loc.h, wallThick), wallMat);
  backWall.position.set(0, loc.h / 2, -loc.d / 2);
  backWall.castShadow = true;
  exteriorGroup.add(backWall);

  // Left wall
  const leftWall = new THREE.Mesh(new THREE.BoxGeometry(wallThick, loc.h, loc.d), wallMat);
  leftWall.position.set(-loc.w / 2, loc.h / 2, 0);
  leftWall.castShadow = true;
  exteriorGroup.add(leftWall);

  // Right wall
  const rightWall = new THREE.Mesh(new THREE.BoxGeometry(wallThick, loc.h, loc.d), wallMat);
  rightWall.position.set(loc.w / 2, loc.h / 2, 0);
  rightWall.castShadow = true;
  exteriorGroup.add(rightWall);

  group.add(exteriorGroup);

  // Base
  const baseMat = new THREE.MeshPhongMaterial({ color: wallColor.clone().multiplyScalar(0.6) });
  const base = new THREE.Mesh(new THREE.BoxGeometry(loc.w + 0.4, 0.6, loc.d + 0.4), baseMat);
  base.position.y = 0.3; base.receiveShadow = true;
  group.add(base);

  // Floor (interior)
  const floorMat = new THREE.MeshPhongMaterial({ color: 0x8a8070, shininess: 20 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(loc.w - wallThick * 2, 0.1, loc.d - wallThick * 2), floorMat);
  floor.position.y = 0.05; floor.receiveShadow = true;
  group.add(floor);

  // Ceiling
  const ceilingMat = new THREE.MeshPhongMaterial({ color: 0xcccccc, side: THREE.DoubleSide });
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(loc.w - wallThick * 2, loc.d - wallThick * 2), ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = loc.h - 0.05;
  group.add(ceiling);

  // Inner walls (cream color, visible from inside)
  const innerFrontL = new THREE.Mesh(new THREE.BoxGeometry(frontLeftW, loc.h, 0.05), wallMatInner);
  innerFrontL.position.set(-loc.w / 2 + frontLeftW / 2, loc.h / 2, loc.d / 2 - wallThick / 2);
  group.add(innerFrontL);
  const innerFrontR = new THREE.Mesh(new THREE.BoxGeometry(frontLeftW, loc.h, 0.05), wallMatInner);
  innerFrontR.position.set(loc.w / 2 - frontLeftW / 2, loc.h / 2, loc.d / 2 - wallThick / 2);
  group.add(innerFrontR);
  const innerBack = new THREE.Mesh(new THREE.PlaneGeometry(loc.w, loc.h), wallMatInner);
  innerBack.position.set(0, loc.h / 2, -loc.d / 2 + wallThick / 2);
  group.add(innerBack);
  const innerLeft = new THREE.Mesh(new THREE.PlaneGeometry(loc.d, loc.h), wallMatInner);
  innerLeft.rotation.y = Math.PI / 2;
  innerLeft.position.set(-loc.w / 2 + wallThick / 2, loc.h / 2, 0);
  group.add(innerLeft);
  const innerRight = new THREE.Mesh(new THREE.PlaneGeometry(loc.d, loc.h), wallMatInner);
  innerRight.rotation.y = -Math.PI / 2;
  innerRight.position.set(loc.w / 2 - wallThick / 2, loc.h / 2, 0);
  group.add(innerRight);

  // Interior lighting
  const interiorLight = new THREE.PointLight(0xffe8c0, 0.8, loc.w * 1.5);
  interiorLight.position.set(0, loc.h - 0.5, 0);
  group.add(interiorLight);
  // Light fixture mesh
  const fixtureMat = new THREE.MeshPhongMaterial({ color: 0xffffff, emissive: 0xffe8c0, emissiveIntensity: 0.5 });
  const fixture = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.4), fixtureMat);
  fixture.position.set(0, loc.h - 0.15, 0);
  group.add(fixture);
  if (loc.w > 14) {
    const light2 = new THREE.PointLight(0xffe8c0, 0.5, loc.w);
    light2.position.set(-loc.w / 4, loc.h - 0.5, 0);
    group.add(light2);
    const fix2 = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.4), fixtureMat);
    fix2.position.set(-loc.w / 4, loc.h - 0.15, 0);
    group.add(fix2);
    const light3 = new THREE.PointLight(0xffe8c0, 0.5, loc.w);
    light3.position.set(loc.w / 4, loc.h - 0.5, 0);
    group.add(light3);
    const fix3 = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.4), fixtureMat);
    fix3.position.set(loc.w / 4, loc.h - 0.15, 0);
    group.add(fix3);
  }

  // Windows (exterior only)
  const winMat = new THREE.MeshPhongMaterial({ color: 0xa0c8e8, emissive: 0x203040, shininess: 80, transparent: true, opacity: 0.85 });
  const winFrameMat = new THREE.MeshPhongMaterial({ color: 0x3a3a3a });
  const winW = 1.4, winH = 1.6;
  const floors = Math.floor((loc.h - 1) / 3);
  for (let fl = 0; fl < Math.max(1, floors); fl++) {
    const wy = 2.5 + fl * 3;
    if (wy + winH / 2 > loc.h - 0.3) continue;
    const cols = Math.max(1, Math.floor(loc.w / 4));
    const spacing = loc.w / (cols + 1);
    for (let c = 0; c < cols; c++) {
      const wx = -loc.w / 2 + spacing * (c + 1);
      [loc.d / 2 + 0.16, -loc.d / 2 - 0.16].forEach((wz, i) => {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH), winMat);
        win.position.set(wx, wy, wz);
        if (i === 1) win.rotation.y = Math.PI;
        exteriorGroup.add(win);
        const fr = new THREE.Mesh(new THREE.BoxGeometry(winW + 0.2, winH + 0.2, 0.08), winFrameMat);
        fr.position.set(wx, wy, wz - 0.02 * (i === 0 ? 1 : -1));
        exteriorGroup.add(fr);
      });
    }
  }

  // Roof
  const roofMat = new THREE.MeshPhongMaterial({ color: 0x3a2a1a, shininess: 5 });
  if (loc.type === 'hq') {
    const flatRoof = new THREE.Mesh(new THREE.BoxGeometry(loc.w + 1.6, 0.4, loc.d + 1.6), roofMat);
    flatRoof.position.y = loc.h + 0.2; flatRoof.castShadow = true;
    exteriorGroup.add(flatRoof);
    const edgeMat = new THREE.MeshPhongMaterial({ color: 0x4a3a2a });
    const edgeGeo = new THREE.BoxGeometry(loc.w + 1.8, 0.5, 0.3);
    [-(loc.d / 2 + 0.8), loc.d / 2 + 0.8].forEach(z => {
      const e = new THREE.Mesh(edgeGeo, edgeMat); e.position.set(0, loc.h + 0.55, z); exteriorGroup.add(e);
    });
    const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 6, 8), new THREE.MeshPhongMaterial({ color: 0x888888, shininess: 60 }));
    flagPole.position.set(0, loc.h + 3.3, 0);
    exteriorGroup.add(flagPole);
    const flagCanvas = document.createElement('canvas');
    flagCanvas.width = 128; flagCanvas.height = 84;
    const fctx = flagCanvas.getContext('2d');
    fctx.fillStyle = '#ffffff'; fctx.fillRect(0, 0, 128, 84);
    fctx.fillStyle = '#cd313a'; fctx.beginPath(); fctx.arc(64, 42, 24, 0, Math.PI, false); fctx.fill();
    fctx.fillStyle = '#003478'; fctx.beginPath(); fctx.arc(64, 42, 24, Math.PI, Math.PI * 2, false); fctx.fill();
    const flagMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 1.3), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(flagCanvas), side: THREE.DoubleSide }));
    flagMesh.position.set(1.1, loc.h + 5.8, 0);
    exteriorGroup.add(flagMesh);
  } else {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(loc.w + 1, 0.4, loc.d + 1), roofMat);
    roof.position.y = loc.h + 0.2; roof.castShadow = true;
    exteriorGroup.add(roof);
  }

  // Door frame and steps (always visible)
  const doorFrameMat = new THREE.MeshPhongMaterial({ color: 0x2a1a0a });
  const doorMat = new THREE.MeshPhongMaterial({ color: 0x6B3513 });
  const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(doorWidth + 0.4, doorHeight + 0.2, wallThick + 0.1), doorFrameMat);
  doorFrame.position.set(0, doorHeight / 2 + 0.1, loc.d / 2);
  group.add(doorFrame);

  const stepMat = new THREE.MeshPhongMaterial({ color: 0x777777 });
  const step1 = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 1), stepMat);
  step1.position.set(0, 0.1, loc.d / 2 + 0.8); step1.receiveShadow = true;
  group.add(step1);

  const awning = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.12, 1.5), new THREE.MeshPhongMaterial({ color: 0x4a5c3e }));
  awning.position.set(0, 3.3, loc.d / 2 + 0.75); awning.castShadow = true;
  group.add(awning);

  // Interior furniture
  addInteriorFurniture(group, loc);

  // Building-specific details
  addBuildingDetails(group, loc);

  // Sign
  const signCanvas = createTextCanvas(loc.name, 256, 64);
  const signTex = new THREE.CanvasTexture(signCanvas);
  const signGeo = new THREE.PlaneGeometry(5, 1.2);
  const signMat2 = new THREE.MeshBasicMaterial({ map: signTex, transparent: true });
  const sign = new THREE.Mesh(signGeo, signMat2);
  sign.position.set(0, loc.h + 2, loc.d / 2 + 0.2);
  exteriorGroup.add(sign);
  const signBack = new THREE.Mesh(signGeo, signMat2);
  signBack.position.set(0, loc.h + 2, -loc.d / 2 - 0.2);
  signBack.rotation.y = Math.PI;
  exteriorGroup.add(signBack);

  buildingGroups[loc.id] = { exterior: exteriorGroup, group: group };
}

function addInteriorFurniture(group, loc) {
  const deskMat = new THREE.MeshPhongMaterial({ color: 0x8B6914, shininess: 30 });
  const chairMat = new THREE.MeshPhongMaterial({ color: 0x2a2a2a });
  const metalMat = new THREE.MeshPhongMaterial({ color: 0x888888, shininess: 60 });
  const iw = loc.w / 2 - 1;
  const id = loc.d / 2 - 1;

  switch (loc.type) {
    case 'hq': case 'admin_office': case 'briefing': case 'situation':
    case 'commander': case 'personnel': case 'officer_room': case 'comm': {
      // Desks in rows
      const rows = Math.max(1, Math.floor(loc.d / 5));
      const cols = Math.max(1, Math.floor(loc.w / 5));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const dx = -iw + 1.5 + c * (loc.w - 3) / Math.max(1, cols - 1 || 1);
          const dz = -id + 1 + r * (loc.d - 4) / Math.max(1, rows);
          // Desk
          const desk = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 1.0), deskMat);
          desk.position.set(dx, 0.75, dz);
          group.add(desk);
          // Desk legs
          [[-0.8, -0.4], [0.8, -0.4], [-0.8, 0.4], [0.8, 0.4]].forEach(([lx, lz]) => {
            const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.75, 0.06), metalMat);
            leg.position.set(dx + lx, 0.375, dz + lz);
            group.add(leg);
          });
          // Chair
          const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), chairMat);
          seat.position.set(dx, 0.45, dz + 0.8);
          group.add(seat);
          const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.06), chairMat);
          back.position.set(dx, 0.7, dz + 1.05);
          group.add(back);
          // Monitor on desk
          const screen = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.04), new THREE.MeshPhongMaterial({ color: 0x111111, emissive: 0x1a3a5a, emissiveIntensity: 0.3 }));
          screen.position.set(dx, 1.0, dz - 0.2);
          group.add(screen);
        }
      }
      // Whiteboard on back wall
      const wb = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(loc.w - 2, 4), 1.5), new THREE.MeshPhongMaterial({ color: 0xf0f0f0 }));
      wb.position.set(0, 2.5, -id + 0.2);
      group.add(wb);
      break;
    }
    case 'barracks': {
      // Bunk beds
      const bedMat = new THREE.MeshPhongMaterial({ color: 0x3a5030 });
      const frameMat = new THREE.MeshPhongMaterial({ color: 0x666666 });
      const bunks = Math.max(2, Math.floor(loc.w / 4));
      for (let i = 0; i < bunks; i++) {
        const bx = -iw + 1.5 + i * (loc.w - 3) / (bunks);
        [-1, 1].forEach(side => {
          const bz = side * (id - 1.2);
          // Frame
          const frame = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.4, 0.06), frameMat);
          frame.position.set(bx, 1.2, bz);
          group.add(frame);
          // Bottom bed
          const bed1 = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 2.0), bedMat);
          bed1.position.set(bx, 0.5, bz - side * 0.5);
          group.add(bed1);
          // Top bed
          const bed2 = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 2.0), bedMat);
          bed2.position.set(bx, 1.8, bz - side * 0.5);
          group.add(bed2);
          // Pillow
          const pillowMat = new THREE.MeshPhongMaterial({ color: 0xeeeeee });
          const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.3), pillowMat);
          p1.position.set(bx, 0.62, bz);
          group.add(p1);
        });
      }
      // Lockers along back wall
      const lockerMat = new THREE.MeshPhongMaterial({ color: 0x4a6040 });
      for (let i = 0; i < Math.floor(loc.w / 1.5); i++) {
        const lk = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.8, 0.5), lockerMat);
        lk.position.set(-iw + 0.5 + i * 1.2, 0.9, -id + 0.4);
        group.add(lk);
      }
      break;
    }
    case 'mess_hall': {
      // Long tables with benches
      const tableMat = new THREE.MeshPhongMaterial({ color: 0xb0a080 });
      const benchMat = new THREE.MeshPhongMaterial({ color: 0x8a6a3a });
      const tables = Math.max(2, Math.floor(loc.d / 4));
      for (let t = 0; t < tables; t++) {
        const tz = -id + 2 + t * (loc.d - 4) / tables;
        const table = new THREE.Mesh(new THREE.BoxGeometry(loc.w - 4, 0.08, 1.0), tableMat);
        table.position.set(0, 0.75, tz);
        group.add(table);
        [[-0.7], [0.7]].forEach(([bz]) => {
          const bench = new THREE.Mesh(new THREE.BoxGeometry(loc.w - 4, 0.06, 0.3), benchMat);
          bench.position.set(0, 0.4, tz + bz);
          group.add(bench);
        });
      }
      // Serving counter at back
      const counter = new THREE.Mesh(new THREE.BoxGeometry(loc.w - 2, 1.0, 0.8), metalMat);
      counter.position.set(0, 0.5, -id + 0.8);
      group.add(counter);
      break;
    }
    case 'medical': {
      // Medical beds
      const bedMat = new THREE.MeshPhongMaterial({ color: 0xffffff });
      for (let i = 0; i < 3; i++) {
        const bx = -iw + 2 + i * 4;
        if (bx > iw - 1) break;
        const bed = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.2), bedMat);
        bed.position.set(bx, 0.25, id - 1.5);
        group.add(bed);
        // IV stand
        const iv = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.8, 6), metalMat);
        iv.position.set(bx + 0.9, 1.4, id - 1.5);
        group.add(iv);
      }
      // Medicine cabinet
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2, 1.5, 0.4), new THREE.MeshPhongMaterial({ color: 0xeeeeee }));
      cab.position.set(0, 1.5, -id + 0.4);
      group.add(cab);
      break;
    }
    case 'equipment': case 'supply': {
      // Shelving racks
      const shelfMat = new THREE.MeshPhongMaterial({ color: 0x606060 });
      for (let r = 0; r < 3; r++) {
        const rz = -id + 1.5 + r * 3;
        if (rz > id - 1) break;
        const shelf = new THREE.Mesh(new THREE.BoxGeometry(loc.w - 3, 2.5, 0.8), shelfMat);
        shelf.position.set(0, 1.25, rz);
        group.add(shelf);
        // Shelves inside
        for (let s = 0; s < 3; s++) {
          const sh = new THREE.Mesh(new THREE.BoxGeometry(loc.w - 3.2, 0.06, 0.7), metalMat);
          sh.position.set(0, 0.5 + s * 0.8, rz);
          group.add(sh);
        }
      }
      break;
    }
    case 'education': case 'training': {
      // Classroom desks facing front
      const rows2 = Math.max(2, Math.floor(loc.d / 3));
      const cols2 = Math.max(2, Math.floor(loc.w / 3));
      for (let r = 0; r < rows2; r++) {
        for (let c = 0; c < cols2; c++) {
          const dx = -iw + 1.5 + c * (loc.w - 3) / cols2;
          const dz = -id + 3 + r * 2.5;
          if (dz > id - 1) continue;
          const desk2 = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.6), deskMat);
          desk2.position.set(dx, 0.7, dz);
          group.add(desk2);
        }
      }
      // Podium
      const podium = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.0, 0.8), deskMat);
      podium.position.set(0, 0.5, -id + 1);
      group.add(podium);
      // Chalkboard
      const cb = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(loc.w - 2, 5), 2), new THREE.MeshPhongMaterial({ color: 0x2a4a2a }));
      cb.position.set(0, 2.5, -id + 0.2);
      group.add(cb);
      break;
    }
    case 'garage': {
      // Vehicle shapes
      const vehicleMat = new THREE.MeshPhongMaterial({ color: 0x4a5a3a });
      for (let i = 0; i < 2; i++) {
        const vx = -iw + 3 + i * 8;
        if (vx > iw - 2) break;
        // Body
        const body = new THREE.Mesh(new THREE.BoxGeometry(3, 1.5, 5), vehicleMat);
        body.position.set(vx, 0.75, 0);
        group.add(body);
        // Wheels
        const wheelMat = new THREE.MeshPhongMaterial({ color: 0x222222 });
        [[-1.2, -2], [-1.2, 2], [1.2, -2], [1.2, 2]].forEach(([wx, wz]) => {
          const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.3, 8), wheelMat);
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(vx + wx, 0.4, wz);
          group.add(wheel);
        });
      }
      break;
    }
    case 'lounge': {
      // Couches and tables
      const couchMat = new THREE.MeshPhongMaterial({ color: 0x5a4030 });
      // Couch L
      const couch1 = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 1.0), couchMat);
      couch1.position.set(-iw + 2, 0.4, id - 1);
      group.add(couch1);
      const couch1b = new THREE.Mesh(new THREE.BoxGeometry(3, 0.5, 0.15), couchMat);
      couch1b.position.set(-iw + 2, 0.9, id - 0.55);
      group.add(couch1b);
      // Couch R
      const couch2 = new THREE.Mesh(new THREE.BoxGeometry(3, 0.8, 1.0), couchMat);
      couch2.position.set(iw - 2, 0.4, id - 1);
      group.add(couch2);
      // Coffee table
      const ct = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.4, 0.8), deskMat);
      ct.position.set(0, 0.2, id - 1);
      group.add(ct);
      // Vending machine
      const vm = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.8, 0.6), new THREE.MeshPhongMaterial({ color: 0x2244aa }));
      vm.position.set(iw - 0.6, 0.9, -id + 0.6);
      group.add(vm);
      break;
    }
    case 'archive': {
      // Filing cabinets
      const cabinetMat = new THREE.MeshPhongMaterial({ color: 0x707070 });
      for (let i = 0; i < Math.floor(loc.w / 1.5); i++) {
        const cab2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.5, 0.5), cabinetMat);
        cab2.position.set(-iw + 0.6 + i * 1.3, 0.75, -id + 0.5);
        group.add(cab2);
      }
      // Reading desk
      const rd = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.08, 1.2), deskMat);
      rd.position.set(0, 0.75, 1);
      group.add(rd);
      break;
    }
    default: {
      // Generic: a desk and a chair
      const gd = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 1.0), deskMat);
      gd.position.set(0, 0.75, -id + 1.5);
      group.add(gd);
      const gs = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.5), chairMat);
      gs.position.set(0, 0.45, -id + 2.5);
      group.add(gs);
      break;
    }
  }
}

function addBuildingDetails(group, loc) {
  switch(loc.type) {
    case 'gate': {
      // Gate barrier
      const barrierPole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3, 8), new THREE.MeshPhongMaterial({ color: 0xcc0000 }));
      barrierPole.position.set(-6, 1.5, 0); group.add(barrierPole);
      const barrier = new THREE.Mesh(new THREE.BoxGeometry(8, 0.15, 0.15), new THREE.MeshPhongMaterial({ color: 0xff4444 }));
      barrier.position.set(-2, 2.8, 0); group.add(barrier);
      // Guard booth
      const booth = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), new THREE.MeshPhongMaterial({ color: 0x5a6e4a }));
      booth.position.set(6, 1.5, 0); group.add(booth);
      // Flag pole
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 8, 8), new THREE.MeshPhongMaterial({ color: 0x888888 }));
      pole.position.set(-10, 4, 0); group.add(pole);
      break;
    }
    case 'prison': {
      // Bars on windows
      const barMat = new THREE.MeshPhongMaterial({ color: 0x333333 });
      for (let i = -2; i <= 2; i++) {
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 6), barMat);
        bar.position.set(i * 0.3, 2.5, loc.d / 2 + 0.1); group.add(bar);
      }
      break;
    }
    case 'medical': {
      // Red cross
      const crossMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
      const crossH = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 0.1), crossMat);
      crossH.position.set(0, loc.h - 1, loc.d / 2 + 0.15); group.add(crossH);
      const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.1), crossMat);
      crossV.position.set(0, loc.h - 1, loc.d / 2 + 0.15); group.add(crossV);
      break;
    }
    case 'range': {
      // Targets
      const targetMat = new THREE.MeshPhongMaterial({ color: 0xeeeeee });
      for (let i = -3; i <= 3; i++) {
        const target = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.1), targetMat);
        target.position.set(i * 3, 1, -loc.d / 2 + 1); group.add(target);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.5, 16), new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide }));
        ring.position.set(i * 3, 1.5, -loc.d / 2 + 1.05); group.add(ring);
      }
      break;
    }
    case 'award': {
      // Trophy on top
      const trophyMat = new THREE.MeshPhongMaterial({ color: 0xffd700, shininess: 100 });
      const trophy = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 1, 8), trophyMat);
      trophy.position.set(0, loc.h + 1.2, 0); group.add(trophy);
      break;
    }
    case 'garage': {
      // Big garage door
      const garageDoor = new THREE.Mesh(new THREE.BoxGeometry(loc.w - 2, loc.h - 1, 0.2), new THREE.MeshPhongMaterial({ color: 0x888888, shininess: 30 }));
      garageDoor.position.set(0, (loc.h - 1) / 2, loc.d / 2 + 0.1); group.add(garageDoor);
      break;
    }
    case 'supply': {
      // Loading dock
      const dock = new THREE.Mesh(new THREE.BoxGeometry(loc.w, 1, 3), new THREE.MeshPhongMaterial({ color: 0x666666 }));
      dock.position.set(0, 0.5, loc.d / 2 + 1.5); group.add(dock);
      break;
    }
  }
}

function buildOpenArea(group, loc) {
  const fieldGeo = new THREE.PlaneGeometry(loc.w, loc.d);
  const fieldMat = new THREE.MeshPhongMaterial({ color: loc.color });
  const field = new THREE.Mesh(fieldGeo, fieldMat);
  field.rotation.x = -Math.PI / 2; field.position.y = 0.02;
  group.add(field);

  // White lines
  const linesMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (let i = -loc.w / 2; i <= loc.w / 2; i += loc.w) {
    const l = new THREE.Mesh(new THREE.PlaneGeometry(0.15, loc.d), linesMat);
    l.rotation.x = -Math.PI / 2; l.position.set(i, 0.03, 0); group.add(l);
  }
  for (let i = -loc.d / 2; i <= loc.d / 2; i += loc.d) {
    const l = new THREE.Mesh(new THREE.PlaneGeometry(loc.w, 0.15), linesMat);
    l.rotation.x = -Math.PI / 2; l.position.set(0, 0.03, i); group.add(l);
  }
  // Center circle
  const ring = new THREE.Mesh(new THREE.RingGeometry(3, 3.15, 32), linesMat);
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
  group.add(ring);
  // Track
  const track = new THREE.Mesh(new THREE.RingGeometry(loc.d / 2 - 1, loc.d / 2 + 1, 32), new THREE.MeshPhongMaterial({ color: 0xcc6644 }));
  track.rotation.x = -Math.PI / 2; track.position.y = 0.025;
  group.add(track);
  // Flag podium
  const podium = new THREE.Mesh(new THREE.BoxGeometry(4, 0.8, 3), new THREE.MeshPhongMaterial({ color: 0x666666 }));
  podium.position.set(0, 0.4, -loc.d / 2 + 3);
  group.add(podium);
  // Sign
  const signCanvas = createTextCanvas(loc.name, 256, 64);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(signCanvas), transparent: true }));
  sign.position.set(0, 3, loc.d / 2 + 2);
  group.add(sign);
}

function createTextCanvas(text, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, 8); ctx.fill();
  ctx.fillStyle = '#d4c45a';
  ctx.font = 'bold 28px Malgun Gothic, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  return canvas;
}

function createTrees() {
  const trunkMat = new THREE.MeshPhongMaterial({ color: 0x6B3A1F });
  const leafColors = [0x2d6a1e, 0x3a7a2a, 0x1d5a0e, 0x4a8a3a];
  for (let i = 0; i < 120; i++) {
    const x = (Math.random() - 0.5) * 340;
    const z = (Math.random() - 0.5) * 340;
    let tooClose = false;
    for (const b of buildings) {
      if (x > b.minX - 4 && x < b.maxX + 4 && z > b.minZ - 4 && z < b.maxZ + 4) { tooClose = true; break; }
    }
    if (Math.abs(x) < 3.5 || Math.abs(z) < 3.5) tooClose = true;
    if (tooClose) continue;
    const treeGroup = new THREE.Group();
    const h = 2.5 + Math.random() * 2;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.3, h, 6), trunkMat);
    trunk.position.y = h / 2; trunk.castShadow = true;
    treeGroup.add(trunk);
    const lc = leafColors[Math.floor(Math.random() * leafColors.length)];
    const leafMat = new THREE.MeshPhongMaterial({ color: lc });
    const layers = 2 + Math.floor(Math.random() * 2);
    for (let l = 0; l < layers; l++) {
      const r = 1.8 - l * 0.4 + Math.random() * 0.3;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, 2.0 - l * 0.3, 7), leafMat);
      cone.position.y = h + l * 1.2; cone.castShadow = true;
      treeGroup.add(cone);
    }
    treeGroup.position.set(x, 0, z);
    const s = 0.8 + Math.random() * 0.5;
    treeGroup.scale.set(s, s, s);
    scene.add(treeGroup);
  }
}

function createFences() {
  const fenceMat = new THREE.MeshLambertMaterial({ color: 0x888888 });
  const fenceSize = 170;
  const fenceHeight = 3;
  const sides = [
    { x: 0, z: -fenceSize, rx: 0, w: fenceSize * 2 },
    { x: 0, z: fenceSize, rx: 0, w: fenceSize * 2 },
    { x: -fenceSize, z: 0, rx: Math.PI / 2, w: fenceSize * 2 },
    { x: fenceSize, z: 0, rx: Math.PI / 2, w: fenceSize * 2 },
  ];
  sides.forEach(s => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.w, fenceHeight, 0.3), fenceMat);
    mesh.position.set(s.x, fenceHeight / 2, s.z);
    if (s.rx) mesh.rotation.y = s.rx;
    mesh.castShadow = true;
    scene.add(mesh);
  });
  const wireMat = new THREE.MeshBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0.6 });
  sides.forEach(side => {
    for (let h = 0; h < 3; h++) {
      const wire = new THREE.Mesh(new THREE.BoxGeometry(side.w, 0.5, 0.1), wireMat);
      wire.position.set(side.x, 0.5 + h * 1.2, side.z);
      if (side.rx) wire.rotation.y = side.rx;
      scene.add(wire);
    }
  });
}

// ==================== OBJ MODEL LOADER ====================
function loadBaseModel() {
  fetch('/models/base.obj')
    .then(r => r.text())
    .then(text => {
      const group = parseOBJ(text, 'base');
      // Center the model: OBJ center is around (79, 2, 125), scale to match game world
      const box = new THREE.Box3().setFromObject(group);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      // Scale: OBJ is ~568 units wide, game world is ~340 units wide
      const scale = 0.6;
      group.scale.set(scale, scale, scale);
      // Position: center the model on the game world
      group.position.set(-center.x * scale, -center.y * scale + 0.1, -center.z * scale);
      group.traverse(child => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      baseModel = group;
      scene.add(group);
      appendSystem('[시스템] 군사기지 모델 로드 완료');
    })
    .catch(err => console.error('OBJ load error:', err));
}

function loadPrisonModel() {
  fetch('/models/prison.obj')
    .then(r => r.text())
    .then(text => {
      const group = parseOBJ(text, 'prison');
      const box = new THREE.Box3().setFromObject(group);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const scale = 14 / Math.max(size.x, size.z);
      group.scale.set(scale, scale, scale);
      group.position.set(60 - center.x * scale, -center.y * scale + 0.05, -50 - center.z * scale);
      group.traverse(child => {
        if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
      });
      scene.add(group);
      appendSystem('[시스템] 영창 모델 로드 완료');
    })
    .catch(err => console.error('Prison OBJ load error:', err));
}

function parseOBJ(text, modelType) {
  const group = new THREE.Group();
  const vertices = [], normals = [];
  let currentVerts = [], currentNorms = [];
  let groupName = '';
  let currentMtl = '';

  const baseMats = {
    default: new THREE.MeshPhongMaterial({ color: 0x6b7d5e, shininess: 10, side: THREE.DoubleSide }),
    base: new THREE.MeshPhongMaterial({ color: 0x4a7a3a, shininess: 5, side: THREE.DoubleSide }),
    wall: new THREE.MeshPhongMaterial({ color: 0x888888, shininess: 15, side: THREE.DoubleSide }),
    roof: new THREE.MeshPhongMaterial({ color: 0x5a4a3a, shininess: 8, side: THREE.DoubleSide }),
  };
  const prisonMats = {
    wall: new THREE.MeshPhongMaterial({ color: 0x5f5d5a, shininess: 5, side: THREE.DoubleSide }),
    bars: new THREE.MeshPhongMaterial({ color: 0x3a3a3a, shininess: 30, side: THREE.DoubleSide }),
    floor: new THREE.MeshPhongMaterial({ color: 0x2a2a2a, shininess: 3, side: THREE.DoubleSide }),
    spawn: new THREE.MeshPhongMaterial({ color: 0x8b4513, shininess: 5, side: THREE.DoubleSide }),
  };

  const flush = (name) => {
    if (currentVerts.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(currentVerts, 3));
    if (currentNorms.length === currentVerts.length)
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(currentNorms, 3));
    else geo.computeVertexNormals();
    let mat;
    if (modelType === 'prison') {
      if (name && name.startsWith('Baseplate')) mat = prisonMats.floor;
      else if (name && name.startsWith('Spawnlocation')) mat = prisonMats.spawn;
      else if (name && (name === 'Part3' || name === 'Part4' || name === 'Part5' || name === 'Part6')) mat = prisonMats.bars;
      else mat = prisonMats.wall;
    } else {
      mat = baseMats.default;
      if (name && (name.startsWith('Baseplate') || name === 'Part178')) mat = baseMats.base;
      else if (name && name.startsWith('Cube')) mat = baseMats.wall;
      else {
        const yAvg = currentVerts.filter((_, i) => i % 3 === 1).reduce((a, b) => a + b, 0) / (currentVerts.length / 3);
        if (yAvg > 10) mat = baseMats.roof;
      }
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name || '';
    group.add(mesh);
    currentVerts = [];
    currentNorms = [];
  };

  const lines = text.split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    switch (parts[0]) {
      case 'v': vertices.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])); break;
      case 'vn': normals.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])); break;
      case 'g':
        flush(groupName);
        groupName = parts.slice(1).join(' ');
        break;
      case 'f':
        const fv = [];
        const fn = [];
        for (let i = 1; i < parts.length; i++) {
          const idx = parts[i].split('/');
          const vi = (parseInt(idx[0]) - 1) * 3;
          fv.push(vertices[vi], vertices[vi + 1], vertices[vi + 2]);
          if (idx[2]) {
            const ni = (parseInt(idx[2]) - 1) * 3;
            fn.push(normals[ni], normals[ni + 1], normals[ni + 2]);
          }
        }
        for (let i = 1; i < fv.length / 3 - 1; i++) {
          currentVerts.push(fv[0], fv[1], fv[2], fv[i * 3], fv[i * 3 + 1], fv[i * 3 + 2], fv[(i + 1) * 3], fv[(i + 1) * 3 + 1], fv[(i + 1) * 3 + 2]);
          if (fn.length > 0) {
            currentNorms.push(fn[0], fn[1], fn[2], fn[i * 3], fn[i * 3 + 1], fn[i * 3 + 2], fn[(i + 1) * 3], fn[(i + 1) * 3 + 1], fn[(i + 1) * 3 + 2]);
          }
        }
        break;
    }
  }
  flush(groupName);
  return group;
}

// ==================== SOLDIER MODEL (RANK-BASED) ====================
function buildSoldierModel(rankIndex, isMainPlayer, outfitMode = 'rank') {
  const group = new THREE.Group();
  const rc = getRankColor(rankIndex);
  const tier = getRankTier(rankIndex);
  const skinMat = new THREE.MeshPhongMaterial({ color: 0xf5c5a3, shininess: 20 });
  const camoUniform = outfitMode === 'field' || outfitMode === 'tactical' ||
    (outfitMode === 'rank' && (tier === 'soldier' || tier === 'nco'));
  const uniformMat = new THREE.MeshPhongMaterial({
    color: camoUniform ? 0xffffff : (outfitMode === 'dress' && tier === 'general' ? 0x24301c : rc.uniform),
    map: camoUniform ? createUniformTexture(rankIndex) : null,
    shininess: 8
  });
  const bootMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a, shininess: 30 });
  const beltMat = new THREE.MeshPhongMaterial({ color: tier === 'general' ? 0x4a3a1a : 0x2a2a1a, shininess: 15 });
  const helmetMat = new THREE.MeshPhongMaterial({ color: rc.helmet, shininess: 12 });
  const trimMat = new THREE.MeshPhongMaterial({
    color: tier === 'general' ? 0xd4af37 : 0xc0a030,
    shininess: 55
  });

  // Legs
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.9, 0.35), uniformMat);
  legL.position.set(-0.22, 0.45, 0); legL.castShadow = true; group.add(legL);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.9, 0.35), uniformMat);
  legR.position.set(0.22, 0.45, 0); legR.castShadow = true; group.add(legR);

  // Boots
  const bootL = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.35, 0.5), bootMat);
  bootL.position.set(-0.22, 0.17, 0.05); group.add(bootL);
  const bootR = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.35, 0.5), bootMat);
  bootR.position.set(0.22, 0.17, 0.05); group.add(bootR);

  // Torso
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.0, 0.45), uniformMat);
  torso.position.y = 1.4; torso.castShadow = true; group.add(torso);

  // Give each career tier a distinct uniform cut and finish.
  if (tier === 'soldier') {
    // Field blouse seam and subdued camouflage panels.
    const camoMat = new THREE.MeshPhongMaterial({ color: 0x596447, shininess: 4 });
    [[-0.29, 1.42], [0.29, 1.42], [-0.29, 1.12], [0.29, 1.12]].forEach(([x, y]) => {
      const patch = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.018), camoMat);
      patch.position.set(x, y, 0.235); group.add(patch);
    });
    const placket = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.72, 0.025), pocketMatFallback());
    placket.position.set(0, 1.4, 0.24); group.add(placket);
  } else if (tier === 'nco') {
    // NCO field jacket: darker reinforced chest and brass collar tabs.
    const panelMat = new THREE.MeshPhongMaterial({ color: 0x344329, shininess: 12 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.72, 0.025), panelMat);
    panel.position.set(0, 1.4, 0.24); group.add(panel);
    [[-0.2, 1.79], [0.2, 1.79]].forEach(([x, y]) => {
      const tab = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.035), trimMat);
      tab.position.set(x, y, 0.23); tab.rotation.z = x < 0 ? 0.25 : -0.25; group.add(tab);
    });
    // Compact blocky field vest with front utility pouches.
    const vestMat = new THREE.MeshPhongMaterial({ color: 0x34392d, shininess: 5 });
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.62, 0.12), vestMat);
    vest.position.set(0, 1.37, 0.285); group.add(vest);
    [-0.22, 0, 0.22].forEach(x => {
      const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.17, 0.08), vestMat);
      pouch.position.set(x, 1.3, 0.38); group.add(pouch);
    });
  } else if (tier === 'officer') {
    // Tailored command jacket with a clean center seam, collar tabs and cuffs.
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.78, 0.025), trimMat);
    seam.position.set(0, 1.4, 0.24); group.add(seam);
    [[-0.2, 1.79], [0.2, 1.79]].forEach(([x, y]) => {
      const tab = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.08, 0.04), trimMat);
      tab.position.set(x, y, 0.235); tab.rotation.z = x < 0 ? 0.25 : -0.25; group.add(tab);
    });
    [-0.55, 0.55].forEach(x => {
      const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.09, 0.3), trimMat);
      cuff.position.set(x, 1.02, 0); group.add(cuff);
    });
  } else if (tier === 'general' && (outfitMode === 'rank' || outfitMode === 'dress')) {
    // General officer dress tunic: gold front braid, collar and sleeve cuffs.
    const braid = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.78, 0.035), trimMat);
    braid.position.set(0, 1.4, 0.245); group.add(braid);
    [[-0.2, 1.79], [0.2, 1.79]].forEach(([x, y]) => {
      const tab = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.09, 0.045), trimMat);
      tab.position.set(x, y, 0.235); tab.rotation.z = x < 0 ? 0.25 : -0.25; group.add(tab);
    });
    [-0.55, 0.55].forEach(x => {
      const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.31), trimMat);
      cuff.position.set(x, 1.02, 0); group.add(cuff);
    });
    const sash = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 0.5), trimMat);
    sash.position.set(0, 1.02, 0); sash.rotation.z = -0.08; group.add(sash);
    // Medal ribbon and chest decorations on the general's dress uniform.
    const ribbonMat = new THREE.MeshPhongMaterial({ color: 0x9b3030, shininess: 30 });
    const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.08, 0.035), ribbonMat);
    ribbon.position.set(0.2, 1.58, 0.255); group.add(ribbon);
    for (let i = 0; i < 3; i++) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.08, 0.008),
        new THREE.MeshBasicMaterial({ color: [0xffffff, 0x315b9a, 0xf0d050][i] }));
      stripe.position.set(0.1 + i * 0.09, 1.58, 0.278); group.add(stripe);
    }
  }

  if (outfitMode === 'tactical' && tier !== 'nco') {
    const vestMat = new THREE.MeshPhongMaterial({ color: 0x34392d, shininess: 5 });
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.62, 0.13), vestMat);
    vest.position.set(0, 1.37, 0.29); group.add(vest);
    [-0.22, 0, 0.22].forEach(x => {
      const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.17, 0.08), vestMat);
      pouch.position.set(x, 1.3, 0.39); group.add(pouch);
    });
  }

  // Belt
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.12, 0.5), beltMat);
  belt.position.y = 0.95; group.add(belt);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, 0.06), new THREE.MeshPhongMaterial({ color: tier === 'general' ? 0xffd700 : 0xc0a030, shininess: 80 }));
  buckle.position.set(0, 0.95, 0.28); group.add(buckle);

  // Pockets
  const pocketColor = new THREE.Color(rc.uniform).multiplyScalar(0.85);
  const pocketMat = new THREE.MeshPhongMaterial({ color: pocketColor });
  [[-0.2, 1.55], [0.2, 1.55]].forEach(([px, py]) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.2, 0.06), pocketMat);
    p.position.set(px, py, 0.26); group.add(p);
  });

  // Rank-specific shoulder boards: chevrons for enlisted/NCOs, bars for
  // officers, and stars for generals. Distinct counts make all ranks readable.
  const shoulderMat = new THREE.MeshPhongMaterial({
    color: tier === 'soldier' ? 0x38472f : (rc.badge || 0xc0a030),
    shininess: tier === 'soldier' ? 8 : 40
  });
  const insigniaMat = new THREE.MeshPhongMaterial({
    color: tier === 'soldier' ? 0xc8c9b7 : (tier === 'general' ? 0xffd700 : 0xf0d879),
    shininess: 65
  });
  [[-0.5, 1.88], [0.5, 1.88]].forEach(([sx, sy]) => {
    const sh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.4), shoulderMat);
    sh.position.set(sx, sy, 0); group.add(sh);

    if (tier === 'soldier' || tier === 'nco') {
      // 훈련병 has a plain board; enlisted ranks get 1–4 stripes,
      // NCO ranks get 1–4 brass chevrons.
      const count = rankIndex === 0 ? 0 : tier === 'soldier' ? rankIndex : rankIndex - 4;
      for (let i = 0; i < count; i++) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.025, 0.025), insigniaMat);
        stripe.position.set(sx, sy + 0.052, -0.12 + i * 0.075);
        stripe.rotation.x = -0.25;
        group.add(stripe);
      }
    } else if (tier === 'officer') {
      // 1–3 parallel gold bars, then 1–3 small diamonds for field-grade officers.
      const bars = rankIndex <= 11 ? rankIndex - 8 : 0;
      const diamonds = rankIndex >= 12 ? rankIndex - 11 : 0;
      for (let i = 0; i < bars; i++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.035), insigniaMat);
        bar.position.set(sx, sy + 0.052, -0.07 + i * 0.07);
        group.add(bar);
      }
      for (let i = 0; i < diamonds; i++) {
        const diamond = new THREE.Mesh(new THREE.OctahedronGeometry(0.045, 0), insigniaMat);
        diamond.position.set(sx, sy + 0.065, -0.07 + i * 0.07);
        diamond.scale.set(0.75, 0.75, 1.25);
        group.add(diamond);
      }
    } else {
      // One to four stars for 준장 through 대장.
      const count = rankIndex - 14;
      for (let i = 0; i < count; i++) {
        const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.05, 0), insigniaMat);
        star.position.set(sx, sy + 0.07, -0.105 + i * 0.07);
        group.add(star);
      }
    }
  });

  // Arms
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.85, 0.28), uniformMat);
  armL.position.set(-0.55, 1.35, 0); armL.castShadow = true; group.add(armL);
  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.85, 0.28), uniformMat);
  armR.position.set(0.55, 1.35, 0); armR.castShadow = true; group.add(armR);

  // Hands
  const handL = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), skinMat);
  handL.position.set(-0.55, 0.88, 0); group.add(handL);
  const handR = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), skinMat);
  handR.position.set(0.55, 0.88, 0); group.add(handR);

  // Neck & Head
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 0.15, 8), skinMat);
  neck.position.y = 1.97; group.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.45, 0.4), skinMat);
  head.position.y = 2.2; head.castShadow = true; group.add(head);

  // Headgear (varies by rank)
  if (tier === 'general' && outfitMode !== 'field' && outfitMode !== 'tactical') {
    // Officer peaked cap
    const capMat = new THREE.MeshPhongMaterial({ color: 0x1a2510, shininess: 20 });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.2, 12), capMat);
    cap.position.y = 2.48; group.add(cap);
    const visor = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.04, 12, 1, false, 0, Math.PI), new THREE.MeshPhongMaterial({ color: 0x111111, shininess: 60 }));
    visor.position.set(0, 2.38, 0.12); visor.rotation.x = -0.3; group.add(visor);
    // Gold band
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.305, 0.305, 0.06, 12), new THREE.MeshPhongMaterial({ color: 0xffd700, shininess: 80 }));
    band.position.y = 2.42; group.add(band);
  } else if (tier === 'officer') {
    // Beret
    const beret = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), new THREE.MeshPhongMaterial({ color: 0x2a351a, shininess: 15 }));
    beret.position.y = 2.38; beret.scale.set(1, 0.6, 1); group.add(beret);
    const beretBand = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.04, 12), new THREE.MeshPhongMaterial({ color: 0xd4af37 }));
    beretBand.position.y = 2.36; group.add(beretBand);
  } else {
    // Standard helmet
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), helmetMat);
    helmet.position.y = 2.35; helmet.castShadow = true; group.add(helmet);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.36, 0.06, 12), helmetMat);
    brim.position.y = 2.18; group.add(brim);
  }

  // Rank badge
  if (rc.badge || isMainPlayer) {
    const badgeCanvas = document.createElement('canvas');
    badgeCanvas.width = 64; badgeCanvas.height = 64;
    const bctx = badgeCanvas.getContext('2d');
    bctx.fillStyle = tier === 'general' ? '#ffd700' : tier === 'officer' ? '#d4af37' : tier === 'nco' ? '#c0a030' : '#888888';
    bctx.font = 'bold 28px sans-serif';
    bctx.textAlign = 'center'; bctx.textBaseline = 'middle';
    const stars = tier === 'general' ? '★'.repeat(Math.min(rankIndex - 14, 4)) : tier === 'officer' ? '◆' : tier === 'nco' ? '▲' : '●';
    bctx.fillText(stars, 32, 32);
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 0.25), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(badgeCanvas), transparent: true }));
    badge.position.set(0.15, 1.75, 0.24); group.add(badge);
  }

  group.userData.legL = legL;
  group.userData.legR = legR;
  group.userData.armL = armL;
  group.userData.armR = armR;
  group.userData.outfitMode = outfitMode;
  return group;
}

function pocketMatFallback() {
  return new THREE.MeshPhongMaterial({ color: 0x303c29, shininess: 5 });
}

function createPlayer() {
  player = buildSoldierModel(currentUser.rankIndex || 0, true, currentUser.outfitMode || 'rank');
  player.position.set(0, 0, 15);
  scene.add(player);
  initWeapons();
}

// ==================== WEAPON SYSTEM ====================
const WEAPONS = [
  { name: 'K2 소총', type: 'rifle', ammo: 30, maxAmmo: 30, reserve: 120, fireRate: 100, damage: 25, auto: true, icon: '🔫' },
  { name: 'K5 권총', type: 'pistol', ammo: 13, maxAmmo: 13, reserve: 52, fireRate: 200, damage: 18, auto: false, icon: '🔫' },
  { name: '군용 단도', type: 'knife', ammo: Infinity, maxAmmo: Infinity, reserve: Infinity, fireRate: 400, damage: 50, auto: false, icon: '🔪' },
];

// ==================== INVENTORY ====================
let inventory = [];

function hasItem(itemId) { return inventory.some(i => i.id === itemId); }

function addItem(item) {
  if (!inventory.some(i => i.id === item.id)) {
    inventory.push(item);
    appendSystem(`[아이템] ${item.name} 획득!`);
  }
}

function initInventory() {
  if (currentUser && currentUser.isAdmin) {
    addItem({ id: 'admin_keycard', name: '관리자 카드키', icon: '🔑', desc: '관리자 벙커 출입 카드키. 최고 관리자만 소지 가능.' });
  }
}

// ==================== CCTV SYSTEM ====================
let cctvActive = false;
let cctvIndex = 0;

function openCCTV() {
  cctvActive = true;
  cctvIndex = 0;
  document.getElementById('cctv-overlay').classList.add('active');
  updateCCTVView();
}

function closeCCTV() {
  cctvActive = false;
  document.getElementById('cctv-overlay').classList.remove('active');
}

function cctvPrev() { cctvIndex = (cctvIndex - 1 + LOCATIONS.length) % LOCATIONS.length; updateCCTVView(); }
function cctvNext() { cctvIndex = (cctvIndex + 1) % LOCATIONS.length; updateCCTVView(); }

function updateCCTVView() {
  const loc = LOCATIONS[cctvIndex];
  document.getElementById('cctv-location').textContent = loc.name;
  document.getElementById('cctv-cam-id').textContent = `CAM-${String(cctvIndex + 1).padStart(2, '0')}`;
  const now = new Date();
  document.getElementById('cctv-time').textContent = now.toLocaleTimeString('ko-KR');
  const playersHere = [];
  Object.entries(otherPlayers).forEach(([id, p]) => {
    const dist = Math.sqrt((p.position.x - loc.x) ** 2 + (p.position.z - loc.z) ** 2);
    if (dist < Math.max(loc.w, loc.d) / 2 + 10) playersHere.push(id);
  });
  if (player) {
    const dist = Math.sqrt((player.position.x - loc.x) ** 2 + (player.position.z - loc.z) ** 2);
    if (dist < Math.max(loc.w, loc.d) / 2 + 10) playersHere.push('(나)');
  }
  document.getElementById('cctv-players').textContent = playersHere.length > 0 ? `감지: ${playersHere.length}명` : '감지된 인원 없음';
  // Draw mini view on canvas
  const canvas = document.getElementById('cctv-canvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a1a0a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Green-tinted CCTV look
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  const scale = 1.2;
  // Draw buildings
  LOCATIONS.forEach(l => {
    const sx = (l.x - loc.x) * scale;
    const sy = (l.z - loc.z) * scale;
    if (Math.abs(sx) > canvas.width / 2 + 20 || Math.abs(sy) > canvas.height / 2 + 20) return;
    ctx.fillStyle = l.id === loc.id ? 'rgba(0,255,80,0.3)' : 'rgba(0,180,60,0.15)';
    ctx.fillRect(sx - l.w * scale / 2, sy - l.d * scale / 2, l.w * scale, l.d * scale);
    ctx.strokeStyle = 'rgba(0,255,80,0.3)';
    ctx.strokeRect(sx - l.w * scale / 2, sy - l.d * scale / 2, l.w * scale, l.d * scale);
  });
  // Draw players
  Object.values(otherPlayers).forEach(p => {
    const sx = (p.position.x - loc.x) * scale;
    const sy = (p.position.z - loc.z) * scale;
    if (Math.abs(sx) > canvas.width / 2 || Math.abs(sy) > canvas.height / 2) return;
    ctx.fillStyle = '#00ff50';
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
  });
  if (player) {
    const sx = (player.position.x - loc.x) * scale;
    const sy = (player.position.z - loc.z) * scale;
    ctx.fillStyle = '#ffff00';
    ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // Scan lines
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  for (let y = 0; y < canvas.height; y += 3) ctx.fillRect(0, y, canvas.width, 1);
  // REC indicator
  ctx.fillStyle = '#ff0000';
  ctx.beginPath(); ctx.arc(20, 20, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ff4444';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('● REC', 30, 25);
}

let currentWeaponIndex = 0;
let weaponState = [];
let weaponModel = null;
let lastFireTime = 0;
let isReloading = false;
let isFiring = false;
let bulletTrails = [];
let recoilOffset = 0;

let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playGunSound(type) {
  const ctx = getAudioCtx();
  if (type === 'rifle') {
    // Rifle: sharp crack + low boom
    const bufLen = ctx.sampleRate * 0.15;
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 40);
      const crack = (Math.random() * 2 - 1) * env;
      const boom = Math.sin(t * 150) * Math.exp(-t * 20) * 0.6;
      data[i] = (crack + boom) * 0.7;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0.35;
    src.connect(gain).connect(ctx.destination);
    src.start();
  } else if (type === 'pistol') {
    // Pistol: sharper, shorter pop
    const bufLen = ctx.sampleRate * 0.1;
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 60);
      const pop = (Math.random() * 2 - 1) * env;
      const snap = Math.sin(t * 300) * Math.exp(-t * 35) * 0.5;
      data[i] = (pop + snap) * 0.8;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = 0.3;
    src.connect(gain).connect(ctx.destination);
    src.start();
  }
}

function playReloadSound(type) {
  const src = type === 'rifle' ? '/sounds/reload_rifle.mp3' : '/sounds/reload_pistol.mp3';
  const snd = new Audio(src);
  snd.volume = 0.5;
  snd.play().catch(() => {});
}

function preloadSounds() {
  new Audio('/sounds/reload_rifle.mp3');
  new Audio('/sounds/reload_pistol.mp3');
}

function initWeapons() {
  weaponState = WEAPONS.map(w => ({
    ammo: w.ammo,
    reserve: w.reserve,
  }));
  preloadSounds();
  createWeaponModel(0);
  updateWeaponHUD();
  document.getElementById('crosshair').classList.add('active');
}

function createWeaponModel(index) {
  if (weaponModel) {
    camera.remove(weaponModel);
    weaponModel = null;
  }
  const w = WEAPONS[index];
  const group = new THREE.Group();
  const gunMetal = new THREE.MeshPhongMaterial({ color: 0x2a2a2a, shininess: 60 });
  const woodMat = new THREE.MeshPhongMaterial({ color: 0x5a3a1a, shininess: 20 });
  const darkMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a, shininess: 40 });

  if (w.type === 'rifle') {
    // K2 rifle body
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.65), gunMetal);
    group.add(body);
    // Barrel
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.45, 8), gunMetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.55;
    group.add(barrel);
    // Stock
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.05, 0.25), woodMat);
    stock.position.set(0, -0.01, 0.38);
    group.add(stock);
    // Magazine
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.06), darkMat);
    mag.position.set(0, -0.1, 0.05);
    mag.rotation.x = -0.15;
    group.add(mag);
    // Grip
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.04), darkMat);
    grip.position.set(0, -0.07, 0.18);
    grip.rotation.x = -0.3;
    group.add(grip);
    // Front sight
    const fSight = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.025, 0.008), gunMetal);
    fSight.position.set(0, 0.04, -0.48);
    group.add(fSight);
    // Rear sight
    const rSight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.008), gunMetal);
    rSight.position.set(0, 0.04, -0.1);
    group.add(rSight);
    // Muzzle flash point
    group.userData.muzzlePos = new THREE.Vector3(0, 0, -0.78);
    group.position.set(0.28, -0.22, -0.35);
    group.rotation.set(0, 0, 0);
  } else if (w.type === 'pistol') {
    // K5 pistol
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.2), gunMetal);
    group.add(slide);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.035, 0.14), darkMat);
    frame.position.set(0, -0.01, 0.03);
    group.add(frame);
    const grip2 = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.1, 0.04), darkMat);
    grip2.position.set(0, -0.06, 0.08);
    grip2.rotation.x = -0.2;
    group.add(grip2);
    const barrel2 = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.08, 8), gunMetal);
    barrel2.rotation.x = Math.PI / 2;
    barrel2.position.z = -0.14;
    group.add(barrel2);
    // Trigger guard
    const tGuard = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.015, 0.04), gunMetal);
    tGuard.position.set(0, -0.035, 0.02);
    group.add(tGuard);
    group.userData.muzzlePos = new THREE.Vector3(0, 0, -0.22);
    group.position.set(0.22, -0.2, -0.3);
  } else if (w.type === 'knife') {
    // Military knife
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.03, 0.22), new THREE.MeshPhongMaterial({ color: 0xcccccc, shininess: 120 }));
    group.add(blade);
    const knifeHandle = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.035, 0.1), new THREE.MeshPhongMaterial({ color: 0x3a2a1a }));
    knifeHandle.position.z = 0.16;
    group.add(knifeHandle);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.01), gunMetal);
    guard.position.z = 0.1;
    group.add(guard);
    group.userData.muzzlePos = new THREE.Vector3(0, 0, -0.12);
    group.position.set(0.25, -0.2, -0.25);
  }

  camera.add(group);
  if (!scene.children.includes(camera)) scene.add(camera);
  weaponModel = group;
}

function switchWeapon(index) {
  if (index === currentWeaponIndex || isReloading) return;
  if (index < 0 || index >= WEAPONS.length) return;
  currentWeaponIndex = index;
  createWeaponModel(index);
  updateWeaponHUD();
  isFiring = false;
}

function updateWeaponHUD() {
  const w = WEAPONS[currentWeaponIndex];
  const s = weaponState[currentWeaponIndex];
  document.querySelectorAll('.weapon-slot').forEach((el, i) => {
    el.classList.toggle('active', i === currentWeaponIndex);
  });
  const ammoEl = document.getElementById('ammo-current');
  const reserveEl = document.getElementById('ammo-reserve');
  const ammoDisplay = document.querySelector('.ammo-display');
  if (w.type === 'knife') {
    ammoEl.textContent = '∞';
    reserveEl.textContent = '';
    document.querySelector('.ammo-sep').style.display = 'none';
    ammoDisplay.classList.remove('no-ammo');
  } else {
    ammoEl.textContent = s.ammo;
    reserveEl.textContent = s.reserve;
    document.querySelector('.ammo-sep').style.display = '';
    ammoDisplay.classList.toggle('no-ammo', s.ammo === 0);
  }
}

function fireWeapon() {
  const now = Date.now();
  const w = WEAPONS[currentWeaponIndex];
  const s = weaponState[currentWeaponIndex];
  if (isReloading) return;
  if (now - lastFireTime < w.fireRate) return;
  if (w.type !== 'knife' && s.ammo <= 0) return;
  lastFireTime = now;

  if (w.type !== 'knife') {
    s.ammo--;
    updateWeaponHUD();
  }

  // Recoil animation
  recoilOffset = 0.03;

  if (w.type === 'knife') {
    // Knife slash animation
    if (weaponModel) {
      weaponModel.rotation.x = -0.5;
      setTimeout(() => { if (weaponModel) weaponModel.rotation.x = 0; }, 200);
    }
  } else {
    // Gun sound
    playGunSound(w.type);
    // Gun effects
    const flash = document.getElementById('muzzle-flash');
    flash.classList.add('flash');
    setTimeout(() => flash.classList.remove('flash'), 50);

    // Create bullet trail in 3D
    createBulletTrail();
  }

  // Auto reload when empty
  if (w.type !== 'knife' && s.ammo === 0 && s.reserve > 0) {
    setTimeout(() => reloadWeapon(), 500);
  }
}

function createBulletTrail() {
  if (!player) return;
  const forward = new THREE.Vector3(-Math.sin(yaw), Math.sin(pitch), -Math.cos(yaw)).normalize();
  const start = new THREE.Vector3(
    player.position.x + Math.sin(yaw) * 0.3,
    player.position.y + 1.6,
    player.position.z + Math.cos(yaw) * 0.3
  );
  const end = start.clone().add(forward.multiplyScalar(80));

  const trailGeo = new THREE.BufferGeometry().setFromPoints([start, end]);
  const trailMat = new THREE.LineBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.6 });
  const trail = new THREE.Line(trailGeo, trailMat);
  scene.add(trail);
  bulletTrails.push({ mesh: trail, life: 8 });
}

function reloadWeapon() {
  const w = WEAPONS[currentWeaponIndex];
  const s = weaponState[currentWeaponIndex];
  if (w.type === 'knife' || isReloading) return;
  if (s.ammo === w.maxAmmo || s.reserve === 0) return;
  isReloading = true;
  playReloadSound(w.type);
  const reloadEl = document.getElementById('reload-indicator');
  reloadEl.style.display = 'block';

  setTimeout(() => {
    const needed = w.maxAmmo - s.ammo;
    const take = Math.min(needed, s.reserve);
    s.ammo += take;
    s.reserve -= take;
    isReloading = false;
    reloadEl.style.display = 'none';
    updateWeaponHUD();
  }, 2000);
}

function createOtherPlayer(userId, nickname, rankIndex, outfitMode = 'rank') {
  const group = buildSoldierModel(rankIndex || 0, false, outfitMode);
  const nameCanvas = createTextCanvas(nickname, 192, 48);
  const nameTag = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(nameCanvas), transparent: true }));
  nameTag.position.y = 2.9;
  group.add(nameTag);
  scene.add(group);
  otherPlayers[userId] = group;
  return group;
}

function updateOtherPlayer(data) {
  let p = otherPlayers[data.userId];
  if (p && p.userData.outfitMode !== (data.outfitMode || 'rank')) {
    const position = p.position.clone();
    const rotation = p.rotation.clone();
    removeOtherPlayer(data.userId);
    p = createOtherPlayer(data.userId, data.nickname, data.rankIndex, data.outfitMode || 'rank');
    p.position.copy(position);
    p.rotation.copy(rotation);
  }
  if (!p) p = createOtherPlayer(data.userId, data.nickname, data.rankIndex, data.outfitMode || 'rank');
  p.position.set(data.x, data.y || 0, data.z);
}

function removeOtherPlayer(userId) {
  const p = otherPlayers[userId];
  if (p) { scene.remove(p); delete otherPlayers[userId]; }
}

// ==================== INPUT ====================
function onMouseMove(e) {
  if (!isPointerLocked) return;
  yaw -= e.movementX * 0.002;
  pitch -= e.movementY * 0.002;
  pitch = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, pitch));
}

function onMouseDown(e) {
  if (!isPointerLocked || e.button !== 0) return;
  isFiring = true;
  fireWeapon();
}

function onMouseUp(e) {
  if (e.button !== 0) return;
  isFiring = false;
}

function onKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  switch (e.code) {
    case 'KeyW': moveForward = true; break;
    case 'KeyS': moveBackward = true; break;
    case 'KeyA': moveLeft = true; break;
    case 'KeyD': moveRight = true; break;
    case 'Space':
      if (!isJumping) { isJumping = true; velocityY = jumpForce; }
      break;
    case 'KeyE':
      interactWithBuilding();
      break;
    case 'KeyR':
      reloadWeapon();
      break;
    case 'Digit1': switchWeapon(0); break;
    case 'Digit2': switchWeapon(1); break;
    case 'Digit3': switchWeapon(2); break;
  }
}

function onKeyUp(e) {
  switch (e.code) {
    case 'KeyW': moveForward = false; break;
    case 'KeyS': moveBackward = false; break;
    case 'KeyA': moveLeft = false; break;
    case 'KeyD': moveRight = false; break;
  }
}

function onResize() {
  if (!renderer) return;
  const container = document.getElementById('game-canvas');
  if (!container) return;
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

// ==================== BUILDING INTERACTION ====================
function interactWithBuilding() {
  if (!player) return;
  const px = player.position.x;
  const pz = player.position.z;

  for (const b of buildings) {
    const dist = Math.sqrt((px - b.cx) ** 2 + (pz - b.cz) ** 2);
    const threshold = Math.max(b.w, b.d) / 2 + 5;
    if (dist < threshold) {
      showBuildingModal(b);
      return;
    }
  }
}

function showBuildingModal(building) {
  currentBuilding = building;
  let modal = document.getElementById('building-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'building-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal" style="width:600px;max-width:95vw;"><button class="close-btn" onclick="closeBuildingModal()">&times;</button><h2 id="building-title"></h2><div id="building-content"></div></div>`;
    document.body.appendChild(modal);
  }
  if (building.type === 'admin_bunker' && !hasItem('admin_keycard')) {
    appendSystem('[접근 거부] 관리자 카드키가 필요합니다.');
    return;
  }
  modal.classList.add('active');
  document.getElementById('building-title').textContent = building.name;
  document.getElementById('building-content').innerHTML = getBuildingContent(building);
  document.exitPointerLock();
}

function closeBuildingModal() {
  const modal = document.getElementById('building-modal');
  if (modal) modal.classList.remove('active');
  currentBuilding = null;
}

function getBuildingContent(b) {
  const desc = {
    gate: `<p>부대의 정문입니다.</p><p>차량 출입 차단기와 경비 초소가 있습니다.</p>
      <button class="promote-btn" onclick="closeBuildingModal()">돌아가기</button>`,
    hq: `<p>부대 전체를 지휘하는 중심 건물입니다.</p>
      <p>사령관 집무실, 지휘통제실, 회의실이 있습니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('부대 현황 조회')">부대 현황</button>
        <button class="promote-btn" onclick="buildingAction('공지 확인')">공지 확인</button>
      </div>`,
    barracks: `<p>병사들의 생활 공간입니다.</p><p>침대, 사물함, 세면대가 있습니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('내 침상 확인')">내 침상</button>
        <button class="promote-btn" onclick="buildingAction('점호')">점호</button>
      </div>`,
    field: `<p>연병장 - 집합, 제식훈련, 행사를 진행합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('집합')">집합</button>
        <button class="promote-btn" onclick="buildingAction('제식훈련 시작')">제식훈련</button>
      </div>`,
    training: `<p>종합 훈련장 - 체력 훈련과 평가를 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="startTraining('달리기')">달리기</button>
        <button class="promote-btn" onclick="startTraining('팔굽혀펴기')">팔굽혀펴기</button>
        <button class="promote-btn" onclick="startTraining('윗몸일으키기')">윗몸일으키기</button>
        <button class="promote-btn" onclick="startTraining('턱걸이')">턱걸이</button>
        <button class="promote-btn" onclick="startTraining('장애물 통과')">장애물 통과</button>
        <button class="promote-btn" onclick="startTraining('종합 체력 평가')">종합 평가</button>
      </div>`,
    admin_office: `<p>행정실 - 인사 행정 업무를 처리합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('내 정보 조회')">내 정보</button>
        <button class="promote-btn" onclick="buildingAction('신청서 작성')">신청서</button>
      </div>`,
    prison: `<p>영창 - 규칙을 위반한 군인을 수용합니다.</p>
      <p style="color:#ff6666;">관리자만 수감/석방할 수 있습니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('수감자 현황')">수감자 현황</button>
      </div>`,
    mp: `<p>군사경찰실 - 사건 접수와 조사를 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('신고 접수')">신고 접수</button>
        <button class="promote-btn" onclick="buildingAction('사건 조회')">사건 조회</button>
      </div>`,
    security: `<p>보안통제실 - 출입 기록과 보안 상태를 관리합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('출입 기록')">출입 기록</button>
      </div>`,
    briefing: `<p>작전회의실 - 지휘관과 간부 회의를 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('회의 목록')">회의 목록</button>
      </div>`,
    mess_hall: `<p>식당 - 아침, 점심, 저녁 식사를 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('오늘 메뉴')">오늘 메뉴</button>
        <button class="promote-btn" onclick="buildingAction('식사하기')">식사하기</button>
      </div>`,
    medical: `<p>의무실 - 부상 치료와 체력 회복을 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('진료 요청')">진료 요청</button>
        <button class="promote-btn" onclick="buildingAction('체력 회복')">체력 회복</button>
      </div>`,
    equipment: `<p>장비실 - 군복과 장비를 지급/반납합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('장비 지급')">장비 지급</button>
        <button class="promote-btn" onclick="buildingAction('장비 반납')">장비 반납</button>
        <button class="promote-btn" onclick="buildingAction('내 장비')">내 장비</button>
      </div>`,
    education: `<p>교육관 - 군 교육과 시험을 진행합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('교육 과정')">교육 과정</button>
        <button class="promote-btn" onclick="buildingAction('수료 현황')">수료 현황</button>
      </div>`,
    garage: `<p>차량 정비고 - 차량 보관과 정비를 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('차량 목록')">차량 목록</button>
        <button class="promote-btn" onclick="buildingAction('정비 요청')">정비 요청</button>
      </div>`,
    comm: `<p>통신실 - 부대 통신과 공지를 관리합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('공지 전달')">공지 전달</button>
      </div>`,
    range: `<p>사격 훈련장 - 사격 훈련과 자격 시험을 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="startTraining('사격 훈련')">사격 훈련</button>
        <button class="promote-btn" onclick="startTraining('사격 자격 시험')">자격 시험</button>
      </div>`,
    guard: `<p>경계 초소 - 경계 근무를 수행합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('경계 근무 시작')">근무 시작</button>
        <button class="promote-btn" onclick="buildingAction('근무 교대')">교대</button>
      </div>`,
    supply: `<p>보급창고 - 물품을 보관하고 지급합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('재고 확인')">재고 확인</button>
        <button class="promote-btn" onclick="buildingAction('보급 요청')">보급 요청</button>
      </div>`,
    event: `<p>행사장 - 입대식, 진급식, 표창식을 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('행사 일정')">행사 일정</button>
      </div>`,
    recruit: `<p>모집소 - 부대 지원과 입대를 처리합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('지원 현황')">지원 현황</button>
      </div>`,
    academy: `<p>사관학교 - 간부 후보생을 교육합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('교육 과정')">교육 과정</button>
        <button class="promote-btn" onclick="buildingAction('후보생 현황')">후보생 현황</button>
      </div>`,
    archive: `<p>기록보관실 - 부대 기록을 보관합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('기록 검색')">기록 검색</button>
      </div>`,
    situation: `<p>종합상황실 - 부대 전체 현황을 확인합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('부대 현황')">부대 현황</button>
        <button class="promote-btn" onclick="buildingAction('접속 인원')">접속 인원</button>
      </div>`,
    commander: `<p>지휘관 집무실 - 지휘관 전용 공간입니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('명령 작성')">명령 작성</button>
        <button class="promote-btn" onclick="buildingAction('보고서 검토')">보고서 검토</button>
      </div>`,
    personnel: `<p>인사과 - 인사 관리와 계급 관리를 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('인사 조회')">인사 조회</button>
        <button class="promote-btn" onclick="buildingAction('진급 현황')">진급 현황</button>
      </div>`,
    interview: `<p>면접실 - 지원자와 후보생 면접을 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('면접 일정')">면접 일정</button>
      </div>`,
    officer_room: `<p>간부회의실 - 간부 전용 회의 공간입니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('회의 목록')">회의 목록</button>
      </div>`,
    award: `<p>표창실 - 우수 군인을 표창합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('표창 목록')">표창 목록</button>
        <button class="promote-btn" onclick="buildingAction('내 표창')">내 표창</button>
      </div>`,
    lounge: `<p>휴게실 - 휴식과 대화를 합니다.</p>
      <div class="building-actions">
        <button class="promote-btn" onclick="buildingAction('휴식하기')">휴식하기</button>
      </div>`,
    admin_bunker: `
      <div class="bunker-panel">
        <div class="bunker-header">⚠ 관리자 벙커 - 최고 관리자 전용 시설</div>
        <div class="bunker-tabs">
          <button class="bunker-tab active" onclick="bunkerTab('cctv')">📹 CCTV</button>
          <button class="bunker-tab" onclick="bunkerTab('players')">👥 유저 관리</button>
          <button class="bunker-tab" onclick="bunkerTab('server')">🖥️ 서버 현황</button>
          <button class="bunker-tab" onclick="bunkerTab('broadcast')">📢 방송</button>
        </div>
        <div id="bunker-content">
          <div class="bunker-cctv-intro">
            <p>CCTV 모니터링 시스템을 시작하려면 아래 버튼을 클릭하세요.</p>
            <button class="promote-btn bunker-btn" onclick="openCCTV()">📹 CCTV 시작</button>
          </div>
        </div>
      </div>`,
  };
  return desc[b.type] || `<p>${b.name}에 오신 것을 환영합니다.</p>`;
}

function bunkerTab(tab) {
  document.querySelectorAll('.bunker-tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  const content = document.getElementById('bunker-content');
  if (tab === 'cctv') {
    content.innerHTML = `<div class="bunker-cctv-intro"><p>CCTV 모니터링 시스템을 시작하려면 아래 버튼을 클릭하세요.</p><button class="promote-btn bunker-btn" onclick="openCCTV()">📹 CCTV 시작</button></div>`;
  } else if (tab === 'players') {
    let html = '<div class="bunker-player-list"><h3>접속 중인 플레이어</h3><table class="bunker-table"><tr><th>닉네임</th><th>계급</th><th>위치</th><th>관리</th></tr>';
    Object.entries(otherPlayers).forEach(([id, p]) => {
      const loc = getLocationName(p.position.x, p.position.z);
      html += `<tr><td>${p.nickname || id}</td><td>${p.rank || '훈련병'}</td><td>${loc}</td><td><button class="promote-btn sm" onclick="bunkerKick('${id}')">추방</button> <button class="promote-btn sm" onclick="bunkerJail('${id}')">영창</button></td></tr>`;
    });
    html += '</table></div>';
    content.innerHTML = html;
  } else if (tab === 'server') {
    const playerCount = Object.keys(otherPlayers).length + 1;
    const uptime = Math.floor(performance.now() / 1000);
    const mins = Math.floor(uptime / 60);
    const secs = uptime % 60;
    content.innerHTML = `<div class="bunker-server">
      <div class="server-stat"><span class="stat-label">접속 인원</span><span class="stat-value">${playerCount}명</span></div>
      <div class="server-stat"><span class="stat-label">세션 시간</span><span class="stat-value">${mins}분 ${secs}초</span></div>
      <div class="server-stat"><span class="stat-label">건물 수</span><span class="stat-value">${LOCATIONS.length}개</span></div>
      <div class="server-stat"><span class="stat-label">서버 상태</span><span class="stat-value" style="color:#4f4">정상</span></div>
    </div>`;
  } else if (tab === 'broadcast') {
    content.innerHTML = `<div class="bunker-broadcast">
      <p>전체 공지 방송을 보냅니다.</p>
      <textarea id="broadcast-msg" placeholder="방송 내용을 입력하세요..." rows="3" style="width:100%;background:#1a1a2e;color:#e0e0e0;border:1px solid #333;border-radius:4px;padding:8px;resize:none;"></textarea>
      <button class="promote-btn bunker-btn" onclick="sendBroadcast()">📢 전체 방송</button>
    </div>`;
  }
}

function getLocationName(x, z) {
  for (const loc of LOCATIONS) {
    const dx = Math.abs(x - loc.x);
    const dz = Math.abs(z - loc.z);
    if (dx < loc.w / 2 + 5 && dz < loc.d / 2 + 5) return loc.name;
  }
  return '야외';
}

function bunkerKick(id) {
  if (socket) socket.emit('admin-command', { type: 'kick', target: id });
  appendSystem(`[관리자] ${id} 추방 요청`);
}

function bunkerJail(id) {
  if (socket) socket.emit('admin-command', { type: 'jail', target: id, duration: 300, reason: '관리자 벙커에서 수감' });
  appendSystem(`[관리자] ${id} 영창 수감 요청`);
}

function sendBroadcast() {
  const msg = document.getElementById('broadcast-msg');
  if (msg && msg.value.trim()) {
    if (socket) socket.emit('chat', { message: `/공지 ${msg.value.trim()}` });
    appendSystem(`[방송] ${msg.value.trim()}`);
    msg.value = '';
  }
}

function buildingAction(action) {
  if (socket) socket.emit('chat', { message: `/building ${currentBuilding ? currentBuilding.name : ''} ${action}` });
  closeBuildingModal();
  appendSystem(`[${currentBuilding ? currentBuilding.name : ''}] ${action} 요청을 처리합니다.`);
}

// Training mini-game
function startTraining(type) {
  closeBuildingModal();
  appendSystem(`[훈련] ${type} 훈련을 시작합니다...`);
  let score = Math.floor(Math.random() * 40) + 60;
  setTimeout(() => {
    appendSystem(`[훈련 결과] ${type}: ${score}점 ${score >= 80 ? '(우수)' : score >= 60 ? '(통과)' : '(미달)'}`);
    if (socket) socket.emit('chat', { message: `/training complete ${type} ${score}` });
  }, 2000);
}

// ==================== GAME LOOP ====================
let posUpdateTimer = 0;

function animate() {
  if (!renderer) return;
  requestAnimationFrame(animate);

  if (player) {
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    let dx = 0, dz = 0;
    if (moveForward) { dx += forward.x * playerSpeed; dz += forward.z * playerSpeed; }
    if (moveBackward) { dx -= forward.x * playerSpeed; dz -= forward.z * playerSpeed; }
    if (moveLeft) { dx -= right.x * playerSpeed; dz -= right.z * playerSpeed; }
    if (moveRight) { dx += right.x * playerSpeed; dz += right.z * playerSpeed; }

    const isMoving = dx !== 0 || dz !== 0;
    let newX = player.position.x + dx;
    let newZ = player.position.z + dz;

    const boundary = 168;
    newX = Math.max(-boundary, Math.min(boundary, newX));
    newZ = Math.max(-boundary, Math.min(boundary, newZ));

    let blocked = false;
    const wallT = 0.3;
    const playerR = 0.3;
    for (const b of buildings) {
      if (b.height < 1) continue;
      if (b.enterable) {
        const insideX = newX > b.minX + wallT + playerR && newX < b.maxX - wallT - playerR;
        const insideZ = newZ > b.minZ + wallT + playerR && newZ < b.maxZ - wallT - playerR;
        const nearDoor = newX > b.doorMinX && newX < b.doorMaxX && Math.abs(newZ - b.doorZ) < 1.5;
        if (insideX && insideZ) continue;
        if (nearDoor) continue;
        // Wall collision
        if (newX > b.minX - playerR && newX < b.maxX + playerR && newZ > b.minZ - playerR && newZ < b.maxZ + playerR) {
          blocked = true; break;
        }
      } else {
        if (newX > b.minX - playerR && newX < b.maxX + playerR && newZ > b.minZ - playerR && newZ < b.maxZ + playerR) {
          blocked = true; break;
        }
      }
    }
    if (!blocked) { player.position.x = newX; player.position.z = newZ; }

    // Check if player is inside a building
    let nowInside = null;
    for (const b of buildings) {
      if (!b.enterable) continue;
      if (player.position.x > b.minX + wallT && player.position.x < b.maxX - wallT &&
          player.position.z > b.minZ + wallT && player.position.z < b.maxZ - wallT) {
        nowInside = b; break;
      }
    }
    if (nowInside !== insideBuilding) {
      if (insideBuilding && buildingGroups[insideBuilding.id]) {
        buildingGroups[insideBuilding.id].exterior.visible = true;
      }
      insideBuilding = nowInside;
      if (insideBuilding && buildingGroups[insideBuilding.id]) {
        buildingGroups[insideBuilding.id].exterior.visible = false;
      }
    }

    velocityY += gravity;
    player.position.y += velocityY;
    if (player.position.y <= 0) { player.position.y = 0; velocityY = 0; isJumping = false; }
    player.rotation.y = yaw;

    if (isMoving && !isJumping) {
      walkCycle += 0.12;
      const swing = Math.sin(walkCycle) * 0.5;
      if (player.userData.legL) player.userData.legL.rotation.x = swing;
      if (player.userData.legR) player.userData.legR.rotation.x = -swing;
      if (player.userData.armL) player.userData.armL.rotation.x = -swing * 0.7;
      if (player.userData.armR) player.userData.armR.rotation.x = swing * 0.7;
    } else {
      if (player.userData.legL) player.userData.legL.rotation.x = 0;
      if (player.userData.legR) player.userData.legR.rotation.x = 0;
      if (player.userData.armL) player.userData.armL.rotation.x = 0;
      if (player.userData.armR) player.userData.armR.rotation.x = 0;
    }

    const camDist = 4.5, camHeight = 3.0;
    camera.position.x = player.position.x - Math.sin(yaw) * camDist;
    camera.position.z = player.position.z - Math.cos(yaw) * camDist;
    camera.position.y = player.position.y + camHeight + Math.sin(pitch) * 3;
    camera.lookAt(player.position.x + Math.sin(yaw) * 3, player.position.y + 1.8 + pitch * 2, player.position.z + Math.cos(yaw) * 3);

    updateLocationLabel();
    updateInteractionHint();

    posUpdateTimer++;
    if (posUpdateTimer > 10) {
      if (firebaseListenersActive) {
        sendFirebasePosition();
      } else if (socket && socket.connected) {
        socket.emit('position', { x: player.position.x, y: player.position.y, z: player.position.z });
      }
      posUpdateTimer = 0;
    }
  }
  // Auto-fire for automatic weapons
  if (isFiring && isPointerLocked && WEAPONS[currentWeaponIndex].auto) {
    fireWeapon();
  }

  // Recoil recovery
  if (recoilOffset > 0) {
    recoilOffset *= 0.85;
    if (recoilOffset < 0.001) recoilOffset = 0;
  }
  if (weaponModel) {
    weaponModel.position.z = weaponModel.position.z + recoilOffset;
    if (recoilOffset > 0) weaponModel.position.z -= recoilOffset;
  }

  // Bullet trail cleanup
  for (let i = bulletTrails.length - 1; i >= 0; i--) {
    bulletTrails[i].life--;
    bulletTrails[i].mesh.material.opacity -= 0.08;
    if (bulletTrails[i].life <= 0) {
      scene.remove(bulletTrails[i].mesh);
      bulletTrails[i].mesh.geometry.dispose();
      bulletTrails[i].mesh.material.dispose();
      bulletTrails.splice(i, 1);
    }
  }

  drawMinimap();
  drawCompass();
  if (cctvActive) updateCCTVView();
  renderer.render(scene, camera);
}

function updateLocationLabel() {
  const label = document.getElementById('location-label');
  const px = player.position.x;
  const pz = player.position.z;
  let nearest = '야외';
  let minDist = Infinity;
  for (const loc of LOCATIONS) {
    const dist = Math.sqrt((px - loc.x) ** 2 + (pz - loc.z) ** 2);
    const threshold = Math.max(loc.w, loc.d) / 2 + 8;
    if (dist < threshold && dist < minDist) { minDist = dist; nearest = loc.name; }
  }
  label.textContent = nearest;
}

function updateInteractionHint() {
  const hint = document.getElementById('interaction-hint');
  if (!hint || !player) return;
  const px = player.position.x, pz = player.position.z;
  let nearBuilding = null;
  for (const b of buildings) {
    const dist = Math.sqrt((px - b.cx) ** 2 + (pz - b.cz) ** 2);
    if (dist < Math.max(b.w, b.d) / 2 + 5) { nearBuilding = b; break; }
  }
  if (nearBuilding) {
    hint.textContent = `[E] ${nearBuilding.name} 입장`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
}

function drawMinimap() {
  if (!minimapCtx || !player) return;
  const ctx = minimapCtx;
  const c = ctx.canvas;
  const cx = c.width / 2, cy = c.height / 2;
  const radius = cx;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#1a2a10';
  ctx.fillRect(0, 0, c.width, c.height);
  const scale = 0.45;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-yaw);
  LOCATIONS.forEach(loc => {
    const sx = (loc.x - player.position.x) * scale;
    const sy = (loc.z - player.position.z) * scale;
    ctx.fillStyle = loc.type === 'prison' ? '#5a2a0a' : loc.type === 'hq' ? '#3e5e2e' : '#4a5c3e';
    ctx.fillRect(sx - loc.w * scale / 2, sy - loc.d * scale / 2, loc.w * scale, loc.d * scale);
    ctx.strokeStyle = 'rgba(107,125,94,0.5)';
    ctx.strokeRect(sx - loc.w * scale / 2, sy - loc.d * scale / 2, loc.w * scale, loc.d * scale);
  });
  Object.values(otherPlayers).forEach(p => {
    const sx = (p.position.x - player.position.x) * scale;
    const sy = (p.position.z - player.position.z) * scale;
    ctx.fillStyle = '#4af';
    ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();
  ctx.fillStyle = '#5af';
  ctx.beginPath(); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx - 4, cy + 4); ctx.lineTo(cx + 4, cy + 4); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, radius - 1, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawCompass() {
  if (!compassCtx) return;
  const ctx = compassCtx;
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  const dirs = [
    { angle: 0, label: 'N', main: true },
    { angle: Math.PI / 4, label: 'NE', main: false },
    { angle: Math.PI / 2, label: 'E', main: true },
    { angle: 3 * Math.PI / 4, label: 'SE', main: false },
    { angle: Math.PI, label: 'S', main: true },
    { angle: 5 * Math.PI / 4, label: 'SW', main: false },
    { angle: 3 * Math.PI / 2, label: 'W', main: true },
    { angle: 7 * Math.PI / 4, label: 'NW', main: false },
  ];
  const centerX = c.width / 2;
  const pixelsPerRad = c.width / (Math.PI * 0.8);
  ctx.font = '700 13px "Noto Sans KR"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  dirs.forEach(d => {
    let diff = d.angle - (-yaw);
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const x = centerX + diff * pixelsPerRad;
    if (x < -20 || x > c.width + 20) return;
    ctx.fillStyle = d.label === 'N' ? '#e04040' : d.main ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.4)';
    ctx.font = d.main ? '700 13px "Noto Sans KR"' : '600 11px "Noto Sans KR"';
    ctx.fillText(d.label, x, c.height / 2);
  });
  for (let deg = 0; deg < 360; deg += 5) {
    const angle = deg * Math.PI / 180;
    let diff = angle - (-yaw);
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const x = centerX + diff * pixelsPerRad;
    if (x < 0 || x > c.width) continue;
    if (deg % 15 === 0 && deg % 45 !== 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '500 9px "Noto Sans KR"';
      ctx.fillText(deg.toString(), x, c.height / 2);
    } else if (deg % 5 === 0 && deg % 15 !== 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.moveTo(x, c.height - 2);
      ctx.lineTo(x, c.height - 6);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath(); ctx.moveTo(centerX, 0); ctx.lineTo(centerX, 3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(centerX, c.height); ctx.lineTo(centerX, c.height - 3); ctx.stroke();
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => { checkSession(); });
window.addEventListener('beforeunload', () => { cleanupFirebase(); });
