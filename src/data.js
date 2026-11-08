'use strict';

/**
 * 패권 — 게임 데이터 정의.
 *
 * 지형·병종·건물·기술 트리·주식 종목처럼 "숫자로 된 규칙" 은 전부 여기에 둔다.
 * 클라이언트에도 그대로 내려보내서(publicState.constants) 화면이 같은 값을 쓴다.
 * 모든 수치는 초당(sim sec) 기준이다.
 */

/* ------------------------------------------------------------------ 지형 */
// moveCost: 타일 통과 비용(초/타일 배수). Infinity 는 지상군 통행 불가.
// def: 그 타일 위에서 방어할 때 배수. vision 은 미사용(위성 시대 — 전장 투명).
const TERRAIN = {
  plain:    { id: 'plain',    name: '평원',   moveCost: 1.0,      def: 1.00 },
  road:     { id: 'road',     name: '고속도로', moveCost: 0.45,   def: 0.95 },
  forest:   { id: 'forest',   name: '삼림',   moveCost: 1.7,      def: 1.25 },
  hill:     { id: 'hill',     name: '구릉',   moveCost: 1.6,      def: 1.35 },
  mountain: { id: 'mountain', name: '산악',   moveCost: 3.2,      def: 1.6 },
  peak:     { id: 'peak',     name: '고봉',   moveCost: Infinity, def: 1.0 },
  river:    { id: 'river',    name: '하천',   moveCost: 2.6,      def: 0.75 },
  water:    { id: 'water',    name: '바다',   moveCost: Infinity, def: 1.0 },
  urban:    { id: 'urban',    name: '도시',   moveCost: 0.8,      def: 1.5 },
};

// 자원 타일(지형 위에 얹히는 오버레이). 도시 반경 안에 있어야 채굴할 수 있다.
const RESOURCES = {
  iron: { id: 'iron', name: '철광', building: 'mine' },
  oil:  { id: 'oil',  name: '유전', building: 'oilwell' },
  farm: { id: 'farm', name: '농지', building: 'farm' },
};

/* ------------------------------------------------------------------ 병종 */
// 1부대 = 1개 사단. strength 0~100(%). cost 는 모병비, upkeep 은 초당 유지비.
// atk/def 는 티어 1 기준이고 기술로 티어가 오르면 (1 + 0.25×(tier−1)) 배.
// range 는 체비쇼프 거리. flying 은 지형을 무시하고 바다도 건넌다.
// naval 은 바다 타일로만 다니고 항구가 있는 해안 도시에서만 편성된다. 사거리 3 함포로 해안 도시·지상군을 포격한다.
const UNITS = {
  inf:   { id: 'inf',   name: '보병사단',   cost: 150, upkeep: 0.35, atk: 4,  def: 6, speed: 1.0, range: 1, tech: null,        ground: true },
  armor: { id: 'armor', name: '기갑사단',   cost: 360, upkeep: 0.95, atk: 9,  def: 8, speed: 1.6, range: 1, tech: 'mech',      ground: true },
  arty:  { id: 'arty',  name: '포병여단',   cost: 300, upkeep: 0.65, atk: 8,  def: 3, speed: 0.9, range: 3, tech: 'artillery', ground: true },
  air:   { id: 'air',   name: '항공전대',   cost: 520, upkeep: 1.45, atk: 10, def: 5, speed: 6.0, range: 2, tech: 'aviation',  ground: false, flying: true },
  navy:  { id: 'navy',  name: '구축함대',   cost: 480, upkeep: 1.2,  atk: 9,  def: 8, speed: 2.4, range: 3, tech: 'naval',     ground: false, naval: true },
};
const UNIT_ORDER = ['inf', 'armor', 'arty', 'air', 'navy'];

// 상성표 [공격자][방어자] — 기술로 바뀌는 칸은 game.counterMult 에서 보정한다. 0 = 공격 불가.
const COUNTER = {
  inf:   { inf: 1.0, armor: 0.55, arty: 1.6, air: 0.35, navy: 0.0 },
  armor: { inf: 1.5, armor: 1.0,  arty: 1.4, air: 0.25, navy: 0.0 },
  arty:  { inf: 1.3, armor: 1.0,  arty: 1.0, air: 0.0,  navy: 0.9 },
  air:   { inf: 1.1, armor: 1.5,  arty: 1.4, air: 1.0,  navy: 1.3 },
  navy:  { inf: 1.2, armor: 1.0,  arty: 1.3, air: 0.7,  navy: 1.0 },
};

