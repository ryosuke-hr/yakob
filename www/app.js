// ヤコブの画面。状態はサーバー（server/src/index.js）から WebSocket で受け取り、
// 変わるたびに render() で DOM を全部描き直す。ルール判定は game.js を共有する。
import { checkDiscard, takeableIndexes, handTotal, isJoker, CALL_LIMIT, MIN_PLAYERS, MAX_PLAYERS } from './game.js';

// Cloudflare に送ったサーバー（server/）の住所
const PROD_SERVER = 'wss://yakob.ryosuke-hr.workers.dev';
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const SERVER = IS_LOCAL ? 'ws://127.0.0.1:8787' : PROD_SERVER;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 見間違えやすい I O 0 1 は使わない

// ---- 保存 ----

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const app = {
  pid: load('yakob.pid') || newId(),
  name: load('yakob.name') || '',
  code: null, // 接続中の部屋
  ws: null,
  conn: 'idle', // idle | connecting | open
  retry: 0,
  retryTimer: null,
  creating: false, // 部屋を作るときの最初の接続
  view: null, // サーバーから届いた状態
  offset: 0, // サーバー時刻 − 端末の時刻
  selected: [],
  showScores: false,
  error: '',
};
store('yakob.pid', app.pid);

// ---- DOM ----

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (['value', 'disabled', 'hidden'].includes(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const SUIT_MARK = { S: '♠', H: '♥', D: '♦', C: '♣' };
const cardLabel = (c) => (isJoker(c) ? 'ジョーカー' : (c[0] === 'T' ? '10' : c[0]) + SUIT_MARK[c[1]]);
// カードは画像を使わず CSS で描く（隅に数字とマーク、中央に大きなマーク。絵札は中央に文字）
// マークの後ろの ︎ は、iPhone で絵文字にならないようにするため
function cardEl(c, cls = '') {
  if (isJoker(c)) {
    return h('div', { class: `card joker ${cls}`, role: 'img', 'aria-label': cardLabel(c) },
      h('span', { class: 'idx' }, 'JO', h('br'), 'KER'),
      h('span', { class: 'pip' }, '★'));
  }
  const rank = c[0] === 'T' ? '10' : c[0];
  const mark = SUIT_MARK[c[1]] + '︎';
  const face = 'JQK'.includes(c[0]);
  return h('div', { class: `card s${c[1]} ${cls}`, role: 'img', 'aria-label': cardLabel(c) },
    h('span', { class: 'idx' }, rank, h('br'), mark),
    h('span', { class: face ? 'pip face' : 'pip' }, face ? rank : mark),
    face ? null : h('span', { class: 'idx idx2' }, rank, h('br'), mark));
}
const backEl = (cls = '') => h('div', { class: `card back ${cls}` });

function fmtNum(n) {
  const r = Math.round(n * 100) / 100;
  return String(Math.abs(r));
}
// 累計: +12 / −4.5 / 0
function fmtScore(n) {
  if (Math.round(n * 100) === 0) return '0';
  return (n > 0 ? '+' : '−') + fmtNum(n);
}
// 1局の得点: +9 / −15 / ±0
function fmtDelta(n) {
  if (Math.round(n * 100) === 0) return '±0';
  return (n > 0 ? '+' : '−') + fmtNum(n);
}
const signClass = (n) => (Math.round(n * 100) > 0 ? 'plus' : Math.round(n * 100) < 0 ? 'minus' : '');

let toastTimer = null;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// ---- 通信 ----

function connect() {
  clearTimeout(app.retryTimer);
  if (!SERVER) {
    app.error = 'サーバーがまだ設定されていません';
    leaveToTop();
    return;
  }
  const code = app.code;
  const params = new URLSearchParams({ pid: app.pid, name: app.name });
  if (app.creating) params.set('create', '1');
  const ws = new WebSocket(`${SERVER}/ws/${code}?${params}`);
  app.ws = ws;
  app.conn = 'connecting';

  ws.onopen = () => {
    if (app.ws !== ws) return;
    app.conn = 'open';
    app.retry = 0;
  };
  ws.onmessage = (event) => {
    if (app.ws !== ws) return;
    const msg = JSON.parse(event.data);
    if (msg.t === 'state') {
      app.creating = false;
      app.offset = msg.serverNow - Date.now();
      // 自分の番が終わったら選んでいた札を外す
      if (msg.state.round?.turnId !== app.view?.round?.turnId) app.selected = [];
      const prev = app.view;
      app.view = msg.state;
      render();
      animateLastAction(prev, msg.state);
    } else if (msg.t === 'error') {
      if (msg.code === 'rule') {
        toast(msg.message);
      } else if (msg.code === 'exists' && app.creating) {
        // 部屋コードがたまたま使われていたら作り直す
        app.ws = null;
        app.code = randomCode();
        history.replaceState(null, '', `#/room/${app.code}`);
        connect();
      } else {
        app.error = msg.message;
        leaveToTop();
      }
    }
  };
  ws.onclose = () => {
    if (app.ws !== ws) return;
    app.ws = null;
    app.conn = 'idle';
    // 部屋にいる間は、切れたらつなぎ直す
    if (app.code) {
      const wait = Math.min(1000 * 2 ** app.retry, 10000);
      app.retry += 1;
      app.retryTimer = setTimeout(connect, wait);
    }
    render();
  };
}

function send(msg) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(msg));
  else toast('接続が切れています。つなぎ直しています…');
}

