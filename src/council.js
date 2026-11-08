'use strict';

/**
 * 세계 의회 — 몇 분마다 결의안이 올라오고 모든 국가가 투표한다.
 *  국가당 1표 (세계 박람회 보유국 +1). 찬성이 반대보다 많으면 가결. 사람은 기권이 기본, 봇은 득실을 따져 찍는다.
 *  가결된 결의는 한시적 세계 효과(game.world.buffs) 나 즉시 효과로 나타난다. 전쟁보다 공조가 이득이 되게 짜여 있다.
 */

const { RULES, PROJECTS } = require('./data');
const Dip = require('./diplomacy');

const RESOLUTIONS = {
  arms:     { id: 'arms',     name: '군비 제한 조약',   desc: '240초간 모든 국가의 부대 유지비 +35%',                 dur: 240, world: { upkeep: 0.35 } },
  trade:    { id: 'trade',    name: '자유 무역 협정',   desc: '240초간 불가침·동맹 교역 보너스 2배',                  dur: 240, world: { tradeMult: 1 } },
  sanction: { id: 'sanction', name: '패권국 제재',      desc: '현재 국력 1위 국가의 세수 −25% (180초)',               dur: 180, top: true, nation: { income: -0.25 } },
  truce:    { id: 'truce',    name: '세계 휴전 결의',   desc: '150초간 도시 점령 불가 · 모든 국가 피로도 −20',       dur: 150, world: { truce: 1 }, instant: 'truce' },
  science:  { id: 'science',  name: '과학 협력 계획',   desc: '240초간 모든 국가 연구 +30%',                          dur: 240, world: { science: 0.30 } },
  aid:      { id: 'aid',      name: '인도적 지원',      desc: '국력 상위 절반이 300씩 내어 최하위 국가를 지원',       instant: 'aid' },
  nonuke:   { id: 'nonuke',   name: '핵 금지 조약',     desc: '300초간 핵 타격 금지',                                 dur: 300, world: { nonuke: 1 }, when: (g) => g.nations.some((n) => n.alive && n.flags && n.flags.nuke) },
  boom:     { id: 'boom',     name: '세계 인프라 기금', desc: '모든 국가 산업 금고 +400 · 자재 가격 +15% (120초)',   dur: 120, instant: 'boom' },
};
const ORDER = Object.keys(RESOLUTIONS);

function install(game) {
  game.council = null;          // 진행 중 투표 { id, left, votes: {idx: 1|-1|0} }
  game._councilClock = RULES.councilEvery;
  game._lastResolution = null;
  game.world.buffs = [];        // 가결된 세계 효과 [{k, v, until, name}]
}

function voteWeight(game, n) {
  let w = 1;
  for (const p of Object.values(game.projects)) if (p.done && p.owner === n.idx && PROJECTS[p.id].effects.vote) w += PROJECTS[p.id].effects.vote;
  return w;
}

function topNation(game) {
  return game.nations.filter((n) => n.alive).sort((a, b) => b.stats.score - a.stats.score)[0] || null;
}

// 봇의 찬반: 내게 이득이면 찬성, 손해면 반대. 성향이 조금 기울인다.
function botVote(game, n, r) {
  const alive = game.nations.filter((x) => x.alive);
  const avgUnits = alive.reduce((s, x) => s + (x.stats.units || 0), 0) / Math.max(1, alive.length);
  const P = n.personality || '';
  const top = topNation(game);
  let s = 0;
  switch (r.id) {
    case 'arms': s = (avgUnits - (n.stats.units || 0)) * 0.3 + (P === '군국형' ? -1.5 : 0.5); break;
    case 'trade': { let tr = 0; for (const o of alive) if (o.idx !== n.idx && Dip.stateOf(game, n.idx, o.idx) !== 'war') tr++; s = tr ? 1 + tr : -0.5; break; }
    case 'sanction': s = top && top.idx === n.idx ? -3 : (top && Dip.isAllied(game, n.idx, top.idx) ? -1 : 1.2); break;
    case 'truce': s = n.weariness > 20 || (n.threat && n.threat.total > 0.5) ? 2 : (P === '군국형' ? -1.5 : 0.6); break;
    case 'science': s = (n.budget.research - 15) * 0.1 + (P === '기술형' ? 1.5 : 0.3); break;
    case 'aid': { const ranked = alive.slice().sort((a, b) => b.stats.score - a.stats.score); const i = ranked.indexOf(n); s = i >= ranked.length / 2 ? 1.5 : -0.8 + (P === '금융형' ? -0.5 : 0); break; }
    case 'nonuke': s = n.flags && n.flags.nuke ? -2 : 2; break;
    case 'boom': s = P === '산업형' ? 2 : 1; break;
  }
  s += (Math.random() - 0.5) * 0.8;
  return s > 0.2 ? 1 : s < -0.2 ? -1 : 0;
}

