'use strict';

const { Game } = require('./game');
const { think: botThink } = require('./bot');

const MIN_PLAYERS = 1;
const MAX_PLAYERS = 6;
const BOT_NAMES = ['알파', '베타', '감마', '델타', '엡실론'];

const TICK_MS = 250;      // 시뮬레이션 간격
const BROADCAST_EVERY = 4; // 250ms × 4 = 1초마다 화면 갱신 (행동은 즉시)
// 재정·주식처럼 매초 조금씩 바뀌는 값은 3번에 한 번만 새로 담는다 (사람이 행동하면 즉시). 그 사이는 브라우저가 이어 계산한다.
const ECON_EVERY = 3;
const BOT_THINK_MS = 6000;

const DEFAULT_SETTINGS = { startCash: 3000, duration: 1200, mapSize: 1, victory: 0, difficulty: 1 };
const SETTING_CHOICES = {
  startCash: [2000, 3000, 5000],
  duration: [900, 1200, 1800, 0], // 0 = 무제한 (방장이 '지금 끝내기'로 종료하거나 정복·경제 승리)
  mapSize: [0, 1, 2], // small / normal / large
  victory: [0, 1, 2], // score(시간 종료 국력) / conquest(최후 생존) / economic(국력 50,000 선착)
  difficulty: [0, 1, 2], // 쉬움 / 보통 / 어려움 (컴퓨터 국가에만 적용)
};
const MAP_SIZES = ['small', 'normal', 'large'];
const VICTORIES = ['score', 'conquest', 'economic'];

/**
 * 방 하나. 대기실 상태와 실시간 게임 루프를 관리한다.
 * phase: 'lobby' | 'playing' | 'ended'
 */
class Room {
  constructor(id, onChange) {
    this.id = id;
    this.onChange = onChange || (() => {});
    this.phase = 'lobby';
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = [];
    this.hostId = null;
    this.game = null;
    this.speed = 1;
    this.chat = [];
    this._chatSeq = 0;
    this.updatedAt = Date.now();
    this._loop = null;
    this._ticks = 0;
    this._botClock = 0;
    this._bcasts = 0;
    this._econFresh = true;
    this._snap = null;
    this._seq = 0;
  }

  touch() { this.updatedAt = Date.now(); }
  player(id) { return this.players.find((p) => p.id === id) || null; }
  isEmpty() { return !this.players.some((p) => p.connected && !p.isBot); }
  reassignHost() {
    const next = this.players.find((p) => !p.isBot && p.connected) || null;
    this.hostId = next ? next.id : null;
  }

  /* ---------------------------------------------------------------- 입장/퇴장 */

  join(playerId, name, socketId) {
    this.touch();
    const existing = this.player(playerId);
    if (existing) {
      existing.socketId = socketId;
      existing.connected = true;
      existing.name = name || existing.name;
      if (!this.hostId) this.hostId = playerId;
      this.pushLog(`${existing.name} 님이 다시 접속했습니다.`);
      return { ok: true };
    }
    if (this.phase !== 'lobby') return { ok: false, error: '이미 게임이 진행 중인 방입니다.' };
    if (this.players.length >= MAX_PLAYERS) return { ok: false, error: `최대 ${MAX_PLAYERS}명까지 입장할 수 있습니다.` };
    if (this.players.some((p) => p.name === name)) return { ok: false, error: '같은 이름이 이미 방에 있습니다.' };
    this.players.push({ id: playerId, name, socketId, connected: true, voice: { on: false, muted: false } });
    if (!this.hostId) this.hostId = playerId;
    this.pushLog(`${name} 님이 입장했습니다.`);
    return { ok: true };
  }

  leave(playerId) {
    this.touch();
    const p = this.player(playerId);
    if (!p) return { ok: true };
    if (this.phase === 'lobby') {
      this.players = this.players.filter((x) => x.id !== playerId);
      this.pushLog(`${p.name} 님이 나갔습니다.`);
    } else {
      p.connected = false;
      p.socketId = null;
      this.pushLog(`${p.name} 님이 자리를 비웠습니다.`);
    }
    if (this.hostId === playerId) this.reassignHost();
    return { ok: true };
  }

  disconnect(socketId) {
    if (!socketId) return;
    const p = this.players.find((x) => x.socketId === socketId);
    if (!p) return;
    this.touch();
    p.socketId = null;
    p.connected = false;
    if (p.voice) { p.voice.on = false; p.voice.muted = false; }
    if (this.phase === 'lobby') {
      this.players = this.players.filter((x) => x.id !== p.id);
      this.pushLog(`${p.name} 님이 나갔습니다.`);
    } else {
      this.pushLog(`${p.name} 님의 연결이 끊겼습니다.`);
    }
    if (this.hostId === p.id) this.reassignHost();
  }