/* ------------------------------------------------------------------ 건물 */
// 도시마다 부지(slots)가 있고, 산업부 장관이 정책 비율에 맞춰 자동으로 짓는다.
// res 가 있는 건물은 도시 반경 안의 해당 자원 타일 수만큼만 레벨을 올릴 수 있다.
const BUILDINGS = {
  mine:     { id: 'mine',     name: '광산',     cost: 300, res: 'iron', cat: 'resource', out: { iron: 0.5 } },
  oilwell:  { id: 'oilwell',  name: '시추소',   cost: 340, res: 'oil',  cat: 'resource', out: { oil: 0.35 } },
  farm:     { id: 'farm',     name: '농장',     cost: 240, res: 'farm', cat: 'resource', out: { grain: 0.6 } },
  factory:  { id: 'factory',  name: '공장',     cost: 420, cat: 'factory', out: { goods: 1.5 }, in: { iron: 0.3, oil: 0.15 } },
  lab:      { id: 'lab',      name: '연구소',   cost: 460, cat: 'infra',   science: 1.0 },
  exchange: { id: 'exchange', name: '거래소',   cost: 520, cat: 'infra',   tech: 'finance' },
  barracks: { id: 'barracks', name: '병영',     cost: 360, cat: 'defense' },
  bunker:   { id: 'bunker',   name: '벙커',     cost: 320, cat: 'defense', tech: 'fortification', hp: 500 },
  aa:       { id: 'aa',       name: '방공포대', cat: 'defense', cost: 340, tech: 'radar', aaDmg: 6 },
  port:     { id: 'port',     name: '항구',     cat: 'defense', cost: 400, tech: 'naval', coastal: true, trade: 0.12 },
};
const BUILDING_ORDER = ['mine', 'oilwell', 'farm', 'factory', 'lab', 'exchange', 'barracks', 'bunker', 'aa', 'port'];
const MAX_BUILDING_LEVEL = 5;

/* ------------------------------------------------------------------ 시장 */
// 전 세계 공용 자재 시장. 사면 오르고 팔면 내리며 기준가로 되돌아온다.
const MATERIALS = {
  iron:  { id: 'iron',  name: '철강', base: 1.6 },
  oil:   { id: 'oil',   name: '원유', base: 2.6 },
  grain: { id: 'grain', name: '곡물', base: 1.0 },
  goods: { id: 'goods', name: '공산품', base: 2.2 },
};
const MARKET_IMPACT = 0.004; // 1단위 체결당 가격 변동 비율
const MARKET_REVERT = 0.05; // 초당 기준가로 되돌아가는 비율
const STOCKPILE_CAP = 120; // 이 이상 쌓이면 자동으로 시장에 판다

/* ------------------------------------------------------------------ 주식 */
// 세계 경제를 대표하는 5개 종목. 각 종목은 판 위에서 실제로 벌어지는 일에 반응한다.
//   방산 ↑ 전투가 격렬할수록 / 에너지 ↑ 원유값 / 테크 ↑ 전 세계 연구량 / 건설 ↑ 건설량 / 식품 ↔ 안정
const STOCKS = {
  defense: { id: 'defense', name: '한성방산',   price: 100, driver: 'war',      yieldRate: 0.00025, sigma: 0.30 },
  energy:  { id: 'energy',  name: '대륙에너지', price: 100, driver: 'oil',      yieldRate: 0.00035, sigma: 0.22 },
  tech:    { id: 'tech',    name: '네오텍',     price: 100, driver: 'research', yieldRate: 0.00010, sigma: 0.35 },
  constr:  { id: 'constr',  name: '태평건설',   price: 100, driver: 'build',    yieldRate: 0.00030, sigma: 0.20 },
  food:    { id: 'food',    name: '푸른식품',   price: 100, driver: 'stable',   yieldRate: 0.00045, sigma: 0.10 },
};
const STOCK_ORDER = ['defense', 'energy', 'tech', 'constr', 'food'];
const STOCK_SPREAD = 0.006; // 매수는 비싸게, 매도는 싸게

