// src/utils.ts
// ultra-ultra-slim: UI helpers + persistence + normalization (single-file)

// -------------------- storage (localStorage only) --------------------

export const LS_KEY = 'roosycozy_state_v1';

// "전체 삭제" 후 새로고침했을 때 샘플이 다시 깔리는 걸 막는 마커
export const LS_SEED_DISABLED_KEY = 'roosycozy_seed_disabled_v1';

export const IS_TAURI =
  typeof window !== 'undefined' &&
  (Boolean((window as any).__TAURI__) || (typeof (window as any).isTauri === 'function' && (window as any).isTauri()));

const ls = () => (typeof localStorage === 'undefined' ? null : localStorage);

export const storageGet = async (): Promise<string | null> => ls()?.getItem(LS_KEY) ?? null;
export const storageSet = async (value: string): Promise<void> => void ls()?.setItem(LS_KEY, value);
export const storageRemove = async (): Promise<void> => void ls()?.removeItem(LS_KEY);

// -------------------- shared app types --------------------

import type {
  Sensitivity,
  ActorType,
  ActorRef,
  StoreType,
  PlaceType,
  RecordItem,
  CaseSensFilter,
  CaseStatus,
  StepItem,
  AdvisorItem,
  CaseItem,
} from './engine';

export type AppState = {
  v: 7;
  tab: 'records' | 'cases';
  selectedCaseId: string | null;
  records: RecordItem[];
  cases: Record<string, CaseItem>;
};

export const STATUSES: CaseStatus[] = ['진행중', '답변 준비', '종결'];

// -------------------- tiny helpers --------------------

export const uid = (prefix = 'id') =>
  `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;

export const nowISO = () => new Date().toISOString();

const z2 = (n: number) => String(n).padStart(2, '0');

export const fmt = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}.${z2(d.getMonth() + 1)}.${z2(d.getDate())}  ${z2(d.getHours())}:${z2(d.getMinutes())}`;
};

export const toLocalInputValue = (iso?: string) => {
  const d = iso ? new Date(iso) : new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
};

export const fromLocalInputValue = (val?: string) => {
  if (!val) return nowISO();
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? nowISO() : d.toISOString();
};

export const safeParseJSON = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' } as any)[m]);

export const mustGetEl = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el as T;
};

export const trunc = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t;
};

// -------------------- persistence --------------------

export const defaultState = (): AppState => ({
  v: 7,
  tab: 'records',
  selectedCaseId: null,
  records: [],
  cases: {},
});

const str = (x: any, d = '') => (x === undefined || x === null ? d : String(x));
const obj = (x: any) => (x && typeof x === 'object' ? x : null);
const arr = (x: any) => (Array.isArray(x) ? x : []);
const trim = (x: any) => str(x, '').trim();

const actorMain = (a: any): ActorRef => {
  const o = obj(a) ?? {};
  return { type: (o.type ?? '외부인') as ActorType, name: trim(o.name) };
};

const actorRel = (a: any): ActorRef | null => {
  const a2 = actorMain(a);
  return a2.name ? a2 : null;
};

const normRecord = (r: any): RecordItem => {
  const o = obj(r) ?? {};
  return {
    id: str(o.id, uid('REC')),
    ts: str(o.ts, nowISO()),
    storeType: (o.storeType ?? '문서') as StoreType,
    storeOther: str(o.storeOther, ''),
    lv: (o.lv ?? 'LV2') as Sensitivity,
    actor: actorMain(o.actor),
    related: arr(o.related).map(actorRel).filter(Boolean) as ActorRef[],
    place: (o.place ?? '기타') as PlaceType,
    placeOther: str(o.placeOther, ''),
    summary: str(o.summary, ''),
  };
};

const normStep = (s: any): StepItem => {
  const o = obj(s) ?? {};
  return {
    id: str(o.id, uid('STEP')),
    ts: str(o.ts, nowISO()),
    name: trim(o.name),
    note: trim(o.note),
    // legacy compat / required blanks (safe even if StepItem marks them optional)
    text: str(o.text, ''),
    place: str(o.place, ''),
    owner: str(o.owner, ''),
    lv: str(o.lv, ''),
  } as StepItem;
};

const normAdvisor = (a: any): AdvisorItem => {
  const o = obj(a) ?? {};
  const level = o.level === 'warn' || o.level === 'critical' ? o.level : 'info';
  const state = o.state === 'done' || o.state === 'dismissed' ? o.state : 'active';
  return {
    id: str(o.id, uid('ADV')),
    ts: str(o.ts, nowISO()),
    title: trim(o.title),
    body: trim(o.body),
    level,
    tags: arr(o.tags).map((x) => trim(x)).filter(Boolean),
    state,
    ruleId: o.ruleId ? str(o.ruleId) : undefined,
  } as AdvisorItem;
};

