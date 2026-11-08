'use strict';

/**
 * 봇 4국 자동 대전 — 밸런스·성능 점검.
 *   node test/balance.js [판수=5] [제한초=1200]
 * 판마다 종료 시각, 국력 격차, 멸망 수, 부대·기술·도시 추이를 찍는다.
 * 기준: 20분 판이 12분 전에 끝나거나(스노우볼), 1위/4위 국력비가 6배를 넘으면 손볼 때다.
 */
const { Game } = require('../src/game');
const { think } = require('../src/bot');

const games = Number(process.argv[2]) || 5;
const duration = Number(process.argv[3]) || 1200;
const summary = [];

for (let gi = 0; gi < games; gi++) {
  const seed = 100 + gi * 37;
  const g = new Game(['A', 'B', 'C', 'D'].map((n, i) => ({ id: n.toLowerCase(), name: n, isBot: true })), { duration, seed });
  const t0 = Date.now();
  let ticks = 0;
  const trace = [];
  while (!g.ended) {
    g.tick(0.25); ticks++;
    if (ticks % 24 === 0) for (const n of g.nations) think(g, n.id);
    if (ticks % 1200 === 0) {
      trace.push(`    t=${String(Math.round(g.time)).padStart(4)} ` + g.nations.map((n) => `${n.alive ? '' : '†'}$${String(Math.round(n.cash)).padStart(5)} +${n.stats.net.toFixed(0).padStart(3)} u${String(n.stats.units).padStart(2)} c${String(n.stats.cities).padStart(2)} T${String(n.techs.length).padStart(2)}`).join(' | '));
    }
  }
  const ms = Date.now() - t0;
  const r = g.ranking;
  const ratio = r[0].score / Math.max(1, r[r.length - 1].score);
  const dead = r.filter((x) => !x.alive).length;
  const captures = g.nations.reduce((s, n) => s + n.stats.conquests, 0); // 기록(log)은 최근 120줄만 남아 셀 수 없다
  summary.push({ seed, end: Math.round(g.time), ratio, dead, captures, msPerTick: ms / ticks });
  console.log(`seed ${seed}: 종료 ${Math.round(g.time)}s, 1위/4위 ${ratio.toFixed(1)}x, 멸망 ${dead}, 도시 점령 ${captures}회, ${(ms / ticks).toFixed(2)}ms/tick`);
  console.log(trace.join('\n'));
  console.log('    순위: ' + r.map((x) => `${x.name}${x.alive ? '' : '†'} ${x.score} (도시 ${x.cities})`).join(' / '));
}
const avgEnd = summary.reduce((s, x) => s + x.end, 0) / summary.length;
const avgRatio = summary.reduce((s, x) => s + x.ratio, 0) / summary.length;
console.log(`\n평균 종료 ${Math.round(avgEnd)}s / 평균 1위·4위 격차 ${avgRatio.toFixed(1)}x / 조기 종료 ${summary.filter((x) => x.end < duration * 0.6).length}판`);
