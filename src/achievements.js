'use strict';

/**
 * 업적 — 판 중에 달성하면 기록에 남고 국력(위신)이 조금 오른다. "세계 최초" 업적은 한 나라만 받는다.
 *  전투 업적보다 내정·외교·과학 업적이 많다 (전쟁이 유일한 재미가 되지 않게).
 */

const { STOCK_ORDER, BUILDING_ORDER } = require('./data');
const Dip = require('./diplomacy');

function treaties(game, n) {
  let c = 0;
  for (const o of game.nations) if (o.alive && o.idx !== n.idx && Dip.stateOf(game, n.idx, o.idx) !== 'war') c++;
  return c;
}
function allies(game, n) {
  let c = 0;
  for (const o of game.nations) if (o.alive && o.idx !== n.idx && Dip.isAllied(game, n.idx, o.idx)) c++;
  return c;
}
function buildingLevels(game, n) {
  let s = 0;
  for (const c of game.cities) if (c.owner === n.idx) for (const k of BUILDING_ORDER) s += c.b[k];
  return s;
}
function stockValue(game, n) {
  let v = 0;
  for (const k of STOCK_ORDER) v += n.stocks[k] * game.stocks[k].price;
  return v;
}

const LIST = [
  { id: 'firsttech',  icon: '🔬', name: '선구자',       desc: '세계 최초로 기술 완성',                 first: true, check: (g, n) => n.techs.length >= 1 },
  { id: 'firstwonder', icon: '🏛', name: '불가사의 건설자', desc: '세계 최초로 국가 프로젝트 완성',     first: true, check: (g, n) => Object.values(g.projects).some((p) => p.done && p.owner === n.idx) },
  { id: 'tech10',     icon: '🧪', name: '과학 강국',     desc: '기술 10개 완성',                          check: (g, n) => n.techs.length >= 10 },
  { id: 'tech20',     icon: '🚀', name: '첨단 문명',     desc: '기술 20개 완성',                          check: (g, n) => n.techs.length >= 20 },
  { id: 'builder',    icon: '🏗', name: '산업 거물',     desc: '건물 총 20단계',                           check: (g, n) => buildingLevels(g, n) >= 20 },
  { id: 'tycoon',     icon: '💹', name: '큰손',          desc: '보유 주식 평가액 5,000',                   check: (g, n) => stockValue(g, n) >= 5000 },
  { id: 'rich',       icon: '💰', name: '부국',          desc: '국력 20,000 달성',                         check: (g, n) => n.stats.score >= 20000 },
  { id: 'diplomat',   icon: '🤝', name: '외교의 달인',   desc: '동시에 3개국과 조약',                      check: (g, n) => treaties(g, n) >= 3 },
  { id: 'alliance',   icon: '🕊', name: '평화의 사도',   desc: '동맹 2개국',                               check: (g, n) => allies(g, n) >= 2 },
  { id: 'pacifist',   icon: '🌿', name: '무혈 번영',     desc: '10분 동안 손실·점령 없이 국력 8,000',      check: (g, n) => g.time >= 600 && n.stats.losses === 0 && n.stats.captures === 0 && n.stats.score >= 8000 },
  { id: 'expand5',    icon: '🏙', name: '개척자',        desc: '도시 5개 보유',                            check: (g, n) => n.stats.cities >= 5 },
  { id: 'navy',       icon: '⚓', name: '해양 강국',     desc: '함대 3개 보유',                            check: (g, n) => { let c = 0; for (const u of g.units.values()) if (u.owner === n.idx && u.naval) c++; return c >= 3; } },
  { id: 'defender',   icon: '🛡', name: '철벽',          desc: '손실 없이 적 부대 8기 격멸',                check: (g, n) => n.stats.kills >= 8 && n.stats.losses === 0 },
  { id: 'veteran',    icon: '⚔', name: '백전노장',      desc: '적 부대 20기 격멸',                        check: (g, n) => n.stats.kills >= 20 },
  { id: 'council',    icon: '🏛', name: '의회의 목소리', desc: '세계 박람회 보유 (투표권 2표)',              check: (g, n) => Object.values(g.projects).some((p) => p.done && p.owner === n.idx && p.id === 'expo') },
  { id: 'spymaster',  icon: '🕵', name: '그림자 정부',   desc: '첩보 작전 3회 성공',                        check: (g, n) => (n.stats.spies || 0) >= 3 },
];
const BY_ID = Object.fromEntries(LIST.map((a) => [a.id, a]));

function tick(game) {
  if (!game.firsts) game.firsts = {};
  for (const n of game.nations) {
    if (!n.alive) continue;
    for (const a of LIST) {
      if (n.ach.includes(a.id)) continue;
      if (a.first && game.firsts[a.id] !== undefined) continue;
      if (!a.check(game, n)) continue;
      n.ach.push(a.id);
      if (a.first) game.firsts[a.id] = n.idx;
      game.pushLog(`🏅 업적 달성: ${a.icon} ${a.name} — ${a.desc}`, n.idx);
      game.pushNews(`🏅 ${n.title}, 「${a.name}」 업적 달성`, n.idx);
    }
  }
}

function publicList() {
  return LIST.map((a) => ({ id: a.id, icon: a.icon, name: a.name, desc: a.desc, first: !!a.first }));
}

module.exports = { LIST, BY_ID, tick, publicList };