function disconnect() {
  clearTimeout(app.retryTimer);
  const ws = app.ws;
  app.ws = null;
  app.code = null;
  app.view = null;
  app.selected = [];
  app.showScores = false;
  app.conn = 'idle';
  if (ws) ws.close();
}

function leaveToTop() {
  disconnect();
  if (location.hash !== '#/') location.hash = '#/';
  else render();
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

// ---- ルーティング ----

function route() {
  const m = location.hash.match(/^#\/room\/([A-Za-z0-9]+)$/);
  const code = m ? m[1].toUpperCase() : null;
  if (code && !app.name) {
    // 招待リンクから来て、まだ名前が無い
    disconnect();
    app.inviteCode = code;
    render();
    return;
  }
  if (code !== app.code) {
    disconnect();
    if (code) {
      app.code = code;
      connect();
    }
  }
  render();
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  // スマホをスリープから戻したとき、すぐにつなぎ直す
  if (document.visibilityState === 'visible' && app.code && !app.ws) {
    app.retry = 0;
    connect();
  }
});

// ---- 画面 ----

const root = document.getElementById('app');

function render() {
  const v = app.view;
  let screen;
  if (!app.code) screen = renderTop();
  else if (!v) screen = [h('p', { class: 'muted', style: 'text-align:center;margin-top:30vh' }, '部屋につないでいます…')];
  else if (v.status === 'lobby') screen = renderLobby(v);
  else if (v.status === 'playing') screen = renderGame(v);
  else screen = renderReveal(v);

  root.replaceChildren(...[].concat(screen).filter(Boolean));
  if (app.code && app.conn !== 'open' && v) root.prepend(h('div', { class: 'conn' }, '接続が切れました。つなぎ直しています…'));
  if (app.showScores && v) root.append(renderScores(v));
  updateTimers();
}

function header(v) {
  return h('div', { class: 'row spread' },
    h('span', { class: 'muted' }, `部屋 ${v.code}`, v.roundNum ? `・第${v.roundNum}局` : ''),
    h('div', { class: 'row' },
      h('button', { class: 'small', onclick: () => { app.showScores = true; render(); } }, '得点表'),
      h('button', { class: 'small', onclick: leaveRoom }, '退出'),
    ),
  );
}

function leaveRoom() {
  if (!confirm('部屋から退出しますか？この部屋での累計は消えます')) return;
  send({ t: 'leave' });
  leaveToTop();
}

function renderTop() {
  const nameInput = h('input', { value: app.name, maxlength: '12', placeholder: 'ニックネーム', autocomplete: 'nickname' });
  const codeInput = h('input', { class: 'code-input', value: app.inviteCode || '', maxlength: '8', placeholder: '部屋コード', autocapitalize: 'characters' });
  const errorEl = h('p', { class: 'error' }, app.error);

  const takeName = () => {
    const name = nameInput.value.trim();
    if (!name) {
      errorEl.textContent = 'ニックネームを入れてください';
      nameInput.focus();
      return null;
    }
    app.name = name;
    store('yakob.name', name);
    app.error = '';
    return name;
  };
  const create = () => {
    if (!takeName()) return;
    app.inviteCode = null;
    app.creating = true;
    location.hash = `#/room/${randomCode()}`;
  };
  const join = () => {
    if (!takeName()) return;
    const code = codeInput.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) {
      errorEl.textContent = '部屋コードを入れてください';
      codeInput.focus();
      return;
    }
    app.inviteCode = null;
    app.creating = false;
    if (location.hash === `#/room/${code}`) route();
    else location.hash = `#/room/${code}`;
  };

  return [
    h('div', { class: 'logo' }, 'ヤコブ'),
    h('div', { class: 'logo-cards' }, cardEl('AS'), cardEl('1J'), cardEl('KH')),
    h('div', { class: 'stack' },
      h('label', { class: 'muted' }, 'ニックネーム'),
      nameInput,
      errorEl,
      app.inviteCode
        ? h('button', { class: 'primary', onclick: join }, `部屋 ${app.inviteCode} に入る`)
        : h('button', { class: 'primary', onclick: create }, '部屋を作る'),
      h('p', { class: 'muted', style: 'margin:16px 0 0' }, '部屋コードで入る'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, codeInput), h('button', { onclick: join }, '入る')),
    ),
    h('p', { class: 'muted', style: 'margin-top:auto;text-align:center' }, `${MIN_PLAYERS}〜${MAX_PLAYERS}人で遊べます。手札の合計が${CALL_LIMIT}以下になったら「ヤコブ！」`),
  ];
}

