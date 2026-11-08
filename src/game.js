'use strict';

/**
 * 패권 — 규칙 엔진. 네트워크 없이 순수 로직만 담는다.
 *
 * 유저는 "돈을 어디에 얼마나 쓸지" 만 정한다 (예산 비율·군사 교리·산업 정책·연구 목표·투자 비중).
 * 실제 집행은 장관(ministers)들이 매 2초 자동으로 한다. 봇 국가도 같은 장관을 쓰고,
 * 봇은 그 비율을 상황에 맞춰 바꾸는 "내각" 만 추가로 돌린다 (bot.js).
 *
 *   tick(dt)
 *     ├ 경제: 자원 생산 → 공장 → 시장 판매 → 세금·유지비·배당 → 예산 분배(pots)
 *     ├ 내각(2초): 산업부 건설 / 과학부 연구 / 국방부 모병·임무 / 재무부 투자
 *     ├ 부대: 임무 재검토(3초) → 행군 → 교전 → 영토 칠하기
 *     ├ 도시: 포위·체력·점령
 *     └ 시장·주식·사건·종료 판정
 */

const D = require('./data');
const { generateMap } = require('./map');
const { findPath } = require('./pathfinding');
const Dip = require('./diplomacy');
const Decisions = require('./decisions');
const Council = require('./council');
const Ach = require('./achievements');
const { PROJECTS, PROJECT_ORDER, SPY_OPS } = D;

const { TERRAIN, UNITS, UNIT_ORDER, COUNTER, BUILDINGS, BUILDING_ORDER, MAX_BUILDING_LEVEL, MATERIALS, STOCKS, STOCK_ORDER, TECHS, RULES } = D;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

const DEFAULT_BUDGET = { industry: 35, research: 20, military: 25, finance: 10, reserve: 10 };
const DEFAULT_DOCTRINE = { defend: 40, expand: 40, attack: 20 };
const DEFAULT_INDUSTRY = { resource: 35, factory: 35, infra: 15, defense: 15 };
const DEFAULT_PORTFOLIO = { defense: 20, energy: 20, tech: 20, constr: 20, food: 20 };

function normalizePct(obj, keys, fallback) {
  const out = {};
  let sum = 0;
  for (const k of keys) {
    const v = Number(obj && obj[k]);
    out[k] = Number.isFinite(v) && v >= 0 ? v : 0;
    sum += out[k];
  }
  if (sum <= 0) return { ...fallback };
  for (const k of keys) out[k] = Math.round((out[k] / sum) * 1000) / 10;
  return out;
}

class Game {
  constructor(playerInfos, settings = {}) {
    this.settings = settings;
    this.duration = Number(settings.duration) || 1200;
    this.time = 0;
    this.ended = false;
    this.winner = null;
    this.ranking = null;
    this.log = [];
    this._logSeq = 0;
    this._fx = {};
    this._fxSeq = 0;
    this._unitSeq = 0;
    this._cabinetClock = 0;
    this._healClock = 0;
    this._stockSampleClock = 0;
    this._eventClock = 60 + Math.random() * 60;
    this.event = null;
    this.victory = ['score', 'conquest', 'economic'].includes(settings.victory) ? settings.victory : 'score';
    this.hist = { t: [], s: [] }; // 국력 추이 (결과 그래프용, 종료 시에만 전송)
    this._histClock = 0;

    const n = playerInfos.length;
    const area = settings.mapSize === 'large' ? [112, 70] : settings.mapSize === 'small' ? [72, 46] : [92, 58];
    const seed = Number(settings.seed) || Math.floor(Math.random() * 1e9);
    this.map = generateMap(area[0], area[1], seed, n);
    this.W = this.map.width;
    this.H = this.map.height;

    this.nations = playerInfos.map((p, i) => ({
      id: p.id, name: p.name, isBot: !!p.isBot, idx: i,
      color: D.NATION_COLORS[i % D.NATION_COLORS.length],
      title: D.NATION_NAMES[i % D.NATION_NAMES.length],
      alive: true,
      cash: Number(settings.startCash) || RULES.startCash,
      pots: { industry: 0, research: 0, military: 0, finance: 0 },
      budget: { ...DEFAULT_BUDGET },
      doctrine: { ...DEFAULT_DOCTRINE },
      attackTarget: 'any',
      industry: { ...DEFAULT_INDUSTRY },
      portfolio: { ...DEFAULT_PORTFOLIO },
      researchTarget: null,
      researching: null, // { id, progress }
      science: 0,
      techs: [],
      mats: { iron: 20, oil: 10, grain: 30 },
      stocks: { defense: 0, energy: 0, tech: 0, constr: 0, food: 0 },
      stockCost: { defense: 0, energy: 0, tech: 0, constr: 0, food: 0 },
      spend: { resource: 0, factory: 0, infra: 0, defense: 0 },
      mult: null,
      stats: { income: 0, expense: 0, sales: 0, dividend: 0, net: 0, tiles: 0, cities: 0, units: 0, score: 0, science: 0, kills: 0, losses: 0, captures: 0, spies: 0 },
      liquidate: false,
      autoReserve: !!p.isBot, // 사람은 비축을 직접 쓴다. 봇은 넘치면 자동 재배분.
      autoCabinet: false,     // 켜면 봇의 상황 대응(예산·교리·산업 조정)을 사람 국가에도 적용 (외교는 제외)
      weariness: 0,           // 전쟁 피로도 0~100
      nukeReady: 0,           // 다음 핵 타격 가능 시각
      buffs: [],              // 한시적 배수 [{k, v, until, name}] — 결단·의회 결의
      ach: [],                // 달성한 업적 id
      decision: null,         // 지도자가 골라야 할 결단 (사람만)
      projectTarget: null,    // 산업 금고로 추진할 국가 프로젝트
      spyReady: 0,            // 다음 첩보 작전 가능 시각
      capitalId: null,
      _missionOffset: Math.random() * RULES.missionInterval,
    }));
    for (const nn of this.nations) {
      this.refreshMult(nn);
      // 시작 자금의 70% 는 첫 예산 비율대로 바로 금고에 배정한다 (가만히 묵히지 않도록)
      const seed = nn.cash * 0.7;
      for (const k of ['industry', 'research', 'military', 'finance']) nn.pots[k] = seed * (nn.budget[k] / 100);
    }

    // 도시 런타임 상태
    this.cities = this.map.cities.map((c) => ({
      id: c.id, name: c.name, x: c.x, y: c.y, size: c.size,
      owner: c.capitalOf !== null ? c.capitalOf : -1,
      pop: c.size === 3 ? 220 : c.size === 2 ? 110 : 55,
      hp: 0, maxHp: 0,
      b: Object.fromEntries(BUILDING_ORDER.map((k) => [k, 0])),
      slots: 3 + c.size * 2,
      cap: null, // { by: nationIdx, t: seconds }
      siege: 0,  // 마지막으로 적이 접촉한 시각
      unrest: 0, // 점령지 저항/피폭 잔여 시간(초): 수입 0
      resTiles: null,
    }));
    this.cityById = new Map(this.cities.map((c) => [c.id, c]));
    for (const c of this.cities) {
      c.resTiles = this.countResourceTiles(c);
      if (c.owner >= 0) {
        const nn = this.nations[c.owner];
        nn.capitalId = c.id;
        c.b.barracks = 1; c.b.factory = 1; c.b.lab = 1;
        c.b.mine = Math.min(1, c.resTiles.iron); c.b.farm = Math.min(1, c.resTiles.farm);
      } else {
        // 중립 도시는 약간의 수비 체력과 건물을 가진다
        if (c.size >= 2) c.b.factory = 1;
      }
      c.maxHp = this.cityMaxHp(c);
      c.hp = c.maxHp;
    }

    this.territory = new Array(this.W * this.H).fill(-1);
    this.units = new Map();
    Dip.install(this);
    this.market = Object.fromEntries(Object.keys(MATERIALS).map((k) => [k, { price: MATERIALS[k].base, base: MATERIALS[k].base }]));
    this.stocks = Object.fromEntries(STOCK_ORDER.map((k) => [k, { price: STOCKS[k].price, mood: 1, hist: { 0: STOCKS[k].price } }]));
    this._histSeq = 0;
    this.world = { war: 0, research: 0, build: 0 }; // 주식 드라이버용 세계 지표 (EMA)
    // 국가 프로젝트: 세계에 하나뿐. prog[국가] 에 투입액이 쌓이고 먼저 채운 나라가 가져간다.
    this.projects = Object.fromEntries(PROJECT_ORDER.map((id) => [id, { id, owner: -1, done: false, city: null, prog: {} }]));
    this.news = null; // 마지막 세계 뉴스 { t, text, c }
    Council.install(this);
    this.recomputeTerritory();

    // 시작 부대: 보병 2
    for (const nn of this.nations) {
      const cap = this.cityById.get(nn.capitalId);
      for (let k = 0; k < 2; k++) this.spawnUnit(nn, 'inf', cap);
      this.updateStats(nn);
    }
  }

  /* ================================================================ 조회 */

