// src/engine.ts
import { rustGenerateAdvisorsForCase, rustRankRecordsForCase } from './engine_rust';

/* -------------------- Types -------------------- */

export type Sensitivity = 'LV1' | 'LV2' | 'LV3' | 'LV4' | 'LV5';
export type ActorType = '관리자' | '학부모' | '학생' | '동료교사' | '외부인' | '기타';
export type ActorRef = { type: ActorType; name: string };
export type StoreType = string;
export type PlaceType = string;

export type RecordItem = {
  id: string;
  ts: string;
  storeType: StoreType;
  storeOther: string;
  lv: Sensitivity;
  actor: ActorRef;
  related: ActorRef[];
  place: PlaceType;
  placeOther: string;
  summary: string;
};

export type CaseSensFilter = 'any' | Sensitivity;
export type CaseStatus = '진행중' | '답변 준비' | '종결';

export type StepItem = {
  id: string;
  ts: string;
  name: string;
  note: string;
  text?: string;
  place?: string;
  owner?: string;
  lv?: string;
};

export type AdvisorLevel = 'info' | 'warn' | 'critical';
export type AdvisorState = 'active' | 'done' | 'dismissed';

export type AdvisorItem = {
  id: string;
  ts: string;
  title: string;
  body: string;
  level: AdvisorLevel;
  tags: string[];
  state: AdvisorState;
  ruleId?: string;
  [k: string]: any;
};

// [추가] Rust의 RankedComponents 구조체와 매칭
export type RankedComponents = {
  keywordScore: number;
  textSim: number;
  qHit: number;
  qTotal: number;

  actorScore: number;
  actorMatch: boolean;
  isMainActor: boolean;

  relatedScore: number;
  relatedHits: number;

  inRange?: boolean;

  wActor: number;
  wRelated: number;
  wText: number;
  minScore: number;
  minTextSim: number;
};

export type CaseItem = {
  id: string;
  title: string;
  actors: ActorRef[];
  sensFilter: CaseSensFilter;
  onlyMainActor?: boolean;
  status: CaseStatus;
  createdAt: string;
  steps: StepItem[];
  advisors?: AdvisorItem[];
  query?: string;
  timeFrom?: string;
  timeTo?: string;
  maxResults?: number;
  mode?: 'smart' | 'normal';
  recordIds?: string[];

  // 점수 스냅샷
  scoreByRecordId?: Record<string, number>;

  // ✅ [추가] Rust components 스냅샷 (recordId -> RankedComponents)
  componentsByRecordId?: Record<string, RankedComponents>;
};

// [수정] 상세 정보(rank, reasons, components)를 포함하도록 확장
export type RankedHit = {
  id: string;
  score: number;
  rank: number;
  reasons: string[];
  components: RankedComponents;
  record: RecordItem;
};

export type CaseUpdateCandidate = RankedHit;

export type TimelineEvent =
  | { kind: 'record'; ts: string; record: RecordItem; score?: number; components?: RankedComponents } // ✅ components 추가
  | { kind: 'advisor'; ts: string; advisor: AdvisorItem }
  | { kind: 'step'; ts: string; step: StepItem };

export const OTHER = '__OTHER__' as const;

/* -------------------- tiny helpers -------------------- */

export const actorEq = (a: ActorRef, b: ActorRef) =>
  String(a?.type ?? '') === String(b?.type ?? '') &&
  String(a?.name ?? '').trim() === String(b?.name ?? '').trim();

export function addActorToList(list: ActorRef[], actor: ActorRef) {
  const a = { type: actor.type, name: String(actor.name || '').trim() };
  if (!a.name) return (list || []).slice();
  const out = (Array.isArray(list) ? list : []).slice();
  if (!out.some((x) => actorEq(x, a))) out.push(a);
  return out;
}

export function resolveName(choice: string, other: string) {
  const c = String(choice || '').trim();
  return !c || c === OTHER ? String(other || '').trim() : c;
}

export function recordActors(r: RecordItem) {
  const arr = [r.actor, ...(Array.isArray(r.related) ? r.related : [])]
    .map((a) => ({
      type: (a?.type ?? '외부인') as ActorType,
      name: String(a?.name ?? '').trim(),
    }))
    .filter((a) => a.name);

  const out: ActorRef[] = [];
  for (const a of arr) if (!out.some((x) => actorEq(x, a))) out.push(a);
  return out;
}

/* -------------------- Rust wrappers -------------------- */