function seat(v, p, { showCards = false } = {}) {
  const r = v.round;
  const isTurn = r && r.turnId === p.id;
  const cls = ['seat', isTurn && 'turn', p.id === v.me && 'me', !p.connected && 'off'].filter(Boolean).join(' ');
  let status = null;
  if (!p.connected) status = h('span', { class: 'status' }, '切断中');
  else if (isTurn && p.id !== v.me) status = h('span', { class: 'status' }, '考え中… ', h('span', { class: 'timer' }));
  else if (r && p.cardCount === null) status = h('span', { class: 'muted' }, '次の局から参加');

  return h('div', { class: cls },
    h('div', {},
      h('span', { class: 'name' }, p.name),
      p.id === v.hostId ? h('span', { class: 'tag' }, '部屋主') : null,
      h('span', { class: `score ${signClass(p.score)}` }, fmtScore(p.score)),
      p.last !== null ? h('span', { class: `last ${signClass(p.last)}` }, `(${fmtDelta(p.last)})`) : null,
    ),
    h('div', { class: 'row' },
      status,
      showCards && p.cardCount ? h('span', { class: 'backs' }, Array.from({ length: p.cardCount }, () => h('span', { class: 'mini' }))) : null,
    ),
  );
}

function renderLobby(v) {
  const isHost = v.me === v.hostId;
  const url = `${location.origin}${location.pathname}#/room/${v.code}`;
  const share = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'ヤコブ', text: `ヤコブの部屋 ${v.code} に招待します`, url }); } catch {}
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('招待リンクをコピーしました');
    } catch {
      prompt('このリンクを送ってください', url);
    }
  };
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(v.code);
      toast('部屋コードをコピーしました');
    } catch {}
  };
  const enough = v.players.length >= MIN_PLAYERS;

  return [
    header(v),
    h('div', { class: 'stack', style: 'text-align:center;margin:24px 0 8px' },
      h('span', { class: 'muted' }, '部屋コード'),
      h('button', { style: 'font-size:36px;font-weight:700;letter-spacing:0.2em;background:none', onclick: copyCode }, v.code),
      h('button', { onclick: share }, '招待リンクを送る'),
    ),
    h('p', { class: 'muted' }, `参加者 ${v.players.length}/${MAX_PLAYERS}`),
    h('div', { class: 'stack' }, v.players.map((p) => seat(v, p))),
    h('div', { class: 'stack', style: 'margin-top:auto' },
      isHost
        ? h('button', { class: 'primary', onclick: () => send({ t: 'start' }), disabled: !enough }, enough ? '開始' : `あと${MIN_PLAYERS - v.players.length}人で始められます`)
        : h('p', { class: 'muted', style: 'text-align:center' }, '部屋主が始めるのを待っています'),
    ),
  ];
}