/* ------------------------------------------------------------------ 기술 트리 */
// era 1 산업 현대 / 2 정보화 / 3 첨단. col/row 는 트리 화면 배치용.
// effects: unit(병종 해금), tier(병종 티어+1), mult(국가 배수 가산), building(건물 해금), flag(상성 보정)
const TECHS = {
  // ---- 1시대
  mech:          { id: 'mech',          name: '기계화',       era: 1, cost: 160, req: [],                      col: 0, row: 0, effects: { unit: 'armor' },                              desc: '기갑사단 생산 가능' },
  artillery:     { id: 'artillery',     name: '야포',         era: 1, cost: 150, req: [],                      col: 0, row: 1, effects: { unit: 'arty' },                               desc: '포병여단 생산 가능 (사거리 3)' },
  aviation:      { id: 'aviation',      name: '항공공학',     era: 1, cost: 220, req: [],                      col: 0, row: 2, effects: { unit: 'air' },                                desc: '항공전대 생산 가능 (지형 무시)' },
  radio:         { id: 'radio',         name: '무선통신',     era: 1, cost: 140, req: [],                      col: 0, row: 3, effects: { mult: { speed: 0.10 } },                      desc: '전군 이동 속도 +10%' },
  massprod:      { id: 'massprod',      name: '대량생산',     era: 1, cost: 170, req: [],                      col: 0, row: 4, effects: { mult: { factory: 0.20 } },                    desc: '공장 생산 +20%' },
  mining:        { id: 'mining',        name: '채굴 기술',    era: 1, cost: 150, req: [],                      col: 0, row: 5, effects: { mult: { resource: 0.25 } },                   desc: '광산·시추소·농장 생산 +25%' },
  fortification: { id: 'fortification', name: '요새화',       era: 1, cost: 140, req: [],                      col: 0, row: 6, effects: { building: 'bunker', mult: { cityDef: 0.15 } }, desc: '벙커 건설 가능, 도시 방어 +15%' },
  finance:       { id: 'finance',       name: '금융공학',     era: 1, cost: 190, req: [],                      col: 0, row: 7, effects: { building: 'exchange', mult: { dividend: 0.15 } }, desc: '거래소 건설 가능, 배당 +15%' },
  naval:         { id: 'naval',         name: '해군 공학',    era: 1, cost: 210, req: [],                      col: 0, row: 8, effects: { unit: 'navy', building: 'port' },               desc: '항구 건설·구축함대 편성 (해안 도시)' },
  missileship:   { id: 'missileship',   name: '미사일 구축함', era: 2, cost: 470, req: ['naval', 'radio'],     col: 1, row: 8, effects: { tier: 'navy', mult: { navyRange: 1 } },        desc: '함대 티어 +1, 함포 사거리 +1' },
  carrier:       { id: 'carrier',       name: '항모 전단',    era: 3, cost: 1200, req: ['missileship', 'jet'],  col: 3, row: 8, effects: { tier: 'navy', mult: { airDef: 0.1, speed: 0.05 } }, desc: '함대 티어 +1, 대공 +10%, 속도 +5%' },
  // ---- 2시대
  composite:     { id: 'composite',     name: '복합장갑',     era: 2, cost: 460, req: ['mech'],                col: 1, row: 0, effects: { tier: 'armor' },                              desc: '기갑 티어 +1 (공·방 +25%)' },
  rocket:        { id: 'rocket',        name: '로켓공학',     era: 2, cost: 450, req: ['artillery'],           col: 1, row: 1, effects: { tier: 'arty', mult: { artyRange: 1 } },       desc: '포병 티어 +1, 사거리 +1' },
  jet:           { id: 'jet',           name: '제트엔진',     era: 2, cost: 480, req: ['aviation'],            col: 1, row: 2, effects: { tier: 'air' },                                desc: '항공 티어 +1' },
  electronics:   { id: 'electronics',   name: '전자공학',     era: 2, cost: 380, req: ['radio'],               col: 1, row: 3, effects: { mult: { science: 0.30 } },                    desc: '연구소 효율 +30%' },
  automation:    { id: 'automation',    name: '자동화',       era: 2, cost: 520, req: ['massprod'],            col: 1, row: 4, effects: { mult: { factory: 0.30 } },                    desc: '공장 생산 +30%' },
  petrochem:     { id: 'petrochem',     name: '석유화학',     era: 2, cost: 430, req: ['mining'],              col: 1, row: 5, effects: { mult: { resource: 0.20, upkeep: -0.10 } },   desc: '자원 생산 +20%, 유지비 −10%' },
  logistics:     { id: 'logistics',     name: '현대 병참',    era: 2, cost: 420, req: ['radio', 'fortification'], col: 1, row: 6, effects: { mult: { upkeep: -0.15, speed: 0.10 } },  desc: '유지비 −15%, 이동 속도 +10%' },
  computers:     { id: 'computers',     name: '컴퓨터',       era: 2, cost: 540, req: ['electronics', 'finance'], col: 1, row: 7, effects: { mult: { science: 0.25, factory: 0.15, dividend: 0.10 } }, desc: '연구 +25%, 공장 +15%, 배당 +10%' },
  // ---- 2.5시대 (상성·방공)
  atgm:          { id: 'atgm',          name: '대전차 미사일', era: 2, cost: 420, req: ['electronics', 'mech'], col: 2, row: 0, effects: { flag: 'atgm' },                              desc: '보병의 대기갑 전투력 정상화' },
  radar:         { id: 'radar',         name: '레이더',       era: 2, cost: 440, req: ['electronics'],         col: 2, row: 2, effects: { building: 'aa', mult: { airDef: 0.15 } },      desc: '방공포대 건설 가능, 대공 방어 +15%' },
  manpads:       { id: 'manpads',       name: '휴대 방공',    era: 2, cost: 400, req: ['radar'],               col: 2, row: 3, effects: { flag: 'manpads' },                            desc: '보병의 대공 전투력 정상화' },
  // ---- 3시대
  mbt3:          { id: 'mbt3',          name: '3.5세대 전차', era: 3, cost: 1050, req: ['composite', 'computers'], col: 3, row: 0, effects: { tier: 'armor' },                        desc: '기갑 티어 +1' },
  precision:     { id: 'precision',     name: '정밀유도',     era: 3, cost: 1100, req: ['rocket', 'computers'], col: 3, row: 1, effects: { tier: 'arty', mult: { artyRange: 1 } },    desc: '포병 티어 +1, 사거리 +1' },
  stealth:       { id: 'stealth',       name: '스텔스',       era: 3, cost: 1150, req: ['jet', 'radar'],        col: 3, row: 2, effects: { tier: 'air' },                              desc: '항공 티어 +1' },
  drones:        { id: 'drones',        name: '드론',         era: 3, cost: 950,  req: ['computers', 'aviation'], col: 3, row: 3, effects: { tier: 'inf', mult: { atk: 0.10 } },      desc: '보병 티어 +1, 전군 공격 +10%' },
  ai:            { id: 'ai',            name: '인공지능',     era: 3, cost: 1400, req: ['computers', 'automation'], col: 3, row: 4, effects: { mult: { science: 0.40, factory: 0.20, atk: 0.10 } }, desc: '연구 +40%, 공장 +20%, 공격 +10%' },
  fusion:        { id: 'fusion',        name: '핵융합',       era: 3, cost: 1600, req: ['ai', 'petrochem'],     col: 3, row: 5, effects: { mult: { income: 0.25, upkeep: -0.20 } },   desc: '국가 수입 +25%, 유지비 −20%' },
  satellites:    { id: 'satellites',    name: '위성 통신',    era: 3, cost: 1250, req: ['rocket', 'electronics'], col: 3, row: 6, effects: { mult: { dividend: 0.20, def: 0.10, speed: 0.10 } }, desc: '배당 +20%, 전군 방어 +10%, 속도 +10%' },
  cyber:         { id: 'cyber',         name: '사이버전',     era: 3, cost: 1000, req: ['computers'],           col: 3, row: 7, effects: { mult: { cityDef: 0.20, income: 0.10 } },   desc: '도시 방어 +20%, 수입 +10%' },
  recon:         { id: 'recon',         name: '정찰 위성',    era: 2, cost: 420, req: ['radio'],                col: 2, row: 6, effects: { flag: 'recon' },                             desc: '타국의 예산·교리·공격 대상 열람' },
  nuke:          { id: 'nuke',          name: '전략 핵무기',  era: 3, cost: 1900, req: ['precision', 'ai'],     col: 3, row: 9, effects: { flag: 'nuke' },                              desc: '핵 타격 가능 (2,500, 5분 대기) — 세계 신뢰 −30' },
};
const TECH_ORDER = Object.keys(TECHS);