  /* ---------------------------------------------------------------- 컴퓨터 */

  addBot(playerId) {
    if (this.phase !== 'lobby') return { ok: false, error: '게임 중에는 추가할 수 없습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 컴퓨터를 추가할 수 있습니다.' };
    if (this.players.length >= MAX_PLAYERS) return { ok: false, error: `최대 ${MAX_PLAYERS}명까지 참가할 수 있습니다.` };
    const used = new Set(this.players.map((p) => p.name));
    const label = BOT_NAMES.map((n) => '컴퓨터 ' + n).find((n) => !used.has(n));
    if (!label) return { ok: false, error: '더 추가할 수 없습니다.' };
    this.players.push({ id: 'bot_' + Math.random().toString(36).slice(2, 10), name: label, socketId: null, connected: true, isBot: true });
    this.pushLog(`${label} 님이 참가했습니다.`);
    this.touch();
    return { ok: true };
  }

  removeBot(playerId) {
    if (this.phase !== 'lobby') return { ok: false, error: '게임 중에는 뺄 수 없습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 컴퓨터를 뺄 수 있습니다.' };
    for (let i = this.players.length - 1; i >= 0; i--) {
      if (this.players[i].isBot) {
        const [removed] = this.players.splice(i, 1);
        this.pushLog(`${removed.name} 님이 나갔습니다.`);
        this.touch();
        return { ok: true };
      }
    }
    return { ok: false, error: '뺄 컴퓨터가 없습니다.' };
  }

  /* ---------------------------------------------------------------- 설정/시작 */

  updateSettings(playerId, patch) {
    if (this.phase !== 'lobby') return { ok: false, error: '게임 중에는 설정을 바꿀 수 없습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 설정을 바꿀 수 있습니다.' };
    for (const [key, choices] of Object.entries(SETTING_CHOICES)) {
      if (patch[key] !== undefined) {
        const v = Number(patch[key]);
        if (!choices.includes(v)) return { ok: false, error: '잘못된 설정 값입니다.' };
        this.settings[key] = v;
      }
    }
    this.touch();
    return { ok: true };
  }

  setSpeed(playerId, speed) {
    if (playerId !== this.hostId) return { ok: false, error: '방장만 속도를 바꿀 수 있습니다.' };
    const s = Number(speed);
    if (![0, 1, 2, 3, 10].includes(s)) return { ok: false, error: '잘못된 속도입니다.' }; // 10× 는 테스트용
    this.speed = s;
    this.touch();
    return { ok: true };
  }

  start(playerId) {
    if (this.phase !== 'lobby') return { ok: false, error: '이미 시작했습니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 시작할 수 있습니다.' };
    const connected = this.players.filter((p) => p.connected);
    if (connected.length < 2) return { ok: false, error: '국가가 2개 이상 필요합니다. (컴퓨터를 추가하세요)' };
    this.phase = 'playing';
    this.speed = 1;
    this.game = new Game(
      connected.map((p) => ({ id: p.id, name: p.name, isBot: !!p.isBot })),
      { ...this.settings, mapSize: MAP_SIZES[this.settings.mapSize] || 'normal', victory: VICTORIES[this.settings.victory] || 'score' }
    );
    this.game.pushLog(`게임 시작! 시작 자금 ${this.settings.startCash}, ${this.settings.duration ? `제한 ${Math.round(this.settings.duration / 60)}분` : '시간 무제한'}. 예산 비율을 정하면 장관들이 알아서 집행합니다.`);
    // 봇은 시작하자마자 한 번 생각한다
    for (const p of this.players) if (p.isBot) botThink(this.game, p.id);
    this.startLoop();
    this.touch();
    return { ok: true };
  }

  // 방장이 지금 국력 순위로 판을 끝낸다 (무제한 게임의 종료 수단, 시간제 게임에서도 가능)
  endGame(playerId) {
    if (this.phase !== 'playing' || !this.game) return { ok: false, error: '게임 중이 아닙니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 끝낼 수 있습니다.' };
    this.game.finish('host');
    this.phase = 'ended';
    this.saveResult();
    this.stopLoop();
    this.touch();
    this._econFresh = true;
    this.onChange(this);
    return { ok: true };
  }

