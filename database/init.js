const bcrypt = require('bcryptjs');

const FIREBASE_URL = (process.env.FIREBASE_DATABASE_URL || 'https://rbseo-76409-default-rtdb.asia-southeast1.firebasedatabase.app').replace(/\/$/, '');

class FirebaseDB {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  ref(path) {
    return new FirebaseRef(this.baseUrl, path);
  }
}

class FirebaseRef {
  constructor(baseUrl, path) {
    this.baseUrl = baseUrl;
    this.path = path || '';
  }

  child(childPath) {
    return new FirebaseRef(this.baseUrl, `${this.path}/${childPath}`);
  }

  async set(data) {
    const url = `${this.baseUrl}/${this.path}.json`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Firebase SET failed: ${res.status}`);
    return await res.json();
  }

  async update(data) {
    const url = `${this.baseUrl}/${this.path}.json`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`Firebase UPDATE failed: ${res.status}`);
    return await res.json();
  }

  async once(eventType) {
    let url = `${this.baseUrl}/${this.path}.json`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firebase GET failed: ${res.status}`);
    let data = await res.json();

    if (this._orderBy && this._equalTo !== undefined && data && typeof data === 'object') {
      const filtered = {};
      for (const key of Object.keys(data)) {
        const item = data[key];
        if (item && item[this._orderBy] === this._equalTo) {
          filtered[key] = item;
        }
      }
      data = Object.keys(filtered).length > 0 ? filtered : null;
    } else if (this._orderBy && data && typeof data === 'object') {
      if (this._limitToLast) {
        const entries = Object.entries(data);
        const sorted = entries.sort((a, b) => {
          const va = a[1][this._orderBy] || 0;
          const vb = b[1][this._orderBy] || 0;
          return va < vb ? -1 : va > vb ? 1 : 0;
        });
        const sliced = sorted.slice(-this._limitToLast);
        data = {};
        for (const [k, v] of sliced) data[k] = v;
      }
    }

    return new FirebaseSnapshot(data);
  }

  push() {
    const id = generatePushId();
    return new FirebaseRefWithKey(this.baseUrl, `${this.path}/${id}`, id);
  }

  orderByChild(child) {
    const ref = new FirebaseRef(this.baseUrl, this.path);
    ref._orderBy = child;
    ref._equalTo = this._equalTo;
    ref._limitToLast = this._limitToLast;
    return ref;
  }

  equalTo(value) {
    const ref = new FirebaseRef(this.baseUrl, this.path);
    ref._orderBy = this._orderBy;
    ref._equalTo = value;
    ref._limitToLast = this._limitToLast;
    return ref;
  }

  limitToLast(n) {
    const ref = new FirebaseRef(this.baseUrl, this.path);
    ref._orderBy = this._orderBy;
    ref._equalTo = this._equalTo;
    ref._limitToLast = n;
    return ref;
  }
}

class FirebaseRefWithKey extends FirebaseRef {
  constructor(baseUrl, path, key) {
    super(baseUrl, path);
    this.key = key;
  }

  async set(data) {
    return super.set(data);
  }
}

class FirebaseSnapshot {
  constructor(data) {
    this._data = data;
  }

  exists() {
    return this._data !== null && this._data !== undefined;
  }

  val() {
    return this._data;
  }

  forEach(callback) {
    if (!this._data || typeof this._data !== 'object') return;
    for (const key of Object.keys(this._data)) {
      callback(new FirebaseChildSnapshot(key, this._data[key]));
    }
  }
}

class FirebaseChildSnapshot {
  constructor(key, data) {
    this.key = key;
    this._data = data;
  }

  val() {
    return this._data;
  }

  exists() {
    return this._data !== null && this._data !== undefined;
  }
}

let lastPushTime = 0;
let lastRandChars = [];
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

function generatePushId() {
  let now = Date.now();
  const timeStampChars = new Array(8);
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
    now = Math.floor(now / 64);
  }

  let id = timeStampChars.join('');
  for (let i = 0; i < 12; i++) {
    id += PUSH_CHARS.charAt(Math.floor(Math.random() * 64));
  }
  return id;
}

function initDatabase() {
  const db = new FirebaseDB(FIREBASE_URL);
  initAdmin(db);
  return db;
}

async function initAdmin(db) {
  try {
    const snap = await db.ref('users').orderByChild('username').equalTo('ree1203').once('value');
    if (!snap.exists()) {
      const password = process.env.ADMIN_INITIAL_PASSWORD || 'admin1234';
      const hash = await bcrypt.hash(password, 12);
      const ref = db.ref('users').push();
      await ref.set({
        username: 'ree1203',
        password_hash: hash,
        nickname: '이주람',
        rank_index: 18,
        affiliation: '육군',
        is_admin: true,
        role: 'admin',
        created_at: Date.now(),
        last_login: null,
        position: { x: 0, y: 0, z: 0 }
      });
      console.log('관리자 계정 생성 완료 (아이디: ree1203)');
    } else {
      console.log('관리자 계정이 이미 존재합니다.');
    }
  } catch (err) {
    console.error('관리자 초기화 오류:', err.message);
  }
}

module.exports = { initDatabase };