/* ------------------------------------------------------------------ 상수 */
const RULES = {
  startCash: 3000,
  tileIncome: 0.045,       // 영토 1타일당 초당 수입
  popTax: 0.016,           // 인구 1당 초당 세금
  cityMilitia: 1.3,        // 도시 규모 1당 인접 적 지상군에 주는 초당 피해 (수비대 없이도 버티는 힘)
  upkeepScaleFrom: 6,      // 이 부대 수를 넘기면 부대당 유지비가 올라간다 (대군 유지비, 스노우볼 억제)
  upkeepScale: 0.04,       // 초과 1부대당 +4%
  rallySize: 3,            // 공격 임무 지상군은 이만큼 모여야 적 도시로 진격한다
  adminFrom: 10,           // 이 도시 수를 넘기면 도시당 수입 효율이 떨어진다 (행정 비용, 스노우볼 억제) — 도시가 촘촘해져 10개부터
  adminPenalty: 0.04,      // 초과 도시 1개당 −4% (최저 55%)
  captureKeep: 0.4,        // 점령 시 남는 건물 레벨 비율
  reserveMin: 1500,        // 비축(가용 현금) 상한의 최솟값
  reserveSeconds: 60,      // 비축 상한 = 순수입 × 이 초 수 (넘치면 금고로 재배분)
  // ---- 전쟁은 비싸고 평화는 돈이 된다
  graceSeconds: 240,       // 초반 보호 기간: 도시 점령 불가, 민병대 2배
  wearinessPerLoss: 5,     // 아군 부대 1기 전멸당 전쟁 피로도 (남의 땅에서)
  wearinessPerLossHome: 3, // 제 땅을 지키다 잃으면 덜 지친다
  wearinessPerKill: 0.8,   // 제 땅(또는 동맹 땅)에서 적 1기 격멸당
  wearinessPerKillAbroad: 2.5, // 남의 땅에서 격멸당 — 침략군은 이겨도 지친다
  wearinessPerConquest: 6, // 적 도시를 점령한 쪽의 피로도
  wearinessDecay: 0.12,    // 초당 회복
  wearinessIncomeMax: 0.5, // 피로도 100 이면 세수 −50%
  unrestSeconds: 150,      // 점령지 저항 기간: 수입 0, 인구 감소. 아군 지상군이 주둔하면 2배 빨리 안정
  tradePeace: 0.04,        // 불가침국 1개당 세수 +4%
  tradeAlly: 0.08,         // 동맹국 1개당 세수 +8%
  conquestOpinion: 6,      // 적 도시 점령 1회당 모든 국가의 신뢰 −6 (세계 여론)
  nukeCost: 2500,
  nukeCooldown: 300,
  nukeFallout: 150,        // 피폭 도시 수입 0 기간
  economicVictory: 50000,  // 경제 승리 국력 기준
  histEvery: 20,           // 국력 추이 표본 간격(초) — 결과 그래프용
  buildingUpkeep: 0.0008,  // 건물 건축비 대비 초당 유지비
  scienceBase: 1.5,        // 연구소 없이도 나오는 기본 과학
  cashToScience: 0.12,     // 연구 예산 1원 → 과학 포인트
  cityRadius: [0, 5, 7, 9],// 도시 규모별 영토 반경
  captureSeconds: 9,       // 도시 체력 0 + 지상군 점거 유지 시간
  cityHpBase: 260,
  cityHpPerSize: 140,
  cityRegen: 3.5,          // 초당 도시 체력 회복 (적 미접촉 시)
  reinforce: 1.2,          // 아군 병영 도시 위에서 초당 병력 회복(%)
  missionInterval: 3,      // 위임 부대가 임무를 재검토하는 주기(초)
  cabinetInterval: 2,      // 장관들이 예산을 집행하는 주기(초)
  unitValueRatio: 0.6,     // 순자산 계산 시 모병비 대비 부대 가치
  territoryValue: 2,       // 순자산 계산 시 타일당 가치
  cityValue: 600,
  maxUnitsPerNation: 40,
  // ---- 재미 요소
  projectShare: 0.5,       // 산업 금고 중 매 집행 주기에 국가 프로젝트로 보내는 최대 비율
  projectPrestige: 0.5,    // 완성한 프로젝트 비용 × 이 비율이 국력(위신)에 더해진다
  projectRefund: 0.5,      // 경쟁에서 지면 투입액의 이 비율을 산업 금고로 돌려받는다
  decisionEvery: 140,      // 결단(선택형 사건) 평균 간격(초)
  decisionSeconds: 45,     // 결단 제한 시간 — 넘기면 기본 선택
  councilEvery: 300,       // 세계 의회 결의 간격(초)
  councilVoteSeconds: 60,  // 투표 시간
  spyCooldown: 90,         // 첩보 작전 재사용 대기(초)
  spyBase: 0.65,           // 기본 성공률 (정찰 위성 +15%p, 상대 정찰 위성/사이버전 −15%p)
  spyCaughtTrust: 25,      // 발각 시 대상국 신뢰 하락 (제3국 −5)
  achPrestige: 250,        // 업적 1개당 국력 위신
};

