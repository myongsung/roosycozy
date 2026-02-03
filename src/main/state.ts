import { nowISO, toLocalInputValue, esc, mustGetEl, defaultState } from '../utils';
import type { AppState } from '../utils';
import type { Sensitivity, ActorType, ActorRef, StoreType, PlaceType, CaseSensFilter, CaseStatus, CaseItem, CaseUpdateCandidate, RecordItem } from '../engine';
import { OTHER } from '../engine';

export type TimelineTarget = { kind: 'record' | 'advisor' | 'step'; id: string };

export let S: AppState = defaultState();
export const $app = mustGetEl<HTMLDivElement>('#app');
export const setState = (next: AppState) => (S = next);

export const ui = {
  qRecords: '',
  qTimeline: '',
  viewRecordId: null as string | null,
  recordsListOpen: false,
  caseCreateOpen: false,
  viewTimelineItem: null as TimelineTarget | null,
  paperCaseId: null as string | null,
  paperHash: null as string | null,
  paperPickOpen: false,
  paperPickQuery: '',
  updateCaseId: null as string | null,
  updateCandidatesForCaseId: null as string | null,
  updateCandidates: null as CaseUpdateCandidate[] | null,
  updateCandidatesLoading: false,
  flashStepId: null as string | null,
  flashStepTimer: null as number | null,
};

export const UI_OTHER_ACTOR_LABEL = '기타/외부인';
export const UI_ACTOR_TYPES = ['학생', '학부모', UI_OTHER_ACTOR_LABEL, '관리자', '동료교사'] as const;
export const ACTOR_TYPES: ActorType[] = ['관리자', '학부모', '학생', '동료교사', '외부인', '기타'];
export const LVS: Sensitivity[] = ['LV1', 'LV2', 'LV3', 'LV4', 'LV5'];

export const STORE_TYPES: StoreType[] = (['녹취록','통화녹취','음성녹음','문서','공문','가정통신문','회의록','상담록','상담일지','지도일지','교무수첩','업무일지','학급일지','전화','문자','업무메신저','이메일','사진','영상','CCTV','진술서','방문상담','공식채널','기타'] as any) as StoreType[];
export const PLACE_TYPES: PlaceType[] = (['교실','복도','급식실','보건실','교외','교무실','운동장','상담실','체육관','도서관','행정실','생활지도실','온라인','기타'] as any) as PlaceType[];

export const STUDENT_NAMES = Array.from({ length: 40 }, (_, i) => `학생${i + 1}`);
export const PARENT_NAMES = Array.from({ length: 40 }, (_, i) => [`${i + 1}번 모`, `${i + 1}번 부`]).flat();
export const ADMIN_NAMES = ['교장', '교감', '교무부장', '학년부장'];

export const actorTypeTextFromInternal = (t: ActorType) => {
  const v = String(t || '').trim();
  return v === '외부인' || v === '기타' ? UI_OTHER_ACTOR_LABEL : (v || UI_OTHER_ACTOR_LABEL);
};
export const actorTypeInternalFromText = (v: string): ActorType => {
  const s = String(v || '').trim();
  if (!s || s === UI_OTHER_ACTOR_LABEL || s === '외부인' || s === '기타') return '외부인' as ActorType;
  return ((ACTOR_TYPES as any).includes(s) ? s : '외부인') as ActorType;
};
export const nameDatalistIdForActorTypeText = (typeText: string) => {
  const t = String(typeText || '').trim();
  return t === '학생' ? 'dlNameStudent' : t === '학부모' ? 'dlNameParent' : t === '관리자' ? 'dlNameAdmin' : '';
};