function openVote(game) {
  const cands = ORDER.filter((id) => id !== game._lastResolution && (!RESOLUTIONS[id].when || RESOLUTIONS[id].when(game)));
  const r = RESOLUTIONS[cands[Math.floor(Math.random() * cands.length)]];
  game._lastResolution = r.id;
  const votes = {};
  for (const n of game.nations) {
    if (!n.alive) continue;
    votes[n.idx] = n.isBot ? botVote(game, n, r) : 0;
  }
  game.council = { id: r.id, left: RULES.councilVoteSeconds, votes };
  game.pushLog(`세계 의회: 「${r.name}」 결의안 상정 — ${RULES.councilVoteSeconds}초 투표`);
  game.pushNews(`🏛 세계 의회 결의안 상정: ${r.name}`);
}

function tally(game) {
  const c = game.council;
  let yes = 0, no = 0;
  for (const n of game.nations) {
    if (!n.alive) continue;
    const v = c.votes[n.idx] || 0;
    if (v > 0) yes += voteWeight(game, n); else if (v < 0) no += voteWeight(game, n);
  }
  return { yes, no };
}

function close(game) {
  const c = game.council;
  const r = RESOLUTIONS[c.id];
  const { yes, no } = tally(game);
  game.council = null;
  const passed = yes > no;
  game.lastCouncil = { id: r.id, passed, yes, no, t: Math.round(game.time) };
  if (!passed) { game.pushLog(`세계 의회: 「${r.name}」 부결 (찬성 ${yes} · 반대 ${no})`); game.pushNews(`🏛 「${r.name}」 부결 (${yes}:${no})`); return; }
  game.pushLog(`세계 의회: 「${r.name}」 가결 (찬성 ${yes} · 반대 ${no})`);
  game.pushNews(`🏛 「${r.name}」 가결 — ${r.desc}`);
  if (r.world) for (const [k, v] of Object.entries(r.world)) game.world.buffs.push({ k, v, until: game.time + r.dur, name: r.name });
  if (r.top) { const t = topNation(game); if (t) for (const [k, v] of Object.entries(r.nation)) t.buffs.push({ k, v, until: game.time + r.dur, name: r.name }); }
  if (r.instant === 'truce') for (const n of game.nations) n.weariness = Math.max(0, n.weariness - 20);
  if (r.instant === 'aid') {
    const ranked = game.nations.filter((n) => n.alive).sort((a, b) => b.stats.score - a.stats.score);
    const bottom = ranked[ranked.length - 1];
    let pool = 0;
    for (let i = 0; i < Math.floor(ranked.length / 2); i++) { ranked[i].cash -= 300; pool += 300; }
    if (bottom) bottom.cash += pool;
  }
  if (r.instant === 'boom') {
    for (const n of game.nations) if (n.alive) { n.cash += 400; n.pots.industry += 400; }
    for (const k of Object.keys(game.market)) game.market[k].price *= 1.15;
  }
}

function tick(game, dt) {
  // 세계 효과 만료
  if (game.world.buffs.length) game.world.buffs = game.world.buffs.filter((b) => b.until > game.time);
  if (game.council) {
    game.council.left -= dt;
    if (game.council.left <= 0) close(game);
    return;
  }
  game._councilClock -= dt;
  if (game._councilClock <= 0 && game.nations.filter((n) => n.alive).length >= 2) {
    game._councilClock = RULES.councilEvery;
    openVote(game);
  }
}

function vote(game, pid, v) {
  const n = game.nation(pid);
  if (!n || !n.alive) return { ok: false, error: '국가가 없습니다.' };
  if (!game.council) return { ok: false, error: '진행 중인 투표가 없습니다.' };
  game.council.votes[n.idx] = v > 0 ? 1 : v < 0 ? -1 : 0;
  return { ok: true };
}

function worldBuff(game, k) {
  let s = 0;
  for (const b of game.world.buffs) if (b.k === k) s += b.v;
  return s;
}

function publicState(game) {
  const c = game.council;
  return {
    vote: c ? { id: c.id, name: RESOLUTIONS[c.id].name, desc: RESOLUTIONS[c.id].desc, left: Math.round(c.left), votes: c.votes } : null,
    active: game.world.buffs.map((b) => ({ name: b.name, left: Math.round(b.until - game.time) })),
    last: game.lastCouncil || null,
  };
}

module.exports = { RESOLUTIONS, install, tick, vote, worldBuff, publicState, voteWeight, botVote };