// ---- 국가 프로젝트 (세계에 하나뿐인 불가사의). 산업 금고로 짓고, 먼저 완성한 나라만 효과를 가진다.
// 경쟁에서 진 나라는 투입액의 절반을 산업 금고로 돌려받는다. prestige 는 국력에 더해지는 위신.
const PROJECTS = {
  expo:    { id: 'expo',    name: '세계 박람회',     icon: '🎪', cost: 3000, req: 'massprod',   desc: '모든 국가 신뢰 +15, 세수 +10%, 세계 의회 투표권 +1',        effects: { mult: { income: 0.10 }, trustAll: 15, vote: 1 } },
  peace:   { id: 'peace',   name: '평화 기념관',     icon: '🕊', cost: 2500, req: null,         desc: '모든 국가 신뢰 +10, 교역 +5%p, 교전이 없을 때 피로도 회복 3배',        effects: { trustAll: 10, wearinessDecay: 2, trade: 0.05 } },
  hub:     { id: 'hub',     name: '국제 금융 허브',  icon: '🏦', cost: 4000, req: 'finance',    desc: '배당 +50%, 교역 보너스 +10%p',                                effects: { mult: { dividend: 0.5 }, trade: 0.10 } },
  canal:   { id: 'canal',   name: '대운하',          icon: '⚓', cost: 4500, req: 'logistics', coastal: true, desc: '항구 교역 2배, 전군 이동 속도 +15% (해안 도시 필요)', effects: { mult: { speed: 0.15 }, portTrade: 1 } },
  station: { id: 'station', name: '우주 정거장',     icon: '🛰', cost: 6000, req: 'satellites', desc: '연구 +40%, 위신 +4,000',                                      effects: { mult: { science: 0.4 }, prestige: 4000 } },
  reactor: { id: 'reactor', name: '핵융합 발전소',   icon: '⚛', cost: 8000, req: 'fusion',     desc: '공장 +40%, 유지비 −25%',                                      effects: { mult: { factory: 0.4, upkeep: -0.25 } } },
};
const PROJECT_ORDER = Object.keys(PROJECTS);

