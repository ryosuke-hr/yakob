// ヤコブのルール。サーバー（server/src/room.js）と画面（app.js）の両方から読み込む。
// DOM や通信には触らない。カードは "7H" のような文字列（ランク + マーク）で表す。
// ランク: A 2-9 T J Q K / マーク: S H D C / ジョーカー: "1J" "2J"

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const JOKERS = ['1J', '2J'];

export const HAND_SIZE = 5;
export const CALL_LIMIT = 5;
export const RETURN_POINTS = 15;
export const TURN_SECONDS = 30;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export const isJoker = (c) => JOKERS.includes(c);
// A=1 … K=13、ジョーカーは 0。点数と連番の並びの両方に使う
export const cardValue = (c) => (isJoker(c) ? 0 : RANKS.indexOf(c[0]) + 1);
export const cardSuit = (c) => (isJoker(c) ? null : c[1]);
export const handTotal = (cards) => cards.reduce((s, c) => s + cardValue(c), 0);

export function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck.concat(JOKERS);
}

// rand(n) は 0 以上 n 未満の整数を返す関数
export function shuffle(cards, rand) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sortHand(cards) {
  return cards.slice().sort((a, b) => cardValue(a) - cardValue(b) || suitOrder(a) - suitOrder(b));
}
const suitOrder = (c) => (isJoker(c) ? 9 + JOKERS.indexOf(c) : SUITS.indexOf(c[1]));

// 捨てる組み合わせを判定する。
// 成功: { ok: true, kind: 'single'|'set'|'run', ordered }（ordered は捨て札として並べる順）
// 失敗: { ok: false, reason }
export function checkDiscard(cards) {
  if (cards.length === 0) return { ok: false, reason: '捨てる札を選んでください' };
  if (new Set(cards).size !== cards.length) return { ok: false, reason: '同じ札が重なっています' };
  if (cards.length === 1) return { ok: true, kind: 'single', ordered: cards.slice() };

  const naturals = cards.filter((c) => !isJoker(c));
  const jokers = cards.filter(isJoker);

  // 同じ数字の組（ジョーカーは何にでもなれる）
  if (naturals.every((c) => c[0] === naturals[0][0])) {
    return { ok: true, kind: 'set', ordered: sortHand(naturals).concat(jokers) };
  }

  if (cards.length < 3) return { ok: false, reason: '2枚なら同じ数字の組にしてください' };
  if (!naturals.every((c) => c[1] === naturals[0][1])) {
    return { ok: false, reason: '連番は同じマークでそろえてください' };
  }
  const vals = naturals.map(cardValue).sort((a, b) => a - b);
  if (new Set(vals).size !== vals.length) return { ok: false, reason: '連番に同じ数字は入れられません' };
  const min = vals[0];
  const max = vals[vals.length - 1];
  const gaps = max - min + 1 - vals.length;
  if (gaps > jokers.length) return { ok: false, reason: '数字がつながっていません' };

  // 穴をジョーカーで埋め、余ったジョーカーは上（K を超えるなら下）につなげる
  const pool = jokers.slice();
  const byValue = new Map(naturals.map((c) => [cardValue(c), c]));
  const ordered = [];
  for (let v = min; v <= max; v++) ordered.push(byValue.get(v) ?? pool.shift());
  let hi = max;
  let lo = min;
  while (pool.length) {
    if (hi < 13) { ordered.push(pool.shift()); hi++; }
    else if (lo > 1) { ordered.unshift(pool.shift()); lo--; }
    else return { ok: false, reason: '数字がつながっていません' };
  }
  return { ok: true, kind: 'run', ordered };
}

// 捨て札の組のうち、次の人が取れる位置（両端）
export function takeableIndexes(top) {
  if (top.length === 0) return [];
  return top.length === 1 ? [0] : [0, top.length - 1];
}

