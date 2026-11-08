'use strict';

/**
 * 캔버스 렌더러 (그래픽 상향판).
 *  지형: 1px/타일 색을 부드럽게 확대해 지형 경계를 번지게 하고(채색 지도 느낌), 그 위에 고도 음영(hillshade),
 *        해안선 거품, 삼림·구릉·산맥·하천·고속도로·도시 블록·자원 마커를 24px/타일로 한 번만 그린다.
 *  영토: 반투명 채움 + 국경선 글로우. 서버 terr 가 바뀐 패치가 올 때만 다시 그린다.
 *  구름: 작은 노이즈 텍스처를 천천히 흘려 그림자·하이라이트를 얹는다 (프레임당 drawImage 몇 번).
 *  부대: 이동 방향으로 회전하는 벡터 아이콘, 그라데이션 몸체, 이동 자취, 교전 예광탄·피격 불꽃·손상 연기.
 *  도시: 규모·건물에 따른 스카이라인, 야간 창문, 수도 표식, 포위 시 화염.
 *  모든 장식은 클라이언트에서만 계산하므로 서버 트래픽은 그대로다.
 */
(function () {
const HG = window.HG;
const ICONS = window.HG_ICONS;
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const mini = document.getElementById('minimap');
const mctx = mini.getContext('2d');

// 오프스크린 타일 크기. 데스크톱은 32px(확대해도 선명), 모바일은 메모리를 아껴 24px
const TS = (window.innerWidth >= 900 && (window.devicePixelRatio || 1) <= 2) ? 32 : 24;
const COL = {
  water: [22, 58, 96], plain: [122, 154, 78], road: [112, 140, 76], forest: [58, 104, 58], hill: [142, 150, 88],
  mountain: [138, 132, 122], peak: [214, 218, 224], river: [60, 128, 180], urban: [124, 128, 136],
};
const ELEV = { water: 0, river: 0.6, plain: 1, road: 1, urban: 1, forest: 1.25, hill: 2.1, mountain: 3.3, peak: 4.4 };
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const rgb = (c, d = 0) => `rgb(${clamp(c[0] + d)},${clamp(c[1] + d)},${clamp(c[2] + d)})`;
function hash(x, y, s) {
  let h = (x * 73856093) ^ (y * 19349663) ^ ((s | 0) * 83492791);
  h = (h ^ (h >>> 13)) >>> 0; h = (h * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}
function hexToRgb(hex) { const m = hex.replace('#', ''); return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]; }
const FONT = () => getComputedStyle(document.body).fontFamily;

let terrainCv = null, terrainKey = null, terrCv = null, miniCv = null, cloudCv = null;
let dpr = 1;

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = window.innerWidth * dpr; canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px'; canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

HG.tileToScreen = (tx, ty) => {
  const z = HG.camera.zoom;
  return { x: window.innerWidth / 2 + (tx - HG.camera.x) * z, y: window.innerHeight / 2 + (ty - HG.camera.y) * z };
};
HG.screenToTile = (sx, sy) => {
  const z = HG.camera.zoom;
  return { x: (sx - window.innerWidth / 2) / z + HG.camera.x, y: (sy - window.innerHeight / 2) / z + HG.camera.y };
};

/* ================================================================== 지형 레이어 */
function buildTerrain(map) {
  const w = map.w, h = map.h, tiles = map.tiles;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 'water' : tiles[y * w + x]);
  const elev = (x, y) => ELEV[at(x, y)] || 0;
  const cv = document.createElement('canvas');
  cv.width = w * TS; cv.height = h * TS;
  const c = cv.getContext('2d');

  // 1) 1px/타일 색 → 부드럽게 확대 (지형 경계가 번진다)
  const lo = document.createElement('canvas');
  lo.width = w; lo.height = h;
  const lc = lo.getContext('2d');
  const img = lc.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = tiles[y * w + x];
      let col = (t === 'river' || t === 'road') ? COL.plain : (COL[t] || COL.plain);
      const v = (hash(x, y, 7) - 0.5) * 18;
      // 바다는 해안에서 멀수록 짙게
      let d = 0;
      if (t === 'water') {
        let near = false;
        for (let oy = -2; oy <= 2 && !near; oy++) for (let ox = -2; ox <= 2; ox++) if (at(x + ox, y + oy) !== 'water') { near = true; break; }
        d = near ? 26 : -14;
      }
      const p = (y * w + x) * 4;
      img.data[p] = clamp(col[0] + v + d); img.data[p + 1] = clamp(col[1] + v + d); img.data[p + 2] = clamp(col[2] + v + d * 0.6); img.data[p + 3] = 255;
    }
  }
  lc.putImageData(img, 0, 0);
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(lo, 0, 0, w, h, 0, 0, w * TS, h * TS);

  // 2) 고도 음영 (hillshade, 북서광) — 저해상도로 그려 부드럽게 확대
  const sh = document.createElement('canvas');
  sh.width = w * 2; sh.height = h * 2;
  const sc = sh.getContext('2d');
  const simg = sc.createImageData(w * 2, h * 2);
  for (let y = 0; y < h * 2; y++) {
    for (let x = 0; x < w * 2; x++) {
      const tx = x / 2, ty = y / 2;
      const e1 = elev(Math.floor(tx - 0.5), Math.floor(ty - 0.5)), e2 = elev(Math.floor(tx + 0.5), Math.floor(ty + 0.5));
      const s = (e1 - e2) * 0.22; // 양수 = 빛을 받음
      const p = (y * w * 2 + x) * 4;
      if (s > 0) { simg.data[p] = 255; simg.data[p + 1] = 250; simg.data[p + 2] = 230; simg.data[p + 3] = clamp(Math.min(0.55, s) * 255); }
      else { simg.data[p] = 10; simg.data[p + 1] = 14; simg.data[p + 2] = 30; simg.data[p + 3] = clamp(Math.min(0.6, -s) * 255); }
    }
  }
  sc.putImageData(simg, 0, 0);
  c.drawImage(sh, 0, 0, w * 2, h * 2, 0, 0, w * TS, h * TS);

  // 3) 바다 잔물결 + 해안 거품
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== 'water') continue;
      const sx = x * TS, sy = y * TS;
      if (hash(x, y, 11) > 0.55) {
        c.strokeStyle = 'rgba(190,225,245,0.22)'; c.lineWidth = 1.2;
        const px = sx + 3 + hash(x, y, 12) * (TS - 12), py = sy + 4 + hash(x, y, 13) * (TS - 8);
        c.beginPath(); c.moveTo(px, py); c.quadraticCurveTo(px + 3.5, py - 2.2, px + 7, py); c.quadraticCurveTo(px + 10, py + 2, px + 13, py); c.stroke();
      }
      // 거품: 육지와 맞닿은 변
      c.strokeStyle = 'rgba(225,240,250,0.55)'; c.lineWidth = 2.2;
      c.beginPath();
      if (at(x + 1, y) !== 'water') { c.moveTo(sx + TS - 1, sy + 2); c.lineTo(sx + TS - 1, sy + TS - 2); }
      if (at(x - 1, y) !== 'water') { c.moveTo(sx + 1, sy + 2); c.lineTo(sx + 1, sy + TS - 2); }
      if (at(x, y + 1) !== 'water') { c.moveTo(sx + 2, sy + TS - 1); c.lineTo(sx + TS - 2, sy + TS - 1); }
      if (at(x, y - 1) !== 'water') { c.moveTo(sx + 2, sy + 1); c.lineTo(sx + TS - 2, sy + 1); }
      c.stroke();
    }
  }
  // 4) 지형 디테일
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = tiles[y * w + x], sx = x * TS, sy = y * TS;
      switch (t) {
        case 'plain': drawPlain(c, sx, sy, x, y); break;
        case 'forest': drawForest(c, sx, sy, x, y); break;
        case 'hill': drawHill(c, sx, sy, x, y); break;
        case 'mountain': drawMountain(c, sx, sy, x, y, false); break;
        case 'peak': drawMountain(c, sx, sy, x, y, true); break;
        default: break;
      }
    }
  }
  // 5) 하천 · 6) 고속도로 — 지도 생성 때 저장한 실제 경로를 매끈한 곡선으로 그린다
  drawRivers(c, map, at);
  drawRoads(c, map, at);
  // 7) 도시 블록
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== 'urban') continue;
      const sx = x * TS, sy = y * TS;
      c.fillStyle = '#5f626a'; c.fillRect(sx, sy, TS, TS);
      for (let by = 0; by < 3; by++) for (let bx = 0; bx < 3; bx++) {
        const hh = hash(x * 3 + bx, y * 3 + by, 21);
        const bxp = sx + 2 + bx * 7.5, byp = sy + 2 + by * 7.5;
        c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(bxp + 1, byp + 1, 5.5, 5.5);
        c.fillStyle = `rgb(${158 + hh * 60 | 0},${160 + hh * 60 | 0},${170 + hh * 60 | 0})`; c.fillRect(bxp, byp, 5.5, 5.5);
        c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(bxp, byp, 5.5, 1.2);
      }
    }
  }
  // 8) 자원 마커
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = map.res[y * w + x];
      if (!r) continue;
      const cx = x * TS + TS / 2, cy = y * TS + TS / 2;
      c.fillStyle = 'rgba(0,0,0,0.32)'; c.beginPath(); c.arc(cx, cy + 1, 9.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.12)'; c.beginPath(); c.arc(cx, cy, 9, 0, Math.PI * 2); c.fill();
      ICONS.drawResource(c, r, cx, cy, 15);
    }
  }
  return cv;
}
/* ================================================================== 하천 · 고속도로 (곡선 경로) */
const K = TS / 32; // 선 굵기 배율
// 칸 좌표 목록 → 화면 좌표. jitter 를 주면 물길이 칸 중심에서 살짝 굽이친다 (결정적).
function pathPoints(flat, jitter, salt) {
  const pts = [];
  for (let k = 0; k < flat.length; k += 2) {
    const x = flat[k], y = flat[k + 1];
    const end = k === 0 || k === flat.length - 2;
    const jx = end ? 0 : (hash(x, y, salt) - 0.5) * jitter * TS, jy = end ? 0 : (hash(x, y, salt + 1) - 0.5) * jitter * TS;
    pts.push([x * TS + TS / 2 + jx, y * TS + TS / 2 + jy]);
  }
  return pts;
}
// 차이킨 곡선 다듬기: 모서리를 깎아 계단·꺾임을 없앤다 (양 끝점 유지)
function chaikin(pts, iter) {
  let p = pts;
  for (let it = 0; it < iter; it++) {
    if (p.length < 3) return p;
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[i + 1];
      q.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25], [x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}
function strokePath(c, p) {
  c.beginPath(); c.moveTo(p[0][0], p[0][1]);
  for (let i = 1; i < p.length; i++) c.lineTo(p[i][0], p[i][1]);
  c.stroke();
}
// 굵기가 변하는 선: 짧은 조각을 둥근 끝으로 이어 그린다
function strokeTapered(c, p, wFn) {
  for (let i = 0; i < p.length - 1; i++) {
    c.lineWidth = wFn(i / (p.length - 1));
    c.beginPath(); c.moveTo(p[i][0], p[i][1]); c.lineTo(p[i + 1][0], p[i + 1][1]); c.stroke();
  }
}
function drawRivers(c, map) {
  const rivers = (map.rivers || []).map((r, ri) => chaikin(pathPoints(r, 0.45, 70 + ri), 3));
  c.lineCap = 'round'; c.lineJoin = 'round';
  // 상류는 가늘고 하구로 갈수록 넓어진다
  const w = (t) => (2.2 + 6.5 * Math.pow(t, 0.8)) * K;
  for (const p of rivers) { c.strokeStyle = 'rgba(52,74,40,0.35)'; strokeTapered(c, p, (t) => w(t) + 7 * K); }  // 강둑 그림자
  for (const p of rivers) { c.strokeStyle = 'rgba(150,170,110,0.55)'; strokeTapered(c, p, (t) => w(t) + 3.5 * K); } // 모래톱
  for (const p of rivers) { c.strokeStyle = '#255a8c'; strokeTapered(c, p, (t) => w(t) + 1.2 * K); }
  for (const p of rivers) {
    // 물 — 가장자리보다 밝은 중심
    c.strokeStyle = '#3a78b4'; strokeTapered(c, p, w);
    c.strokeStyle = 'rgba(110,170,220,0.55)'; strokeTapered(c, p, (t) => w(t) * 0.4);
  }
  // 물살 하이라이트: 군데군데 짧은 흰 선
  c.strokeStyle = 'rgba(225,242,255,0.55)'; c.lineWidth = 1 * K;
  rivers.forEach((p, ri) => {
    for (let i = 4; i < p.length - 3; i += 7) {
      if (hash(i, ri, 88) < 0.45) continue;
      const [x0, y0] = p[i], [x1, y1] = p[i + 2];
      c.beginPath(); c.moveTo(x0, y0 - 0.6); c.lineTo(x1, y1 - 0.6); c.stroke();
    }
  });
}
function drawRoads(c, map, at) {
  const roads = (map.roads || []).map((r) => ({ flat: r, p: chaikin(pathPoints(r, 0, 0), 3) }));
  c.lineCap = 'round'; c.lineJoin = 'round';
  // 층별로 전체 도로망을 그려야 교차로가 이음매 없이 이어진다
  c.save(); c.translate(1.2 * K, 1.8 * K);
  c.strokeStyle = 'rgba(0,0,0,0.32)'; c.lineWidth = 8.5 * K; for (const r of roads) strokePath(c, r.p); // 그림자
  c.restore();
  c.strokeStyle = '#b9b29a'; c.lineWidth = 7.4 * K; for (const r of roads) strokePath(c, r.p);       // 갓길
  c.strokeStyle = '#3b3f46'; c.lineWidth = 5.6 * K; for (const r of roads) strokePath(c, r.p);       // 아스팔트
  c.strokeStyle = 'rgba(255,255,255,0.10)'; c.lineWidth = 1.2 * K;
  c.save(); c.translate(0, -1.4 * K); for (const r of roads) strokePath(c, r.p); c.restore();          // 노면 반사
  c.strokeStyle = 'rgba(245,205,90,0.85)'; c.lineWidth = 1 * K; c.setLineDash([5 * K, 5 * K]);
  for (const r of roads) strokePath(c, r.p);                                                          // 중앙선
  c.setLineDash([]);
  // 교량: 도로가 강 칸을 지나는 곳에 난간
  for (const r of roads) {
    const f = r.flat;
    for (let k = 2; k < f.length - 2; k += 2) {
      if (at(f[k], f[k + 1]) !== 'river') continue;
      const ax = f[k - 2], ay = f[k - 1], bx = f[k + 2], by = f[k + 3];
      const cx = f[k] * TS + TS / 2, cy = f[k + 1] * TS + TS / 2;
      const ang = Math.atan2(by - ay, bx - ax);
      c.save(); c.translate(cx, cy); c.rotate(ang);
      const L = TS * 0.62, Wd = 4.2 * K;
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(-L / 2 + 1.5 * K, -Wd - 1.5 * K + 2 * K, L, Wd * 2 + 3 * K);
      c.fillStyle = '#8f8a7c'; c.fillRect(-L / 2, -Wd - 1.5 * K, L, Wd * 2 + 3 * K);
      c.fillStyle = '#4a4d54'; c.fillRect(-L / 2, -Wd + 0.4 * K, L, Wd * 2 - 0.8 * K);
      c.fillStyle = '#d8d3c4'; c.fillRect(-L / 2, -Wd - 1.5 * K, L, 1.2 * K); c.fillRect(-L / 2, Wd + 0.3 * K, L, 1.2 * K);
      c.restore();
    }
  }
}
function drawPlain(c, sx, sy, x, y) {
  const n = 2 + Math.floor(hash(x, y, 31) * 3);
  c.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const px = sx + 2 + hash(x + i, y, 32) * (TS - 4), py = sy + 5 + hash(x, y + i, 33) * (TS - 7);
    c.strokeStyle = `rgba(${60 + hash(x, y, 34 + i) * 40 | 0},${110 + hash(x, y, 35 + i) * 30 | 0},50,0.4)`;
    c.beginPath(); c.moveTo(px, py); c.quadraticCurveTo(px + 1, py - 2.5, px + 2.5, py - 4.5); c.stroke();
  }
  if (hash(x, y, 36) > 0.86) { c.fillStyle = 'rgba(230,220,120,0.5)'; c.beginPath(); c.arc(sx + 4 + hash(x, y, 37) * 16, sy + 4 + hash(x, y, 38) * 16, 1.2, 0, Math.PI * 2); c.fill(); }
}
function drawForest(c, sx, sy, x, y) {
  const n = 3 + Math.floor(hash(x, y, 41) * 3);
  for (let i = 0; i < n; i++) {
    const px = sx + 4 + hash(x * 9 + i, y * 7, 42) * (TS - 8), py = sy + 4 + hash(x * 11 + i, y * 5, 43) * (TS - 8);
    const r = 3.4 + hash(x * 3 + i, y * 4, 44) * 2.6;
    c.fillStyle = 'rgba(8,26,12,0.5)'; c.beginPath(); c.arc(px + 1.5, py + 2, r, 0, Math.PI * 2); c.fill();
    const g = c.createRadialGradient(px - r * 0.3, py - r * 0.4, r * 0.1, px, py, r);
    g.addColorStop(0, `rgb(${110 + hash(x, y + i, 45) * 30 | 0},${170 + hash(x + i, y, 46) * 30 | 0},90)`);
    g.addColorStop(1, `rgb(${28 + hash(x, y + i, 47) * 14 | 0},${72 + hash(x + i, y, 48) * 24 | 0},36)`);
    c.fillStyle = g; c.beginPath(); c.arc(px, py, r, 0, Math.PI * 2); c.fill();
  }
}
function drawHill(c, sx, sy, x, y) {
  const n = 1 + Math.floor(hash(x, y, 51) * 2);
  for (let i = 0; i < n; i++) {
    const px = sx + 5 + hash(x + i, y, 52) * (TS - 10), py = sy + 9 + hash(x, y + i, 53) * (TS - 12);
    const w = 10 + hash(x, y, 54) * 7, hh = w * 0.42;
    c.fillStyle = 'rgba(60,70,36,0.4)'; c.beginPath(); c.ellipse(px + 1.5, py + 2, w / 2, hh / 2, 0, 0, Math.PI * 2); c.fill();
    const g = c.createLinearGradient(px - w / 2, py - hh / 2, px + w / 2, py + hh / 2);
    g.addColorStop(0, 'rgba(196,200,130,0.95)'); g.addColorStop(1, 'rgba(110,120,62,0.95)');
    c.fillStyle = g; c.beginPath(); c.ellipse(px, py, w / 2, hh / 2, 0, Math.PI, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(96,104,54,0.7)'; c.beginPath(); c.ellipse(px, py, w / 2, hh / 2, 0, 0, Math.PI); c.fill();
  }
}
function drawMountain(c, sx, sy, x, y, peak) {
  const p1 = sx + TS * (0.3 + (hash(x, y, 61) - 0.5) * 0.14), p2 = sx + TS * (0.7 + (hash(x, y, 62) - 0.5) * 0.14);
  const apex = (p1 + p2) / 2 + (hash(x, y, 63) - 0.5) * 4;
  const top = sy + TS * (peak ? 0.04 : 0.18);
  c.fillStyle = 'rgba(0,0,0,0.25)';
  c.beginPath(); c.moveTo(sx + 2, sy + TS + 2); c.lineTo(apex + 2, top + 3); c.lineTo(sx + TS + 3, sy + TS + 2); c.closePath(); c.fill();
  const g = c.createLinearGradient(sx, top, sx, sy + TS);
  g.addColorStop(0, peak ? '#e6e9ee' : '#a39c93'); g.addColorStop(1, peak ? '#5f636d' : '#4e4a45');
  c.fillStyle = g;
  c.beginPath(); c.moveTo(sx - 1, sy + TS); c.lineTo(p1, top + 5); c.lineTo(apex, top); c.lineTo(p2, top + 7); c.lineTo(sx + TS + 1, sy + TS); c.closePath(); c.fill();
  c.fillStyle = 'rgba(0,0,0,0.3)';
  c.beginPath(); c.moveTo(apex, top); c.lineTo(p2, top + 7); c.lineTo(sx + TS + 1, sy + TS); c.lineTo(apex + 1.5, sy + TS); c.closePath(); c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.18)'; c.lineWidth = 1; c.beginPath(); c.moveTo(apex, top); c.lineTo(apex - 3, sy + TS * 0.7); c.stroke();
  if (peak || hash(x, y, 64) > 0.6) {
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.beginPath(); c.moveTo(apex, top); c.lineTo(apex - 4.5, top + 7); c.lineTo(apex - 1, top + 6); c.lineTo(apex + 2, top + 8); c.lineTo(apex + 4.5, top + 7.5); c.closePath(); c.fill();
  }
}

