'use strict';

/**
 * 컴퓨터 국가의 "내각". 사람과 똑같이 비율만 정한다 — 실제 집행은 game.js 의 장관들이 한다.
 * 몇 초마다 상황(위협·국력·시간대)을 보고 예산·교리·산업·투자·연구 목표를 조정한다.
 */

const { TECHS, STOCK_ORDER, PROJECTS } = require('./data');
const Dip = require('./diplomacy');

const PERSONALITIES = [
  { name: '산업형', industry: 8, military: -3, research: 0, aggression: -6 },
  { name: '군국형', industry: -6, military: 7, research: -3, aggression: 10 },
  { name: '기술형', industry: -3, military: -2, research: 8, aggression: -3 },
  { name: '금융형', industry: -4, military: -2, research: -2, finance: 8, aggression: 0 },
];

// 성향은 판마다 섞어서 배정한다 (지도 시드 기준) — 특정 자리가 늘 같은 성향이 되지 않게
function pickPersonality(game, idx) {
  const seed = (game.map.seed || 0) >>> 0;
  const order = PERSONALITIES.map((_, i) => i).sort((a, b) => ((seed * 9301 + a * 49297) % 233280) - ((seed * 9301 + b * 49297) % 233280));
  return PERSONALITIES[order[idx % order.length]];
}

