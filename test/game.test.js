import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDiscard, takeableIndexes, handTotal, newDeck,
  createRoom, joinRoom, startRound, playMove, callYakob, autoMove, leaveRoom, viewFor, currentPlayer,
} from '../www/game.js';

const rand = () => 0;
const NOW = 1_000_000;

// 手札を指定して局の途中の状態を作る
function roomWith(hands, { turn = 0, top = ['9S'] } = {}) {
  const room = createRoom('TEST');
  for (const id of Object.keys(hands)) joinRoom(room, id, id.toUpperCase());
  startRound(room, room.hostId, rand, NOW);
  room.round.hands = structuredClone(hands);
  room.round.turn = turn;
  room.round.top = top;
  return room;
}

test('54枚の山札と点数', () => {
  assert.equal(newDeck().length, 54);
  assert.equal(handTotal(['AS', 'TH', 'JD', 'QC', 'KS', '1J']), 1 + 10 + 11 + 12 + 13 + 0);
});

test('捨てられる組み合わせ', () => {
  assert.equal(checkDiscard(['7H']).kind, 'single');
  assert.equal(checkDiscard(['7H', '7S']).kind, 'set');
  assert.equal(checkDiscard(['7H', '1J']).kind, 'set');
  assert.equal(checkDiscard(['1J', '2J']).kind, 'set');
  assert.deepEqual(checkDiscard(['6H', '4H', '5H']), { ok: true, kind: 'run', ordered: ['4H', '5H', '6H'] });
  assert.deepEqual(checkDiscard(['4H', '6H', '1J']).ordered, ['4H', '1J', '6H']);
  assert.deepEqual(checkDiscard(['QS', 'KS', '1J']).ordered, ['1J', 'QS', 'KS']);
  assert.equal(checkDiscard(['AS', '2S', '3S', '4S', '5S']).kind, 'run');

  assert.equal(checkDiscard([]).ok, false);
  assert.equal(checkDiscard(['7H', '8H']).ok, false);
  assert.equal(checkDiscard(['4H', '5S', '6H']).ok, false);
  assert.equal(checkDiscard(['4H', '7H', '1J']).ok, false);
  assert.equal(checkDiscard(['KS', 'AS', '2S']).ok, false);
});

test('捨て札は両端だけ取れる', () => {
  assert.deepEqual(takeableIndexes(['4H']), [0]);
  assert.deepEqual(takeableIndexes(['4H', '5H', '6H']), [0, 2]);
});

test('配札と最初の手番', () => {
  const room = createRoom('TEST');
  joinRoom(room, 'a', 'A');
  joinRoom(room, 'b', 'B');
  assert.throws(() => startRound(room, 'b', rand, NOW), /部屋主/);
  startRound(room, 'a', rand, NOW);
  assert.equal(room.round.hands.a.length, 5);
  assert.equal(room.round.hands.b.length, 5);
  assert.equal(room.round.top.length, 1);
  assert.equal(room.round.deck.length, 54 - 11);
  assert.equal(currentPlayer(room), 'a');
});

test('捨てて引く', () => {
  const room = roomWith({ a: ['4H', '5H', '6H', '9C', 'KD'], b: ['2S', '3S', '8D', '9D', 'TD'] }, { top: ['7S', '8S', '9S'] });
  assert.throws(() => playMove(room, 'b', ['2S'], 'deck', rand, NOW), /あなたの番/);
  assert.throws(() => playMove(room, 'a', ['4H', '6H'], 'deck', rand, NOW), /同じ数字/);
  assert.throws(() => playMove(room, 'a', ['KD'], 1, rand, NOW), /取れません/);
  playMove(room, 'a', ['6H', '4H', '5H'], 2, rand, NOW);
  assert.deepEqual(room.round.hands.a, ['9S', '9C', 'KD']);
  assert.deepEqual(room.round.top, ['4H', '5H', '6H']);
  assert.deepEqual(room.round.pile.slice(-2), ['7S', '8S']);
  assert.equal(currentPlayer(room), 'b');
});

test('普通の上がり: いちばん大きい人だけが払う', () => {
  const room = roomWith({ a: ['AS', '2S'], b: ['3H', '5H'], c: ['KS'] });
  callYakob(room, 'a');
  assert.equal(room.result.type, 'yakob');
  assert.deepEqual(room.result.deltas, { a: 10, b: 0, c: -10 });
  assert.equal(room.nextStarter, 'c');
});

test('普通の上がり: いちばん大きい人が並んだら割り勘', () => {
  const room = roomWith({ a: ['3S'], b: ['KS'], c: ['KH'] });
  callYakob(room, 'a');
  assert.deepEqual(room.result.deltas, { a: 10, b: -5, c: -5 });
  assert.equal(room.nextStarter, 'b');
});

test('ヤコブ返し: 同じ数でも成立し、いちばん小さい人が +15', () => {
  const room = roomWith({ a: ['4S'], b: ['2S'], c: ['2H'], d: ['9S'] });
  callYakob(room, 'a');
  assert.equal(room.result.type, 'return');
  assert.deepEqual(room.result.deltas, { a: -15, b: 7.5, c: 7.5, d: 0 });
  assert.equal(room.nextStarter, 'a');

  const tie = roomWith({ a: ['4S'], b: ['4H'] });
  callYakob(tie, 'a');
  assert.deepEqual(tie.result.deltas, { a: -15, b: 15 });
});

test('合計が5を超えると宣言できない', () => {
  const room = roomWith({ a: ['6S'], b: ['KS'] });
  assert.throws(() => callYakob(room, 'a'), /5以下/);
});

test('時間切れはいちばん大きい札を捨てて山札から引く', () => {
  const room = roomWith({ a: ['AS', 'KD', '3C'], b: ['2S'] });
  autoMove(room, rand, NOW);
  assert.deepEqual(room.round.top, ['KD']);
  assert.equal(room.round.hands.a.length, 3);
});

test('2人未満になったら局を中止する', () => {
  const room = roomWith({ a: ['AS'], b: ['2S'] });
  leaveRoom(room, 'a', NOW);
  assert.equal(room.status, 'lobby');
  assert.equal(room.hostId, 'b');
  assert.equal(room.roundNum, 0);
});

test('他人の手札は見えない', () => {
  const room = roomWith({ a: ['AS'], b: ['2S'] });
  const v = viewFor(room, 'a', ['a', 'b']);
  assert.deepEqual(v.hand, ['AS']);
  assert.equal(JSON.stringify(v).includes('2S'), false);
  assert.equal(v.players.find((p) => p.id === 'b').cardCount, 1);
});

test('満員なら入れない', () => {
  const room = createRoom('TEST');
  for (const id of ['a', 'b', 'c', 'd']) joinRoom(room, id, id);
  assert.throws(() => joinRoom(room, 'e', 'e'), /満員/);
});