// ---- 첩보 작전. 비축(가용 현금)으로 집행. 실패하면 발각되어 신뢰가 떨어진다.
const SPY_OPS = {
  sabotage: { id: 'sabotage', name: '산업 사보타주', icon: '💥', cost: 600, desc: '대상의 가장 큰 공장(2단계 이상) 1단계 파괴 또는 도시 체력 −40% + 산업 금고 −300' },
  steal:    { id: 'steal',    name: '기술 절취',     icon: '📡', cost: 800, desc: '대상이 연구 중인 진척의 40% 를 과학 포인트로 획득 (최대 400)' },
  incite:   { id: 'incite',   name: '선동 공작',     icon: '📢', cost: 500, desc: '대상 전쟁 피로도 +12, 지방 도시 하나에 40초 소요 사태' },
};

const NATION_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];
const NATION_NAMES = ['북방연방', '남부공화국', '동해연합', '서부왕국', '중원제국', '해양동맹', '고원공화국', '삼각주연방'];

module.exports = {
  TERRAIN, RESOURCES, UNITS, UNIT_ORDER, COUNTER, BUILDINGS, BUILDING_ORDER, MAX_BUILDING_LEVEL,
  MATERIALS, MARKET_IMPACT, MARKET_REVERT, STOCKPILE_CAP, STOCKS, STOCK_ORDER, STOCK_SPREAD,
  TECHS, TECH_ORDER, RULES, NATION_COLORS, NATION_NAMES,
  PROJECTS, PROJECT_ORDER, SPY_OPS,
};