export const opt = (value: string, label: string, selected: string) =>
  `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
export const renderSelectOptions = (opts: { value: string; label: string }[], selected: string) => {
  const sel = String(selected ?? '');
  const merged = opts.some((o) => o.value === sel) ? opts : [{ value: sel, label: sel }, ...opts];
  return merged.map((o) => opt(o.value, o.label, sel)).join('');
};
export const renderSelectFromList = (values: readonly string[], selected: string) =>
  renderSelectOptions((values || []).map((v) => ({ value: v, label: v })), selected);
export const renderSelectFromListWithPlaceholder = (values: readonly string[], selected: string, placeholder: string) => {
  const sel = String(selected || '');
  const base = (values || []).slice();
  const merged = sel && !base.includes(sel) ? [sel, ...base] : base;
  return `<option value="" ${!sel ? 'selected' : ''} disabled>${esc(placeholder)}</option>` + merged.map((v) => opt(v, v, sel)).join('');
};
export const renderNameFieldForType = (args: { typeText: string; value: string; action: 'draft-record' | 'draft-case'; field: string; placeholder: string; }) => {
  const t = String(args.typeText || '').trim();
  const v = String(args.value || '');
  const common = `data-action="${esc(args.action)}" data-field="${esc(args.field)}"`;
  if (!(t === '학생' || t === '학부모' || t === '관리자')) return `<input value="${esc(v)}" placeholder="${esc(args.placeholder)}" ${common} />`;
  const list = t === '학생' ? STUDENT_NAMES : t === '학부모' ? PARENT_NAMES : ADMIN_NAMES;
  const ph = t === '학생' ? '학생 선택' : t === '학부모' ? '학부모 선택' : '관리자 선택';
  return `<select ${common}>${renderSelectFromListWithPlaceholder(list as any, v, ph)}</select>`;
};

export const matchLite = (text: string, q: string) => !String(q || '').trim() || String(text || '').toLowerCase().includes(String(q || '').trim().toLowerCase());
export const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));
export const actorEqLite = (a: ActorRef, b: ActorRef) => String(a?.type ?? '').trim() === String(b?.type ?? '').trim() && String(a?.name ?? '').trim() === String(b?.name ?? '').trim();
export const tokenizeLite = (s: string) => String(s || '').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter((t) => t.length >= 2);
export const isWithinRangeISO = (tsISO: string, from?: string, to?: string) => {
  const t = String(tsISO || '');
  return !!t && (!from || t >= from) && (!to || t <= to);
};
export const daysDiff = (aISO: string, bISO: string) => {
  const a = new Date(aISO).getTime(), b = new Date(bISO).getTime();
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 86400000) : NaN;
};

export const lvLabel = (lv: Sensitivity) => lv;
export const storeLabel = (t: StoreType, other: string) => (t !== '기타' ? t : (other?.trim() ? `기타:${other.trim()}` : '기타'));
export const placeLabel = (p: PlaceType, other: string) => (p !== '기타' ? p : (other?.trim() ? `기타:${other.trim()}` : '기타'));
export const actorLabel = (a: ActorRef) => `${actorTypeTextFromInternal((a.type || '외부인') as any)} · ${a.name || '기타'}`;
export const actorShort = (a: ActorRef) => {
  const n = a.name || '기타';
  if (a.type === '학생') return `학생 ${n}`;
  if (a.type === '학부모') return `학부모 ${n}`;
  if (a.type === '관리자') return `관리자 ${n}`;
  if (a.type === '동료교사') return `동료교사 ${n}`;
  return `${UI_OTHER_ACTOR_LABEL} ${n}`;
};
export const sensFilterLabel = (s: CaseSensFilter) => (s === 'any' ? '전체' : s);

/* toast */
type ToastAction = { label: string; onClick: () => void };
let toastTimer: number | null = null, toastFn: (() => void) | null = null;
export const toast = (msg: string, action?: ToastAction) => {
  const root = document.getElementById('toast'); if (!root) return;
  const msgEl = root.querySelector('.toastMsg') as HTMLElement | null;
  const actBtn = root.querySelector('.toastAct') as HTMLButtonElement | null;
  if (msgEl) msgEl.textContent = msg; else root.textContent = msg;
  toastFn = action?.onClick ?? null;
  if (actBtn) { actBtn.hidden = !action; actBtn.textContent = action?.label ?? ''; }
  root.classList.add('show');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { root.classList.remove('show'); toastFn = null; }, action ? 6000 : 1200);
};
export const runToastAction = () => { const fn = toastFn; toastFn = null; const root = document.getElementById('toast'); if (root) root.classList.remove('show'); fn?.(); };

/* logs */
const LOG_MAX = 200;
export const logs: string[] = [];

export function log(msg: string, ...extra: unknown[]) {
  const time = new Date().toLocaleTimeString();
  const tail = extra.length ? ' ' + extra.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') : '';
  const line = `[${time}] ${msg}${tail}`;

  logs.push(line);
  while (logs.length > LOG_MAX) logs.shift();

  // 콘솔엔 원본 형태로 남김(디버깅 편함)
  // eslint-disable-next-line no-console
  console.log(msg, ...extra);
}


/* confirm */
let confirmResolver: ((ok: boolean) => void) | null = null;
export const openConfirm = (message: string) => {
  const dlg = document.getElementById('confirmModal') as HTMLDialogElement | null;
  const msgEl = document.getElementById('confirmMessage');
  if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm(message));
  if (msgEl) msgEl.textContent = message;
  dlg.showModal();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => { dlg.removeEventListener('cancel', onCancel); dlg.removeEventListener('close', onClose); if (confirmResolver === resolver) confirmResolver = null; };
    const resolver = (ok: boolean) => { if (settled) return; settled = true; resolve(ok); cleanup(); };
    const onCancel = (e: Event) => { e.preventDefault(); resolver(false); dlg.open && dlg.close(); };
    const onClose = () => { if (!settled) resolver(false); };
    confirmResolver = resolver;
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
  });
};
export const closeConfirm = (ok: boolean) => { confirmResolver?.(ok); confirmResolver = null; const dlg = document.getElementById('confirmModal') as HTMLDialogElement | null; dlg?.open && dlg.close(); };

/* dialogs */
const dlg = (id: string) => document.getElementById(id) as HTMLDialogElement | null;
const openDlg = (id: string) => { const d = dlg(id); d && !d.open && d.showModal(); };
const closeDlg = (id: string) => { const d = dlg(id); d?.open && d.close(); };

export const openRecordModal = () => openDlg('recordModal');
export const closeRecordModal = () => { ui.viewRecordId = null; closeDlg('recordModal'); };
export const openRecordsListModal = () => openDlg('recordsListModal');
export const closeRecordsListModal = () => { ui.recordsListOpen = false; closeDlg('recordsListModal'); };

export const openCaseCreateModal = () => {
  const d = dlg('caseCreateModal'); if (!d) return;
  const any = d as any;
  if (!any.__wired) { any.__wired = true; d.addEventListener('close', () => (ui.caseCreateOpen = false)); }
  !d.open && d.showModal();
};
export const closeCaseCreateModal = () => { ui.caseCreateOpen = false; closeDlg('caseCreateModal'); };

export const openTimelineModal = () => openDlg('timelineDetailModal');
export const closeTimelineModal = () => { ui.viewTimelineItem = null; closeDlg('timelineDetailModal'); };

export const openPaperModal = () => openDlg('paperModal');
export const closePaperModal = () => { ui.paperCaseId = null; ui.paperHash = null; closeDlg('paperModal'); };

export const openPaperPickModal = () => {
  ui.paperPickOpen = true;
  const d = dlg('paperPickModal'); if (!d) return;
  const any = d as any;
  if (!any.__wired) { any.__wired = true; d.addEventListener('close', () => (ui.paperPickOpen = false)); }
  !d.open && d.showModal();
};
export const closePaperPickModal = () => { ui.paperPickOpen = false; ui.paperPickQuery = ''; closeDlg('paperPickModal'); };


export const openCaseUpdateModal = () => openDlg('caseUpdateModal');
export const closeCaseUpdateModal = () => { ui.updateCaseId = ui.updateCandidatesForCaseId = null; ui.updateCandidates = null; ui.updateCandidatesLoading = false; closeDlg('caseUpdateModal'); };

/* drafts */
export const draftRecord = {
  intake: '상담' as const,
  actorTypeText: '학생', actorType: '학생' as ActorType, actorNameChoice: OTHER, actorNameOther: '',
  relTypeText: '학부모', relType: '학부모' as ActorType, relNameChoice: OTHER, relNameOther: '', related: [] as ActorRef[],
  placeText: '교실', place: '교실' as PlaceType, placeOther: '',
  storeTypeText: '전화', storeType: '전화' as StoreType, storeOther: '',
  lvText: 'LV2', lv: 'LV2' as Sensitivity,
  ts: toLocalInputValue(nowISO()),
  summary: '',
};
export const draftCase = {
  title: '', query: '', timeFrom: '', timeTo: '', maxResults: 80,
  actors: [] as ActorRef[],
  sensFilterText: 'any', sensFilter: 'any' as CaseSensFilter,
  statusText: '진행중', status: '진행중' as CaseStatus,
  addTypeText: '학생', addType: '학생' as ActorType, addNameChoice: OTHER, addNameOther: '',
};
export const draftStep = { ts: toLocalInputValue(nowISO()), name: '', note: '' };

/* selectors */
export const getSelectedCase = (): CaseItem | null => (S.selectedCaseId ? S.cases[S.selectedCaseId] ?? null : null);
export const visibleRecords = () => {
  const list = S.records.slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  if (!ui.qRecords.trim()) return list;
  return list.filter((r: RecordItem) =>
    matchLite([r.summary, actorShort(r.actor), storeLabel(r.storeType, r.storeOther), placeLabel(r.place, r.placeOther), r.ts].join(' '), ui.qRecords)
  );
};
export const visibleCases = () =>
  Object.keys(S.cases).sort((a, b) => String(S.cases[b]?.createdAt || '').localeCompare(String(S.cases[a]?.createdAt || '')));
