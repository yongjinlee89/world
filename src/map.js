'use strict';

const { TERRAIN, RULES } = require('./data');

/**
 * 절차적 현대 대륙 생성.
 *  - 시드 기반 값 노이즈로 고도를 만들고 → 바다/평원/구릉/산악/고봉 으로 나눈다
 *  - 수분 노이즈로 삼림을 뿌리고, 산에서 바다로 흐르는 하천을 몇 줄기 긋는다
 *  - 도시(수도 n개 + 중립 도시)를 육지에 서로 떨어지게 배치하고 고속도로로 잇는다
 *  - 자원 타일(철광·유전·농지)을 도시 주변에 뿌린다
 * 수도는 지도 가장자리를 따라 서로 최대한 멀리 둔다.
 */

function rngFromSeed(seed) {
  let s = seed >>> 0 || 1;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

// 2D 값 노이즈 (격자 보간 + 옥타브)
function makeNoise(rand) {
  const SIZE = 256;
  const grid = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const smooth = (t) => t * t * (3 - 2 * t);
  function sample(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const g = (gx, gy) => grid[((gy & (SIZE - 1)) * SIZE) + (gx & (SIZE - 1))];
    const a = g(x0, y0), b = g(x0 + 1, y0), c = g(x0, y0 + 1), d = g(x0 + 1, y0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  return function fbm(x, y, octaves = 4, lac = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += sample(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lac;
    }
    return sum / norm;
  };
}

const CITY_NAMES = [
  '가람', '누리', '다온', '로하', '마루', '바다솔', '새벽', '아라', '자은', '하늬', '한울', '온새미', '그린', '나래', '도담', '라온', '미리내', '보람', '사랑', '여울',
  '이든', '초롱', '해솔', '가온', '늘봄', '단비', '모아', '별하', '소담', '윤슬', '은솔', '채운', '푸른', '한결', '희나', '노을', '다솜', '마중', '벼리', '시루',
  '하랑', '세운', '벨마르', '카디아', '노르덴', '오르테', '루멘', '사비나', '테라노', '미르', '아르카', '델포',
  '유니온', '엘리아', '포르투', '카르멜', '솔라', '네바', '아스트라', '비르고', '칼룬', '이사르', '모르딘', '페른',
  '라미아', '토르', '세레나', '바이샤', '헬리오', '온다', '퀸시', '제노', '타르', '울란', '베가', '시엘',
];

function generateMap(width, height, seed, nationCount) {
  const rand = rngFromSeed(seed);
  const noise = makeNoise(rand);
  const noise2 = makeNoise(rand);
  const tiles = new Array(width * height).fill('plain');
  const height01 = new Float32Array(width * height);

  // --- 고도 -------------------------------------------------------------
  // 가장자리로 갈수록 낮아지는 마스크로 대륙 하나 + 바다 연안을 만든다.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = x / width, ny = y / height;
      const e = noise(x * 0.045 + 3.1, y * 0.045 + 7.7, 5, 2.1, 0.5);
      const dx = Math.abs(nx - 0.5) * 2, dy = Math.abs(ny - 0.5) * 2;
      const edge = Math.pow(Math.max(dx, dy), 3.2); // 네 변이 바다
      let h = e - edge * 0.55;
      height01[y * width + x] = h;
    }
  }
  // 수면 높이를 조정해 육지가 60~68% 정도 되게 한다
  const sorted = Array.from(height01).sort((a, b) => a - b);
  const seaLevel = sorted[Math.floor(sorted.length * 0.33)];
  const mountainLevel = sorted[Math.floor(sorted.length * 0.9)];
  const peakLevel = sorted[Math.floor(sorted.length * 0.965)];
  const hillLevel = sorted[Math.floor(sorted.length * 0.80)];

  for (let i = 0; i < tiles.length; i++) {
    const h = height01[i];
    if (h < seaLevel) tiles[i] = 'water';
    else if (h > peakLevel) tiles[i] = 'peak';
    else if (h > mountainLevel) tiles[i] = 'mountain';
    else if (h > hillLevel) tiles[i] = 'hill';
    else tiles[i] = 'plain';
  }

  // --- 삼림 -------------------------------------------------------------
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (tiles[i] !== 'plain' && tiles[i] !== 'hill') continue;
      const m = noise2(x * 0.08 + 11, y * 0.08 + 5, 3);
      if (m > 0.6 && rand() < 0.85) tiles[i] = 'forest';
    }
  }

  // --- 하천: 산악에서 시작해 낮은 쪽으로 흘러 바다에 닿는다 ------------
  const riverCount = Math.max(3, Math.round((width * height) / 1400));
  const riverPaths = []; // 화면용 경로 [x0,y0,x1,y1,...] (상류 → 하구)
  let made = 0, tries = 0;
  while (made < riverCount && tries++ < 400) {
    const sx = Math.floor(rand() * width), sy = Math.floor(rand() * height);
    const si = sy * width + sx;
    if (tiles[si] !== 'mountain' && tiles[si] !== 'hill') continue;
    let x = sx, y = sy, len = 0;
    const path = [];
    const seen = new Set();
    let mouth = null;
    while (len++ < 120) {
      const i = y * width + x;
      if (tiles[i] === 'water') { mouth = i; break; }
      if (seen.has(i)) break;
      seen.add(i);
      path.push(i);
      // 가장 낮은 이웃으로. 더 낮은 곳이 없으면(분지) 거기서 끝난다 — 평지에서 웅덩이처럼 퍼지지 않게
      let best = null, bestH = height01[i] + 0.004;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx2 = x + ox, ny2 = y + oy;
          if (nx2 < 0 || ny2 < 0 || nx2 >= width || ny2 >= height) continue;
          const h = height01[ny2 * width + nx2] + (rand() - 0.5) * 0.006;
          if (h < bestH && !seen.has(ny2 * width + nx2)) { bestH = h; best = { x: nx2, y: ny2 }; }
        }
      }
      if (!best) break;
      x = best.x; y = best.y;
    }
    if (path.length >= 10) {
      for (const i of path) if (tiles[i] !== 'water' && tiles[i] !== 'peak') tiles[i] = 'river';
      const pts = [];
      for (const i of path) pts.push(i % width, (i - (i % width)) / width);
      if (mouth !== null) pts.push(mouth % width, (mouth - (mouth % width)) / width);
      riverPaths.push(pts);
      made++;
    }
  }

  // --- 도시 배치 -----------------------------------------------------------
  const isLand = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const t = tiles[y * width + x];
    return t === 'plain' || t === 'forest' || t === 'hill';
  };
  // 육지 품질: 주변 5×5 중 평지 비율
  const landScore = (x, y) => {
    let s = 0;
    for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
      const nx2 = x + ox, ny2 = y + oy;
      if (!isLand(nx2, ny2)) { s -= (tiles[(ny2 * width + nx2)] === 'water' ? 0.4 : 1); continue; }
      s += tiles[ny2 * width + nx2] === 'plain' ? 1 : 0.5;
    }
    return s;
  };

  const cities = [];
  const margin = 6;
  // 수도: 가장자리 타원 위에 균등 각도로 배치 후 가까운 좋은 육지로 스냅
  for (let k = 0; k < nationCount; k++) {
    const ang = (k / nationCount) * Math.PI * 2 + rand() * 0.3 - 0.15 + Math.PI / nationCount;
    const cx = width / 2 + Math.cos(ang) * (width / 2 - margin - 8);
    const cy = height / 2 + Math.sin(ang) * (height / 2 - margin - 6);
    let best = null, bestS = -Infinity;
    for (let r = 0; r < 14; r++) {
      for (let a = 0; a < 16; a++) {
        const x = Math.round(cx + Math.cos(a / 16 * Math.PI * 2) * r);
        const y = Math.round(cy + Math.sin(a / 16 * Math.PI * 2) * r);
        if (!isLand(x, y)) continue;
        if (x < margin || y < margin || x >= width - margin || y >= height - margin) continue;
        const s = landScore(x, y) - r * 0.6;
        if (s > bestS) { bestS = s; best = { x, y }; }
      }
      if (best && r >= 4) break;
    }
    if (!best) best = { x: Math.round(cx), y: Math.round(cy) };
    cities.push({ id: 'c' + cities.length, name: CITY_NAMES[cities.length % CITY_NAMES.length], x: best.x, y: best.y, size: 3, capitalOf: k });
  }
  // 중립 도시: 서로/수도와 최소 거리 유지
  // 육지 넓이에 비례해 도시를 촘촘히 둔다 (도시 하나가 육지 약 75칸을 관할)
  let landTiles = 0;
  for (let i = 0; i < tiles.length; i++) if (tiles[i] !== 'water') landTiles++;
  const neutralCount = Math.max(nationCount * 4, Math.round(landTiles / 75) - nationCount);
  const minDist = Math.max(5.5, Math.min(9, Math.sqrt(landTiles / (neutralCount + nationCount)) * 0.82));
  tries = 0;
  while (cities.length < nationCount + neutralCount && tries++ < 12000) {
    const x = margin + Math.floor(rand() * (width - margin * 2));
    const y = margin + Math.floor(rand() * (height - margin * 2));
    if (!isLand(x, y)) continue;
    if (landScore(x, y) < (tries < 3000 ? 8 : 2)) continue; // 좋은 땅부터, 모자라면 구릉·해안에도
    let ok = true;
    for (const c of cities) if (Math.hypot(c.x - x, c.y - y) < minDist) { ok = false; break; }
    if (!ok) continue;
    const size = rand() < 0.22 ? 2 : 1;
    cities.push({ id: 'c' + cities.length, name: CITY_NAMES[cities.length % CITY_NAMES.length], x, y, size, capitalOf: null });
  }

  // --- 고속도로: 최소 신장 트리로 도시들을 잇는다 ----------------------
  const roadPaths = []; // 화면용 경로 [x0,y0,...]
  const pave = (a, b) => { const pts = roadPath(tiles, width, height, a, b); if (pts) roadPaths.push(pts); };
  if (cities.length >= 2) {
    const connected = new Set([0]);
    while (connected.size < cities.length) {
      let bi = -1, bj = -1, bd = Infinity;
      for (const i of connected) {
        for (let j = 0; j < cities.length; j++) {
          if (connected.has(j)) continue;
          const d = Math.hypot(cities[i].x - cities[j].x, cities[i].y - cities[j].y);
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
      }
      if (bj === -1) break;
      pave(cities[bi], cities[bj]);
      connected.add(bj);
    }
    // 가까운 쌍 몇 개를 추가로 이어 순환로를 만든다
    for (let i = 0; i < cities.length; i++) {
      let near = null, nd = Infinity;
      for (let j = 0; j < cities.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(cities[i].x - cities[j].x, cities[i].y - cities[j].y);
        if (d < nd) { nd = d; near = j; }
      }
      if (near !== null && rand() < 0.3) pave(cities[i], cities[near]);
    }
  }

  // --- 도시 타일 + 주변 정리 ---------------------------------------------
  for (const c of cities) {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const nx2 = c.x + ox, ny2 = c.y + oy;
      if (nx2 < 0 || ny2 < 0 || nx2 >= width || ny2 >= height) continue;
      const i = ny2 * width + nx2;
      if (tiles[i] === 'peak' || tiles[i] === 'mountain') tiles[i] = 'hill';
      if (tiles[i] === 'water') tiles[i] = 'plain';
    }
    tiles[c.y * width + c.x] = 'urban';
    if (c.size >= 2) {
      // 큰 도시는 도시 타일이 넓다
      const extra = c.size === 3 ? [[1, 0], [0, 1], [-1, 0], [0, -1]] : [[1, 0], [0, 1]];
      for (const [ox, oy] of extra) {
        const i = (c.y + oy) * width + (c.x + ox);
        if (i >= 0 && i < tiles.length && tiles[i] !== 'water') tiles[i] = 'urban';
      }
    }
  }

  // --- 관할 구역(지방): 각 육지 칸을 가장 가까운 도시에 배정 ----------------
  const prov = computeProvinces(tiles, width, height, cities);

  // --- 자원 타일 (도시 관할 구역 안) ---------------------------------------
  const resources = new Array(width * height).fill(null);
  for (let ci = 0; ci < cities.length; ci++) {
    const c = cities[ci];
    const R = Math.min(RULES.cityRadius[c.size], 6);
    const want = { iron: 1 + Math.floor(rand() * 2), oil: rand() < 0.7 ? 1 : 0, farm: 1 + Math.floor(rand() * 2) };
    if (c.capitalOf !== null) { want.iron = 2; want.oil = 1; want.farm = 2; }
    for (const [kind, n] of Object.entries(want)) {
      let placed = 0, t2 = 0;
      while (placed < n && t2++ < 80) {
        const a = rand() * Math.PI * 2, r = 2 + rand() * (R - 2.5);
        const x = Math.round(c.x + Math.cos(a) * r), y = Math.round(c.y + Math.sin(a) * r);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = y * width + x;
        const t = tiles[i];
        if (resources[i] || t === 'water' || t === 'urban' || t === 'peak' || t === 'river') continue;
        if (prov[i] !== ci) continue;
        if (kind === 'farm' && t !== 'plain') continue;
        if (kind === 'iron' && t !== 'hill' && t !== 'mountain' && t !== 'plain') continue;
        if (kind === 'oil' && t !== 'plain' && t !== 'forest') continue;
        resources[i] = kind;
        placed++;
      }
    }
  }

  return { width, height, tiles, resources, cities, prov, roads: roadPaths, rivers: riverPaths, seed };
}