export async function rankRecordsForCase(
  records: RecordItem[],
  c: CaseItem,
  opts?: {
    limit?: number;
    weights?: { actor?: number; related?: number; text?: number; time?: number };
    minScore?: number;
    minTextSim?: number;
  }
): Promise<RankedHit[]> {
  // Rust에서 전체 데이터(reasons, components 포함)를 받아옴
  const main = (c as any).onlyMainActor ? ((c.actors || [])[0] ?? null) : null;
  const scoped = main ? records.filter((r) => actorEq(r.actor, main)) : records;
  const hits: any[] = await rustRankRecordsForCase(scoped, c, opts);

  const map = new Map(scoped.map((r) => [r.id, r]));

  return hits
    .map((h) => {
      const record = map.get(h.id);
      if (!record) return null;

      // Rust가 준 모든 데이터를 다 챙겨서 반환
      return {
        id: h.id,
        score: h.score,
        rank: h.rank,
        reasons: Array.isArray(h.reasons) ? h.reasons : [],
        components: h.components as RankedComponents,
        record: record,
      };
    })
    .filter((h): h is RankedHit => h !== null);
}

export const regenerateCaseAdvisors = (c: CaseItem, records: RecordItem[]) =>
  rustGenerateAdvisorsForCase(records, c);

/* -------------------- builders -------------------- */

export type RecordDraftInput = {
  tsISO: string;
  storeType: StoreType;
  storeOther: string;
  lv: Sensitivity;
  actorType: ActorType;
  actorNameChoice: string;
  actorNameOther: string;
  related: ActorRef[];
  place: PlaceType;
  placeOther: string;
  summary: string;
};

export function buildRecordFromDraft(d: RecordDraftInput, makeId: () => string) {
  const summary = String(d.summary || '').trim();
  if (!summary) return { error: '내용을 입력하세요' } as const;

  const actorName = resolveName(d.actorNameChoice, d.actorNameOther);
  if (!actorName) return { error: '주체 이름을 입력하세요' } as const;

  if (d.storeType === '기타' && !String(d.storeOther || '').trim())
    return { error: '보관형태 상세(기타)를 입력하세요' } as const;

  if (d.place === '기타' && !String(d.placeOther || '').trim())
    return { error: '장소 상세(기타)를 입력하세요' } as const;

  const main: ActorRef = { type: d.actorType, name: actorName.trim() };

  const related = (Array.isArray(d.related) ? d.related : [])
    .map((a) => ({
      type: (a?.type ?? '외부인') as ActorType,
      name: String(a?.name ?? '').trim(),
    }))
    .filter((a) => a.name && !actorEq(a, main))
    .reduce((acc, a) => addActorToList(acc, a), [] as ActorRef[]);

  return {
    record: {
      id: makeId(),
      ts: String(d.tsISO || new Date().toISOString()),
      storeType: d.storeType,
      storeOther: d.storeType === '기타' ? String(d.storeOther || '').trim() : '',
      lv: d.lv,
      actor: main,
      related,
      place: d.place,
      placeOther: d.place === '기타' ? String(d.placeOther || '').trim() : '',
      summary,
    },
  } as const;
}

export type CaseDraftInput = {
  title: string;
  actors: ActorRef[];
  query: string;
  timeFromISO: string;
  onlyMainActor?: boolean;
  timeToISO: string;
  sensFilter: CaseSensFilter;
  status: CaseStatus;
  maxResults: number;
};

const clamp = (n: any) => Math.max(1, Math.min(400, Number.isFinite(+n) ? +n : 80));

export async function buildCaseFromDraft(
  d: CaseDraftInput,
  records: RecordItem[],
  makeId: () => string,
  nowISO: () => string
) {
  const title = String(d.title || '').trim();
  if (!title) return { error: '방어파일 이름을 입력하세요', pickedCount: 0 } as const;

  const c: CaseItem = {
    id: makeId(),
    title,
    actors: (Array.isArray(d.actors) ? d.actors : []).filter((a) => a?.name),
    onlyMainActor: !!(d as any).onlyMainActor,
    sensFilter: d.sensFilter ?? 'any',
    status: d.status ?? '진행중',
    createdAt: nowISO(),
    steps: [],
    query: String(d.query || ''),
    timeFrom: String(d.timeFromISO || ''),
    timeTo: String(d.timeToISO || ''),
    maxResults: clamp(d.maxResults ?? 80),
    recordIds: [],
    scoreByRecordId: {},
    componentsByRecordId: {}, // ✅ 추가
  };

  const hits = await rankRecordsForCase(records, c, { limit: c.maxResults });

  c.recordIds = hits.map((h) => h.id);
  c.scoreByRecordId = Object.fromEntries(hits.map((h) => [h.id, h.score]));

  // ✅ Rust components도 케이스에 저장
  c.componentsByRecordId = Object.fromEntries(hits.map((h) => [h.id, h.components]));

  return { caseItem: c, pickedCount: c.recordIds.length } as const;
}