// ---- 局の進行 ----
// room: { hostId, players: [{ id, name, score, last }], status: 'lobby'|'playing'|'reveal',
//         round, result, history: [{ num, type, callerId, deltas }], roundNum, nextStarter }
// round: { participants: [id], hands: { id: [card] }, deck, pile, top, topBy, turn, deadline, lastAction }
// 失敗したら Error を投げる（メッセージは画面にそのまま出す日本語）

export function createRoom(code) {
  return { code, hostId: null, players: [], names: {}, status: 'lobby', round: null, result: null, history: [], roundNum: 0, nextStarter: null };
}

export function joinRoom(room, id, name) {
  const p = room.players.find((x) => x.id === id);
  if (p) {
    p.name = name;
  } else {
    if (room.players.length >= MAX_PLAYERS) throw new Error('部屋が満員です');
    room.players.push({ id, name, score: 0, last: null });
    if (!room.hostId) room.hostId = id;
  }
  room.names[id] = name;
}

export function startRound(room, byId, rand, now) {
  if (byId !== room.hostId) throw new Error('局を始められるのは部屋主だけです');
  if (room.status === 'playing') throw new Error('すでに対戦中です');
  if (room.players.length < MIN_PLAYERS) throw new Error(`${MIN_PLAYERS}人以上そろってから始めてください`);

  const participants = room.players.map((p) => p.id);
  const deck = shuffle(newDeck(), rand);
  const hands = {};
  for (const id of participants) hands[id] = sortHand(deck.splice(-HAND_SIZE));
  const top = [deck.pop()];

  let turn = participants.indexOf(room.nextStarter);
  if (turn < 0) turn = Math.max(0, participants.indexOf(room.hostId));

  room.roundNum += 1;
  room.status = 'playing';
  room.result = null;
  room.round = { participants, hands, deck, pile: [], top, topBy: null, turn, deadline: now + TURN_SECONDS * 1000, lastAction: null };
}

export const currentPlayer = (room) => room.round && room.round.participants[room.round.turn];

function assertTurn(room, id) {
  if (room.status !== 'playing') throw new Error('対戦中ではありません');
  if (currentPlayer(room) !== id) throw new Error('あなたの番ではありません');
}

// draw: 'deck' か、捨て札の組の位置（takeableIndexes のどれか）
export function playMove(room, id, cards, draw, rand, now) {
  assertTurn(room, id);
  const r = room.round;
  const hand = r.hands[id];
  if (!Array.isArray(cards) || !cards.every((c) => hand.includes(c))) throw new Error('手札にない札です');
  const check = checkDiscard(cards);
  if (!check.ok) throw new Error(check.reason);

  let took = null;
  if (draw === 'deck') {
    if (r.deck.length === 0) {
      r.deck = shuffle(r.pile, rand);
      r.pile = [];
    }
    if (r.deck.length === 0) throw new Error('山札がありません。捨て札から引いてください');
    took = r.deck.pop();
    r.pile.push(...r.top);
  } else {
    if (!takeableIndexes(r.top).includes(draw)) throw new Error('その札は取れません');
    took = r.top[draw];
    r.pile.push(...r.top.filter((_, i) => i !== draw));
  }

  r.hands[id] = sortHand(hand.filter((c) => !cards.includes(c)).concat(took));
  r.lastAction = { by: id, discarded: check.ordered, took: draw === 'deck' ? null : took };
  r.top = check.ordered;
  r.topBy = id;
  advanceTurn(room, now);
}

function advanceTurn(room, now) {
  const r = room.round;
  r.turn = (r.turn + 1) % r.participants.length;
  r.deadline = now + TURN_SECONDS * 1000;
}

// 時間切れ: いちばん点数の大きい札を1枚捨てて、山札（無ければ捨て札）から引く
export function autoMove(room, rand, now) {
  const id = currentPlayer(room);
  const hand = room.round.hands[id];
  const worst = hand.reduce((a, b) => (cardValue(b) >= cardValue(a) ? b : a));
  const deckEmpty = room.round.deck.length === 0 && room.round.pile.length === 0;
  playMove(room, id, [worst], deckEmpty ? 0 : 'deck', rand, now);
}