/* ================================================================== 영토 레이어 */
function buildTerritory(g) {
  const w = g.map.w, h = g.map.h, terr = g.terr;
  if (!terrCv) { terrCv = document.createElement('canvas'); terrCv.width = w * TS; terrCv.height = h * TS; }
  const c = terrCv.getContext('2d');
  c.clearRect(0, 0, terrCv.width, terrCv.height);
  const cols = g.nations.map((n) => n.color);
  const own = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : terr[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = terr[y * w + x];
      if (o < 0) continue;
      const [r, gg, b] = hexToRgb(cols[o]);
      c.fillStyle = `rgba(${r},${gg},${b},0.22)`;
      c.fillRect(x * TS, y * TS, TS + 0.5, TS + 0.5);
    }
  }
  // 지방(도시 관할 구역) 경계: 옅은 점선. 국경은 아래에서 굵게 덮는다
  const prov = g.map.prov;
  if (prov) {
    const pv = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -2 : prov[y * w + x]);
    c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = 1; c.setLineDash([3, 3]);
    c.beginPath();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = prov[y * w + x];
      if (p < 0) continue;
      const sx = x * TS, sy = y * TS;
      const r = pv(x + 1, y), d = pv(x, y + 1);
      if (r >= 0 && r !== p) { c.moveTo(sx + TS, sy); c.lineTo(sx + TS, sy + TS); }
      if (d >= 0 && d !== p) { c.moveTo(sx, sy + TS); c.lineTo(sx + TS, sy + TS); }
    }
    c.stroke(); c.setLineDash([]);
  }
  // 국경 글로우 + 선
  c.lineCap = 'square';
  for (const pass of [0, 1]) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = terr[y * w + x];
        if (o < 0) continue;
        const sx = x * TS, sy = y * TS;
        const [r, gg, b] = hexToRgb(cols[o]);
        c.strokeStyle = pass === 0 ? `rgba(${r},${gg},${b},0.35)` : cols[o];
        c.lineWidth = pass === 0 ? 9 : 2.5;
        const in0 = pass === 0 ? 4.5 : 1.5;
        c.beginPath();
        if (own(x + 1, y) !== o) { c.moveTo(sx + TS - in0, sy); c.lineTo(sx + TS - in0, sy + TS); }
        if (own(x - 1, y) !== o) { c.moveTo(sx + in0, sy); c.lineTo(sx + in0, sy + TS); }
        if (own(x, y + 1) !== o) { c.moveTo(sx, sy + TS - in0); c.lineTo(sx + TS, sy + TS - in0); }
        if (own(x, y - 1) !== o) { c.moveTo(sx, sy + in0); c.lineTo(sx + TS, sy + in0); }
        c.stroke();
      }
    }
  }
}