// opts.diplomacy=false 면 외교 행동(제안·선전포고)은 하지 않는다 — 사람 국가의 "자동 내각" 모드
function think(game, nationId, opts = {}) {
  const n = game.nation(nationId);
  if (!n || !n.alive) return false;
  const P = pickPersonality(game, n.idx);
  n.personality = P.name;
  const diplomacy = opts.diplomacy !== false;
  const t = game.time;

  // 위협 평가
  let threat = 0;
  for (const c of game.cities) if (c.owner === n.idx) threat = Math.max(threat, game.threatOf(c, n.idx));
  // 국력 비교
  const myScore = n.stats.score || 1;
  const others = game.nations.filter((x) => x.alive && x.idx !== n.idx);
  const avg = others.length ? others.reduce((s, x) => s + (x.stats.score || 1), 0) / others.length : myScore;
  const ratio = myScore / Math.max(1, avg);
  const hasNeutral = game.cities.some((c) => c.owner === -1);
  const unitCount = n.stats.units || 0;

  // ---- 예산
  let industry = 36, research = 20, military = 28, finance = 10, reserve = 6;
  if (t < 150) { industry += 8; military -= 4; finance -= 4; }
  if (threat > 1.5) { military += 28; industry -= 12; finance -= 8; research -= 8; }
  else if (threat > 0.3) { military += 15; industry -= 7; finance -= 5; research -= 3; }
  if (ratio > 1.3 && t > 300) { military += 6; industry -= 3; }
  if (ratio < 0.8) { military += 8; finance -= 5; research -= 3; }
  if (unitCount < 3) { military += 15; industry -= 8; finance -= 7; }
  if (n.cash > 6000) { finance += 10; reserve -= 5; industry -= 5; }
  if (n.cash < 300) { reserve += 8; finance -= 6; }
  industry += P.industry; military += P.military; research += P.research; finance += P.finance || 0;
  military = Math.max(military, 20);
  n.budget = clampPct({ industry, research, military, finance, reserve });

  // ---- 교리
  let defend = 40, expand = 40, attack = 20;
  if (!hasNeutral) { expand = 0; attack += 25; defend += 15; }
  if (threat > 1.0) { defend += 25; attack -= 10; expand -= 15; }
  if (ratio > 1.25 && unitCount >= 6 && t > 240) { attack += 25 + P.aggression; defend -= 10; }
  if (ratio < 0.7) { defend += 15; attack -= 15; }
  attack += P.aggression * 0.5;
  n.doctrine = clampPct({ defend, expand, attack });
  // 전쟁에 지쳤으면 공격 대신 수비·내정으로 (전쟁은 돈이 안 된다)
  if (n.weariness > 60) { n.doctrine = clampPct({ defend: n.doctrine.defend + 30, expand: n.doctrine.expand, attack: Math.max(0, n.doctrine.attack - 25) }); }
  // 외교: 화친·동맹·배신 판단
  if (diplomacy) Dip.botThink(game, n.idx);
  // 공격 대상: 적대국 중 가장 약한 이웃
  const hostiles = others.filter((o) => Dip.isHostile(game, n.idx, o.idx));
  if (hostiles.length) {
    let best = 'any', bestS = Infinity;
    for (const o of hostiles) {
      const cap = game.cityById.get(o.capitalId);
      const mine = game.cityById.get(n.capitalId);
      if (!cap || !mine) continue;
      const d = Math.hypot(cap.x - mine.x, cap.y - mine.y);
      const s = (o.stats.score || 1) / myScore * 40 + d * 0.5;
      if (s < bestS) { bestS = s; best = o.idx; }
    }
    n.attackTarget = ratio > 0.9 ? best : 'any';
  } else {
    n.attackTarget = 'any';
    // 적이 아무도 없고 충분히 강하면 가장 약하고 신뢰 낮은 상대에게 적대 선언 (군국형이 더 쉽게)
    const weakest = others.slice().sort((a, b) => (a.stats.score || 1) - (b.stats.score || 1))[0];
    if (diplomacy && weakest && t > 240 && n.weariness < 30 && ratio > (P.name === '군국형' ? 1.1 : 1.5)) {
      const r = Dip.relOf(game, n.idx, weakest.idx);
      if (r && r.trust < 50 && Math.random() < 0.2) Dip.declareWar(game, n.idx, weakest.idx);
    }
  }

  // ---- 산업 정책
  let resource = 35, factory = 35, infra = 15, defense = 15;
  if (n.mats.iron < 10 || n.mats.oil < 5) resource += 20;
  if (n.mats.iron > 60 && n.mats.oil > 40) { factory += 15; resource -= 15; }
  if (threat > 0.8) { defense += 20; factory -= 10; }
  if (t > 400) infra += 10;
  // 해군 공학을 알고 해안 도시가 있는데 항구가 없으면 항구부터
  if (game.hasTech(n, 'naval') && game.cities.some((c) => c.owner === n.idx && game.isCoastal(c)) && !game.cities.some((c) => c.owner === n.idx && c.b.port > 0)) { defense += 20; factory -= 10; resource -= 5; }
  n.industry = clampPct({ resource, factory, infra, defense });

  // ---- 투자: 세상 흐름을 보고 비중을 기울인다
  const w = { defense: 20, energy: 20, tech: 20, constr: 20, food: 20 };
  if (game.world.war > 2) w.defense += 25;
  if (game.market.oil.price > 3.2) w.energy += 20;
  if (game.world.research > 30) w.tech += 15;
  if (game.world.build > 0.6) w.constr += 15;
  if (n.cash < 500 && STOCK_ORDER.some((k) => n.stocks[k] > 0)) n.liquidate = true;
  n.portfolio = normalize(w, STOCK_ORDER);

  // ---- 연구 목표
  if (!n.researchTarget || game.hasTech(n, n.researchTarget)) {
    const coastal = game.cities.some((c) => c.owner === n.idx && game.isCoastal(c));
    const wishlist = P.name === '군국형'
      ? ['mech', 'artillery', 'naval', 'composite', 'aviation', 'rocket', 'logistics', 'jet', 'missileship', 'atgm', 'mbt3', 'stealth', 'carrier']
      : P.name === '기술형'
        ? ['radio', 'electronics', 'computers', 'mech', 'automation', 'ai', 'aviation', 'radar', 'naval', 'drones', 'missileship']
        : P.name === '금융형'
          ? ['finance', 'massprod', 'computers', 'naval', 'mech', 'mining', 'petrochem', 'satellites', 'fusion']
          : ['massprod', 'mining', 'mech', 'artillery', 'naval', 'automation', 'petrochem', 'fortification', 'computers', 'mbt3'];
    const next = wishlist.find((id) => TECHS[id] && !game.hasTech(n, id) && (coastal || !['naval', 'missileship', 'carrier'].includes(id)));
    if (next) n.researchTarget = next;
  }

  // ---- 국가 프로젝트: 성향에 맞는 것 중 지을 수 있는 첫 번째를 목표로 (위협이 크면 미룬다)
  if (!n.projectTarget && t > 240 && threat < 0.8) {
    const wish = P.name === '금융형' ? ['hub', 'expo', 'peace', 'station', 'reactor', 'canal']
      : P.name === '기술형' ? ['station', 'expo', 'reactor', 'hub', 'peace', 'canal']
        : P.name === '군국형' ? ['canal', 'reactor', 'expo', 'hub', 'peace', 'station']
          : ['expo', 'reactor', 'peace', 'canal', 'hub', 'station'];
    const pick = wish.find((id) => game.canProject(n, id).ok && !Object.values(game.projects[id].prog).some((v) => v > PROJECTS[id].cost * 0.6));
    if (pick) n.projectTarget = pick;
  }

  // ---- 첩보: 군국형·기술형이 가끔, 적대국 상대로, 비축이 넉넉할 때만
  if (diplomacy && t > 300 && t >= n.spyReady && n.weariness < 40 && (P.name === '군국형' || P.name === '기술형') && Math.random() < 0.05) {
    const free = n.cash - (n.pots.industry + n.pots.research + n.pots.military + n.pots.finance);
    if (free > 1800 && hostiles.length) {
      const target = hostiles.slice().sort((a, b) => (b.stats.score || 0) - (a.stats.score || 0))[0];
      const op = P.name === '기술형' ? 'steal' : (Math.random() < 0.5 ? 'sabotage' : 'incite');
      game.spy(n.id, target.idx, op);
    }
  }
  return false; // 비율 변경은 화면에 급히 보일 필요가 없어 즉시 브로드캐스트하지 않는다
}

function clampPct(o) {
  const out = {};
  for (const k of Object.keys(o)) out[k] = Math.max(0, o[k]);
  return normalize(out, Object.keys(out));
}
function normalize(o, keys) {
  let sum = 0;
  for (const k of keys) sum += Math.max(0, o[k] || 0);
  const out = {};
  for (const k of keys) out[k] = sum > 0 ? Math.round((Math.max(0, o[k] || 0) / sum) * 1000) / 10 : 100 / keys.length;
  return out;
}

module.exports = { think, PERSONALITIES };
