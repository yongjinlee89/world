'use strict';

const { TERRAIN } = require('./data');

/**
 * A* 길찾기 (8방향). sam 의 구현을 가져와 지형 테이블만 바꿨다.
 *  - 이진 힙으로 O(log n) 선택, 스크래치 버퍼를 세대 스탬프로 재사용해 GC 를 피한다.
 *  - 반복 횟수를 직선 거리에 비례해 제한해서, 못 가는 곳은 ms 안에 포기한다.
 *  - opts.flying 이면 지형 비용을 무시하고(바다 포함) 직진한다.
 *  - opts.naval 이면 바다 타일만 지나간다 (비용 1).
 *  - opts.amphibious 면 지상군도 바다를 건넌다 (수송선: 바다 칸 비용 2.5, 육지→바다 승선 +10).
 *  - opts.avoid = [{x,y,r,cost}] 위험 지대에 가산 비용을 줘서 우회하게 한다.
 * 반환: 출발지를 뺀 {x,y} 배열(목적지 포함). 경로가 없으면 null.
 */

const NEIGH8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

let _scr = null, _scrN = 0, _scrGen = 0;
function getScratch(N) {
  if (!_scr || _scrN !== N) {
    _scr = { came: new Int32Array(N), g: new Float32Array(N), stamp: new Int32Array(N), closedStamp: new Int32Array(N) };
    _scrN = N;
    _scrGen = 0;
  }
  _scrGen++;
  return _scr;
}

const AMPHIBIOUS_COST = 2.5; // 수송선으로 바다 1칸
const EMBARK_COST = 10;      // 승선 (같은 대륙 안에서 만을 가로지르는 지름길로 바다에 나가지 않게)

function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  return Math.max(dx, dy) + 0.41 * Math.min(dx, dy);
}

function findPath(map, start, goal, opts = {}) {
  if (!start || !goal) return null;
  const sx = Math.round(start.x), sy = Math.round(start.y);
  const gx = Math.round(goal.x), gy = Math.round(goal.y);
  if (sx === gx && sy === gy) return [];
  const w = map.width, h = map.height;
  if (sx < 0 || sx >= w || sy < 0 || sy >= h) return null;
  if (gx < 0 || gx >= w || gy < 0 || gy >= h) return null;

  const N = w * h;
  const scr = getScratch(N);
  const gen = _scrGen;
  const came = scr.came, gScore = scr.g, gStamp = scr.stamp, closedStamp = scr.closedStamp;
  const gAt = (k) => (gStamp[k] === gen ? gScore[k] : Infinity);

  const heap = [];
  function heapPush(key, f) {
    heap.push({ key, f });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f <= heap[i].f) break;
      const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp;
      i = p;
    }
  }
  function heapPop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      const n = heap.length;
      for (;;) {
        const l = i * 2 + 1, r = i * 2 + 2;
        let best = i;
        if (l < n && heap[l].f < heap[best].f) best = l;
        if (r < n && heap[r].f < heap[best].f) best = r;
        if (best === i) break;
        const tmp = heap[i]; heap[i] = heap[best]; heap[best] = tmp;
        i = best;
      }
    }
    return top;
  }

  const startKey = sy * w + sx;
  const goalKey = gy * w + gx;
  gScore[startKey] = 0;
  gStamp[startKey] = gen;
  came[startKey] = -1;
  heapPush(startKey, heuristic(sx, sy, gx, gy));

  const h0 = heuristic(sx, sy, gx, gy);
  const maxIter = Math.min(N, Math.max(opts.amphibious ? 4000 : 1500, Math.floor(h0 * 90)));
  let iter = 0;
  const tiles = map.tiles;
  const flying = !!opts.flying;
  const naval = !!opts.naval;
  const amphibious = !!opts.amphibious;
  const avoid = opts.avoid;

  while (heap.length > 0) {
    if (iter++ >= maxIter) return null;
    const cur = heapPop();
    if (closedStamp[cur.key] === gen) continue;
    closedStamp[cur.key] = gen;

    if (cur.key === goalKey) {
      const path = [];
      let k = cur.key;
      while (came[k] !== -1) {
        const cx = k % w;
        path.push({ x: cx, y: (k - cx) / w });
        k = came[k];
      }
      path.reverse();
      return path;
    }

    const cx = cur.key % w;
    const cy = (cur.key - cx) / w;
    const cg = gAt(cur.key);

    for (let i = 0; i < 8; i++) {
      const dx = NEIGH8[i][0], dy = NEIGH8[i][1];
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nKey = ny * w + nx;
      if (closedStamp[nKey] === gen) continue;
      let base = 1;
      if (naval) {
        if (tiles[nKey] !== 'water') continue;
      } else if (!flying) {
        const t = TERRAIN[tiles[nKey]];
        if (!t) continue;
        base = t.moveCost;
        if (!isFinite(base)) {
          if (!amphibious || tiles[nKey] !== 'water') continue;
          base = AMPHIBIOUS_COST + (tiles[cur.key] !== 'water' ? EMBARK_COST : 0);
        }
      }
      let stepCost = base * (dx !== 0 && dy !== 0 ? 1.41421 : 1.0);
      if (avoid) {
        for (let k = 0; k < avoid.length; k++) {
          const av = avoid[k];
          const adx = Math.abs(nx - av.x), ady = Math.abs(ny - av.y);
          if ((adx > ady ? adx : ady) <= av.r) stepCost += av.cost;
        }
      }
      const tentative = cg + stepCost;
      if (tentative < gAt(nKey)) {
        came[nKey] = cur.key;
        gScore[nKey] = tentative;
        gStamp[nKey] = gen;
        heapPush(nKey, tentative + heuristic(nx, ny, gx, gy));
      }
    }
  }
  return null;
}

module.exports = { findPath, AMPHIBIOUS_COST };