/**
 * 관할 구역: 도시들에서 동시에 퍼져 나가는 최단 경로(다익스트라)로 각 육지 칸의 소속 도시를 정한다.
 * 산·고봉은 넘기 어려워 자연 국경이 되고, 바다는 막힌다. 큰 도시는 출발 비용이 낮아 더 넓게 관할한다.
 * 도시에서 너무 먼 칸은 아무 도시에도 속하지 않는다(-1, 황무지).
 */
const PROV_COST = { plain: 1, road: 0.9, urban: 1, river: 1.25, forest: 1.3, hill: 1.5, mountain: 2.3, peak: 4 };
function computeProvinces(tiles, width, height, cities) {
  const N = width * height;
  const prov = new Int16Array(N).fill(-1);
  const dist = new Float64Array(N).fill(Infinity); // Float32 면 음수 시작 비용이 반올림돼 수도가 퍼지지 못한다
  // 이진 힙 (비용, 칸)
  const hc = [], hi = [];
  const push = (c, i) => {
    let k = hc.length; hc.push(c); hi.push(i);
    while (k > 0) { const p = (k - 1) >> 1; if (hc[p] <= hc[k]) break; [hc[p], hc[k]] = [hc[k], hc[p]]; [hi[p], hi[k]] = [hi[k], hi[p]]; k = p; }
  };
  const pop = () => {
    const c = hc[0], i = hi[0];
    const lc = hc.pop(), li = hi.pop();
    if (hc.length) {
      hc[0] = lc; hi[0] = li;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1; let m = k;
        if (l < hc.length && hc[l] < hc[m]) m = l;
        if (r < hc.length && hc[r] < hc[m]) m = r;
        if (m === k) break;
        [hc[m], hc[k]] = [hc[k], hc[m]]; [hi[m], hi[k]] = [hi[k], hi[m]]; k = m;
      }
    }
    return [c, i];
  };
  const maxCost = (ci) => 8 + cities[ci].size * 2.2;
  cities.forEach((c, ci) => {
    const i = c.y * width + c.x;
    const d0 = -(c.size - 1) * 1.6;
    dist[i] = d0; prov[i] = ci; push(d0, i);
  });
  while (hc.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    const ci = prov[i];
    const x = i % width, y = (i - x) / width;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      if (!ox && !oy) continue;
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      const t = tiles[j];
      if (t === 'water') continue;
      const nd = d + (PROV_COST[t] || 1) * (ox && oy ? 1.414 : 1);
      if (nd > maxCost(ci) || nd >= dist[j]) continue;
      dist[j] = nd; prov[j] = ci; push(nd, j);
    }
  }
  return Array.from(prov);
}