  nation(pid) {
    return this.nations.find((n) => n.id === pid) || null;
  }
  tileId(x, y) {
    return this.map.tiles[y * this.W + x];
  }
  terrain(x, y) {
    return TERRAIN[this.tileId(x, y)];
  }
  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.W && y < this.H;
  }
  cityAt(x, y) {
    for (const c of this.cities) if (c.x === x && c.y === y) return c;
    return null;
  }
  countResourceTiles(c) {
    const R = RULES.cityRadius[c.size];
    const out = { iron: 0, oil: 0, farm: 0 };
    for (let y = c.y - R; y <= c.y + R; y++) {
      for (let x = c.x - R; x <= c.x + R; x++) {
        if (!this.inBounds(x, y)) continue;
        const r = this.map.resources[y * this.W + x];
        if (r && Math.hypot(x - c.x, y - c.y) <= R) out[r]++;
      }
    }
    return out;
  }
  cityMaxHp(c) {
    const own = c.owner >= 0 ? this.nations[c.owner] : null;
    const m = own ? own.mult.cityDef : 1;
    return Math.round((RULES.cityHpBase + RULES.cityHpPerSize * c.size + BUILDINGS.bunker.hp * c.b.bunker) * m);
  }
  pushLog(text, nationIdx = -1) {
    this.log.push({ id: ++this._logSeq, t: Math.round(this.time), text, n: nationIdx });
    if (this.log.length > 120) this.log.shift();
  }
  fx(kind, x, y, extra) {
    const id = ++this._fxSeq;
    this._fx[id] = { k: kind, x: r1(x), y: r1(y), t: r1(this.time), ...(extra || {}) };
  }

  pushNews(text, nationIdx = -1) {
    this.news = { t: Math.round(this.time), text, c: nationIdx };
  }
  // 한시적 배수 합: 국가 버프 + 세계 결의
  buff(n, k) {
    let s = 0;
    for (const b of n.buffs) if (b.k === k) s += b.v;
    return s + Council.worldBuff(this, k);
  }
  // 완성한 국가 프로젝트의 비배수 효과 합 (trade, portTrade, wearinessDecay, prestige, vote)
  projectBonus(n, k) {
    let s = 0;
    for (const p of Object.values(this.projects)) if (p.done && p.owner === n.idx && PROJECTS[p.id].effects[k]) s += PROJECTS[p.id].effects[k];
    return s;
  }
  truce() {
    return Council.worldBuff(this, 'truce') > 0;
  }

  hasTech(n, id) {
    return n.techs.includes(id);
  }
  // 기술로 바뀌는 국가 배수를 캐시한다 (기술 획득 시에만 다시 계산)
  refreshMult(n) {
    const m = { factory: 1, resource: 1, science: 1, speed: 1, upkeep: 1, atk: 1, def: 1, cityDef: 1, airDef: 1, dividend: 1, income: 1, artyRange: 0, navyRange: 0 };
    const tier = { inf: 1, armor: 1, arty: 1, air: 1, navy: 1 };
    const flags = {};
    for (const id of n.techs) {
      const e = TECHS[id].effects;
      if (e.mult) for (const [k, v] of Object.entries(e.mult)) m[k] += v;
      if (e.tier) tier[e.tier]++;
      if (e.flag) flags[e.flag] = true;
    }
    if (this.projects) for (const p of Object.values(this.projects)) {
      if (!p.done || p.owner !== n.idx || !PROJECTS[p.id].effects.mult) continue;
      for (const [k, v] of Object.entries(PROJECTS[p.id].effects.mult)) m[k] += v;
    }
    n.mult = m;
    n.tier = tier;
    n.flags = flags;
  }
  unitUnlocked(n, type) {
    const t = UNITS[type].tech;
    return !t || this.hasTech(n, t);
  }
  buildingUnlocked(n, kind) {
    const t = BUILDINGS[kind].tech;
    return !t || this.hasTech(n, t);
  }
  counterMult(att, def) {
    let m = COUNTER[att.type][def.type];
    const an = this.nations[att.owner];
    if (att.type === 'inf' && def.type === 'armor' && an.flags.atgm) m = 1.0;
    if (att.type === 'inf' && def.type === 'air' && an.flags.manpads) m = 0.9;
    return m;
  }
  unitRange(u) {
    const n = this.nations[u.owner];
    return UNITS[u.type].range + (u.type === 'arty' ? n.mult.artyRange : u.type === 'navy' ? n.mult.navyRange : 0);
  }
  // 도시에서 가장 가까운 바다 타일 (반경 3 안) — 없으면 내륙 도시
  shoreTile(c) {
    if (c._shore !== undefined) return c._shore;
    let best = null, bd = Infinity;
    for (let y = c.y - 3; y <= c.y + 3; y++) {
      for (let x = c.x - 3; x <= c.x + 3; x++) {
        if (!this.inBounds(x, y) || this.tileId(x, y) !== 'water') continue;
        const d = Math.hypot(x - c.x, y - c.y);
        if (d < bd) { bd = d; best = { x, y }; }
      }
    }
    c._shore = best;
    return best;
  }
  isCoastal(c) {
    return !!this.shoreTile(c);
  }

  /* ================================================================ 플레이어 명령 (위임 설정) */

  setBudget(pid, b) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    n.budget = normalizePct(b, ['industry', 'research', 'military', 'finance', 'reserve'], DEFAULT_BUDGET);
    return { ok: true };
  }
  setDoctrine(pid, d) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    n.doctrine = normalizePct(d, ['defend', 'expand', 'attack'], DEFAULT_DOCTRINE);
    if (d && d.target !== undefined) {
      const t = d.target === 'any' ? 'any' : this.nations.find((x) => x.idx === Number(d.target) && x.id !== pid) ? Number(d.target) : 'any';
      if (t !== 'any' && !Dip.isHostile(this, n.idx, t)) return { ok: false, error: '적대 관계가 아닌 국가입니다. 외교 탭에서 먼저 적대를 선언하세요.' };
      n.attackTarget = t;
    }
    // 비율이 바뀌었으니 위임 부대를 즉시 재배정한다
    for (const u of this.units.values()) if (u.owner === n.idx && u.mission !== 'manual') u.nextThink = 0;
    return { ok: true };
  }
  setIndustry(pid, p) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    n.industry = normalizePct(p, ['resource', 'factory', 'infra', 'defense'], DEFAULT_INDUSTRY);
    return { ok: true };
  }
  setPortfolio(pid, p) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    n.portfolio = normalizePct(p, STOCK_ORDER, DEFAULT_PORTFOLIO);
    return { ok: true };
  }
  // 특별 집행: 비축(가용 현금)에서 특정 부처 금고로 한 번에 옮긴다. 장관이 2초 안에 집행을 시작한다.
  allocate(pid, pot, amount) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    if (!['industry', 'research', 'military', 'finance'].includes(pot)) return { ok: false, error: '잘못된 부처입니다.' };
    const earmarked = n.pots.industry + n.pots.research + n.pots.military + n.pots.finance;
    const free = Math.floor(n.cash - earmarked);
    amount = Math.floor(Number(amount));
    if (!(amount > 0)) return { ok: false, error: '금액이 잘못되었습니다.' };
    if (amount > free) return { ok: false, error: `가용 현금이 ${Math.max(0, free)} 뿐입니다.` };
    n.pots[pot] += amount;
    const name = { industry: '산업부', research: '과학부', military: '국방부', finance: '재무부' }[pot];
    this.pushLog(`특별 집행: 비축 ${amount}을 ${name} 금고에 투입했습니다.`, n.idx);
    return { ok: true };
  }
  // 회수: 아직 쓰지 않은 금고 돈을 비축으로 되돌린다
  recall(pid, pot) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    if (!['industry', 'research', 'military', 'finance'].includes(pot)) return { ok: false, error: '잘못된 부처입니다.' };
    const amt = Math.floor(n.pots[pot]);
    if (amt <= 0) return { ok: false, error: '회수할 금고 잔액이 없습니다.' };
    n.pots[pot] = 0;
    this.pushLog(`${{ industry: '산업부', research: '과학부', military: '국방부', finance: '재무부' }[pot]} 금고 ${amt}을 비축으로 회수했습니다.`, n.idx);
    return { ok: true };
  }
  setAutoReserve(pid, on) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    n.autoReserve = !!on;
    return { ok: true };
  }
  setAutoCabinet(pid, on) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    n.autoCabinet = !!on;
    return { ok: true };
  }
  // 핵 타격: 적 도시 체력 0, 인구·건물 절반, 반경 2 적 부대 소멸, 피폭 150초. 세계 신뢰 −30, 양쪽 피로도 상승.
  nuke(pid, cityId) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    if (!n.flags.nuke) return { ok: false, error: '전략 핵무기 기술이 없습니다.' };
    if (this.time < n.nukeReady) return { ok: false, error: `재사용 대기 ${Math.ceil(n.nukeReady - this.time)}초` };
    if (Council.worldBuff(this, 'nonuke') > 0) return { ok: false, error: '세계 의회의 핵 금지 조약이 발효 중입니다.' };
    if (n.cash < RULES.nukeCost) return { ok: false, error: `현금 ${RULES.nukeCost}이 필요합니다.` };
    const c = this.cityById.get(cityId);
    if (!c || c.owner < 0 || c.owner === n.idx) return { ok: false, error: '적 도시를 지정하세요.' };
    if (!this.hostile(n.idx, c.owner)) return { ok: false, error: '적대 관계가 아닙니다.' };
    n.cash -= RULES.nukeCost;
    n.nukeReady = this.time + RULES.nukeCooldown;
    c.hp = 0; c.pop = Math.round(c.pop * 0.5);
    for (const k of BUILDING_ORDER) c.b[k] = Math.floor(c.b[k] / 2);
    c.maxHp = this.cityMaxHp(c);
    c.unrest = Math.max(c.unrest, RULES.nukeFallout);
    for (const [id, u] of this.units) {
      if (u.owner === n.idx || !u.ground && !u.naval) continue;
      if (cheb(u.tx, u.ty, c.x, c.y) <= 2) { this.units.delete(id); this.nations[u.owner].stats.losses++; }
    }
    this.fx('nuke', c.x, c.y, { c: n.idx });
    for (const o of this.nations) if (o.idx !== n.idx) Dip.bump(this, n.idx, o.idx, -30);
    n.weariness = Math.min(100, n.weariness + 12);
    const v = this.nations[c.owner];
    v.weariness = Math.min(100, v.weariness + 30);
    this.pushLog(`☢ ${n.title}이(가) ${v.title}의 ${c.name}에 핵 타격을 가했습니다! 세계가 경악합니다.`, n.idx);
    return { ok: true };
  }
  setLiquidate(pid, on) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    n.liquidate = !!on;
    return { ok: true };
  }
  setResearchTarget(pid, techId) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    if (techId !== null && !TECHS[techId]) return { ok: false, error: '없는 기술입니다.' };
    if (techId && this.hasTech(n, techId)) return { ok: false, error: '이미 보유한 기술입니다.' };
    n.researchTarget = techId;
    // 진행 중인 연구가 목표 경로 밖이면 바꾼다 (진행도는 보존)
    if (n.researching && techId) {
      const path = this.researchPath(n, techId);
      if (!path.includes(n.researching.id)) {
        n._saved = n._saved || {};
        n._saved[n.researching.id] = n.researching.progress;
        n.researching = null;
      }
    }
    return { ok: true };
  }
  // 직접 명령: 위임을 잠시 벗어나 지정 지점으로 이동/공격
  orderUnit(pid, unitId, x, y) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    const u = this.units.get(unitId);
    if (!u || u.owner !== n.idx) return { ok: false, error: '내 부대가 아닙니다.' };
    x = Math.round(Number(x)); y = Math.round(Number(y));
    if (!this.inBounds(x, y)) return { ok: false, error: '지도 밖입니다.' };
    if (u.naval && this.tileId(x, y) !== 'water') return { ok: false, error: '함대는 바다로만 갈 수 있습니다.' };
    if (u.ground && !isFinite(this.terrain(x, y).moveCost)) return { ok: false, error: '지상군이 갈 수 없는 지형입니다.' };
    u.mission = 'manual';
    u.manualIdle = 0;
    this.setGoal(u, x, y);
    return { ok: true };
  }
  releaseUnit(pid, unitId) {
    const n = this.nation(pid);
    const u = this.units.get(unitId);
    if (!n || !u || u.owner !== n.idx) return { ok: false, error: '내 부대가 아닙니다.' };
    u.mission = 'defend';
    u.nextThink = 0;
    return { ok: true };
  }

  /* ================================================================ 영토 */

  // 도시 반경 기준 기본 영토: 각 도시에서 BFS(통행 가능 육지)로 반경까지 퍼뜨린다.
  // 가장 가까운 도시가 이긴다. 반경 밖의 타일은 부대가 칠한 값을 유지한다.
  recomputeTerritory() {
    const W = this.W, H = this.H;
    const dist = new Int16Array(W * H).fill(32767);
    const own = new Int16Array(W * H).fill(-1);
    const src = new Int16Array(W * H).fill(-1);
    const queue = [];
    this.cities.forEach((c, ci) => {
      if (c.owner < 0) return;
      const i = c.y * W + c.x;
      dist[i] = 0; own[i] = c.owner; src[i] = ci;
      queue.push(i);
    });
    let qi = 0;
    while (qi < queue.length) {
      const i = queue[qi++];
      const c = this.cities[src[i]];
      const R = RULES.cityRadius[c.size];
      const d = dist[i];
      const x = i % W, y = (i - x) / W;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          // 둥근 영토: 도시에서 유클리드 반경 안쪽만
          if (Math.hypot(nx - c.x, ny - c.y) > R + 0.3) continue;
          const j = ny * W + nx;
          const t = this.map.tiles[j];
          if (t === 'water') continue;
          const nd = d + 1;
          if (nd < dist[j]) { dist[j] = nd; own[j] = own[i]; src[j] = src[i]; queue.push(j); }
        }
      }
    }
    for (let i = 0; i < own.length; i++) if (own[i] >= 0) this.territory[i] = own[i];
    // 도시 타일은 항상 도시 주인의 것
    for (const c of this.cities) this.territory[c.y * W + c.x] = c.owner;
  }

  // 전선에서 멀어진 점령지는 천천히 원래 도시 주인에게 돌아간다
  healTerritory() {
    const W = this.W, H = this.H;
    const enemyNear = (x, y, ownerIdx) => {
      for (const u of this.units.values()) {
        if (u.owner === ownerIdx || !u.ground || !this.hostile(u.owner, ownerIdx)) continue;
        if (cheb(u.tx, u.ty, x, y) <= 2) return true;
      }
      return false;
    };
    for (const c of this.cities) {
      if (c.owner < 0) continue;
      const R = RULES.cityRadius[c.size] - 1;
      for (let y = c.y - R; y <= c.y + R; y++) {
        for (let x = c.x - R; x <= c.x + R; x++) {
          if (!this.inBounds(x, y)) continue;
          const i = y * W + x;
          if (this.territory[i] === c.owner || this.territory[i] === -1) continue;
          if (this.map.tiles[i] === 'water') continue;
          if (Math.hypot(x - c.x, y - c.y) > R) continue;
          if (Math.random() < 0.35 && !enemyNear(x, y, c.owner)) this.territory[i] = c.owner;
        }
      }
    }
  }

  paintTerritory(u) {
    const W = this.W;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const x = u.tx + ox, y = u.ty + oy;
        if (!this.inBounds(x, y)) continue;
        const i = y * W + x;
        const t = this.map.tiles[i];
        if (t === 'water' || t === 'peak') continue;
        if (t === 'urban') continue; // 도시 타일은 점령으로만 바뀐다
        const cur = this.territory[i];
        if (cur >= 0 && cur !== u.owner && !this.hostile(u.owner, cur)) continue; // 불가침·동맹국 땅은 건드리지 않는다
        this.territory[i] = u.owner;
      }
    }
  }

  /* ================================================================ 부대 */

  spawnUnit(n, type, city) {
    const def = UNITS[type];
    const id = 'u' + (++this._unitSeq).toString(36);
    const at = def.naval ? (this.shoreTile(city) || city) : city;
    const u = {
      id, owner: n.idx, type, ground: !!def.ground, flying: !!def.flying, naval: !!def.naval,
      x: at.x, y: at.y, tx: at.x, ty: at.y,
      strength: 100, path: null, goal: null, mission: 'defend', targetCity: null,
      fight: false, nextThink: Math.random() * 2, manualIdle: 0, stuck: 0,
    };
    this.units.set(id, u);
    return u;
  }

  setGoal(u, x, y) {
    if (u.goal && u.goal.x === x && u.goal.y === y && u.path) return;
    u.goal = { x, y };
    u.path = findPath(this.map, { x: u.tx, y: u.ty }, { x, y }, { flying: u.flying, naval: u.naval });
    if (!u.path) { u.goal = null; u.stuck++; }
    else u.stuck = 0;
  }

  // 교리 비율에 가장 못 미치는 임무를 고른다
  pickMission(n) {
    const counts = { defend: 0, expand: 0, attack: 0 };
    let total = 0;
    for (const u of this.units.values()) {
      if (u.owner !== n.idx || u.mission === 'manual') continue;
      counts[u.mission] = (counts[u.mission] || 0) + 1;
      total++;
    }
    const hasNeutral = this.cities.some((c) => c.owner === -1);
    if (n.attackTarget !== 'any' && !(this.nations[n.attackTarget] && this.nations[n.attackTarget].alive)) n.attackTarget = 'any';
    const hasEnemy = this.cities.some((c) => this.isEnemyCityFor(n, c));
    let best = 'defend', bestGap = -Infinity;
    for (const m of ['defend', 'expand', 'attack']) {
      if (m === 'expand' && !hasNeutral) continue;
      if (m === 'attack' && !hasEnemy) continue;
      const target = n.doctrine[m] / 100;
      if (target <= 0 && m !== 'defend') continue;
      const share = total > 0 ? counts[m] / (total + 1) : 0;
      const gap = target - share;
      if (gap > bestGap) { bestGap = gap; best = m; }
    }
    return best;
  }

  threatOf(city, ownerIdx) {
    return this.threatDetail(city, ownerIdx).total;
  }
  // 도시 주변(10칸) 적 위협을 병종별로 나눠 센다 — 무엇이 오는지 알아야 맞는 병종을 보낼 수 있다
  threatDetail(city, ownerIdx) {
    const by = { inf: 0, armor: 0, arty: 0, air: 0, navy: 0 };
    let total = 0;
    for (const u of this.units.values()) {
      if (u.owner === ownerIdx) continue;
      if (!this.nations[u.owner].alive) continue;
      if (!this.hostile(u.owner, ownerIdx)) continue;
      const d = Math.hypot(u.x - city.x, u.y - city.y);
      if (d >= 10) continue;
      const w = (u.strength / 100) * (UNITS[u.type].cost / 150) / (1 + d * 0.5);
      by[u.type] += w;
      total += w;
    }
    return { total, by };
  }
  // 이 부대가 주어진 위협 구성에 얼마나 통하는가 (0~1.6). 항공만 오는데 기갑을 보내면 0.25 처럼 낮게 나온다.
  effectiveness(u, by) {
    let total = 0, eff = 0;
    for (const t of UNIT_ORDER) { total += by[t]; }
    if (total <= 0) return 1;
    for (const t of UNIT_ORDER) if (by[t] > 0) eff += (by[t] / total) * this.counterMult(u, { type: t });
    return eff;
  }
  // 국가 전체 위협 구성 (내각이 병종·방공 우선순위를 정할 때 쓴다)
  nationThreat(n) {
    const by = { inf: 0, armor: 0, arty: 0, air: 0, navy: 0 };
    let total = 0;
    for (const c of this.cities) {
      if (c.owner !== n.idx) continue;
      const d = this.threatDetail(c, n.idx);
      for (const t of UNIT_ORDER) by[t] += d.by[t];
      total += d.total;
    }
    const share = {};
    for (const t of UNIT_ORDER) share[t] = total > 0 ? by[t] / total : 0;
    n.threat = { total, share };
    return n.threat;
  }

  isEnemyCityFor(n, c) {
    if (c.owner < 0 || c.owner === n.idx) return false;
    if (!this.nations[c.owner].alive) return false;
    if (!Dip.isHostile(this, n.idx, c.owner)) return false;
    if (n.attackTarget !== 'any' && c.owner !== n.attackTarget) return false;
    return true;
  }
  hostile(a, b) {
    return Dip.isHostile(this, a, b);
  }

  /* ---------------------------------------------------------------- 외교 명령 */
  dipPropose(pid, target, kind) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    if (kind !== 'peace' && kind !== 'ally') return { ok: false, error: '잘못된 제안입니다.' };
    const t = Number(target);
    if (!this.nations[t]) return { ok: false, error: '상대 국가가 없습니다.' };
    return Dip.propose(this, n.idx, t, kind);
  }
  dipRespond(pid, offerId, yes) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    return Dip.respond(this, n.idx, Number(offerId), !!yes);
  }
  dipDeclare(pid, target) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    const t = Number(target);
    if (!this.nations[t] || t === n.idx) return { ok: false, error: '상대 국가가 없습니다.' };
    return Dip.declareWar(this, n.idx, t);
  }
  dipTribute(pid, target, amount) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    const t = Number(target);
    if (!this.nations[t] || t === n.idx || !this.nations[t].alive) return { ok: false, error: '상대 국가가 없습니다.' };
    return Dip.sendTribute(this, n.idx, t, amount);
  }

  thinkUnit(u, n) {
    const lost = (u.lastStr === undefined ? 0 : u.lastStr - u.strength);
    u.lastStr = u.strength;
    if (u.mission === 'manual') {
      if (!u.goal) {
        u.manualIdle += RULES.missionInterval;
        if (u.manualIdle > 25) u.mission = this.pickMission(n);
      }
      return;
    }
    // 반격할 수 없는 적(예: 기갑을 때리는 항공기)에게 맞고만 있으면 방공망이 있는 아군 도시로 물러난다
    if (lost > 2.5 && !u.fight && u.ground) {
      const near = { inf: 0, armor: 0, arty: 0, air: 0, navy: 0 };
      for (const v of this.units.values()) {
        if (v.owner === u.owner || !this.hostile(u.owner, v.owner)) continue;
        if (cheb(v.tx, v.ty, u.tx, u.ty) <= 4) near[v.type] += v.strength;
      }
      if (this.effectiveness(u, near) < 0.35) {
        let best = null, bd = Infinity;
        for (const c of this.cities) {
          if (c.owner !== n.idx) continue;
          const d = Math.hypot(c.x - u.x, c.y - u.y);
          const score = d - (near.air > 0 && c.b.aa > 0 ? 8 : 0) + this.threatOf(c, n.idx) * 3;
          if (score < bd) { bd = score; best = c; }
        }
        if (best && !(best.x === u.tx && best.y === u.ty)) { this.setGoal(u, best.x, best.y); u.targetCity = best.id; return; }
      }
    }
    // 교리가 바뀌면 재배정. 목표가 없는 임무는 expand → attack → defend 순으로 내려간다 (재귀 없음).
    let mission = this.rebalanceMission(u, n, u.mission);
    let target = null;
    if (u.naval) return this.thinkNavy(u, n, mission);
    if (mission === 'expand') {
      let best = null, bestD = Infinity;
      for (const c of this.cities) {
        if (c.owner !== -1) continue;
        let heading = 0;
        for (const v of this.units.values()) if (v.owner === n.idx && v.targetCity === c.id && v.id !== u.id) heading++;
        const d = Math.hypot(u.x - c.x, u.y - c.y) + heading * 6;
        if (d < bestD) { bestD = d; best = c; }
      }
      target = best;
      if (!target) mission = 'attack';
    }
    if (mission === 'attack') {
      let best = null, bestS = Infinity;
      for (const c of this.cities) {
        if (!this.isEnemyCityFor(n, c)) continue;
        const d = Math.hypot(u.x - c.x, u.y - c.y);
        // 그 도시를 지키는 적 구성에 내가 통하지 않으면(기갑으로 함대·항공 수비를 뚫기 등) 다른 목표를 고른다
        const guard = this.threatDetail(c, c.owner);
        const eff = guard.total > 0.3 ? this.effectiveness(u, guard.by) : 1;
        if (eff < 0.3) continue;
        const defense = guard.total + c.hp / 400;
        const s = d + defense * 3 / Math.max(0.5, eff) - (c.hp <= 0 ? 8 : 0);
        if (s < bestS) { bestS = s; best = c; }
      }
      target = best;
      if (!target) mission = 'defend';
    }
    if (mission === 'defend') {
      let best = null, bestScore = -Infinity;
      for (const c of this.cities) {
        const mine = c.owner === n.idx;
        const allied = !mine && c.owner >= 0 && Dip.isAllied(this, n.idx, c.owner);
        if (!mine && !allied) continue;
        const td = this.threatDetail(c, c.owner);
        const th = td.total;
        if (allied && th < 0.5) continue; // 동맹 도시는 실제로 위협받을 때만 구원한다
        let defenders = 0;
        for (const v of this.units.values()) if (v.owner === n.idx && v.targetCity === c.id && v.id !== u.id) defenders++;
        const d = Math.hypot(u.x - c.x, u.y - c.y);
        // 위협 구성에 내가 통하는 만큼만 위협을 "내 일" 로 친다. 항공만 오는 도시에 기갑은 가지 않는다 (방공포대 몫).
        const eff = th > 0.3 ? this.effectiveness(u, td.by) : 1;
        const myThreat = th * Math.min(1.3, eff) - (eff < 0.3 ? th * 2 : 0);
        const score = myThreat * (mine ? 6 : 4) + (c.id === n.capitalId ? 1.5 : 0) + c.size * 0.3 - defenders * 1.2 - d * 0.05 - (allied ? 1 : 0);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      target = best;
    }
    u.mission = mission;
    if (!target) return;
    u.targetCity = target.id;
    // 공격 임무 지상군은 혼자 가지 않는다: 목표에 가장 가까운 아군 도시에 모였다가 rallySize 이상이면 진격
    if (mission === 'attack' && u.ground && Math.hypot(u.x - target.x, u.y - target.y) > 7) {
      let rally = null, rd = Infinity;
      for (const c of this.cities) {
        if (c.owner !== n.idx) continue;
        const d = Math.hypot(c.x - target.x, c.y - target.y);
        if (d < rd) { rd = d; rally = c; }
      }
      if (rally) {
        let group = 0;
        for (const v of this.units.values()) {
          if (v.owner !== n.idx || !v.ground || v.mission !== 'attack' || v.id === u.id) continue;
          if (Math.hypot(v.x - u.x, v.y - u.y) <= 5) group++;
        }
        if (group + 1 < RULES.rallySize) { this.setGoal(u, rally.x, rally.y); return; }
      }
    }
    this.setGoal(u, target.x, target.y);
  }

  // 함대: 중립 도시는 점령 못 하므로 확장 임무는 공격으로 본다. 해안 도시의 앞바다로 가서 포격/초계한다.
  thinkNavy(u, n, mission) {
    if (mission === 'expand') mission = 'attack';
    let target = null;
    if (mission === 'attack') {
      let bestS = Infinity;
      for (const c of this.cities) {
        if (!this.isEnemyCityFor(n, c) || !this.isCoastal(c)) continue;
        const sh = this.shoreTile(c);
        const s = Math.hypot(u.x - sh.x, u.y - sh.y) + this.threatOf(c, n.idx) * 2;
        if (s < bestS) { bestS = s; target = c; }
      }
      if (!target) mission = 'defend';
    }
    if (mission === 'defend') {
      let bestScore = -Infinity;
      for (const c of this.cities) {
        if (c.owner !== n.idx || !this.isCoastal(c)) continue;
        let guards = 0;
        for (const v of this.units.values()) if (v.owner === n.idx && v.naval && v.targetCity === c.id && v.id !== u.id) guards++;
        const sh = this.shoreTile(c);
        const score = this.threatOf(c, n.idx) * 6 + c.size * 0.3 + (c.b.port > 0 ? 1 : 0) - guards * 1.2 - Math.hypot(u.x - sh.x, u.y - sh.y) * 0.05;
        if (score > bestScore) { bestScore = score; target = c; }
      }
    }
    u.mission = mission;
    if (!target) return;
    u.targetCity = target.id;
    const sh = this.shoreTile(target);
    this.setGoal(u, sh.x, sh.y);
  }

  rebalanceMission(u, n, mission) {
    // 현재 임무 분포가 교리와 많이 어긋나면 이 부대를 가장 부족한 임무로 돌린다
    const counts = { defend: 0, expand: 0, attack: 0 };
    let total = 0;
    for (const v of this.units.values()) {
      if (v.owner !== n.idx || v.mission === 'manual') continue;
      counts[v.mission] = (counts[v.mission] || 0) + 1;
      total++;
    }
    if (total === 0) return mission;
    const share = counts[mission] / total;
    const want = n.doctrine[mission] / 100;
    if (share > want + 0.25 || want === 0) return this.pickMission(n);
    return mission;
  }

  moveUnit(u, n, dt) {
    if (!u.path || u.path.length === 0) { u.path = null; u.goal = null; return; }
    if (u.fight && u.mission !== 'manual') return; // 교전 중에는 전진하지 않는다
    const next = u.path[0];
    const dx = next.x - u.x, dy = next.y - u.y;
    const dist = Math.hypot(dx, dy);
    const terr = u.flying || u.naval ? 1 : this.terrain(next.x, next.y).moveCost;
    if (!isFinite(terr)) { u.path = null; u.goal = null; return; }
    const speed = (UNITS[u.type].speed * n.mult.speed) / terr * (u.strength < 30 ? 0.8 : 1);
    const step = speed * dt;
    if (step >= dist) {
      u.x = next.x; u.y = next.y;
      u.path.shift();
      if (u.path.length === 0) { u.path = null; u.goal = null; }
    } else {
      u.x += (dx / dist) * step;
      u.y += (dy / dist) * step;
    }
    const tx = Math.round(u.x), ty = Math.round(u.y);
    if (tx !== u.tx || ty !== u.ty) {
      u.tx = tx; u.ty = ty;
      if (u.ground) this.paintTerritory(u);
    }
  }

  buildUnitGrid() {
    const grid = new Map();
    for (const u of this.units.values()) {
      const k = u.ty * this.W + u.tx;
      let arr = grid.get(k);
      if (!arr) grid.set(k, (arr = []));
      arr.push(u);
    }
    return grid;
  }
  enemiesInRange(u, grid, range) {
    const out = [];
    for (let oy = -range; oy <= range; oy++) {
      for (let ox = -range; ox <= range; ox++) {
        const x = u.tx + ox, y = u.ty + oy;
        if (!this.inBounds(x, y)) continue;
        const arr = grid.get(y * this.W + x);
        if (!arr) continue;
        for (const v of arr) if (v.owner !== u.owner && this.nations[v.owner].alive && this.hostile(u.owner, v.owner)) out.push(v);
      }
    }
    return out;
  }

  tickCombat(dt, grid) {
    const dmg = new Map(); // unitId → damage
    const dmgBy = new Map(); // unitId → { ownerIdx: damage } (격멸 공로)
    let warIntensity = 0;
    for (const u of this.units.values()) {
      const range = this.unitRange(u);
      const enemies = this.enemiesInRange(u, grid, range);
      // 포병은 근접하면 불리하므로 사거리 안 적 중 가장 먼 적을 친다. 나머지는 가장 약한 적.
      let target = null, bestS = -Infinity;
      for (const e of enemies) {
        if (u.type === 'arty' && e.flying) continue; // 포병은 항공기를 못 친다
        const cm = this.counterMult(u, e);
        if (cm <= 0) continue;
        const s = cm * 2 - e.strength / 100;
        if (s > bestS) { bestS = s; target = e; }
      }
      u.fight = !!target;
      if (!target) continue;
      const an = this.nations[u.owner], dn = this.nations[target.owner];
      an._fightAt = this.time; dn._fightAt = this.time; // 평화 기념관 등 "교전 중이 아닐 때" 판정용
      const atk = UNITS[u.type].atk * (1 + 0.25 * (an.tier[u.type] - 1)) * (an.mult.atk + this.buff(an, 'atk')) * this.counterMult(u, target);
      let def = UNITS[target.type].def * (1 + 0.25 * (dn.tier[target.type] - 1)) * (dn.mult.def + this.buff(dn, 'def'));
      if (!target.flying) def *= this.terrain(target.tx, target.ty).def;
      else def *= 1 + (dn.mult.airDef - 1);
      const d = (atk / def) * 6 * (u.strength / 100) * dt;
      dmg.set(target.id, (dmg.get(target.id) || 0) + d);
      let by = dmgBy.get(target.id);
      if (!by) dmgBy.set(target.id, (by = {}));
      by[u.owner] = (by[u.owner] || 0) + d;
      warIntensity += d;
    }
    for (const [id, d] of dmg) {
      const u = this.units.get(id);
      if (!u) continue;
      u.strength -= d;
      if (u.strength <= 0) {
        this.units.delete(id);
        this.fx('boom', u.x, u.y, { c: u.owner });
        const n = this.nations[u.owner];
        this.pushLog(`${n.title}의 ${UNITS[u.type].name}이(가) 전멸했습니다.`, u.owner);
        // 전쟁 피로도: 잃은 쪽이 크게 — 단, 제 땅을 지키다 잃으면 덜하다. 격멸한 쪽도 남의 땅에서 싸웠으면 크게 (침략은 사회를 지치게 한다)
        n.stats.losses++;
        const tileOwner = this.territory[Math.round(u.ty) * this.W + Math.round(u.tx)];
        n.weariness = Math.min(100, n.weariness + (tileOwner === u.owner ? RULES.wearinessPerLossHome : RULES.wearinessPerLoss));
        const by = dmgBy.get(id) || {};
        let killer = -1, best = 0;
        for (const [o, v] of Object.entries(by)) if (v > best) { best = v; killer = Number(o); }
        if (killer >= 0) {
          const k = this.nations[killer]; k.stats.kills++;
          const abroad = tileOwner !== killer && !(tileOwner >= 0 && Dip.isAllied(this, killer, tileOwner)); // 동맹 땅을 지키는 건 침략이 아니다
          k.weariness = Math.min(100, k.weariness + (abroad ? RULES.wearinessPerKillAbroad : RULES.wearinessPerKill));
        }
      }
    }
    this.world.war += (warIntensity - this.world.war) * Math.min(1, dt * 0.3);
  }

  /* ================================================================ 도시 */

  tickCities(dt, grid) {
    for (const c of this.cities) {
      const own = c.owner >= 0 ? this.nations[c.owner] : null;
      // 사거리 안의 적 (보병·기갑은 인접, 포병·함대는 3~4칸 밖에서도 포격). 수비대·민병대는 인접 1칸 기준.
      const attackers = [];
      const adjacent = [];
      let defenders = 0;
      let onTile = null;
      for (let oy = -4; oy <= 4; oy++) {
        for (let ox = -4; ox <= 4; ox++) {
          const arr = grid.get((c.y + oy) * this.W + (c.x + ox));
          if (!arr) continue;
          const adj = Math.abs(ox) <= 1 && Math.abs(oy) <= 1;
          for (const u of arr) {
            if (u.owner === c.owner || (c.owner >= 0 && Dip.isAllied(this, u.owner, c.owner))) { if (u.ground && adj) defenders++; continue; }
            if (!this.nations[u.owner].alive) continue;
            if (!this.hostile(u.owner, c.owner)) continue;
            if (Math.max(Math.abs(ox), Math.abs(oy)) > this.unitRange(u)) continue;
            attackers.push(u);
            if (adj) adjacent.push(u);
            if (!ox && !oy && u.ground && (!onTile || u.strength > onTile.strength)) onTile = u;
          }
        }
      }
      // 방공포대
      if (c.b.aa > 0 && own) {
        for (const u of attackers) {
          if (!u.flying) continue;
          u.strength -= BUILDINGS.aa.aaDmg * c.b.aa * own.mult.airDef * dt;
          if (u.strength <= 0) {
            this.units.delete(u.id);
            this.fx('boom', u.x, u.y, { c: u.owner });
            this.pushLog(`${this.nations[u.owner].title}의 항공전대가 ${c.name} 방공망에 격추되었습니다.`, u.owner);
          }
        }
      }
      if (attackers.length === 0) {
        if (c.hp < c.maxHp && this.time - c.siege > 4) c.hp = Math.min(c.maxHp, c.hp + RULES.cityRegen * (1 + c.b.bunker * 0.5) * dt);
        c.cap = null;
        continue;
      }
      c.siege = this.time;
      // 도시 민병대: 인접 적 지상군에 피해 (체력이 깎일수록 약해진다, 중립은 60%)
      const grace = (this.time < RULES.graceSeconds || this.truce()) && own; // 초반 보호: 민병대 2배, 점령 불가
      const militia = RULES.cityMilitia * c.size * (0.25 + 0.75 * (c.hp / c.maxHp)) * (own ? 1 : 0.6) * (1 + c.b.bunker * 0.5) * (own ? own.mult.cityDef : 1) * (grace ? 2 : 1);
      for (const u of adjacent) {
        if (!u.ground) continue;
        u.strength -= militia * dt;
        if (u.strength <= 0) {
          this.units.delete(u.id);
          this.fx('boom', u.x, u.y, { c: u.owner });
          this.pushLog(`${this.nations[u.owner].title}의 ${UNITS[u.type].name}이(가) ${c.name} 수비대에 궤멸되었습니다.`, u.owner);
        }
      }
      // 교전 중이 아닌 공격자만 도시를 때린다
      let dps = 0;
      for (const u of attackers) {
        if (u.fight) continue;
        const an = this.nations[u.owner];
        dps += UNITS[u.type].atk * (1 + 0.25 * (an.tier[u.type] - 1)) * (an.mult.atk + this.buff(an, 'atk')) * (u.strength / 100) * (u.type === 'arty' ? 1.6 : u.type === 'navy' ? 1.4 : 1);
      }
      c.hp = Math.max(0, c.hp - dps * 2.2 * dt / (1 + defenders * 0.5));
      // 점령: 체력 0 + 아군 지상 수비대 없음 + 적 지상군이 타일 위
      if (c.hp <= 0 && onTile && defenders === 0 && !onTile.fight && !grace) {
        if (!c.cap || c.cap.by !== onTile.owner) c.cap = { by: onTile.owner, t: 0 };
        c.cap.t += dt;
        if (c.cap.t >= RULES.captureSeconds) this.captureCity(c, onTile.owner);
      } else {
        c.cap = null;
      }
    }
  }

  captureCity(c, byIdx) {
    const prev = c.owner;
    const n = this.nations[byIdx];
    c.owner = byIdx;
    c.cap = null;
    for (const k of BUILDING_ORDER) c.b[k] = Math.floor(c.b[k] * RULES.captureKeep);
    c.pop = Math.round(c.pop * 0.7);
    c.maxHp = this.cityMaxHp(c);
    c.hp = Math.round(c.maxHp * 0.3);
    this.fx('cap', c.x, c.y, { c: byIdx });
    n.stats.captures++;
    if (prev >= 0) {
      const pn = this.nations[prev];
      this.pushLog(`${n.title}이(가) ${pn.title}의 도시 ${c.name}을(를) 점령했습니다!`, byIdx);
      // 점령지 저항 + 세계 여론: 정복은 돈이 바로 되지 않고 평판을 깎는다
      c.unrest = RULES.unrestSeconds;
      pn.weariness = Math.min(100, pn.weariness + 8);
      n.weariness = Math.min(100, n.weariness + RULES.wearinessPerConquest); // 정복한 쪽도 지친다
      for (const o of this.nations) if (o.idx !== byIdx && o.idx !== prev) Dip.bump(this, byIdx, o.idx, -RULES.conquestOpinion);
      if (pn.capitalId === c.id) {
        // 수도를 잃으면 남은 도시 중 가장 큰 곳으로 천도
        const rest = this.cities.filter((x) => x.owner === prev).sort((a, b) => b.size - a.size);
        if (rest.length) { pn.capitalId = rest[0].id; this.pushLog(`${pn.title}이(가) ${rest[0].name}(으)로 천도했습니다.`, prev); }
        else this.eliminate(pn);
      }
    } else {
      this.pushLog(`${n.title}이(가) 중립 도시 ${c.name}을(를) 병합했습니다.`, byIdx);
    }
    this.recomputeTerritory();
  }

  eliminate(n) {
    n.alive = false;
    n.capitalId = null;
    for (const [id, u] of this.units) if (u.owner === n.idx) this.units.delete(id);
    for (let i = 0; i < this.territory.length; i++) if (this.territory[i] === n.idx) this.territory[i] = -1;
    this.pushLog(`${n.title}이(가) 멸망했습니다.`, n.idx);
    this.recomputeTerritory();
  }

  /* ================================================================ 경제 */

  tickEconomy(dt) {
    for (const n of this.nations) {
      if (!n.alive) continue;
      const m = n.mult;
      let income = 0, sales = 0, expense = 0, science = RULES.scienceBase;
      let tiles = 0;
      const bFactory = 1 + this.buff(n, 'factory'), bResource = 1 + this.buff(n, 'resource'), bScience = 1 + this.buff(n, 'science');
      for (let i = 0; i < this.territory.length; i++) if (this.territory[i] === n.idx) tiles++;
      income += tiles * RULES.tileIncome;
      let grainNeed = 0, grainOut = 0;
      for (const c of this.cities) {
        if (c.owner !== n.idx) continue;
        grainNeed += c.pop * 0.004;
        // 저항/피폭 중인 도시는 아무것도 내지 않는다 (주둔군이 있으면 2배 빨리 안정)
        if (c.unrest > 0) {
          let garrison = false;
          for (const u of this.units.values()) if (u.owner === n.idx && u.ground && u.tx === c.x && u.ty === c.y) { garrison = true; break; }
          c.unrest = Math.max(0, c.unrest - dt * (garrison ? 2 : 1));
          c.pop = Math.max(20, c.pop * (1 - 0.0006 * dt));
          continue;
        }
        income += c.pop * RULES.popTax;
        // 자원
        n.mats.iron += BUILDINGS.mine.out.iron * c.b.mine * m.resource * bResource * dt;
        n.mats.oil += BUILDINGS.oilwell.out.oil * c.b.oilwell * m.resource * bResource * dt;
        const g = BUILDINGS.farm.out.grain * c.b.farm * m.resource * bResource;
        grainOut += g;
        n.mats.grain += g * dt;
        science += BUILDINGS.lab.science * c.b.lab * m.science * bScience;
        // 공장: 재료가 있으면 생산, 부족하면 시장에서 사 온다
        if (c.b.factory > 0) {
          const needIron = BUILDINGS.factory.in.iron * c.b.factory * dt;
          const needOil = BUILDINGS.factory.in.oil * c.b.factory * dt;
          let ok = true;
          if (c.b.port > 0) income += c.pop * RULES.popTax * BUILDINGS.port.trade * c.b.port * (1 + this.projectBonus(n, 'portTrade')); // 항구 교역 (대운하 2배)
        for (const [mat, need] of [['iron', needIron], ['oil', needOil]]) {
            if (n.mats[mat] < need) {
              const short = need - n.mats[mat];
              const cost = this.marketBuy(mat, short);
              if (n.cash - cost < -200) { ok = false; break; }
              n.cash -= cost; expense += cost / dt;
              n.mats[mat] += short;
            }
          }
          if (ok) {
            n.mats.iron -= needIron; n.mats.oil -= needOil;
            const goods = BUILDINGS.factory.out.goods * c.b.factory * m.factory * bFactory * dt;
            const rev = this.marketSell('goods', goods);
            sales += rev / dt;
            n.cash += rev;
          }
        }
        // 건물 유지비
        for (const k of BUILDING_ORDER) if (c.b[k]) expense += BUILDINGS[k].cost * c.b[k] * RULES.buildingUpkeep;
      }
      // 곡물: 인구 소비 → 남으면 인구 증가, 모자라면 감소
      n.mats.grain -= grainNeed * dt;
      const fed = n.mats.grain > 0;
      if (!fed) n.mats.grain = 0;
      for (const c of this.cities) {
        if (c.owner !== n.idx || c.unrest > 0) continue;
        const cap = 160 * c.size + 80;
        if (fed && grainOut >= grainNeed * 0.8 && n.weariness < 40) c.pop = Math.min(cap, c.pop * (1 + 0.0007 * dt));
        else if (!fed) c.pop = Math.max(20, c.pop * (1 - 0.0008 * dt));
      }
      // 자재 과잉은 자동 매도
      for (const mat of ['iron', 'oil', 'grain']) {
        if (n.mats[mat] > D.STOCKPILE_CAP) {
          const q = n.mats[mat] - D.STOCKPILE_CAP;
          const rev = this.marketSell(mat, q);
          n.mats[mat] -= q;
          n.cash += rev; sales += rev / dt;
        }
      }
      // 부대 유지비 — 대군일수록 부대당 유지비가 오른다
      let units = 0, upkeepSum = 0;
      for (const u of this.units.values()) {
        if (u.owner !== n.idx) continue;
        units++;
        upkeepSum += UNITS[u.type].upkeep;
      }
      expense += upkeepSum * m.upkeep * (1 + this.buff(n, 'upkeep')) * (1 + RULES.upkeepScale * Math.max(0, units - RULES.upkeepScaleFrom));
      // 배당
      let dividend = 0;
      for (const k of STOCK_ORDER) dividend += n.stocks[k] * this.stocks[k].price * STOCKS[k].yieldRate * m.dividend * (1 + this.buff(n, 'dividend'));
      // 행정 비용: 도시가 많을수록 세수 효율이 떨어진다
      let cityCount = 0;
      for (const c of this.cities) if (c.owner === n.idx) cityCount++;
      const admin = Math.max(0.55, 1 - RULES.adminPenalty * Math.max(0, cityCount - RULES.adminFrom));
      // 교역: 불가침·동맹국이 많을수록 세수가 는다. 전쟁 피로도는 세수를 깎는다.
      let trade = 0;
      for (const o of this.nations) {
        if (o.idx === n.idx || !o.alive) continue;
        const s = Dip.stateOf(this, n.idx, o.idx);
        if (s === 'ally') trade += RULES.tradeAlly; else if (s === 'peace') trade += RULES.tradePeace;
      }
      trade = trade * (1 + Council.worldBuff(this, 'tradeMult')) + this.projectBonus(n, 'trade');
      const weary = 1 - RULES.wearinessIncomeMax * (n.weariness / 100);
      n.stats.trade = trade; n.stats.weary = weary;
      income *= m.income * (1 + this.buff(n, 'income')) * admin * (1 + trade) * weary;
      const net = income + sales + dividend - expense;
      n.cash += (income + dividend - expense) * dt;
      // 예산 분배: 흑자분만 각 부처 금고에 쌓인다 (비축 비율은 현금으로 남는다)
      const positive = Math.max(0, net) * dt;
      for (const k of ['industry', 'research', 'military', 'finance']) n.pots[k] += positive * (n.budget[k] / 100);
      // 적자 상태: 부대가 이탈한다
      if (n.cash < 0) {
        for (const u of this.units.values()) if (u.owner === n.idx) u.strength -= 0.6 * dt;
        for (const [id, u] of this.units) if (u.owner === n.idx && u.strength <= 0) { this.units.delete(id); this.pushLog(`${n.title}의 ${UNITS[u.type].name}이(가) 급여 미지급으로 해산했습니다.`, n.idx); }
      }
      n.science += science * dt;
      n.stats.science = science;
      n.stats.income = income; n.stats.sales = sales; n.stats.expense = expense; n.stats.dividend = dividend; n.stats.net = net;
      n.stats.tiles = tiles; n.stats.units = units;
      this.world.research += (science - this.world.research / Math.max(1, this.nations.length)) * dt * 0.05;
    }
  }

  marketBuy(mat, qty) {
    const mk = this.market[mat];
    const cost = qty * mk.price * (1 + D.STOCK_SPREAD);
    mk.price *= 1 + D.MARKET_IMPACT * qty;
    return cost;
  }
  marketSell(mat, qty) {
    const mk = this.market[mat];
    const rev = qty * mk.price * (1 - D.STOCK_SPREAD);
    mk.price *= Math.max(0.5, 1 - D.MARKET_IMPACT * qty);
    return rev;
  }
  tickMarket(dt) {
    for (const k of Object.keys(this.market)) {
      const mk = this.market[k];
      let base = mk.base;
      if (this.event && this.event.mat === k) base *= this.event.mult;
      mk.price += (base - mk.price) * Math.min(1, D.MARKET_REVERT * dt);
      mk.price = clamp(mk.price, base * 0.3, base * 4);
    }
  }

  tickStocks(dt) {
    // 각 종목의 기준 흐름 = 성장 + 세계 지표 + 평균회귀 무드 + 노이즈
    const drivers = {
      war: clamp(this.world.war / 6, 0, 2) - 0.3,
      oil: (this.market.oil.price / MATERIALS.oil.base) - 1,
      research: clamp(this.world.research / 40, 0, 2) - 0.4,
      build: clamp(this.world.build, 0, 2) - 0.2,
      stable: 0,
    };
    for (const k of STOCK_ORDER) {
      const s = this.stocks[k], def = STOCKS[k];
      const drift = 0.0004 + drivers[def.driver] * 0.0025;
      const noise = (Math.random() * 2 - 1) * def.sigma * 0.02;
      s.mood += (1 - s.mood) * 0.02 * dt + noise * Math.sqrt(dt);
      s.mood = clamp(s.mood, 0.45, 1.9);
      s.price *= 1 + (drift * dt) + (s.mood - 1) * 0.004 * dt;
      if (this.event && this.event.stock === k) s.price *= 1 + this.event.drift * dt;
      s.price = clamp(s.price, 8, 2500);
    }
    this.world.build *= Math.max(0, 1 - 0.05 * dt);
    this._stockSampleClock += dt;
    if (this._stockSampleClock >= 10) {
      this._stockSampleClock = 0;
      this._histSeq++;
      for (const k of STOCK_ORDER) {
        const s = this.stocks[k];
        s.hist[this._histSeq] = r2(s.price);
        delete s.hist[this._histSeq - 36];
      }
    }
  }

  tickEvents(dt) {
    this._eventClock -= dt;
    if (this.event) {
      this.event.left -= dt;
      if (this.event.left <= 0) { this.pushLog(`사건 종료: ${this.event.name}`); this.event = null; }
      return;
    }
    if (this._eventClock > 0) return;
    this._eventClock = 90 + Math.random() * 90;
    const pool = [
      { name: '중동 정세 불안 — 원유 급등', mat: 'oil', mult: 1.9, stock: 'energy', drift: 0.004 },
      { name: '철강 공급 과잉', mat: 'iron', mult: 0.55, stock: 'constr', drift: -0.002 },
      { name: '흉작 — 곡물 가격 폭등', mat: 'grain', mult: 2.1, stock: 'food', drift: 0.003 },
      { name: '기술주 랠리', stock: 'tech', drift: 0.006 },
      { name: '방산 수출 호황', stock: 'defense', drift: 0.005 },
      { name: '세계 경기 침체', stock: 'constr', drift: -0.005, mat: 'goods', mult: 0.7 },
      { name: '건설 붐', stock: 'constr', drift: 0.006 },
    ];
    const e = pool[Math.floor(Math.random() * pool.length)];
    this.event = { ...e, left: 45 + Math.random() * 40 };
    this.pushLog(`사건 발생: ${e.name}`);
  }

  /* ================================================================ 내각 (장관 자동 집행) */

  tickCabinet() {
    for (const n of this.nations) {
      if (!n.alive) continue;
      // 비축(가용 현금)은 지도자의 저축이다 — 모아 두었다가 "특별 집행" 으로 한 번에 쏟아부을 수 있다.
      // autoReserve 가 켜진 국가(봇 기본값)만 상한을 넘는 만큼을 예산 비율대로 금고에 자동 재배분한다.
      const earmarked = n.pots.industry + n.pots.research + n.pots.military + n.pots.finance;
      const free = n.cash - earmarked;
      const cap = Math.max(RULES.reserveMin, RULES.reserveSeconds * Math.max(0, n.stats.net));
      if (n.autoReserve && free > cap) {
        const excess = free - cap;
        const keys = ['industry', 'research', 'military', 'finance'];
        const sum = keys.reduce((s, k) => s + n.budget[k], 0);
        if (sum > 0) for (const k of keys) n.pots[k] += excess * (n.budget[k] / sum);
      }
      this.nationThreat(n);
      this.fundProject(n);
      // 특별 집행으로 금고가 두둑해지면 그만큼 빨리 집행한다 (틱당 최대 6건)
      for (let i = 0; i < 6 && this.ministerIndustry(n); i++);
      this.ministerResearch(n);
      for (let i = 0; i < 6 && this.ministerMilitary(n); i++);
      // 쓸 곳이 없어 넘치는 금고(부지 포화·부대 상한)는 투자로 돌린다 — 돈이 놀지 않게
      for (const k of ['industry', 'military']) {
        if (n.pots[k] > 2500) { n.pots.finance += n.pots[k] - 2500; n.pots[k] = 2500; }
      }
      this.ministerFinance(n);
      this.updateStats(n);
    }
    Ach.tick(this);
  }

  /* ================================================================ 국가 프로젝트 (불가사의) */

  canProject(n, id) {
    const P = PROJECTS[id];
    if (!P) return { ok: false, error: '없는 프로젝트입니다.' };
    const p = this.projects[id];
    if (p.done) return { ok: false, error: `이미 ${this.nations[p.owner].title}이(가) 완성했습니다.` };
    if (P.req && !this.hasTech(n, P.req)) return { ok: false, error: `「${TECHS[P.req].name}」 기술이 필요합니다.` };
    if (P.coastal && !this.cities.some((c) => c.owner === n.idx && this.isCoastal(c))) return { ok: false, error: '해안 도시가 필요합니다.' };
    return { ok: true };
  }
  setProject(pid, id) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    if (!id) { n.projectTarget = null; return { ok: true }; }
    const c = this.canProject(n, id);
    if (!c.ok) return c;
    n.projectTarget = id;
    return { ok: true };
  }
  // 산업 장관: 목표 프로젝트에 산업 금고의 일부를 매 주기 투입한다. 비용을 다 채우면 완성 — 세계에 하나뿐이다.
  fundProject(n) {
    const id = n.projectTarget;
    if (!id) return;
    const p = this.projects[id];
    const P = PROJECTS[id];
    if (p.done || !this.canProject(n, id).ok) { n.projectTarget = null; return; }
    const have = p.prog[n.idx] || 0;
    const amt = Math.min(n.pots.industry * RULES.projectShare, n.cash, P.cost - have);
    if (amt < 1) return;
    this.spend(n, 'industry', amt);
    p.prog[n.idx] = have + amt;
    if (p.prog[n.idx] >= P.cost - 0.01) this.completeProject(n, p);
  }
  completeProject(n, p) {
    const P = PROJECTS[p.id];
    const cap = this.cityById.get(n.capitalId);
    p.done = true; p.owner = n.idx; p.city = cap ? cap.id : null;
    n.projectTarget = null;
    // 경쟁자들은 투입액의 절반을 돌려받는다
    for (const [idx, v] of Object.entries(p.prog)) {
      const o = this.nations[Number(idx)];
      if (!o || o.idx === n.idx || !o.alive) continue;
      const refund = v * RULES.projectRefund;
      o.cash += refund; o.pots.industry += refund;
      if (o.projectTarget === p.id) o.projectTarget = null;
      this.pushLog(`${P.name} 경쟁에서 밀렸습니다 — 투입액의 절반(${Math.round(refund)})을 산업 금고로 회수`, o.idx);
    }
    p.prog = {};
    if (P.effects.trustAll) for (const o of this.nations) if (o.idx !== n.idx) Dip.bump(this, n.idx, o.idx, P.effects.trustAll);
    this.refreshMult(n);
    if (cap) this.fx('wonder', cap.x, cap.y, { c: n.idx });
    this.pushLog(`${P.icon} ${n.title}이(가) 「${P.name}」을(를) 완성했습니다! ${P.desc}`, n.idx);
    this.pushNews(`${P.icon} ${n.title}, 「${P.name}」 완성 — ${P.desc}`, n.idx);
  }

  /* ================================================================ 첩보 */

  spy(pid, targetIdx, op) {
    const n = this.nation(pid);
    if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
    const O = SPY_OPS[op];
    if (!O) return { ok: false, error: '없는 작전입니다.' };
    const t = this.nations[Number(targetIdx)];
    if (!t || t.idx === n.idx || !t.alive) return { ok: false, error: '대상이 잘못되었습니다.' };
    if (this.time < n.spyReady) return { ok: false, error: `첩보망 재정비 중 (${Math.ceil(n.spyReady - this.time)}초)` };
    const free = n.cash - (n.pots.industry + n.pots.research + n.pots.military + n.pots.finance);
    if (free < O.cost) return { ok: false, error: `비축이 ${O.cost} 필요합니다 (현재 ${Math.max(0, Math.floor(free))}).` };
    n.cash -= O.cost;
    n.spyReady = this.time + RULES.spyCooldown;
    const chance = RULES.spyBase + (n.flags.recon ? 0.15 : 0) - (t.flags.recon ? 0.15 : 0) - (this.hasTech(t, 'cyber') ? 0.15 : 0);
    const success = Math.random() < chance;
    if (!success) {
      // 발각: 대상국 신뢰 급락, 제3국도 눈살
      Dip.bump(this, n.idx, t.idx, -RULES.spyCaughtTrust);
      for (const o of this.nations) if (o.idx !== n.idx && o.idx !== t.idx) Dip.bump(this, n.idx, o.idx, -5);
      this.pushLog(`${O.icon} ${O.name} 실패 — ${t.title}에 요원이 발각되었습니다 (신뢰 −${RULES.spyCaughtTrust})`, n.idx);
      this.pushLog(`${n.title}의 첩보 요원을 체포했습니다 (${O.name})`, t.idx);
      this.pushNews(`🕵 ${t.title}, ${n.title}의 첩보 요원 체포`, t.idx);
      return { ok: true, success: false };
    }
    n.stats.spies++;
    let detail = '';
    if (op === 'sabotage') {
      // 공장이 2단계 이상인 도시만 한 단계 깎는다 (마지막 공장은 남는다). 없으면 도시 체력만 깎는다.
      const city = this.cities.filter((c) => c.owner === t.idx && c.b.factory >= 2).sort((a, b) => b.b.factory - a.b.factory)[0];
      if (city) { city.b.factory--; detail = `${city.name} 공장 −1`; this.fx('boom', city.x, city.y); this.pushLog(`${city.name}의 공장에서 원인 불명의 폭발 사고 (공장 −1)`, t.idx); }
      else { const any = this.cities.filter((c) => c.owner === t.idx).sort((a, b) => b.size - a.size)[0]; if (any) { any.hp = Math.max(1, any.hp * 0.6); this.fx('boom', any.x, any.y); detail = `${any.name} 체력 −40%`; } }
      const dock = Math.min(300, t.pots.industry); t.pots.industry -= dock; t.cash -= dock;
      detail += ` · 산업 금고 −${Math.round(dock)}`;
    } else if (op === 'steal') {
      const gain = Math.min(400, 100 + (t.researching ? t.researching.progress * 0.4 : 0));
      n.science += gain;
      detail = `과학 +${Math.round(gain)}`;
    } else if (op === 'incite') {
      t.weariness = Math.min(100, t.weariness + 12);
      const towns = this.cities.filter((c) => c.owner === t.idx && c.id !== t.capitalId);
      const city = towns.length ? towns[Math.floor(Math.random() * towns.length)] : null;
      if (city) { city.unrest = Math.max(city.unrest, 40); this.fx('cap', city.x, city.y, { c: -1 }); }
      detail = `피로도 +12${city ? ` · ${city.name} 소요 40초` : ''}`;
      this.pushLog(`전국에서 반정부 시위가 번지고 있습니다 (피로도 +12)`, t.idx);
    }
    this.pushLog(`${O.icon} ${O.name} 성공 — ${t.title}: ${detail}`, n.idx);
    return { ok: true, success: true };
  }
  decide(pid, i) { return Decisions.decide(this, pid, i); }
  vote(pid, v) { return Council.vote(this, pid, v); }

  // 지출 가능액 = 금고와 현금 중 작은 쪽
  canSpend(n, pot, cost) {
    return n.pots[pot] >= cost && n.cash >= cost;
  }
  spend(n, pot, cost) {
    n.pots[pot] -= cost;
    n.cash -= cost;
  }

  buildCost(c, kind) {
    const lv = c.b[kind];
    return Math.round(BUILDINGS[kind].cost * Math.pow(1.35, lv));
  }
  // 부지는 건물 "종류" 수를 제한한다. 증설(레벨업)은 부지를 더 먹지 않고 비용만 1.35배씩 오른다.
  usedSlots(c) {
    let s = 0;
    for (const k of BUILDING_ORDER) if (c.b[k] > 0) s++;
    return s;
  }
  // 이 도시에 이 건물을 (한 단계 더) 지을 수 있는가
  canBuild(n, c, kind) {
    const def = BUILDINGS[kind];
    if (!this.buildingUnlocked(n, kind)) return false;
    if (c.b[kind] >= MAX_BUILDING_LEVEL) return false;
    if (c.b[kind] === 0 && this.usedSlots(c) >= c.slots) return false;
    if (def.res && c.b[kind] >= c.resTiles[def.res]) return false;
    if (def.coastal && !this.isCoastal(c)) return false;
    return true;
  }

  // 한 건 지었으면 true (호출자가 금고가 허락하는 만큼 반복한다)
  ministerIndustry(n) {
    const pot = n.pots.industry;
    if (pot < 200) return false;
    const my = this.cities.filter((c) => c.owner === n.idx);
    if (!my.length) return false;
    // 실제 지출 비중이 정책 비중에 가장 못 미치는 범주부터
    const totalSpend = Object.values(n.spend).reduce((a, b) => a + b, 0) + 1;
    const cats = ['resource', 'factory', 'infra', 'defense']
      .map((cat) => ({ cat, gap: n.industry[cat] / 100 - n.spend[cat] / totalSpend }))
      .filter((x) => n.industry[x.cat] > 0)
      .sort((a, b) => b.gap - a.gap);
    for (const { cat } of cats) {
      // 범주 안에서 가장 필요한 건물: 공장은 재료 자급률, 자원은 부족 자재 우선
      const kinds = BUILDING_ORDER.filter((k) => BUILDINGS[k].cat === cat);
      let best = null;
      for (const kind of kinds) {
        for (const c of my) {
          if (!this.canBuild(n, c, kind)) continue;
          const cost = this.buildCost(c, kind);
          if (cost > pot || cost > n.cash) continue;
          let score = -cost / 100;
          if (kind === 'mine') score += 6 - n.mats.iron / 20;
          if (kind === 'oilwell') score += 6 - n.mats.oil / 15;
          if (kind === 'farm') score += 4 - n.mats.grain / 30 + (c.pop / 100);
          if (kind === 'factory') score += 5 + (n.mats.iron > 40 ? 2 : 0);
          if (kind === 'lab') score += 4 + n.budget.research / 20;
          if (kind === 'exchange') score += 2 + n.budget.finance / 15 - c.b.exchange * 2;
          if (kind === 'barracks') score += 3 - c.b.barracks * 2 + (c.id === n.capitalId ? 1 : 0);
          if (kind === 'bunker') score += 2 + this.threatOf(c, n.idx) * 4 + (c.id === n.capitalId ? 1 : 0);
          if (kind === 'aa') {
            // 항공 위협을 받는 도시에 방공포대를 최우선으로 — 지상군으로는 막을 수 없다
            const td = this.threatDetail(c, n.idx);
            score += 1 + td.by.air * 12 + (n.threat && n.threat.share.air > 0.3 ? 4 : 0) - c.b.aa * 2;
          }
          if (kind === 'port') score += 4 + c.size * 0.5 - c.b.port * 3 + (this.cities.some((x) => x.owner === n.idx && x.b.port > 0) ? -2 : 6);
          score += c.size * 0.3 - c.b[kind] * 0.8;
          if (!best || score > best.score) best = { kind, c, cost, score };
        }
      }
      if (!best) continue;
      this.spend(n, 'industry', best.cost);
      best.c.b[best.kind]++;
      n.spend[cat] += best.cost;
      if (best.kind === 'bunker') { best.c.maxHp = this.cityMaxHp(best.c); best.c.hp += BUILDINGS.bunker.hp; }
      this.world.build += 0.15;
      this.fx('build', best.c.x, best.c.y, { c: n.idx });
      if (!n.isBot) this.pushLog(`산업부: ${best.c.name}에 ${BUILDINGS[best.kind].name} Lv${best.c.b[best.kind]} 건설 (−${best.cost})`, n.idx);
      return true;
    }
    return false;
  }

  researchPath(n, targetId) {
    const path = [];
    const visit = (id) => {
      if (this.hasTech(n, id) || path.includes(id)) return;
      for (const r of TECHS[id].req) visit(r);
      path.push(id);
    };
    visit(targetId);
    return path;
  }
  availableTechs(n) {
    return D.TECH_ORDER.filter((id) => !this.hasTech(n, id) && TECHS[id].req.every((r) => this.hasTech(n, r)));
  }
  ministerResearch(n) {
    // 연구 예산 → 과학 포인트
    if (n.pots.research > 0 && n.cash > 0) {
      const amt = Math.min(n.pots.research, n.cash);
      this.spend(n, 'research', amt);
      n.science += amt * RULES.cashToScience;
    }
    if (!n.researching) {
      let next = null;
      if (n.researchTarget && !this.hasTech(n, n.researchTarget)) {
        const path = this.researchPath(n, n.researchTarget);
        next = path.find((id) => TECHS[id].req.every((r) => this.hasTech(n, r))) || null;
      }
      if (!next) {
        // 목표가 없으면 예산 성향에 맞춰 고른다: 군사 예산이 크면 군사 기술, 아니면 경제 기술
        const avail = this.availableTechs(n);
        if (!avail.length) return;
        const mil = new Set(['mech', 'artillery', 'aviation', 'composite', 'rocket', 'jet', 'atgm', 'radar', 'manpads', 'mbt3', 'precision', 'stealth', 'drones', 'fortification', 'logistics']);
        const wantMil = n.budget.military >= 30;
        avail.sort((a, b) => {
          const sa = TECHS[a].cost + (mil.has(a) === wantMil ? -200 : 0);
          const sb = TECHS[b].cost + (mil.has(b) === wantMil ? -200 : 0);
          return sa - sb;
        });
        next = avail[0];
      }
      if (n.researchTarget && this.hasTech(n, n.researchTarget)) n.researchTarget = null;
      const saved = (n._saved && n._saved[next]) || 0;
      n.researching = { id: next, progress: saved };
    }
    const r = n.researching;
    const cost = TECHS[r.id].cost;
    const take = Math.min(n.science, cost - r.progress);
    r.progress += take;
    n.science -= take;
    if (r.progress >= cost) {
      n.techs.push(r.id);
      this.refreshMult(n);
      for (const c of this.cities) if (c.owner === n.idx) c.maxHp = this.cityMaxHp(c);
      this.pushLog(`${n.title}이(가) 「${TECHS[r.id].name}」 기술을 완성했습니다.`, n.idx);
      n.researching = null;
      if (n.researchTarget === r.id) n.researchTarget = null;
    }
  }

  // 적 구성에 맞춰 병종을 고른다
  pickUnitType(n) {
    const hasPort = this.cities.some((c) => c.owner === n.idx && c.b.port > 0);
    const avail = UNIT_ORDER.filter((t) => this.unitUnlocked(n, t) && (t !== 'navy' || hasPort));
    const mine = { inf: 0, armor: 0, arty: 0, air: 0, navy: 0 };
    const enemy = { inf: 0, armor: 0, arty: 0, air: 0, navy: 0 };
    for (const u of this.units.values()) {
      if (u.owner === n.idx) mine[u.type]++;
      else if (this.nations[u.owner].alive) enemy[u.type]++;
    }
    const myTotal = Object.values(mine).reduce((a, b) => a + b, 0) + 1;
    const enTotal = Object.values(enemy).reduce((a, b) => a + b, 0) + 1;
    const want = { inf: 0.36, armor: 0.26, arty: 0.13, air: 0.15, navy: hasPort ? 0.12 : 0 };
    // 적이 기갑 위주면 항공·포병, 항공 위주면 보병(휴대방공)·항공, 보병 위주면 기갑·포병, 함대 위주면 함대·항공
    want.navy += enemy.navy / enTotal * (hasPort ? 0.3 : 0);
    want.air += enemy.navy / enTotal * 0.15;
    want.air += enemy.armor / enTotal * 0.25;
    want.arty += enemy.inf / enTotal * 0.15;
    want.armor += enemy.inf / enTotal * 0.2;
    want.inf += enemy.air / enTotal * (n.flags.manpads ? 0.3 : 0.05);
    want.air += enemy.air / enTotal * 0.15;
    // 지금 내 도시를 실제로 치고 있는 적 구성은 전체 구성보다 두 배 무겁게 본다
    const th = n.threat || this.nationThreat(n);
    if (th.total > 0.3) {
      const s = th.share;
      want.air += s.air * 0.5 + s.armor * 0.3 + s.navy * 0.3;
      want.inf += s.air * (n.flags.manpads ? 0.4 : 0) + s.arty * 0.3;
      want.armor += s.inf * 0.4 + s.arty * 0.2 - s.air * 0.3 - s.navy * 0.2;
      want.arty += s.inf * 0.2 - s.air * 0.3;
      want.navy += hasPort ? s.navy * 0.4 : 0;
      for (const t of UNIT_ORDER) want[t] = Math.max(0, want[t]);
    }
    let best = 'inf', bestGap = -Infinity;
    for (const t of avail) {
      const gap = want[t] - mine[t] / myTotal;
      if (gap > bestGap) { bestGap = gap; best = t; }
    }
    return best;
  }

  // 한 번 편성했으면 true
  ministerMilitary(n) {
    let count = 0;
    for (const u of this.units.values()) if (u.owner === n.idx) count++;
    if (count >= RULES.maxUnitsPerNation) return false;
    const type = this.pickUnitType(n);
    const cost = UNITS[type].cost;
    if (!this.canSpend(n, 'military', cost)) return false;
    // 병영이 있는 도시 중 위협이 큰 곳 → 없으면 수도. 함대는 항구가 있는 해안 도시에서만.
    const my = this.cities.filter((c) => c.owner === n.idx && (type === 'navy' ? c.b.port > 0 : (c.b.barracks > 0 || c.id === n.capitalId)));
    if (!my.length) return false;
    my.sort((a, b) => this.threatOf(b, n.idx) - this.threatOf(a, n.idx));
    const city = my[0];
    // 포위된 도시에서는 한 기씩 내보내 각개격파당하지 않도록, 3기 분을 모아 한꺼번에 편성한다
    const threatened = this.threatOf(city, n.idx) > 0.5;
    const batch = threatened ? 3 : 1;
    if (threatened && !this.canSpend(n, 'military', cost * batch)) return false;
    const mission = this.pickMission(n);
    for (let i = 0; i < batch && count + i < RULES.maxUnitsPerNation; i++) {
      this.spend(n, 'military', cost);
      const u = this.spawnUnit(n, type, city);
      u.mission = threatened ? 'defend' : mission;
      u.nextThink = 0;
    }
    this.fx('spawn', city.x, city.y, { c: n.idx });
    if (!n.isBot) this.pushLog(`국방부: ${city.name}에서 ${UNITS[type].name}${batch > 1 ? ' ×' + batch : ''} 편성 → ${({ defend: '수비', expand: '확장', attack: '공격' })[threatened ? 'defend' : mission]} 임무`, n.idx);
    return true;
  }

  ministerFinance(n) {
    const exch = this.cities.filter((c) => c.owner === n.idx).reduce((s, c) => s + c.b.exchange, 0);
    const feeMult = Math.max(0.4, 1 - exch * 0.12);
    // 적자이거나 현금화 지시면 매도
    if (n.liquidate || n.cash < 0) {
      for (const k of STOCK_ORDER) {
        const q = n.liquidate ? n.stocks[k] : Math.min(n.stocks[k], Math.ceil((-n.cash + 100) / this.stocks[k].price));
        if (q <= 0) continue;
        const rev = q * this.stocks[k].price * (1 - D.STOCK_SPREAD * feeMult);
        n.stocks[k] -= q;
        n.stockCost[k] = n.stocks[k] > 0 ? n.stockCost[k] * (n.stocks[k] / (n.stocks[k] + q)) : 0;
        n.cash += rev;
        this.stocks[k].price *= Math.max(0.9, 1 - 0.00008 * q);
        if (!n.isBot) this.pushLog(`재무부: ${STOCKS[k].name} ${q}주 매도 (+${Math.round(rev)})`, n.idx);
        if (!n.liquidate && n.cash >= 0) break;
      }
      if (n.liquidate && STOCK_ORDER.every((k) => n.stocks[k] === 0)) n.liquidate = false;
      return;
    }
    if (n.pots.finance < 60 || n.cash < 60) return;
    // 목표 비중에 가장 못 미치는 종목을 산다
    let total = 0;
    const val = {};
    for (const k of STOCK_ORDER) { val[k] = n.stocks[k] * this.stocks[k].price; total += val[k]; }
    const budget = Math.min(n.pots.finance, n.cash - 20);
    let best = null, bestGap = -Infinity;
    for (const k of STOCK_ORDER) {
      if (n.portfolio[k] <= 0) continue;
      const gap = n.portfolio[k] / 100 - (total > 0 ? val[k] / (total + budget) : 0);
      if (gap > bestGap) { bestGap = gap; best = k; }
    }
    if (!best) return;
    const price = this.stocks[best].price * (1 + D.STOCK_SPREAD * feeMult);
    const q = Math.floor(budget / price);
    if (q <= 0) return;
    const cost = q * price;
    this.spend(n, 'finance', cost);
    n.stockCost[best] += cost;
    n.stocks[best] += q;
    this.stocks[best].price *= 1 + 0.00008 * q;
    if (!n.isBot && q >= 3) this.pushLog(`재무부: ${STOCKS[best].name} ${q}주 매수 (−${Math.round(cost)})`, n.idx);
  }

  /* ================================================================ 점수/통계 */

  netWorth(n) {
    let w = n.cash;
    for (const k of STOCK_ORDER) w += n.stocks[k] * this.stocks[k].price;
    for (const k of ['iron', 'oil', 'grain']) w += n.mats[k] * this.market[k].price;
    for (const c of this.cities) {
      if (c.owner !== n.idx) continue;
      w += RULES.cityValue * c.size;
      for (const k of BUILDING_ORDER) for (let l = 0; l < c.b[k]; l++) w += BUILDINGS[k].cost * Math.pow(1.35, l) * 0.7;
    }
    for (const u of this.units.values()) if (u.owner === n.idx) w += UNITS[u.type].cost * RULES.unitValueRatio * (u.strength / 100);
    w += n.stats.tiles * RULES.territoryValue;
    // 위신: 완성한 프로젝트와 업적
    for (const p of Object.values(this.projects)) if (p.done && p.owner === n.idx) w += PROJECTS[p.id].cost * RULES.projectPrestige + (PROJECTS[p.id].effects.prestige || 0);
    w += n.ach.length * RULES.achPrestige;
    return w;
  }
  updateStats(n) {
    n.stats.cities = this.cities.filter((c) => c.owner === n.idx).length;
    n.stats.score = Math.round(this.netWorth(n));
  }

  /* ================================================================ 메인 루프 */

  tick(dt) {
    if (this.ended) return;
    this.time += dt;
    this.tickEconomy(dt);
    this.tickMarket(dt);
    this.tickStocks(dt);
    this.tickEvents(dt);
    Dip.tick(this, dt);
    Decisions.tick(this, dt);
    Council.tick(this, dt);
    for (const n of this.nations) if (n.buffs.length) n.buffs = n.buffs.filter((b) => b.until > this.time);
    // 피로도 회복 — 평화 기념관의 회복 보너스는 30초 이상 교전이 없을 때만 (전쟁을 편하게 해 주는 장치가 아니다)
    for (const n of this.nations) if (n.weariness > 0) n.weariness = Math.max(0, n.weariness - RULES.wearinessDecay * (1 + (this.time - (n._fightAt || -999) > 30 ? this.projectBonus(n, 'wearinessDecay') : 0)) * dt);
    this._histClock += dt;
    if (this._histClock >= RULES.histEvery) {
      this._histClock = 0;
      this.hist.t.push(Math.round(this.time));
      this.hist.s.push(this.nations.map((n) => n.alive ? Math.round(n.stats.score) : 0));
    }

    this._cabinetClock += dt;
    if (this._cabinetClock >= RULES.cabinetInterval) {
      this._cabinetClock = 0;
      this.tickCabinet();
    }

    // 부대 임무 재검토 + 행군
    for (const u of this.units.values()) {
      const n = this.nations[u.owner];
      u.nextThink -= dt;
      if (u.nextThink <= 0) {
        u.nextThink = RULES.missionInterval + Math.random() * 0.5;
        this.thinkUnit(u, n);
      }
      this.moveUnit(u, n, dt);
    }
    const grid = this.buildUnitGrid();
    this.tickCombat(dt, grid);
    this.tickCities(dt, grid);
    // 병영 도시에 주둔한 아군은 서서히 보충된다 (함대는 항구 앞바다에서)
    for (const u of this.units.values()) {
      if (u.fight || u.path || u.strength >= 100) continue;
      if (u.naval) {
        const port = this.cities.find((c) => c.owner === u.owner && c.b.port > 0 && cheb(c.x, c.y, u.tx, u.ty) <= 3);
        if (port) u.strength = Math.min(100, u.strength + RULES.reinforce * (1 + port.b.port * 0.3) * dt);
        continue;
      }
      const c = this.cityAt(u.tx, u.ty);
      if (c && c.owner === u.owner && (c.b.barracks > 0 || c.id === this.nations[u.owner].capitalId)) {
        u.strength = Math.min(100, u.strength + RULES.reinforce * (1 + c.b.barracks * 0.3) * dt);
      }
    }

    this._healClock += dt;
    if (this._healClock >= 8) { this._healClock = 0; this.healTerritory(); }

    // 오래된 이펙트 정리
    for (const id of Object.keys(this._fx)) if (this.time - this._fx[id].t > 3) delete this._fx[id];

    this.checkEnd();
  }

  checkEnd() {
    const alive = this.nations.filter((n) => n.alive);
    if (alive.length <= 1) return this.finish('conquest');
    if (this.victory === 'conquest') {
      if (this.time >= this.duration * 3) this.finish('time'); // 정복전은 제한 시간의 3배까지
      return;
    }
    if (this.victory === 'economic' && this.time > 120) {
      const top = alive.find((n) => n.stats.score >= RULES.economicVictory);
      if (top) return this.finish('economic', top);
    }
    if (this.time >= this.duration) this.finish('time');
  }
  finish(reason = 'time', winnerNation = null) {
    this.ended = true;
    this.endReason = reason;
    for (const n of this.nations) this.updateStats(n);
    const ranked = this.nations.slice().sort((a, b) => (b.alive - a.alive) || (b.stats.score - a.stats.score));
    if (winnerNation) { const i = ranked.indexOf(winnerNation); if (i > 0) { ranked.splice(i, 1); ranked.unshift(winnerNation); } }
    this.ranking = ranked.map((n) => ({ id: n.id, name: n.name, title: n.title, idx: n.idx, score: n.stats.score, alive: n.alive, cities: n.stats.cities, tiles: n.stats.tiles, kills: n.stats.kills, losses: n.stats.losses, captures: n.stats.captures, techs: n.techs.length }));
    this.winner = ranked[0].id;
    this.hist.t.push(Math.round(this.time));
    this.hist.s.push(this.nations.map((n) => n.alive ? Math.round(n.stats.score) : 0));
    const why = { time: '제한 시간 종료', conquest: '최후의 생존', economic: `경제 승리 (국력 ${RULES.economicVictory} 달성)` }[reason] || reason;
    this.pushLog(`게임 종료 (${why}) — ${ranked[0].title}(${ranked[0].name})의 패권!`, ranked[0].idx);
  }

  /* ================================================================ 공개 상태 */

  // 위성 시대 — 숨은 정보가 없으므로 모두에게 같은 스냅샷을 보낸다.
  // 화면에 쓰는 값만, 화면 해상도로 반올림해 담는다 (diff 가 작아진다).
  // opts.econ: 국가 재정·주식·시장처럼 "매초 조금씩 바뀌는 값" 을 새로 담을지. 아니면 직전 스냅샷을 그대로 재사용해
  // diff 가 비게 한다 (room 이 3초에 한 번, 그리고 플레이어 행동 직후에 켠다). 클라이언트는 그 사이를 순수입으로 이어 계산한다.
  publicState(opts = {}) {
    const econ = opts.econ !== false || !this._econCache;
    if (econ) {
      this._econCache = {
        econT: Math.round(this.time),
        nations: this.nations.map((n) => ({
          id: n.id, name: n.name, title: n.title, color: n.color, idx: n.idx, alive: n.alive, isBot: n.isBot,
          cash: Math.round(n.cash), sci: Math.round(n.science), capital: n.capitalId,
          techs: n.techs, researching: n.researching ? { id: n.researching.id, p: Math.round((n.researching.progress / TECHS[n.researching.id].cost) * 100) } : null,
          target: n.researchTarget,
          budget: n.budget, doctrine: n.doctrine, attackTarget: n.attackTarget, industry: n.industry, portfolio: n.portfolio, liquidate: n.liquidate, autoReserve: n.autoReserve, autoCabinet: n.autoCabinet,
          weariness: Math.round(n.weariness), nukeReady: Math.round(n.nukeReady), spyReady: Math.round(n.spyReady),
          ach: n.ach, project: n.projectTarget,
          buffs: n.buffs.map((b) => ({ k: b.k, v: Math.round(b.v * 100), n: b.name, u: Math.round(b.until) })),
          decision: n.decision ? { id: n.decision.id, name: n.decision.name, text: n.decision.text, u: Math.round(this.time + n.decision.left), options: n.decision.options } : null,
          pots: { industry: Math.round(n.pots.industry), research: Math.round(n.pots.research), military: Math.round(n.pots.military), finance: Math.round(n.pots.finance) },
          stocks: n.stocks, stockCost: Object.fromEntries(STOCK_ORDER.map((k) => [k, Math.round(n.stockCost[k])])),
          mats: { iron: Math.round(n.mats.iron), oil: Math.round(n.mats.oil), grain: Math.round(n.mats.grain) },
          tier: n.tier,
          threat: n.threat ? { total: r1(n.threat.total), share: Object.fromEntries(UNIT_ORDER.map((t) => [t, Math.round(n.threat.share[t] * 100)])) } : null,
          stats: { income: r1(n.stats.income), sales: r1(n.stats.sales), expense: r1(n.stats.expense), dividend: r1(n.stats.dividend), net: r1(n.stats.net), science: r1(n.stats.science), tiles: n.stats.tiles, cities: n.stats.cities, units: n.stats.units, score: n.stats.score, kills: n.stats.kills, losses: n.stats.losses, trade: Math.round((n.stats.trade || 0) * 100), weary: Math.round((1 - (n.stats.weary === undefined ? 1 : n.stats.weary)) * 100) },
        })),
        market: Object.fromEntries(Object.keys(this.market).map((k) => [k, r2(this.market[k].price)])),
        // 주가 이력은 배열 대신 {표본번호: 값} — 밀릴 때 전체가 재전송되지 않고 새 표본 하나만 나간다
        stocks: Object.fromEntries(STOCK_ORDER.map((k) => [k, { p: r2(this.stocks[k].price), h: this.stocks[k].hist }])),
      };
    }
    const ec = this._econCache;
    const units = {};
    for (const u of this.units.values()) {
      units[u.id] = {
        o: u.owner, t: u.type, x: r1(u.x), y: r1(u.y), s: Math.round(u.strength), m: u.mission,
        f: u.fight ? 1 : 0, g: u.goal ? [u.goal.x, u.goal.y] : 0,
      };
    }
    return {
      t: Math.round(this.time),
      dur: this.duration,
      victory: this.victory,
      ended: this.ended,
      winner: this.winner,
      endReason: this.endReason || null,
      ranking: this.ranking,
      hist: this.ended ? this.hist : null, // 결과 그래프 — 종료 때만 보낸다
      event: this.event ? { name: this.event.name, u: Math.round(this.time + this.event.left) } : null, // 남은 초는 클라이언트가 u - t 로 계산
      map: this._mapState || (this._mapState = { w: this.W, h: this.H, seed: this.map.seed || 0, tiles: this.map.tiles, res: this.map.resources.map((r) => r || 0) }),
      terr: this.territory,
      dip: Dip.publicState(this),
      council: Council.publicState(this),
      news: this.news,
      projects: Object.fromEntries(Object.values(this.projects).map((p) => [p.id, { o: p.owner, d: p.done ? 1 : 0, c: p.city, prog: Object.fromEntries(Object.entries(p.prog).map(([k, v]) => [k, Math.round(v / 10) * 10])) }])), // 10 단위 — 2초마다 바뀌는 값을 덜 보낸다
      econT: ec.econT,
      nations: ec.nations,
      cities: this.cities.map((c) => ({
        id: c.id, name: c.name, x: c.x, y: c.y, size: c.size, o: c.owner, pop: Math.round(c.pop),
        hp: Math.round(c.hp), maxHp: c.maxHp, b: c.b, slots: c.slots, res: c.resTiles, unrest: Math.round(c.unrest), cs: this.isCoastal(c) ? 1 : 0,
        cap: c.cap ? { by: c.cap.by, p: Math.round((c.cap.t / RULES.captureSeconds) * 100) } : 0,
      })),
      units,
      market: ec.market,
      stocks: ec.stocks,
      fx: this._fx,
    };
  }

  static constants() {
    return {
      TERRAIN, UNITS, UNIT_ORDER, COUNTER, BUILDINGS, BUILDING_ORDER, MAX_BUILDING_LEVEL, MATERIALS, STOCKS, STOCK_ORDER, TECHS, TECH_ORDER: D.TECH_ORDER, RULES,
      RESOURCES: D.RESOURCES, PROJECTS, PROJECT_ORDER, SPY_OPS, ACHIEVEMENTS: Ach.publicList(),
      RESOLUTIONS: Object.fromEntries(Object.values(Council.RESOLUTIONS).map((r) => [r.id, { name: r.name, desc: r.desc }])),
    };
  }
}

module.exports = { Game, DEFAULT_BUDGET, DEFAULT_DOCTRINE, DEFAULT_INDUSTRY, DEFAULT_PORTFOLIO };