function describeLast(v) {
  const a = v.round.lastAction;
  if (!a) return '';
  const who = v.names[a.by] || '?';
  const discarded = a.discarded.map(cardLabel).join(' ');
  return a.took ? `${who}: ${discarded} を捨てて、${cardLabel(a.took)} を取った` : `${who}: ${discarded} を捨てて、山札から引いた`;
}

// 自分を下にして、ほかのプレイヤーを時計回り（左 → 上 → 右）にテーブルのまわりへ並べる
const RING_POSITIONS = { 1: ['top'], 2: ['upleft', 'upright'], 3: ['left', 'top', 'right'] };

function ringSeat(v, p, pos) {
  const r = v.round;
  const isTurn = r.turnId === p.id;
  const isMe = p.id === v.me;
  let status = null;
  if (!p.connected) status = '切断中';
  else if (isTurn) status = [isMe ? 'あなたの番 ' : '考え中 ', h('span', { class: 'timer' })];
  else if (p.cardCount === null) status = '次の局から参加';
  const cls = ['rseat', `pos-${pos}`, isTurn && 'turn', isMe && 'me', !p.connected && 'off'].filter(Boolean).join(' ');

  return h('div', { class: cls, 'data-pid': p.id },
    h('div', { class: 'name' }, p.name, p.id === v.hostId ? h('span', { class: 'tag' }, '部屋主') : null),
    h('div', {},
      h('span', { class: `score ${signClass(p.score)}` }, fmtScore(p.score)),
      p.last !== null ? h('span', { class: `last ${signClass(p.last)}` }, `(${fmtDelta(p.last)})`) : null,
    ),
    !isMe && p.cardCount ? h('div', { class: 'backs' }, Array.from({ length: p.cardCount }, () => h('span', { class: 'mini' }))) : null,
    status ? h('div', { class: 'status' }, status) : null,
  );
}

function renderGame(v) {
  const r = v.round;
  const myIndex = v.players.findIndex((p) => p.id === v.me);
  const me = v.players[myIndex];
  const others = v.players.slice(myIndex + 1).concat(v.players.slice(0, myIndex));
  const positions = RING_POSITIONS[others.length] || [];
  const myTurn = r.turnId === v.me;
  const hand = v.hand;
  const check = checkDiscard(app.selected);
  const canDraw = myTurn && check.ok;
  const ends = takeableIndexes(r.top);

  const move = (draw) => {
    if (!canDraw) return;
    send({ t: 'move', cards: app.selected, draw });
    app.selected = [];
  };
  const toggle = (c) => {
    if (!myTurn) return;
    app.selected = app.selected.includes(c) ? app.selected.filter((x) => x !== c) : app.selected.concat(c);
    render();
  };

  let hint = '';
  if (!hand) hint = 'この局は観戦中です。次の局から参加します';
  else if (!myTurn) hint = `${v.names[r.turnId] || ''} の番です`;
  else if (!app.selected.length) hint = '捨てる札を選んでください';
  else if (!check.ok) hint = check.reason;
  else hint = '山札か、光っている捨て札をタップして引きます';

  const deck = h('button', { class: 'card-btn deck', onclick: () => move('deck'), disabled: !canDraw, 'aria-label': '山札から引く' },
    backEl(), backEl(), backEl(canDraw ? 'takeable' : ''));
  const top = h('div', { class: 'top-set' }, r.top.map((c, i) => {
    const takeable = canDraw && ends.includes(i);
    return h('button', { class: 'card-btn', onclick: () => move(i), disabled: !takeable, 'aria-label': `${cardLabel(c)} を取る` }, cardEl(c, takeable ? 'takeable' : ''));
  }));

  const total = hand ? handTotal(hand) : null;
  return [
    header(v),
    h('div', { class: 'ring' },
      h('div', { class: 'ring-felt' }),
      others.map((p, i) => ringSeat(v, p, positions[i])),
      h('div', { class: 'ring-center' },
        h('div', {}, deck, h('div', { class: 'pile-label' }, `山札 ${r.deckCount}`)),
        h('div', {}, top, h('div', { class: 'pile-label' }, r.topBy ? `${v.names[r.topBy]} の捨て札` : '最初の捨て札')),
      ),
      me ? ringSeat(v, me, 'bottom') : null,
    ),
    h('div', { class: 'last-action' }, describeLast(v)),
    hand ? h('div', { class: 'hand-info' }, h('span', { class: 'muted' }, '手札の合計'), h('span', { class: 'total' }, total)) : null,
    hand ? h('div', { class: 'hand' }, hand.map((c) => h('button', { class: 'card-btn', onclick: () => toggle(c), 'aria-label': cardLabel(c) }, cardEl(c, app.selected.includes(c) ? 'selected' : '')))) : null,
    h('p', { class: 'hint' }, hint),
    myTurn && total <= CALL_LIMIT
      ? h('button', { class: 'primary yakob-btn', onclick: () => send({ t: 'yakob' }) }, 'ヤコブ！')
      : null,
  ];
}