export function callYakob(room, id) {
  assertTurn(room, id);
  const r = room.round;
  const totals = {};
  for (const pid of r.participants) totals[pid] = handTotal(r.hands[pid]);
  const w = totals[id];
  if (w > CALL_LIMIT) throw new Error(`手札の合計が${CALL_LIMIT}以下のときだけ宣言できます`);

  const others = r.participants.filter((pid) => pid !== id);
  const deltas = Object.fromEntries(r.participants.map((pid) => [pid, 0]));
  const returners = others.filter((pid) => totals[pid] <= w);
  let type;
  let winners;
  let losers;
  if (returners.length) {
    type = 'return';
    const m = Math.min(...returners.map((pid) => totals[pid]));
    winners = returners.filter((pid) => totals[pid] === m);
    losers = [id];
    deltas[id] = -RETURN_POINTS;
    for (const pid of winners) deltas[pid] = RETURN_POINTS / winners.length;
  } else {
    type = 'yakob';
    const M = Math.max(...others.map((pid) => totals[pid]));
    winners = [id];
    losers = others.filter((pid) => totals[pid] === M);
    deltas[id] = M - w;
    for (const pid of losers) deltas[pid] = -(M - w) / losers.length;
  }

  for (const p of room.players) {
    p.last = has(deltas, p.id) ? deltas[p.id] : null;
    if (p.last !== null) p.score += p.last;
  }

  // 次の局は負けた人から。複数なら宣言した人から時計回りで最初の人
  const ci = r.participants.indexOf(id);
  const order = r.participants.slice(ci).concat(r.participants.slice(0, ci));
  room.nextStarter = order.find((pid) => losers.includes(pid));

  room.history.push({ num: room.roundNum, type, callerId: id, deltas });
  room.result = { num: room.roundNum, type, callerId: id, winners, losers, hands: r.hands, totals, deltas };
  room.status = 'reveal';
  room.round = null;
}
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

// 退出。部屋に誰もいなくなったら true を返す
export function leaveRoom(room, id, now) {
  const idx = room.players.findIndex((p) => p.id === id);
  if (idx < 0) return room.players.length === 0;
  room.players.splice(idx, 1);
  if (room.hostId === id) room.hostId = room.players[0]?.id ?? null;

  const r = room.round;
  if (r && r.participants.includes(id)) {
    const pi = r.participants.indexOf(id);
    const wasTurn = pi === r.turn;
    r.pile.push(...r.hands[id]);
    delete r.hands[id];
    r.participants.splice(pi, 1);
    if (r.participants.length < MIN_PLAYERS) {
      // 2人未満になったら局を中止（得点なし）
      room.status = 'lobby';
      room.round = null;
      room.roundNum -= 1;
    } else {
      if (pi < r.turn) r.turn -= 1;
      r.turn %= r.participants.length;
      if (wasTurn) r.deadline = now + TURN_SECONDS * 1000;
    }
  }
  return room.players.length === 0;
}

// 端末ごとに送る内容。他人の手札と山札の並びは入れない
export function viewFor(room, id, connectedIds) {
  const r = room.round;
  return {
    code: room.code,
    me: id,
    hostId: room.hostId,
    status: room.status,
    roundNum: room.roundNum,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      last: p.last,
      connected: connectedIds.includes(p.id),
      cardCount: r && r.hands[p.id] ? r.hands[p.id].length : null,
    })),
    round: r && {
      turnId: currentPlayer(room),
      deadline: r.deadline,
      top: r.top,
      topBy: r.topBy,
      deckCount: r.deck.length,
      lastAction: r.lastAction,
    },
    hand: r && r.hands[id] ? r.hands[id] : null,
    result: room.status === 'reveal' ? room.result : null,
    history: room.history,
    names: room.names,
  };
}