/* ================================================================== 구름 */
function buildClouds() {
  const S = 512;
  cloudCv = document.createElement('canvas'); cloudCv.width = S; cloudCv.height = S;
  const c = cloudCv.getContext('2d');
  for (let i = 0; i < 70; i++) {
    const x = hash(i, 1, 91) * S, y = hash(i, 2, 92) * S, r = 30 + hash(i, 3, 93) * 70;
    for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
      const g = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(0.6, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x + ox, y + oy, r, 0, Math.PI * 2); c.fill();
    }
  }
}
function drawClouds(now) {
  if (!cloudCv) buildClouds();
  const z = HG.camera.zoom;
  const scale = z / 6; // 구름 한 장 = 약 85타일
  const size = 512 * scale;
  const t = now / 1000;
  const offX = ((-HG.camera.x * z + t * 6) % size + size) % size;
  const offY = ((-HG.camera.y * z + t * 2) % size + size) % size;
  const W = window.innerWidth, H = window.innerHeight;
  // 그림자(살짝 어긋나게) → 하이라이트
  for (const [alpha, dx, dy, op] of [[0.16, 10, 12, 'multiply'], [0.09, 0, 0, 'screen']]) {
    ctx.globalAlpha = alpha; ctx.globalCompositeOperation = op;
    for (let x = offX - size; x < W + size; x += size) for (let y = offY - size; y < H + size; y += size) ctx.drawImage(cloudCv, x + dx, y + dy, size, size);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}

/* ================================================================== 미니맵 */
function buildMini(g) {
  const w = g.map.w, h = g.map.h, S = 2;
  if (!miniCv) miniCv = document.createElement('canvas');
  miniCv.width = w * S; miniCv.height = h * S;
  const c = miniCv.getContext('2d');
  const img = c.createImageData(w * S, h * S);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = g.map.tiles[y * w + x];
      let col = COL[t] || COL.plain;
      const o = g.terr[y * w + x];
      if (o >= 0) { const nc = hexToRgb(g.nations[o].color); col = [col[0] * 0.4 + nc[0] * 0.6, col[1] * 0.4 + nc[1] * 0.6, col[2] * 0.4 + nc[2] * 0.6]; }
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const p = ((y * S + sy) * w * S + x * S + sx) * 4;
        img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = 255;
      }
    }
  }
  c.putImageData(img, 0, 0);
}