// ---- アニメーション ----
// 手番が進んだら、捨てた札が席から捨て札へ、取った札が捨て札（山札）から席へ動く。
// 何を取っていったか分かるよう、捨て札から取った札は持ち上げて光らせてから運ぶ。

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const centerOf = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

function animateLastAction(prev, next) {
  const a = next.round?.lastAction;
  if (!a || !prev?.round || prev.roundNum !== next.roundNum || reduceMotion()) return;
  if (JSON.stringify(prev.round.lastAction) === JSON.stringify(a)) return;
  const seatEl = root.querySelector(`.rseat[data-pid="${a.by}"]`);
  const pileEl = root.querySelector('.top-set');
  const deckEl = root.querySelector('.deck');
  if (!seatEl || !pileEl || !deckEl) return;
  const seat = centerOf(seatEl.getBoundingClientRect());

  // 捨てた札: 席から飛んできて捨て札に重なる
  for (const el of pileEl.querySelectorAll('.card')) {
    const to = centerOf(el.getBoundingClientRect());
    el.animate([
      { transform: `translate(${seat.x - to.x}px, ${seat.y - to.y}px) scale(0.5)`, opacity: 0.4 },
      { transform: 'none', opacity: 1 },
    ], { duration: 450, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  }

  // 取った札: 元の捨て札の端（または山札）から席へ
  const pileRect = pileEl.getBoundingClientRect();
  const cardW = pileEl.querySelector('.card').offsetWidth; // 飛んでくる途中の縮小を含めない大きさ
  let from;
  if (a.took) {
    const fromLeft = prev.round.top[0] === a.took;
    from = { x: fromLeft ? pileRect.left + cardW / 2 : pileRect.right - cardW / 2, y: pileRect.top + pileRect.height / 2 };
  } else {
    from = centerOf(deckEl.getBoundingClientRect());
  }
  const ghost = a.took ? cardEl(a.took, 'flying taken') : backEl('flying');
  ghost.style.setProperty('--card-w', `${cardW}px`);
  ghost.style.left = `${from.x - cardW / 2}px`;
  ghost.style.top = `${from.y - (cardW * 7) / 10}px`;
  document.body.append(ghost);
  const dx = seat.x - from.x;
  const dy = seat.y - from.y;
  const frames = a.took
    ? [
      { transform: 'none', offset: 0 },
      { transform: 'translateY(-14px) scale(1.25)', offset: 0.3 },
      { transform: 'translateY(-14px) scale(1.25)', offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.45)`, opacity: 0.6, offset: 1 },
    ]
    : [
      { transform: 'none' },
      { transform: `translate(${dx}px, ${dy}px) scale(0.45)`, opacity: 0.6 },
    ];
  const anim = ghost.animate(frames, { duration: a.took ? 1200 : 600, delay: 150, easing: 'ease-in-out', fill: 'both' });
  anim.onfinish = () => ghost.remove();
  anim.oncancel = () => ghost.remove();

  const line = root.querySelector('.last-action');
  line?.animate([{ backgroundColor: 'rgba(250, 199, 117, 0.35)' }, { backgroundColor: 'rgba(250, 199, 117, 0)' }], { duration: 1800 });
}

function renderReveal(v) {
  const res = v.result;
  const isHost = v.me === v.hostId;
  const caller = v.names[res.callerId];
  const ids = Object.keys(res.totals);
  return [
    header(v),
    h('div', { class: `banner ${res.type === 'return' ? 'return' : ''}` },
      res.type === 'return' ? 'ヤコブ返し！' : `${caller} の ヤコブ！`),
    res.type === 'return' ? h('p', { class: 'muted', style: 'text-align:center;margin:0' }, `${caller} が宣言したけど、返されました`) : null,
    h('div', { class: 'stack' }, ids.map((id) => {
      const p = v.players.find((x) => x.id === id);
      const cls = ['reveal-row', res.winners.includes(id) && 'winner', res.losers.includes(id) && 'loser'].filter(Boolean).join(' ');
      return h('div', { class: cls },
        h('div', { class: 'row spread' },
          h('span', {}, h('b', {}, v.names[id]), id === res.callerId ? h('span', { class: 'muted' }, '（宣言）') : null),
          h('span', {}, `合計 ${res.totals[id]}`),
        ),
        h('div', { class: 'row spread' },
          h('div', { class: 'reveal-cards' }, res.hands[id].map((c) => cardEl(c))),
          h('div', { style: 'text-align:right' },
            h('div', { class: signClass(res.deltas[id]), style: 'font-size:20px;font-weight:700' }, fmtDelta(res.deltas[id])),
            p ? h('div', { class: 'muted' }, `累計 ${fmtScore(p.score)}`) : h('div', { class: 'muted' }, '退出しました'),
          ),
        ),
      );
    })),
    h('div', { class: 'stack', style: 'margin-top:auto' },
      isHost
        ? h('button', { class: 'primary', onclick: () => send({ t: 'start' }), disabled: v.players.length < MIN_PLAYERS }, '次の局へ')
        : h('p', { class: 'muted', style: 'text-align:center' }, '部屋主が次の局を始めるのを待っています'),
      h('button', { onclick: () => { app.showScores = true; render(); } }, '得点表'),
    ),
  ];
}

function renderScores(v) {
  // 退出した人も、得点がついた局があれば列に残す
  const ids = v.players.map((p) => p.id);
  for (const row of v.history) for (const id of Object.keys(row.deltas)) if (!ids.includes(id)) ids.push(id);
  const sum = (id) => v.history.reduce((s, row) => s + (row.deltas[id] ?? 0), 0);
  const close = () => { app.showScores = false; render(); };

  return h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'sheet' },
      h('div', { class: 'row spread' }, h('h2', {}, '得点表'), h('button', { class: 'small', style: 'background:none;color:inherit', onclick: close }, '閉じる')),
      v.history.length === 0
        ? h('p', {}, 'まだ得点はありません')
        : h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '局'), ids.map((id) => h('th', {}, v.names[id] || '?')))),
          h('tbody', {}, v.history.map((row) => h('tr', {},
            h('td', {}, `${row.num}${row.type === 'return' ? ' 返し' : ''}`),
            ids.map((id) => h('td', { class: signClass(row.deltas[id] ?? 0) }, id in row.deltas ? fmtDelta(row.deltas[id]) : '−')),
          ))),
          h('tfoot', {}, h('tr', {}, h('td', {}, '累計'), ids.map((id) => h('td', { class: signClass(sum(id)) }, fmtScore(sum(id)))))),
        ),
    ),
  );
}

// 残り秒数だけは描き直さずに毎秒書き換える
function updateTimers() {
  const r = app.view?.round;
  if (!r) return;
  const left = Math.max(0, Math.ceil((r.deadline - (Date.now() + app.offset)) / 1000));
  for (const el of document.querySelectorAll('.timer')) {
    el.textContent = `${left}秒`;
    el.classList.toggle('low', left <= 10);
  }
}
setInterval(updateTimers, 250);

route();