  // 지난 판 결과를 방에 보관한다 — 대기실로 돌아가도(다시 하기·접속 끊김 정리) 최종 순위를 볼 수 있게
  saveResult() {
    const g = this.game;
    if (!g || !g.ranking) return;
    this.lastResult = {
      reason: g.endReason || 'time',
      ranking: g.ranking.map((r) => ({ ...r, color: g.nations[r.idx].color, ach: g.nations[r.idx].ach.length })),
      hist: g.hist,
      colors: g.nations.map((n) => n.color),
    };
  }
  resetToLobby() {
    if (this.game && this.game.ended) this.saveResult();
    this.stopLoop();
    this.phase = 'lobby';
    this.game = null;
    this.players = this.players.filter((p) => p.connected || p.isBot);
    if (!this.player(this.hostId)) this.reassignHost();
    this.touch();
  }

  restart(playerId) {
    if (this.phase === 'lobby') return { ok: true };
    if (this.phase !== 'ended') return { ok: false, error: '게임이 아직 진행 중입니다.' };
    if (playerId !== this.hostId) return { ok: false, error: '방장만 다시 시작할 수 있습니다.' };
    this.resetToLobby();
    this.pushLog('대기실로 돌아왔습니다. 설정을 바꾸고 다시 시작하세요.');
    return { ok: true };
  }

  /* ---------------------------------------------------------------- 실시간 루프 */

  startLoop() {
    this.stopLoop();
    this._ticks = 0;
    this._botClock = 0;
    this._loop = setInterval(() => this.step(), TICK_MS);
  }
  stopLoop() {
    if (this._loop) { clearInterval(this._loop); this._loop = null; }
  }
  clearAutoTimer() { this.stopLoop(); }

  step() {
    if (this.phase !== 'playing' || !this.game) return;
    const dt = TICK_MS / 1000;
    // 배속은 틱을 여러 번 돌려서 낸다 (전투 안정성)
    for (let i = 0; i < this.speed; i++) this.game.tick(dt);

    this._botClock += TICK_MS * this.speed;
    if (this._botClock >= BOT_THINK_MS) {
      this._botClock = 0;
      for (const p of this.players) {
        const nation = this.game.nation(p.id);
        if (!p.isBot && !(nation && nation.autoCabinet)) continue;
        try { botThink(this.game, p.id, { diplomacy: !!p.isBot }); } catch (err) { console.error('[bot]', err); }
      }
    }

    if (this.game.ended) {
      this.phase = 'ended';
      this.saveResult();
      this.stopLoop();
      this.touch();
      this.onChange(this);
      return;
    }
    this._ticks++;
    if (this.speed === 0) return; // 일시정지 중엔 아무것도 안 보낸다
    if (this._ticks % BROADCAST_EVERY === 0) {
      this._bcasts++;
      if (this._bcasts % ECON_EVERY === 0) this._econFresh = true;
      this.onChange(this);
    }
  }

  gameAction(playerId, fn) {
    if (this.phase !== 'playing' || !this.game) return { ok: false, error: '게임 중이 아닙니다.' };
    if (!this.game.nation(playerId)) return { ok: false, error: '게임 참가자가 아닙니다.' };
    const result = fn(this.game);
    if (result && result.ok) { this.touch(); this._econFresh = true; }
    return result;
  }

  /* ---------------------------------------------------------------- 로그/상태 */

  pushLog(text) {
    if (this.game) this.game.pushLog(text);
    else this.pushChat('알림', text);
  }
  pushChat(name, text) {
    this.chat.push({ id: ++this._chatSeq, t: Date.now(), name, text });
    if (this.chat.length > 100) this.chat.shift();
  }

  state() {
    const base = {
      roomId: this.id,
      phase: this.phase,
      hostId: this.hostId,
      speed: this.speed,
      settings: this.settings,
      settingChoices: SETTING_CHOICES,
      maxPlayers: MAX_PLAYERS,
      roomPlayers: this.players.map((p) => ({
        id: p.id, name: p.name, connected: p.connected, isBot: !!p.isBot,
        voice: p.voice ? { on: !!p.voice.on, muted: !!p.voice.muted } : 0,
      })),
      chat: Object.fromEntries(this.chat.slice(-60).map((e) => [e.id, e])),
      lastResult: this.phase === 'lobby' ? (this.lastResult || null) : null,
      constants: Room._constants || (Room._constants = Game.constants()),
    };
    if (this.game) {
      base.game = this.game.publicState({ econ: this._econFresh || this.game.ended });
      this._econFresh = false;
      base.log = Object.fromEntries(this.game.log.slice(-60).map((e) => [e.id, e]));
    }
    return base;
  }
}

module.exports = { Room, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_SETTINGS, SETTING_CHOICES, TICK_MS };