/* ================================================================== 부대 보간 / 이펙트 */
const unitDisp = new Map(); // id → {x,y,ang,trail:[],smoke}
HG.unitPos = (id, u) => {
  let d = unitDisp.get(id);
  if (!d) { d = { x: u.x, y: u.y, ang: 0, trail: [], lastS: u.s }; unitDisp.set(id, d); }
  return d;
};
function stepUnits(g, dt, now) {
  for (const [id, u] of Object.entries(g.units)) {
    const d = HG.unitPos(id, u);
    // 항공기는 목표 없이 떠 있을 때 상공을 선회한다 (서버 위치 주변 시각 효과)
    let ux = u.x, uy = u.y;
    if (u.t === 'air' && !u.g) {
      const ph = now / 1800 + hash(id.length, u.o, 9) * 10;
      ux += Math.cos(ph) * 0.9; uy += Math.sin(ph) * 0.9;
    }
    const dx = ux - d.x, dy = uy - d.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 8) { d.x = ux; d.y = uy; d.trail.length = 0; continue; }
    const k = Math.min(1, dt * (u.t === 'air' ? 3.5 : 2.2));
    if (dist > 0.02) {
      d.ang += ((Math.atan2(dy, dx) - d.ang + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 6);
      d.x += dx * k; d.y += dy * k;
      if (!d.trail.length || Math.hypot(d.trail[d.trail.length - 1].x - d.x, d.trail[d.trail.length - 1].y - d.y) > 0.25) d.trail.push({ x: d.x, y: d.y, t: now });
    }
    while (d.trail.length && now - d.trail[0].t > 1400) d.trail.shift();
    // 피격 불꽃: 병력이 줄었을 때
    if (u.s < d.lastS - 0.5) for (let i = 0; i < 3; i++) particles.push({ kind: 'dot', x: d.x + (Math.random() - 0.5) * 0.5, y: d.y + (Math.random() - 0.5) * 0.5, vx: (Math.random() - 0.5) * 2, vy: -Math.random() * 2, t: 0, life: 0.4, col: '#ffd27a', r: 0.05 });
    d.lastS = u.s;
    // 손상 연기
    if (u.s < 45 && Math.random() < dt * (u.s < 25 ? 6 : 2.5)) particles.push({ kind: 'smoke', x: d.x + (Math.random() - 0.5) * 0.3, y: d.y - 0.2, t: 0, life: 1.4, small: true });
  }
  for (const id of unitDisp.keys()) if (!g.units[id]) unitDisp.delete(id);
}

const seenFx = new Set();
const particles = [];
function spawnFx(id, f) {
  if (seenFx.has(id)) return;
  seenFx.add(id);
  const col = f.c !== undefined && f.c >= 0 ? HG.colorOf(f.c) : '#fff';
  if (f.k === 'boom') {
    particles.push({ kind: 'flash', x: f.x, y: f.y, t: 0, life: 0.25 });
    particles.push({ kind: 'ring', x: f.x, y: f.y, t: 0, life: 0.7, col: '#ffc46b', w: 3 });
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 4;
      particles.push({ kind: 'dot', x: f.x, y: f.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1, t: 0, life: 0.5 + Math.random() * 0.8, col: Math.random() < 0.5 ? '#ffd27a' : '#ff6b3d', r: 0.06 + Math.random() * 0.12, g: 3 });
    }
    for (let i = 0; i < 5; i++) particles.push({ kind: 'smoke', x: f.x + (Math.random() - 0.5) * 0.6, y: f.y, t: -i * 0.12, life: 2.2 });
  } else if (f.k === 'cap') {
    particles.push({ kind: 'ring', x: f.x, y: f.y, t: 0, life: 1.8, col, big: true, w: 4 });
    particles.push({ kind: 'ring', x: f.x, y: f.y, t: -0.5, life: 1.8, col, big: true, w: 2 });
    for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; particles.push({ kind: 'dot', x: f.x, y: f.y, vx: Math.cos(a) * 3, vy: Math.sin(a) * 3, t: 0, life: 1.2, col, r: 0.09, g: 0 }); }
  } else if (f.k === 'build') {
    for (let i = 0; i < 10; i++) particles.push({ kind: 'dot', x: f.x + (Math.random() - 0.5) * 0.9, y: f.y + 0.3, vx: (Math.random() - 0.5) * 0.5, vy: -0.8 - Math.random() * 1.2, t: 0, life: 1.1, col: '#ffe9a8', r: 0.06, g: 0 });
  } else if (f.k === 'spawn') {
    particles.push({ kind: 'ring', x: f.x, y: f.y, t: 0, life: 0.9, col, w: 2 });
  } else if (f.k === 'wonder') {
    particles.push({ kind: 'flash', x: f.x, y: f.y, t: 0, life: 0.8, big: 2 });
    for (let k = 0; k < 3; k++) particles.push({ kind: 'ring', x: f.x, y: f.y, t: -k * 0.35, life: 2.2, col: '#ffd700', big: true, w: 3 });
    for (let i = 0; i < 40; i++) { const a = Math.random() * Math.PI * 2, sp = 0.8 + Math.random() * 3; particles.push({ kind: 'dot', x: f.x, y: f.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2.5, t: 0, life: 1.4 + Math.random() * 1.2, col: Math.random() < 0.5 ? '#ffe9a8' : '#ffd700', r: 0.07 + Math.random() * 0.1, g: 2 }); }
  } else if (f.k === 'nuke') {
    particles.push({ kind: 'flash', x: f.x, y: f.y, t: 0, life: 1.2, big: 4 });
    for (let k = 0; k < 3; k++) particles.push({ kind: 'ring', x: f.x, y: f.y, t: -k * 0.3, life: 2.5, col: '#ffd27a', big: true, w: 5 });
    for (let i = 0; i < 60; i++) { const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 6; particles.push({ kind: 'dot', x: f.x, y: f.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, t: 0, life: 1 + Math.random() * 1.5, col: Math.random() < 0.5 ? '#fff1c2' : '#ff8c42', r: 0.1 + Math.random() * 0.2, g: 2 }); }
    for (let i = 0; i < 14; i++) particles.push({ kind: 'smoke', x: f.x + (Math.random() - 0.5) * 1.5, y: f.y, t: -i * 0.15, life: 5, huge: true });
  }
}
HG.flashOrder = (x, y) => { particles.push({ kind: 'ring', x, y, t: 0, life: 0.7, col: '#5eead4', w: 2 }); particles.push({ kind: 'ring', x, y, t: -0.2, life: 0.7, col: '#5eead4', w: 1 }); };