const normCase = (raw: any, key: string): CaseItem => {
  const c = obj(raw) ?? {};
  const st = STATUSES.includes(c.status) ? c.status : '진행중';
  const m = c.mode === 'smart' ? 'smart' : c.mode === 'normal' ? 'normal' : undefined;

  return {
    id: str(c.id, key),
    title: (trim(c.title) || '케이스') as any,
    actors: arr(c.actors).map(actorRel).filter(Boolean) as ActorRef[],
    sensFilter: (c.sensFilter ?? 'any') as CaseSensFilter,
    status: st as CaseStatus,
    createdAt: str(c.createdAt, nowISO()),
    steps: arr(c.steps).map(normStep) as any,
    advisors: arr(c.advisors).map(normAdvisor) as any,
    query: str(c.query, ''),
    timeFrom: str(c.timeFrom, ''),
    timeTo: str(c.timeTo, ''),
    maxResults: typeof c.maxResults === 'number' ? c.maxResults : undefined,
    recordIds: Array.isArray(c.recordIds) ? c.recordIds.map((x: any) => str(x)) : undefined,
    scoreByRecordId: c.scoreByRecordId && typeof c.scoreByRecordId === 'object' ? c.scoreByRecordId : undefined,
    mode: m as any,
  } as CaseItem;
};

export const normalizeState = (anyObj: any): AppState => {
  const base = defaultState();

  // accept packs: {v, exportedAt, state}
  const o = obj(anyObj?.state && typeof anyObj.state === 'object' ? anyObj.state : anyObj);
  if (!o) return base;

  base.tab = o.tab === 'cases' ? 'cases' : 'records';
  base.selectedCaseId = typeof o.selectedCaseId === 'string' ? o.selectedCaseId : null;

  base.records = arr(o.records).map(normRecord);

  const cs = obj(o.cases) ?? {};
  const out: Record<string, CaseItem> = {};
  for (const id of Object.keys(cs)) out[id] = normCase((cs as any)[id], id);
  base.cases = out;

  return base;
};

// -------------------- sample seeding (only when empty) --------------------
// 1) src/sample_pack_v7.json 파일을 만들고 "pack" 형태(JSON 전체)로 넣어두면 됨.
// 2) 비어있는 첫 실행에서만 자동 시드됨. (기존 사용자 데이터는 절대 덮지 않음)

const SAMPLE_PACK_URL = new URL('./sample_pack_v7.json', import.meta.url);

// 기본: 개발 모드에서는 시드 X, 배포(=production)에서는 시드 O
// 필요하면 .env.production 에 VITE_SEED_SAMPLE=0 같은 식으로 제어 가능하게도 확장 가능
const SEED_ON_EMPTY =
  ((import.meta as any)?.env?.VITE_SEED_SAMPLE ?? '') === '1' ||
  String((import.meta as any)?.env?.MODE ?? '') === 'production';

const loadSamplePack = async (): Promise<any | null> => {
  try {
    const res = await fetch(SAMPLE_PACK_URL);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

// -------------------- public load/save/wipe --------------------

export const loadState = async (): Promise<AppState> => {
  const raw = await storageGet();
  if (raw) return normalizeState(safeParseJSON(raw)); // ✅ 기존 사용자: 그대로

  // ✅ 사용자가 "전체 삭제"를 한 적이 있으면, 샘플 자동시드 금지
  if (ls()?.getItem(LS_SEED_DISABLED_KEY) === '1') return defaultState();

  // ✅ 배포 환경/플래그 조건이 아니면 그냥 빈 상태
  if (!SEED_ON_EMPTY) return defaultState();

  // ✅ 신규 사용자(스토리지 없음): 샘플 시드
  const pack = await loadSamplePack();
  if (!pack) return defaultState();

  const seeded = normalizeState(pack);
  await storageSet(JSON.stringify(seeded));

  // 시드 성공했으니 wipe 마커 제거
  void ls()?.removeItem(LS_SEED_DISABLED_KEY);

  return seeded;
};

export const saveState = async (s: AppState) => {
  // 사용자가 저장을 시작하면 wipe 마커 제거(의미상 깨끗하게)
  void ls()?.removeItem(LS_SEED_DISABLED_KEY);
  return storageSet(JSON.stringify(s));
};

export const wipeAll = async () => {
  // LS_KEY 제거
  await storageRemove();
  // 삭제 후 새로고침 시 샘플이 다시 깔리는 걸 막음
  void ls()?.setItem(LS_SEED_DISABLED_KEY, '1');
};