// 고속도로 경로: 평지를 좋아하고 산·강(교량)은 피하며, 이미 깔린 도로는 싸게 재사용한다 (A*, 8방향).
// 깐 칸은 'road' 로 바꾸고 화면용 경로 [x0,y0,...] 를 돌려준다. 바다로 막히면 null.
const ROAD_COST = { plain: 1, road: 0.45, urban: 0.6, forest: 1.7, hill: 2.2, river: 3, mountain: 5, peak: 14 };
function roadPath(tiles, width, height, a, b) {
  const N = width * height;
  const g = new Float64Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const heap = new MinHeap();
  const s = a.y * width + a.x, t = b.y * width + b.x;
  const hfun = (i) => { const x = i % width, y = (i - x) / width; return Math.hypot(x - b.x, y - b.y) * 0.45; };
  g[s] = 0; heap.push(hfun(s), s);
  while (heap.size()) {
    const [, i] = heap.pop();
    if (i === t) break;
    const x = i % width, y = (i - x) / width;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      if (!ox && !oy) continue;
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      const tt = tiles[j];
      if (tt === 'water') continue;
      // 대각선으로 바다 모서리를 가로지르지 않게
      if (ox && oy && (tiles[y * width + nx] === 'water' || tiles[ny * width + x] === 'water')) continue;
      const ng = g[i] + (ROAD_COST[tt] || 1) * (ox && oy ? 1.414 : 1);
      if (ng >= g[j]) continue;
      g[j] = ng; from[j] = i; heap.push(ng + hfun(j), j);
    }
  }
  if (!isFinite(g[t])) return null;
  const idx = [];
  for (let i = t; i !== -1; i = from[i]) idx.push(i);
  idx.reverse();
  const pts = [];
  for (const i of idx) {
    if (tiles[i] !== 'urban' && tiles[i] !== 'river') tiles[i] = 'road'; // 강 위는 교량 (강 칸 유지)
    pts.push(i % width, (i - (i % width)) / width);
  }
  return pts;
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  size() { return this.k.length; }
  push(key, val) {
    const K = this.k, V = this.v;
    let i = K.length; K.push(key); V.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= K[i]) break; [K[p], K[i]] = [K[i], K[p]]; [V[p], V[i]] = [V[i], V[p]]; i = p; }
  }
  pop() {
    const K = this.k, V = this.v;
    const top = [K[0], V[0]];
    const lk = K.pop(), lv = V.pop();
    if (K.length) {
      K[0] = lk; V[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < K.length && K[l] < K[m]) m = l;
        if (r < K.length && K[r] < K[m]) m = r;
        if (m === i) break;
        [K[m], K[i]] = [K[i], K[m]]; [V[m], V[i]] = [V[i], V[m]]; i = m;
      }
    }
    return top;
  }
}

function tileAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  return TERRAIN[map.tiles[y * map.width + x]];
}

module.exports = { computeProvinces, generateMap, tileAt, rngFromSeed };