function drawParticles(dt) {
  const z = HG.camera.zoom;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt;
    if (p.t >= p.life) { particles.splice(i, 1); continue; }
    if (p.t < 0) continue;
    const k = p.t / p.life;
    const s = HG.tileToScreen(p.x, p.y);
    if (p.kind === 'ring') {
      ctx.strokeStyle = p.col; ctx.globalAlpha = 1 - k; ctx.lineWidth = p.w || 2;
      ctx.beginPath(); ctx.arc(s.x, s.y, (p.big ? 0.4 + k * 2.4 : 0.2 + k * 1.3) * z, 0, Math.PI * 2); ctx.stroke();
    } else if (p.kind === 'flash') {
      const R = z * 1.4 * (p.big || 1);
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, R);
      g.addColorStop(0, `rgba(255,240,200,${0.9 * (1 - k)})`); g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === 'dot') {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += (p.g === undefined ? 1.2 : p.g) * dt; p.vx *= 0.97;
      ctx.fillStyle = p.col; ctx.globalAlpha = 1 - k;
      ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(1, p.r * z), 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === 'smoke') {
      const r = (p.small ? 0.15 + k * 0.4 : p.huge ? 0.8 + k * 2.6 : 0.35 + k * 1.1) * z;
      ctx.fillStyle = p.small ? '#2a2a2a' : p.huge ? '#4a4036' : '#3a3a3a'; ctx.globalAlpha = (p.small ? 0.4 : 0.55) * (1 - k);
      ctx.beginPath(); ctx.arc(s.x + Math.sin(p.t * 3) * z * 0.1, s.y - k * z * (p.small ? 0.6 : p.huge ? 2.5 : 1.0), r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

/* ================================================================== 메인 */
let lastFrame = performance.now();
let centered = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const S = HG.S;
  if (!S || S.phase === 'lobby' || !S.game || document.getElementById('screen-game').classList.contains('hidden')) { centered = false; HG.cameraReady = false; return; }
  const g = S.game;
  const key = g.map.w + 'x' + g.map.h + ':' + (g.map.seed || 0) + ':' + S.roomId; // 같은 방에서 새 판이 열리면(시드 변경) 지형을 다시 그린다
  if (terrainKey !== key || !terrainCv) { terrainCv = buildTerrain(g.map); terrainKey = key; terrCv = null; HG.terrDirty = true; }
  if (HG.terrDirty) { buildTerritory(g); buildMini(g); HG.terrDirty = false; }
  if (!centered) {
    if (!(HG.restoreCamera && HG.restoreCamera(S.roomId, g.t))) {
      const me = HG.myNation();
      const cap = me && g.cities.find((c) => c.id === me.capital);
      if (cap) { HG.camera.x = cap.x; HG.camera.y = cap.y; } else { HG.camera.x = g.map.w / 2; HG.camera.y = g.map.h / 2; }
      HG.camera.zoom = Math.max(12, Math.min(24, window.innerWidth / g.map.w * 1.6));
    }
    centered = true;
    HG.cameraReady = true; // 이 전엔 카메라를 저장하지 않는다 (탭이 숨겨져 첫 프레임이 늦으면 (0,0) 이 저장되던 문제)
  }
  HG.camera.x = Math.max(-5, Math.min(g.map.w + 5, HG.camera.x));
  HG.camera.y = Math.max(-5, Math.min(g.map.h + 5, HG.camera.y));

  stepUnits(g, dt, now);
  for (const [id, f] of Object.entries(g.fx || {})) spawnFx(id, f);

  const W = window.innerWidth, H = window.innerHeight, z = HG.camera.zoom;
  ctx.fillStyle = '#0d1f33'; // 지도 밖은 먼바다 색 (수도가 모서리에 있어도 검게 비지 않게)
  ctx.fillRect(0, 0, W, H);

  const tl = HG.screenToTile(0, 0), br = HG.screenToTile(W, H);
  const x0 = Math.max(0, Math.floor(tl.x - 0.5)), y0 = Math.max(0, Math.floor(tl.y - 0.5));
  const x1 = Math.min(g.map.w, Math.ceil(br.x + 0.5)), y1 = Math.min(g.map.h, Math.ceil(br.y + 0.5));
  if (x1 > x0 && y1 > y0) {
    const s0 = HG.tileToScreen(x0 - 0.5, y0 - 0.5);
    const dw = (x1 - x0) * z, dh = (y1 - y0) * z;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = z < TS ? 'high' : 'low';
    ctx.drawImage(terrainCv, x0 * TS, y0 * TS, (x1 - x0) * TS, (y1 - y0) * TS, s0.x, s0.y, dw, dh);
    ctx.drawImage(terrCv, x0 * TS, y0 * TS, (x1 - x0) * TS, (y1 - y0) * TS, s0.x, s0.y, dw, dh);
  }
  drawClouds(now);
  if (z >= 30) drawGrid(g, x0, y0, x1, y1);

  drawTrails(g);
  drawCities(g, now);
  drawUnits(g, now);
  drawParticles(dt);
  drawSelection(g, now);

  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.4, W / 2, H / 2, Math.max(W, H) * 0.8);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  drawMinimap(g);
}

function drawGrid(g, x0, y0, x1, y1) {
  const z = HG.camera.zoom;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= x1; x++) { const s = HG.tileToScreen(x - 0.5, y0 - 0.5); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y + (y1 - y0) * z); }
  for (let y = y0; y <= y1; y++) { const s = HG.tileToScreen(x0 - 0.5, y - 0.5); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + (x1 - x0) * z, s.y); }
  ctx.stroke();
}