export async function createCaseWithAdvisors(
  d: CaseDraftInput,
  records: RecordItem[],
  makeId: () => string,
  nowISO: () => string
) {
  const built = await buildCaseFromDraft(d, records, makeId, nowISO);
  if (!(built as any).caseItem) return built;

  const c = (built as any).caseItem as CaseItem;
  c.advisors = await rustGenerateAdvisorsForCase(records, c);
  return { caseItem: c, pickedCount: built.pickedCount } as const;
}

export async function getCaseUpdateCandidates(
  c: CaseItem,
  records: RecordItem[]
): Promise<CaseUpdateCandidate[]> {
  const hits = await rankRecordsForCase(records, c, { limit: clamp(c.maxResults ?? 80) });
  const existing = new Set(Array.isArray(c.recordIds) ? c.recordIds : []);

  // 이미 RankedHit 타입에 모든 정보가 있으므로 그대로 반환
  return hits.filter((h) => !existing.has(h.id));
}

// overload 유지 (기존 호출부 안 깨지게)
export async function addRecordsToCase(c: CaseItem, idsToAdd: string[]): Promise<CaseItem>;
export async function addRecordsToCase(c: CaseItem, records: RecordItem[], idsToAdd: string[]): Promise<CaseItem>;
export async function addRecordsToCase(c: CaseItem, a: RecordItem[] | string[], b?: string[]) {
  const hasRecs = Array.isArray(b);
  const records = hasRecs ? (a as RecordItem[]) : [];
  const ids = (hasRecs ? b : (a as string[]))!.map((x) => String(x || '').trim()).filter(Boolean);

  const recordIds = Array.isArray(c.recordIds) ? c.recordIds.slice() : [];
  const set = new Set(recordIds);
  for (const id of ids) if (!set.has(id)) (recordIds.push(id), set.add(id));

  let scoreByRecordId = { ...(c.scoreByRecordId || {}) } as Record<string, number>;
  let componentsByRecordId = { ...(c.componentsByRecordId || {}) } as Record<string, RankedComponents>;

  if (hasRecs) {
    const hits = await rankRecordsForCase(records, { ...c, recordIds }, { limit: clamp(c.maxResults ?? 80) });

    // ✅ 스테일 점수 방지: recordIds 전체를 기준으로 scoreByRecordId를 "재생성"
    const nextScore: Record<string, number> = Object.fromEntries(recordIds.map((id) => [id, 0]));
    for (const h of hits) nextScore[h.id] = h.score;
    scoreByRecordId = nextScore;

    // ✅ components도 최신으로 갱신 (hits에 들어온 항목만 업데이트)
    const nextComp: Record<string, RankedComponents> = { ...componentsByRecordId };
    for (const h of hits) nextComp[h.id] = h.components;
    componentsByRecordId = nextComp;
  }

  return { ...c, recordIds, scoreByRecordId, componentsByRecordId };
}

/* -------------------- selectors / timeline -------------------- */

export function recordsForCase(records: RecordItem[], c: CaseItem) {
  const ids = Array.isArray(c.recordIds) ? c.recordIds : [];
  if (!ids.length) return [];
  const set = new Set(ids);
  return records
    .filter((r) => set.has(r.id))
    .slice()
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
}

export function casesContainingRecord(r: RecordItem, cases: Record<string, CaseItem>) {
  const out: CaseItem[] = [];
  for (const id of Object.keys(cases || {})) {
    const c = cases[id];
    if (c && Array.isArray(c.recordIds) && c.recordIds.includes(r.id)) out.push(c);
  }
  return out;
}

export function buildCaseTimeline(c: CaseItem, records: RecordItem[], _q: string) {
  const recs = recordsForCase(records, c);
  const steps = (c.steps || []).slice().sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const advisors = (c.advisors || [])
    .slice()
    .filter((a) => a && a.state !== 'dismissed')
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

  const scoreMap = (c.scoreByRecordId || {}) as Record<string, number>;
  const compMap = (c.componentsByRecordId || {}) as Record<string, RankedComponents>;

  const events: TimelineEvent[] = [
    ...recs.map((r) => ({
      kind: 'record' as const,
      ts: r.ts,
      record: r,
      score: scoreMap[r.id],
      components: compMap[r.id], // ✅ 포함
    })),
    ...steps.map((s) => ({ kind: 'step' as const, ts: s.ts, step: s })),
    ...advisors.map((a) => ({ kind: 'advisor' as const, ts: a.ts, advisor: a })),
  ].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

  return { events, mappedCount: recs.length, hasRange: !!(c.timeFrom || c.timeTo) };
}

/* ---- proto compat (import 깨짐 방지) ---- */
export const actorNameOptions = (_t: ActorType, _r: RecordItem[]) => [] as string[];
export const uniqueActorRefsFromRecords = (_r: RecordItem[]) => [] as ActorRef[];
``