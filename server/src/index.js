// ヤコブのサーバー。部屋1つにつき Durable Object（Room）を1つ使い、
// 各端末とは WebSocket（Hibernation API）でつなぐ。ルール判定は www/game.js を共有する。
import { DurableObject } from 'cloudflare:workers';
import {
  createRoom, joinRoom, startRound, playMove, callYakob, autoMove, leaveRoom, viewFor, TURN_SECONDS,
} from '../../www/game.js';

const CODE_RE = /^[A-Z0-9]{4,8}$/;
const PID_RE = /^[A-Za-z0-9-]{8,64}$/;
const NAME_MAX = 12;
const IDLE_DELETE_MS = 24 * 60 * 60 * 1000; // 誰もつながっていない部屋は24時間で消す

const rand = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;

export default {
  // GET /ws/:code?pid=…&name=…&create=1
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (!m) return new Response('ヤコブ', { status: 200 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket で接続してください', { status: 426 });
    const code = m[1].toUpperCase();
    if (!CODE_RE.test(code)) return new Response('部屋コードが正しくありません', { status: 400 });
    return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
  },
};

export class Room extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const code = url.pathname.split('/').pop().toUpperCase();
    const pid = url.searchParams.get('pid') || '';
    const name = (url.searchParams.get('name') || '').trim().slice(0, NAME_MAX);
    const create = url.searchParams.get('create') === '1';

    const [client, server] = Object.values(new WebSocketPair());
    // 失敗の理由を画面に出せるよう、いったん受け付けてからエラーを送って閉じる
    const reject = (errCode, message) => {
      server.accept();
      server.send(JSON.stringify({ t: 'error', code: errCode, message }));
      server.close(4000, errCode);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (!PID_RE.test(pid) || !name) return reject('bad', 'ニックネームを入れてください');

    let room = await this.load();
    if (create) {
      if (room && room.players.length) return reject('exists', 'その部屋コードは使われています');
      room = createRoom(code);
    } else if (!room) {
      return reject('notfound', '部屋が見つかりません');
    }
    try {
      joinRoom(room, pid, name);
    } catch (e) {
      return reject('full', e.message);
    }

    // 同じプレイヤーの古い接続は閉じる（同じ端末で開き直したとき）
    for (const ws of this.ctx.getWebSockets(pid)) {
      try { ws.close(4001, 'replaced'); } catch {}
    }
    this.ctx.acceptWebSocket(server, [pid]);

    // 誰もいない間は時間切れで進めないので、戻ってきたら手番の時間を取り直す
    if (room.status === 'playing' && this.connectedIds().length === 1) {
      room.round.deadline = Date.now() + TURN_SECONDS * 1000;
    }
    room.idleSince = null;
    await this.saveAndBroadcast(room);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const pid = this.ctx.getTags(ws)[0];
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const room = await this.load();
    if (!room) return;
    const now = Date.now();
    try {
      switch (msg.t) {
        case 'start': startRound(room, pid, rand, now); break;
        case 'move': playMove(room, pid, msg.cards, msg.draw, rand, now); break;
        case 'yakob': callYakob(room, pid); break;
        case 'leave':
          if (leaveRoom(room, pid, now)) {
            await this.ctx.storage.deleteAll();
            ws.close(1000, 'left');
            return;
          }
          ws.close(1000, 'left');
          break;
        case 'ping': return;
        default: return;
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', code: 'rule', message: e.message }));
      return;
    }
    await this.saveAndBroadcast(room);
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch {}
    const room = await this.load();
    if (!room) return;
    if (this.connectedIds(ws).length === 0) room.idleSince = Date.now();
    await this.saveAndBroadcast(room, ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    const room = await this.load();
    if (!room) return;
    const now = Date.now();
    if (this.connectedIds().length === 0) {
      if (room.idleSince && now - room.idleSince >= IDLE_DELETE_MS) {
        await this.ctx.storage.deleteAll();
        return;
      }
      await this.save(room);
      return;
    }
    if (room.status === 'playing' && now >= room.round.deadline - 100) {
      autoMove(room, rand, now);
      await this.saveAndBroadcast(room);
      return;
    }
    await this.save(room);
  }

  // ---- 内部 ----

  async load() {
    return (await this.ctx.storage.get('room')) ?? null;
  }

  // 保存して、次に起きる時刻（手番の締め切りか、無人の部屋の削除）にアラームを合わせる
  async save(room, closing = null) {
    await this.ctx.storage.put('room', room);
    const connected = this.connectedIds(closing).length > 0;
    if (connected && room.status === 'playing') {
      await this.ctx.storage.setAlarm(room.round.deadline);
    } else if (!connected && room.idleSince) {
      await this.ctx.storage.setAlarm(room.idleSince + IDLE_DELETE_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async saveAndBroadcast(room, closing = null) {
    await this.save(room, closing);
    const ids = this.connectedIds(closing);
    const serverNow = Date.now();
    for (const ws of this.openSockets(closing)) {
      const pid = this.ctx.getTags(ws)[0];
      try {
        ws.send(JSON.stringify({ t: 'state', serverNow, state: viewFor(room, pid, ids) }));
      } catch {}
    }
  }

  openSockets(closing = null) {
    return this.ctx.getWebSockets().filter((ws) => ws !== closing && ws.readyState === WebSocket.OPEN);
  }

  connectedIds(closing = null) {
    return [...new Set(this.openSockets(closing).map((ws) => this.ctx.getTags(ws)[0]))];
  }
}