function drawTrails(g) {
  const z = HG.camera.zoom;
  if (z < 10) return;
  ctx.lineCap = 'round';
  for (const [id, u] of Object.entries(g.units)) {
    const d = unitDisp.get(id);
    if (!d || d.trail.length < 2) continue;
    const col = HG.colorOf(u.o);
    for (let i = 1; i < d.trail.length; i++) {
      const a = HG.tileToScreen(d.trail[i - 1].x, d.trail[i - 1].y), b = HG.tileToScreen(d.trail[i].x, d.trail[i].y);
      ctx.strokeStyle = col; ctx.globalAlpha = (i / d.trail.length) * 0.35; ctx.lineWidth = Math.max(1, z * (u.t === 'air' ? 0.08 : 0.16));
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawCities(g, now) {
  const z = HG.camera.zoom;
  const wonderByCity = {};
  for (const p of Object.values(g.projects || {})) if (p.d && p.c !== null && p.c !== undefined) wonderByCity[p.c] = (wonderByCity[p.c] || '') + (HG.C.PROJECTS[p.id] || {}).icon;
  ctx.textAlign = 'center';
  for (const c of g.cities) {
    const s = HG.tileToScreen(c.x, c.y);
    if (s.x < -80 || s.y < -80 || s.x > window.innerWidth + 80 || s.y > window.innerHeight + 80) continue;
    const n = HG.nationByIdx(c.o);
    const col = n ? n.color : '#9aa3b2';
    const R = (0.55 + c.size * 0.13) * z;
    // 영향권
    ctx.strokeStyle = col; ctx.globalAlpha = 0.3; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.arc(s.x, s.y, R + 6, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // 바닥 (그라데이션 디스크)
    const bg = ctx.createRadialGradient(s.x, s.y, R * 0.2, s.x, s.y, R);
    bg.addColorStop(0, 'rgba(30,36,50,0.9)'); bg.addColorStop(1, 'rgba(8,10,16,0.85)');
    ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, Math.PI * 2); ctx.stroke();
    // 스카이라인 (깊이감: 뒤쪽 어둡게, 앞쪽 밝게)
    const levels = Object.values(c.b).reduce((a, b) => a + b, 0);
    const nB = Math.min(9, 3 + c.size + Math.floor(levels / 2));
    const bw = (R * 1.55) / nB;
    for (let row = 1; row >= 0; row--) {
      for (let i = 0; i < nB; i++) {
        const hh = R * (0.3 + hash(i + row * 11, c.x + c.y, 77) * 0.8 + (levels > 8 ? 0.25 : 0)) * (row ? 0.8 : 1);
        const bx = s.x - R * 0.77 + i * bw + (row ? bw * 0.5 : 0);
        const by = s.y + R * (row ? 0.25 : 0.45);
        const shade = row ? 110 : 185;
        ctx.fillStyle = `rgba(${shade},${shade + 8},${shade + 24},0.95)`;
        ctx.fillRect(bx + bw * 0.1, by - hh, bw * 0.8, hh);
        ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(bx + bw * 0.1, by - hh, bw * 0.8, 1.5);
        if (z > 15) {
          ctx.fillStyle = `rgba(255,220,140,${0.6 + 0.4 * Math.sin(now / 900 + i)})`;
          for (let wy = 2; wy < hh - 2; wy += 3.5) if (hash(i + wy, c.y + row, 79) > 0.45) ctx.fillRect(bx + bw * 0.3, by - hh + wy, 1.6, 1.6);
        }
      }
    }
    // 불가사의 표식 (완성한 국가 프로젝트가 있는 도시)
    if (wonderByCity[c.id]) {
      const icons = wonderByCity[c.id];
      const pulse = 0.6 + 0.4 * Math.sin(now / 500);
      ctx.strokeStyle = `rgba(255,215,0,${0.35 + 0.3 * pulse})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(s.x, s.y, R + 10 + pulse * 2, 0, Math.PI * 2); ctx.stroke();
      if (z > 10) { ctx.font = `${Math.max(12, z * 0.6)}px sans-serif`; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(icons, s.x, s.y - R - 14 - z * 0.3); ctx.textBaseline = 'alphabetic'; }
    }
    // 저항/피폭 표시
    if (c.unrest > 0) {
      ctx.strokeStyle = 'rgba(255,120,60,0.8)'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.lineDashOffset = now / 60;
      ctx.beginPath(); ctx.arc(s.x, s.y, R + 3, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    // 포위 중 화염
    if (c.cap || (c.hp < c.maxHp * 0.6 && c.hp < c.maxHp)) {
      for (let i = 0; i < 2; i++) {
        const fx = s.x + (hash(i, Math.floor(now / 150), 5) - 0.5) * R * 1.2, fy = s.y - hash(i, Math.floor(now / 170), 6) * R * 0.6;
        const fg = ctx.createRadialGradient(fx, fy, 0, fx, fy, R * 0.35);
        fg.addColorStop(0, 'rgba(255,200,80,0.8)'); fg.addColorStop(1, 'rgba(255,60,0,0)');
        ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(fx, fy, R * 0.35, 0, Math.PI * 2); ctx.fill();
      }
    }
    // 수도 별
    if (n && n.capital === c.id) {
      ctx.fillStyle = '#ffd166'; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) { const r = i % 2 ? 2.5 : 5.5, a = -Math.PI / 2 + (i * Math.PI) / 5; ctx.lineTo(s.x + Math.cos(a) * r, s.y - R - 8 + Math.sin(a) * r); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // 이름
    if (z > 9) {
      const fs = Math.max(10, Math.min(15, z * 0.55));
      ctx.font = `${c.size === 3 ? 700 : 500} ${fs}px ${FONT()}`;
      const tw = ctx.measureText(c.name).width + 10;
      ctx.fillStyle = 'rgba(6,8,14,0.65)'; ctx.beginPath(); ctx.roundRect(s.x - tw / 2, s.y + R + 4, tw, fs + 6, 4); ctx.fill();
      ctx.fillStyle = '#eef2ff'; ctx.fillText(c.name, s.x, s.y + R + 4 + fs);
    }
    // 체력
    if (c.hp < c.maxHp || c.cap) {
      const bw2 = R * 2, bh = 4;
      ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.beginPath(); ctx.roundRect(s.x - R, s.y - R - 11, bw2, bh, 2); ctx.fill();
      const ratio = Math.max(0, c.hp / c.maxHp);
      ctx.fillStyle = ratio > 0.5 ? '#4ade80' : ratio > 0.2 ? '#fbbf24' : '#f87171';
      ctx.beginPath(); ctx.roundRect(s.x - R, s.y - R - 11, bw2 * ratio, bh, 2); ctx.fill();
    }
    if (c.cap) {
      ctx.strokeStyle = HG.colorOf(c.cap.by); ctx.lineWidth = 4; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(s.x, s.y, R + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (c.cap.p / 100)); ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }
}

// 교전 중 부대의 가장 가까운 적 (예광탄 방향용)
function nearestEnemy(g, id, u, range) {
  const p = HG.unitPos(id, u);
  let best = null, bd = Infinity;
  for (const [vid, v] of Object.entries(g.units)) {
    if (v.o === u.o) continue;
    const q = HG.unitPos(vid, v);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= range + 0.8 && d < bd) { bd = d; best = q; }
  }
  return best;
}

// 편대 배치 (부대 중심 기준, 타일 단위). 선두가 진행 방향 앞.
const FORMATION = [[0.25, 0], [-0.1, 0.32], [-0.1, -0.32], [-0.45, 0.62], [-0.45, -0.62], [-0.5, 0]];
const FORMATION_WIDE = [[0.3, 0], [0.05, 0.5], [0.05, -0.5], [-0.3, 0.95], [-0.3, -0.95], [-0.4, 0]];
function unitRangeOf(u, n) {
  const U = HG.C.UNITS;
  return U[u.t].range + (u.t === 'arty' ? n.techs.filter((t) => t === 'rocket' || t === 'precision').length : u.t === 'navy' ? n.techs.filter((t) => t === 'missileship').length : 0);
}
// 교전 중인 부대의 사격 대상 (적 부대 → 없으면 사거리 안의 적 도시)
function fireTarget(g, id, u, n) {
  const range = unitRangeOf(u, n);
  const e = nearestEnemy(g, id, u, range);
  if (e) return { x: e.x, y: e.y, unit: true };
  const p = HG.unitPos(id, u);
  for (const c of g.cities) {
    if (c.o === u.o) continue;
    if (Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)) <= range + 0.6 && (c.hp < c.maxHp || c.cap)) return { x: c.x, y: c.y, unit: false };
  }
  return null;
}

// 포탄: 포병·함대는 곡사, 나머지는 예광탄 직사. 클라이언트가 위상으로만 그린다 (서버 데이터 없음)
function drawShots(g, list, now) {
  const z = HG.camera.zoom;
  for (const [id, u] of list) {
    if (!u.f && !(u.t === 'arty' || u.t === 'navy')) continue;
    const n = HG.nationByIdx(u.o);
    const tgt = fireTarget(g, id, u, n);
    if (!tgt) continue;
    const p = HG.unitPos(id, u);
    const s = HG.tileToScreen(p.x, p.y);
    const t = HG.tileToScreen(tgt.x, tgt.y);
    if (Math.max(s.x, t.x) < -60 || Math.max(s.y, t.y) < -60 || Math.min(s.x, t.x) > window.innerWidth + 60 || Math.min(s.y, t.y) > window.innerHeight + 60) continue;
    const arc = u.t === 'arty' || u.t === 'navy';
    const shots = arc ? 2 : 3;
    for (let i = 0; i < shots; i++) {
      const phase = ((now / (arc ? 900 : 260)) + hash(id.length + i, u.o, 3) * 10 + i / shots) % 1;
      if (arc) {
        const k = phase;
        const hgt = Math.sin(k * Math.PI) * z * (u.t === 'navy' ? 1.6 : 2.2);
        const x = s.x + (t.x - s.x) * k, y = s.y + (t.y - s.y) * k - hgt;
        ctx.fillStyle = '#ffe3a8'; ctx.beginPath(); ctx.arc(x, y, Math.max(1.5, z * 0.07), 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,200,120,0.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - (t.x - s.x) * 0.06, y + hgt * 0.12); ctx.stroke();
        if (k > 0.93) {
          const fg = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, z * 0.7);
          fg.addColorStop(0, 'rgba(255,230,160,0.9)'); fg.addColorStop(0.4, 'rgba(255,120,40,0.5)'); fg.addColorStop(1, 'rgba(60,30,10,0)');
          ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(t.x + (hash(i, Math.floor(now / 900), 4) - 0.5) * z * 0.8, t.y + (hash(i, Math.floor(now / 900), 5) - 0.5) * z * 0.6, z * 0.7, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        if (!u.f) continue;
        const k0 = phase, k1 = Math.min(1, phase + 0.18);
        const jx = (hash(i, Math.floor(now / 260) + i, 6) - 0.5) * z * 0.5, jy = (hash(i, Math.floor(now / 260) + i, 7) - 0.5) * z * 0.5;
        ctx.strokeStyle = u.t === 'air' ? 'rgba(255,120,120,0.9)' : 'rgba(255,240,180,0.9)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(s.x + (t.x + jx - s.x) * k0, s.y + (t.y + jy - s.y) * k0); ctx.lineTo(s.x + (t.x + jx - s.x) * k1, s.y + (t.y + jy - s.y) * k1); ctx.stroke();
        if (phase > 0.8) { ctx.fillStyle = 'rgba(255,200,120,0.85)'; ctx.beginPath(); ctx.arc(t.x + jx, t.y + jy, 2.5, 0, Math.PI * 2); ctx.fill(); }
      }
    }
  }
}

function drawUnits(g, now) {
  const z = HG.camera.zoom;
  const me = HG.myNation();
  const pulse = 0.5 + 0.5 * Math.sin(now / 120);
  const list = Object.entries(g.units).sort((a, b) => (a[1].t === 'air') - (b[1].t === 'air') || a[1].y - b[1].y);
  const detail = z >= 13; // 확대 시 편대 미니 스프라이트, 축소 시 배지만
  drawShots(g, list, now);
  for (const [id, u] of list) {
    const p = HG.unitPos(id, u);
    const s = HG.tileToScreen(p.x, p.y);
    if (s.x < -80 || s.y < -80 || s.x > window.innerWidth + 80 || s.y > window.innerHeight + 80) continue;
    const col = HG.colorOf(u.o);
    const [cr, cg, cb] = hexToRgb(col);
    const light = `rgb(${clamp(cr + 60)},${clamp(cg + 60)},${clamp(cb + 60)})`, dark = `rgb(${clamp(cr - 50)},${clamp(cg - 50)},${clamp(cb - 50)})`;
    const sel = HG.selected && HG.selected.kind === 'unit' && HG.selected.id === id;
    const n = HG.nationByIdx(u.o);
    const air = u.t === 'air';
    const d = unitDisp.get(id);
    const moving = !!(d && d.trail.length > 1 && now - d.trail[d.trail.length - 1].t < 700);
    const tgt = (u.f || u.t === 'arty' || u.t === 'navy') ? fireTarget(g, id, u, n) : null;
    const facing = tgt ? Math.atan2(tgt.y - p.y, tgt.x - p.x) : (d ? d.ang : 0);
    if (u.f) {
      const gg = ctx.createRadialGradient(s.x, s.y, z * 0.2, s.x, s.y, z * 1.1);
      gg.addColorStop(0, `rgba(255,140,60,${0.18 + pulse * 0.2})`); gg.addColorStop(1, 'rgba(255,100,40,0)');
      ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(s.x, s.y, z * 1.1, 0, Math.PI * 2); ctx.fill();
    }
    const badgeSize = detail ? Math.max(12, Math.min(22, z * 0.6)) : Math.max(14, Math.min(36, z * 1.1));
    let badgeY = s.y;
    if (detail) {
      // ---- 편대: 병력에 따라 2~6개 미니 스프라이트
      const count = u.s > 85 ? 6 : u.s > 65 ? 5 : u.s > 45 ? 4 : u.s > 20 ? 3 : 2;
      const m = z * (air ? 0.26 : u.t === 'navy' ? 0.3 : u.t === 'inf' ? 0.24 : 0.27);
      const form = (u.f && !air) ? FORMATION_WIDE : FORMATION;
      const cosF = Math.cos(facing), sinF = Math.sin(facing);
      const anim = { col, light, dark, moving, firing: !!tgt, phase: 0 };
      // 그림자/항적/항공 그림자
      for (let i = 0; i < count; i++) {
        const [fx, fy] = form[i];
        const ox = (fx * cosF - fy * sinF) * z, oy = (fx * sinF + fy * cosF) * z;
        const x = s.x + ox, y = s.y + oy;
        if (air) {
          ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.ellipse(x + z * 0.35, y + z * 0.55, m * 0.9, m * 0.45, facing, 0, Math.PI * 2); ctx.fill();
          // 비행운
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = Math.max(1, m * 0.12);
          ctx.beginPath(); ctx.moveTo(x - cosF * m * 1.1, y - sinF * m * 1.1); ctx.lineTo(x - cosF * m * 3.2, y - sinF * m * 3.2); ctx.stroke();
        } else if (u.t === 'navy') {
          // 항적
          ctx.strokeStyle = 'rgba(230,245,255,0.45)'; ctx.lineWidth = Math.max(1, m * 0.15);
          const wl = moving ? m * 3.5 : m * 1.5;
          ctx.beginPath(); ctx.moveTo(x - cosF * m * 1.1, y - sinF * m * 1.1); ctx.lineTo(x - cosF * wl - sinF * m * 0.5, y - sinF * wl + cosF * m * 0.5);
          ctx.moveTo(x - cosF * m * 1.1, y - sinF * m * 1.1); ctx.lineTo(x - cosF * wl + sinF * m * 0.5, y - sinF * wl - cosF * m * 0.5); ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(x + m * 0.15, y + m * 0.45, m * 0.8, m * 0.4, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      for (let i = 0; i < count; i++) {
        const [fx, fy] = form[i];
        const ox = (fx * cosF - fy * sinF) * z, oy = (fx * sinF + fy * cosF) * z;
        let x = s.x + ox, y = s.y + oy;
        anim.phase = now / 1000 + i * 0.37 + hash(id.length, i, 2) * 3;
        if (air) y -= z * 0.5 + Math.sin(anim.phase * 1.3) * m * 0.3;
        else if (u.t === 'navy') y += Math.sin(anim.phase * 1.6) * m * 0.08;
        ctx.save(); ctx.translate(x, y);
        ICONS.mini[u.t](ctx, m, facing, anim);
        ctx.restore();
        // 총구 섬광
        if (tgt && (Math.sin(anim.phase * (u.t === 'arty' || u.t === 'navy' ? 7 : 20)) > 0.92)) {
          const bl = u.t === 'inf' ? m * 0.8 : m * 1.1;
          const bx = x + cosF * bl, by = y + sinF * bl;
          const fg = ctx.createRadialGradient(bx, by, 0, bx, by, m * 0.6);
          fg.addColorStop(0, 'rgba(255,245,200,1)'); fg.addColorStop(0.5, 'rgba(255,180,60,0.6)'); fg.addColorStop(1, 'rgba(255,120,0,0)');
          ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(bx, by, m * 0.6, 0, Math.PI * 2); ctx.fill();
        }
      }
      badgeY = s.y - z * (air ? 1.2 : 0.95);
    } else {
      ctx.fillStyle = `rgba(0,0,0,${air ? 0.3 : 0.45})`;
      ctx.beginPath(); ctx.ellipse(s.x + (air ? badgeSize * 0.25 : 0), s.y + badgeSize * (air ? 0.5 : 0.42), badgeSize * 0.5, badgeSize * 0.18, 0, 0, Math.PI * 2); ctx.fill();
      badgeY = s.y + (air ? -badgeSize * 0.45 : 0);
    }
    // ---- 배지 (국가색 칩 + 아이콘 + 병력바)
    const w = badgeSize, h = badgeSize * 0.78;
    ctx.save();
    ctx.translate(s.x, badgeY);
    ctx.globalAlpha = detail ? 0.92 : 1;
    const body = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    body.addColorStop(0, light); body.addColorStop(1, dark);
    ctx.fillStyle = body;
    ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.7)'; ctx.lineWidth = sel ? 2.5 : 1.2;
    ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, 5); ctx.fill(); ctx.stroke();
    if (!detail) {
      const ang = d && d.trail.length > 1 ? d.ang : 0;
      if (air) ctx.rotate(ang + Math.PI / 2);
      else if (d && d.trail.length > 1 && Math.cos(ang) < 0) ctx.scale(-1, 1);
    }
    (ICONS[u.t] || ICONS.inf)(ctx, 0.5, 0.5, w * 0.78, 'rgba(0,0,0,0.6)');
    (ICONS[u.t] || ICONS.inf)(ctx, 0, 0, w * 0.78, '#f6f8ff');
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.beginPath(); ctx.roundRect(s.x - w / 2, badgeY + h / 2 + 2, w, 3.2, 2); ctx.fill();
    const sg = ctx.createLinearGradient(s.x - w / 2, 0, s.x + w / 2, 0);
    const sc = u.s > 60 ? ['#86efac', '#22c55e'] : u.s > 30 ? ['#fde68a', '#f59e0b'] : ['#fca5a5', '#ef4444'];
    sg.addColorStop(0, sc[0]); sg.addColorStop(1, sc[1]);
    ctx.fillStyle = sg; ctx.beginPath(); ctx.roundRect(s.x - w / 2, badgeY + h / 2 + 2, w * (u.s / 100), 3.2, 2); ctx.fill();
    const tier = n && n.tier ? n.tier[u.t] : 1;
    if (tier > 1 && z > 12) {
      ctx.fillStyle = '#ffd166';
      for (let i = 0; i < tier - 1; i++) { ctx.beginPath(); ctx.moveTo(s.x - 5 + i * 5, badgeY - h / 2 - 2); ctx.lineTo(s.x - 2 + i * 5, badgeY - h / 2 - 6); ctx.lineTo(s.x + 1 + i * 5, badgeY - h / 2 - 2); ctx.fill(); }
    }
    if (me && u.o === me.idx && z > 12) {
      ctx.fillStyle = ({ attack: '#f87171', defend: '#60a5fa', expand: '#4ade80', manual: '#fbbf24' })[u.m] || '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(s.x + w / 2 - 2, badgeY - h / 2 + 2, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
}

function drawSelection(g, now) {
  const sel = HG.selected;
  if (!sel) return;
  const z = HG.camera.zoom;
  const pulse = 0.5 + 0.5 * Math.sin(now / 250);
  if (sel.kind === 'unit') {
    const u = g.units[sel.id];
    if (!u) { HG.selected = null; return; }
    const p = HG.unitPos(sel.id, u);
    const s = HG.tileToScreen(p.x, p.y);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.lineDashOffset = -now / 40;
    ctx.beginPath(); ctx.arc(s.x, s.y, Math.max(14, z * 0.9) + pulse * 3, 0, Math.PI * 2); ctx.stroke();
    if (u.g) {
      const t = HG.tileToScreen(u.g[0], u.g[1]);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(t.x, t.y, 5 + pulse * 2, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
  } else if (sel.kind === 'city') {
    const c = g.cities.find((x) => x.id === sel.id);
    if (!c) return;
    const s = HG.tileToScreen(c.x, c.y);
    const R = (0.55 + c.size * 0.13) * z;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.lineDashOffset = -now / 40;
    ctx.beginPath(); ctx.arc(s.x, s.y, R + 12, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // 이 도시의 관할 구역 강조
    const prov = g.map.prov, ci = g.cities.indexOf(c), w = g.map.w, h = g.map.h;
    if (prov && ci >= 0) {
      const tl = HG.screenToTile(0, 0), br = HG.screenToTile(window.innerWidth, window.innerHeight);
      const x0 = Math.max(0, Math.floor(tl.x) - 1), y0 = Math.max(0, Math.floor(tl.y) - 1), x1 = Math.min(w - 1, Math.ceil(br.x) + 1), y1 = Math.min(h - 1, Math.ceil(br.y) + 1);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (prov[y * w + x] !== ci) continue;
        const p = HG.tileToScreen(x - 0.5, y - 0.5);
        ctx.fillRect(p.x, p.y, z, z);
        if (x + 1 >= w || prov[y * w + x + 1] !== ci) { ctx.moveTo(p.x + z, p.y); ctx.lineTo(p.x + z, p.y + z); }
        if (x - 1 < 0 || prov[y * w + x - 1] !== ci) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y + z); }
        if (y + 1 >= h || prov[(y + 1) * w + x] !== ci) { ctx.moveTo(p.x, p.y + z); ctx.lineTo(p.x + z, p.y + z); }
        if (y - 1 < 0 || prov[(y - 1) * w + x] !== ci) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + z, p.y); }
      }
      ctx.stroke();
    }
  } else if (sel.kind === 'tile') {
    const s = HG.tileToScreen(sel.x, sel.y);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(s.x - z / 2, s.y - z / 2, z, z, 3); ctx.stroke();
  }
}

function drawMinimap(g) {
  if (!miniCv) return;
  const r = mini.getBoundingClientRect();
  const want = Math.max(1, Math.round(r.width * dpr)), wantH = Math.max(1, Math.round(r.height * dpr));
  if (mini.width !== want || mini.height !== wantH) { mini.width = want; mini.height = wantH; }
  const mw = mini.width, mh = mini.height;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.clearRect(0, 0, mw, mh);
  mctx.imageSmoothingEnabled = true;
  mctx.drawImage(miniCv, 0, 0, mw, mh);
  const sx = mw / g.map.w, sy = mh / g.map.h;
  for (const c of g.cities) {
    mctx.fillStyle = c.o >= 0 ? '#fff' : '#bbb';
    mctx.beginPath(); mctx.arc(c.x * sx, c.y * sy, c.size >= 3 ? 2.5 : 1.8, 0, Math.PI * 2); mctx.fill();
  }
  for (const [id, u] of Object.entries(g.units)) {
    const p = HG.unitPos(id, u);
    mctx.fillStyle = u.f ? '#ffb347' : HG.colorOf(u.o);
    mctx.fillRect(p.x * sx - 1, p.y * sy - 1, 2.5, 2.5);
  }
  const tl = HG.screenToTile(0, 0), br = HG.screenToTile(window.innerWidth, window.innerHeight);
  mctx.strokeStyle = 'rgba(255,255,255,0.85)'; mctx.lineWidth = 1;
  mctx.strokeRect(tl.x * sx, tl.y * sy, (br.x - tl.x) * sx, (br.y - tl.y) * sy);
}

requestAnimationFrame(frame);
})();
