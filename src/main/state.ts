import { nowISO, toLocalInputValue, esc, mustGetEl, defaultState, ensureRecordV8, LS_KEY, RELATIONSHIP_DEFAULT_GROUPS } from '../utils';
import type { AppState, RelationshipGroup, RelationshipGroupMember } from '../utils';
import type { Sensitivity, ActorType, ActorRef, StoreType, PlaceType, CaseSensFilter, CaseStatus, CaseItem, CaseUpdateCandidate, RecordItem, RecordSummaryParts } from '../engine';
import { OTHER } from '../engine';

export type TimelineTarget = { kind: 'record' | 'advisor' | 'step'; id: string };

export let S: AppState = defaultState();
export const $app = mustGetEl<HTMLDivElement>('#app');
export const setState = (next: AppState) => (S = next);

export const ui = {
  qRecords: '',
  qTimeline: '',
  qUpdate: '', // [추가] 업데이트 모달 내 검색어
  updatesNoteOpen: false,
  evidenceTab: 'write' as 'write' | 'list',
  caseTab: 'create' as 'create' | 'list' | 'proof',
  legalTab: 'simulation' as const,
  simulationDraft: {
    evidenceFilter: '',
    scenarioPreset: 'balanced',
    parentTone: 58,
    escalation: 46,
    persistence: 62,
    adminSupport: 52,
    publicSpread: 24,
    legalLeverage: 38,
    goal: 'stabilize',
  },
  simulationSelectedRecordIds: [] as string[],
  simulationCaseId: null as string | null,
  simulationPickerOpen: false,
  simulationPickerQuery: '',
  simulationPickerSelectedRecordIds: [] as string[],
  simulationDirty: true,
  simulationResult: null as null | {
    calculatedAt: string,
    bundleLabel: string,
    selectedCount: number,
    totalAvailable: number,
    responseIndex: number,
    evidencePower: number,
    counterLogic: number,
    escalationRisk: number,
    communicationControl: number,
    recommendedTone: string,
    recommendedAction: string,
    highlights: string[],
    caution: string[],
    nextSteps: string[],
  },
  strategyChatInput: '',
  strategyChatModel: 'roosy-hybrid' as 'roosy-hybrid',
  strategyChatModelMenuOpen: false,
  strategyChatPending: false,
  strategyChatPendingStartedAt: '',
  strategyChatError: '',
  strategyModelStatus: null as null | {
    windowsDownloadMode: boolean,
    downloadSupported: boolean,
    allReady: boolean,
    storageDir: string,
    models: Array<{
      id: string,
      label: string,
      filename: string,
      available: boolean,
      path: string,
    }>,
  },
  strategyModelStatusLoading: false,
  strategyModelDownloadPending: false,
  strategyModelDownloadMessage: '',
  strategyModelDownloadPercent: 0,
  strategyModelDownloadLabel: '',
  strategyModelDownloadIndeterminate: false,
  strategyModelDownloadReceivedMb: 0,
  strategyModelDownloadTotalMb: 0,
  strategyModelDownloads: {} as Record<string, {
    id: string,
    label: string,
    stage: string,
    message: string,
    pending: boolean,
    done: boolean,
    error: boolean,
  }>,
  strategyChatProgressLines: [] as string[],
  strategyChatProgressStage: '',
  strategyChatMessages: [] as Array<{
    id: string,
    role: 'assistant' | 'user' | 'system',
    content: string,
    ts: string,
    meta?: string,
  }>,
  strategyThreadPackageId: '',
  settingsOpen: false,
  recRelatedOpen: false, // 빠른 캡처 > 관계 항목 추가(details) 열림 상태
  recEditRelatedOpen: false, // 기록 수정 > 관계 항목 추가(details) 열림 상태
  // 메모 필터(사이드바) - draft는 입력값, applied는 적용된 값
  recFilterActor: '', recFilterPlace: '', recFilterKeyword: '',
  recFilterActorDraft: '', recFilterPlaceDraft: '', recFilterKeywordDraft: '',
  // '빠른 캡처' 모달 필터 - draft/applied 분리
  updFilterActor: '', updFilterPlace: '', updFilterKeyword: '',
  updFilterActorDraft: '', updFilterPlaceDraft: '', updFilterKeywordDraft: '',
  updatePickIds: [] as string[],
  viewRecordId: null as string | null,
  recordEditId: null as string | null,
  recordModalTab: 'current' as 'current' | 'history' | 'edit',
  recordsListOpen: false,
  caseCreateOpen: false,
  recordComposerOpen: false,
  viewTimelineItem: null as TimelineTarget | null,
  paperCaseId: null as string | null,
  paperHash: null as string | null,
  contentProofDraft: {
    senderName: '',
    senderAddress: '',
    recipientName: '',
    recipientAddress: '',
  },
  paperPickOpen: false,
  paperPickQuery: '',
  updateCaseId: null as string | null,
  updateCandidatesForCaseId: null as string | null,
  updateCandidates: null as CaseUpdateCandidate[] | null,
  updateCandidatesLoading: false,
  signatureModalMode: null as null | 'create' | 'amend',
  flashStepId: null as string | null,
  flashStepTimer: null as number | null,
  classRosterOpen: false,
  classRosterDraft: [] as RelationshipGroup[],
  classRosterGroupId: '' as string,
  pinLocked: false,
  pinModalOpen: false,
  pinEntryDraft: '',
  pinConfirmDraft: '',
  pinSettingsDraft: '',
  pinSettingsConfirmDraft: '',
};

export const UI_OTHER_ACTOR_LABEL = '직접입력';
export const LEGACY_UI_OTHER_ACTOR_LABEL = '기타/외부인';
export const UI_CLASS_ACTOR_LABEL = '프로필 템플릿';
export const UI_ACTOR_TYPES = ['당사자', '상대방', '참여자', UI_CLASS_ACTOR_LABEL, '기관/조직', UI_OTHER_ACTOR_LABEL] as const;
export const ACTOR_TYPES: ActorType[] = ['관리자', '학부모', '학생', '동료교사', '외부인', '기타'];
export const LVS: Sensitivity[] = ['LV1', 'LV2', 'LV3', 'LV4', 'LV5'];

export const STORE_TYPES: StoreType[] = (['메모','채팅','이메일','전화','녹취','사진','영상','문서','파일','웹 링크','방문 기록','공식 채널','기타'] as any) as StoreType[];
export const PLACE_TYPES: PlaceType[] = (['온라인','메신저','전화/회의','현장','사무 공간','집','이동 중','공공장소','기타'] as any) as PlaceType[];

export const CLASS_ROSTER_SIZE = 40;
export const emptyClassRoster = () => Array.from({ length: CLASS_ROSTER_SIZE }, () => '');
export const emptyRelationshipGroups = (): RelationshipGroup[] =>
  RELATIONSHIP_DEFAULT_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    members: [],
  }));
export const STUDENT_NAMES = Array.from({ length: 40 }, (_, i) => `당사자${i + 1}`);
export const PARENT_NAMES = Array.from({ length: 40 }, (_, i) => `상대방${i + 1}`);
export const ADMIN_NAMES = ['기관 담당', '연락 창구', '외부 자문', '지원 담당'];

export const SCREEN_PIN_STORAGE_KEY = `${LS_KEY}:screen_pin`;
export const SCREEN_PIN_LENGTH = 4;
export const normalizeScreenPin = (value: string) => String(value || '').replace(/\D+/g, '').slice(0, SCREEN_PIN_LENGTH);
export const isValidScreenPin = (value: string) => /^\d{4}$/.test(normalizeScreenPin(value));
export const readScreenPin = () => {
  try {
    const raw = String(window.localStorage.getItem(SCREEN_PIN_STORAGE_KEY) || '');
    return isValidScreenPin(raw) ? normalizeScreenPin(raw) : '';
  } catch {
    return '';
  }
};
export const hasScreenPin = () => !!readScreenPin();
export const saveScreenPin = (pin: string) => {
  const normalized = normalizeScreenPin(pin);
  if (!isValidScreenPin(normalized)) return false;
  try {
    window.localStorage.setItem(SCREEN_PIN_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
};
export const clearScreenPin = () => {
  try {
    window.localStorage.removeItem(SCREEN_PIN_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
};


export const actorTypeTextFromInternal = (t: ActorType) => {
  const v = String(t || '').trim();
  if (v === '학생') return '당사자';
  if (v === '학부모') return '상대방';
  if (v === '관리자') return '기관/조직';
  if (v === '동료교사') return '참여자';
  return UI_OTHER_ACTOR_LABEL;
};
export const normalizeActorTypeTextUI = (v: string) => {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s === LEGACY_UI_OTHER_ACTOR_LABEL || s === '외부인' || s === '기타') return UI_OTHER_ACTOR_LABEL;
  if (s === '학생') return '당사자';
  if (s === '학부모') return '상대방';
  if (s === '관리자') return '기관/조직';
  if (s === '동료교사') return '참여자';
  if (s === '우리반') return UI_CLASS_ACTOR_LABEL;
  return s;
};
export const actorTypeInternalFromText = (v: string): ActorType => {
  const s = normalizeActorTypeTextUI(v);
  if (!s || s === UI_OTHER_ACTOR_LABEL) return '외부인' as ActorType;
  if (s === UI_CLASS_ACTOR_LABEL) return '학생' as ActorType;
  if (s === '당사자') return '학생' as ActorType;
  if (s === '상대방') return '학부모' as ActorType;
  if (s === '기관/조직') return '관리자' as ActorType;
  if (s === '참여자') return '동료교사' as ActorType;
  return ((ACTOR_TYPES as any).includes(s) ? s : '외부인') as ActorType;
};
export const getClassRoster = () => {
  const flattened = getRelationshipGroups()
    .flatMap((group) => group.members.map((member) => String(member.name || '').trim()))
    .filter(Boolean)
    .slice(0, CLASS_ROSTER_SIZE);
  const raw = Array.isArray(S.classRoster) ? S.classRoster : [];
  return Array.from({ length: CLASS_ROSTER_SIZE }, (_, i) => String(flattened[i] || raw[i] || '').trim());
};
export const getClassRosterNames = () => getClassRoster().map((name) => String(name || '').trim()).filter(Boolean);

export const cloneRelationshipGroups = (groups?: RelationshipGroup[]) =>
  (Array.isArray(groups) ? groups : emptyRelationshipGroups()).map((group, groupIndex) => ({
    id: String(group?.id || RELATIONSHIP_DEFAULT_GROUPS[groupIndex]?.id || `group-${groupIndex + 1}`),
    title: String(group?.title || RELATIONSHIP_DEFAULT_GROUPS[groupIndex]?.title || `그룹${groupIndex + 1}`).trim(),
    members: (Array.isArray(group?.members) ? group.members : []).map((member, memberIndex) => ({
      id: String(member?.id || `${String(group?.id || `group-${groupIndex + 1}`)}-member-${memberIndex + 1}`),
      name: String(member?.name || '').trim(),
    })),
  }));

export const getRelationshipGroups = () => {
  const raw = Array.isArray((S as any).relationshipGroups) ? ((S as any).relationshipGroups as RelationshipGroup[]) : [];
  const groups = cloneRelationshipGroups(raw.length ? raw : emptyRelationshipGroups());
  for (const fallback of RELATIONSHIP_DEFAULT_GROUPS) {
    if (!groups.some((group) => group.id === fallback.id)) {
      groups.push({ id: fallback.id, title: fallback.title, members: [] });
    }
  }
  return groups.slice(0, Math.max(groups.length, RELATIONSHIP_DEFAULT_GROUPS.length));
};

export const getRelationshipGroup = (groupId: string) =>
  getRelationshipGroups().find((group) => group.id === String(groupId || '').trim()) || null;

export const getRelationshipMembers = (groupId: string): RelationshipGroupMember[] =>
  (getRelationshipGroup(groupId)?.members || []).filter((member) => String(member?.name || '').trim());

export const getRelationshipMember = (groupId: string, memberId: string) =>
  getRelationshipMembers(groupId).find((member) => member.id === String(memberId || '').trim()) || null;

export const makeRelationshipActorRef = (groupId: string, memberId: string): ActorRef | null => {
  const group = getRelationshipGroup(groupId);
  const member = getRelationshipMember(groupId, memberId);
  if (!group || !member) return null;
  const name = String(member.name || '').trim();
  const groupLabel = String(group.title || '').trim();
  if (!name) return null;
  return {
    type: '기타',
    name,
    groupId: group.id,
    ...(groupLabel ? { groupLabel } : {}),
  };
};

export const serializeActorChoice = (actor: ActorRef) =>
  [
    encodeURIComponent(String(actor?.type || '').trim()),
    encodeURIComponent(String(actor?.name || '').trim()),
    encodeURIComponent(String((actor as any)?.groupId || '').trim()),
    encodeURIComponent(String((actor as any)?.groupLabel || '').trim()),
  ].join('::');

export const parseActorChoice = (raw: string): ActorRef | null => {
  const [type, name, groupId, groupLabel] = String(raw || '').split('::').map((part) => decodeURIComponent(part || ''));
  if (!String(name || '').trim()) return null;
  return {
    type: ((String(type || '').trim() || '기타') as ActorType),
    name: String(name || '').trim(),
    ...(String(groupId || '').trim() ? { groupId: String(groupId || '').trim() } : {}),
    ...(String(groupLabel || '').trim() ? { groupLabel: String(groupLabel || '').trim() } : {}),
  };
};

export const getRecordArchiveMainActors = () => {
  const out: ActorRef[] = [];
  for (const record of S.records || []) {
    for (const actor of recordMainActors(record)) {
      if (!out.some((item) => actorEqLite(item, actor))) out.push(actor);
    }
  }
  return out.sort((a, b) => actorShort(a).localeCompare(actorShort(b), 'ko'));
};

export const getRecordArchiveRelatedActors = () => {
  const out: ActorRef[] = [];
  for (const record of S.records || []) {
    for (const actor of Array.isArray(record.related) ? record.related : []) {
      const safe = {
        type: (actor?.type || '기타') as ActorType,
        name: String(actor?.name || '').trim(),
        ...(String((actor as any)?.groupId || '').trim() ? { groupId: String((actor as any).groupId).trim() } : {}),
        ...(String((actor as any)?.groupLabel || '').trim() ? { groupLabel: String((actor as any).groupLabel).trim() } : {}),
      } as ActorRef;
      if (!safe.name) continue;
      if (!out.some((item) => actorEqLite(item, safe))) out.push(safe);
    }
  }
  return out.sort((a, b) => actorShort(a).localeCompare(actorShort(b), 'ko'));
};

export const nameDatalistIdForActorTypeText = (typeText: string) => {
  const t = String(typeText || '').trim();
  return t === '당사자' ? 'dlNameStudent' : t === UI_CLASS_ACTOR_LABEL ? 'dlNameClassRoster' : t === '상대방' ? 'dlNameParent' : t === '기관/조직' ? 'dlNameAdmin' : '';
};

export const opt = (value: string, label: string, selected: string) =>
  `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
export const renderSelectOptions = (opts: { value: string; label: string }[], selected: string) => {
  const sel = normalizeActorTypeTextUI(String(selected ?? ''));
  const normalizedOpts = opts.map((o) => ({
    value: normalizeActorTypeTextUI(o.value),
    label: normalizeActorTypeTextUI(o.label),
  }));
  const merged = normalizedOpts.some((o) => o.value === sel) ? normalizedOpts : [{ value: sel, label: sel }, ...normalizedOpts];
  return merged.map((o) => opt(o.value, o.label, sel)).join('');
};
export const renderSelectFromList = (values: readonly string[], selected: string) =>
  renderSelectOptions((values || []).map((v) => ({ value: v, label: v })), selected);
export const renderSelectFromListWithPlaceholder = (values: readonly string[], selected: string, placeholder: string, includeUnknownSelected = true) => {
  const sel = normalizeActorTypeTextUI(String(selected || ''));
  const base = (values || []).map((v) => normalizeActorTypeTextUI(v)).filter((v, i, arr) => arr.indexOf(v) === i);
  const merged = includeUnknownSelected && sel && !base.includes(sel) ? [sel, ...base] : base;
  const effectiveSel = merged.includes(sel) ? sel : '';
  return `<option value="" ${!effectiveSel ? 'selected' : ''} disabled>${esc(placeholder)}</option>` + merged.map((v) => opt(v, v, effectiveSel)).join('');
};
export const renderNameFieldForType = (args: { typeText: string; value: string; action: 'draft-record' | 'draft-record-edit' | 'draft-case'; field: string; placeholder: string; }) => {
  const t = String(args.typeText || '').trim();
  const v = String(args.value || '');
  const common = `data-action="${esc(args.action)}" data-field="${esc(args.field)}"`;
  if (t === UI_CLASS_ACTOR_LABEL) {
    const list = getClassRosterNames();
    const ph = list.length ? '프로필 템플릿 선택' : '프로필 템플릿을 먼저 저장하세요';
    return `<select ${common} ${list.length ? '' : 'disabled'}>${list.length ? renderSelectFromListWithPlaceholder(list as any, v, ph, false) : `<option value="" selected disabled>${esc(ph)}</option>`}</select>`;
  }
  if (!(t === '당사자' || t === '상대방' || t === '기관/조직')) return `<input value="${esc(v)}" placeholder="${esc(args.placeholder)}" ${common} />`;
  const list = t === '당사자' ? STUDENT_NAMES : t === '상대방' ? PARENT_NAMES : ADMIN_NAMES;
  const ph = t === '당사자' ? '당사자 선택' : t === '상대방' ? '상대방 선택' : '기관/조직 선택';
  return `<select ${common}>${renderSelectFromListWithPlaceholder(list as any, v, ph, false)}</select>`;
};

export const matchLite = (text: string, q: string) => !String(q || '').trim() || String(text || '').toLowerCase().includes(String(q || '').trim().toLowerCase());
export const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));
export const actorEqLite = (a: ActorRef, b: ActorRef) =>
  String(a?.type ?? '').trim() === String(b?.type ?? '').trim() &&
  String(a?.name ?? '').trim() === String(b?.name ?? '').trim() &&
  String((a as any)?.groupId ?? '').trim() === String((b as any)?.groupId ?? '').trim() &&
  String((a as any)?.groupLabel ?? '').trim() === String((b as any)?.groupLabel ?? '').trim();
export const recordMainActors = (r: any): ActorRef[] => {
  const raw = Array.isArray(r?.actors) && r.actors.length ? r.actors : [r?.actor];
  const out: ActorRef[] = [];
  for (const item of raw) {
    const a = {
      type: ((item?.type || '외부인') as ActorType),
      name: String(item?.name || '').trim(),
      ...(String((item as any)?.groupId || '').trim() ? { groupId: String((item as any).groupId).trim() } : {}),
      ...(String((item as any)?.groupLabel || '').trim() ? { groupLabel: String((item as any).groupLabel).trim() } : {}),
    } as ActorRef;
    if (!a.name) continue;
    if (!out.some((x) => actorEqLite(x, a))) out.push(a);
  }
  return out;
};
export const recordActorText = (r: any) => {
  const mains = recordMainActors(r);
  if (!mains.length) return '—';
  return mains.map(actorShort).join(' · ');
};
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
export const actorLabel = (a: ActorRef) => {
  const groupLabel = String((a as any)?.groupLabel || '').trim();
  if (groupLabel) return `${groupLabel} · ${a.name || '기타'}`;
  return `${actorTypeTextFromInternal((a.type || '외부인') as any)} · ${a.name || '기타'}`;
};
export const actorShort = (a: ActorRef) => {
  const n = a.name || '기타';
  const groupLabel = String((a as any)?.groupLabel || '').trim();
  if (groupLabel) return `${groupLabel} ${n}`.trim();
  if (a.type === '학생') return `당사자 ${n}`;
  if (a.type === '학부모') return `상대방 ${n}`;
  if (a.type === '관리자') return `기관/조직 ${n}`;
  if (a.type === '동료교사') return `참여자 ${n}`;
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
const dlg = (id: string) => document.getElementById(id) as (HTMLDialogElement | HTMLElement | null);
const isDialogEl = (el: unknown): el is HTMLDialogElement => !!el && typeof (el as HTMLDialogElement).showModal === 'function' && typeof (el as HTMLDialogElement).close === 'function';
const openDlg = (id: string) => { const d = dlg(id); if (isDialogEl(d) && !d.open) d.showModal(); };
const closeDlg = (id: string) => { const d = dlg(id); if (isDialogEl(d) && d.open) d.close(); };

export const openRecordModal = () => openDlg('recordModal');
export const closeRecordModal = () => { ui.viewRecordId = null; ui.recordEditId = null; ui.recordModalTab = 'current'; ui.recEditRelatedOpen = false; closeDlg('recordModal'); };
export const openRecordsListModal = () => {
  // Legacy: 이전에는 "전체 목록"을 dialog로 열었지만,
  // 현재 UI에서는 우측 목록이 항상 보일 수 있어요.
  // 1) dialog가 있으면 열고, 2) 없으면 목록/필터로 스크롤 + 포커스만 이동.
  const d = dlg('recordsListModal');
  if (isDialogEl(d)) {
    ui.recordsListOpen = true;
    if (!d.open) d.showModal();
    return;
  }
  const list = document.getElementById('recordsList') as HTMLElement | null;
  list?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  (document.getElementById('memoFilterKeyword') as HTMLInputElement | null)?.focus();
};

export const closeRecordsListModal = () => {
  ui.recordsListOpen = false;
  closeDlg('recordsListModal');
};

export const openCaseCreateModal = () => {
  const d = dlg('caseCreateModal'); if (!isDialogEl(d)) return;
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
  const d = dlg('paperPickModal'); if (!isDialogEl(d)) return;
  const any = d as any;
  if (!any.__wired) { any.__wired = true; d.addEventListener('close', () => (ui.paperPickOpen = false)); }
  !d.open && d.showModal();
};
export const closePaperPickModal = () => { ui.paperPickOpen = false; ui.paperPickQuery = ''; closeDlg('paperPickModal'); };


export const openCaseUpdateModal = () => openDlg('caseUpdateModal');
export const closeCaseUpdateModal = () => {
  ui.updateCaseId = ui.updateCandidatesForCaseId = null;
  ui.updateCandidates = null;
  ui.updateCandidatesLoading = false;
  ui.updatePickIds = [];
  ui.updFilterActor = ui.updFilterPlace = ui.updFilterKeyword = '';
  ui.updFilterActorDraft = ui.updFilterPlaceDraft = ui.updFilterKeywordDraft = '';
  closeDlg('caseUpdateModal');
};

const emptySummaryParts = (): Required<RecordSummaryParts> => ({
  overview: '',
  background: '',
  issues: '',
  evidenceList: '',
  teacherActions: '',
  other: '',
});

const summaryPartsFromRecord = (record: any): Required<RecordSummaryParts> => {
  const raw = (record && typeof record.summaryParts === 'object' && record.summaryParts) ? record.summaryParts : null;
  if (raw) {
    return {
      overview: String(raw.overview || '').trim(),
      background: String(raw.background || '').trim(),
      issues: String(raw.issues || '').trim(),
      evidenceList: String(raw.evidenceList || '').trim(),
      teacherActions: String(raw.teacherActions || '').trim(),
      other: String(raw.other || '').trim(),
    };
  }
  return {
    ...emptySummaryParts(),
    overview: String(record?.summary || '').trim(),
  };
};

/* drafts */
const RECORD_DRAFT_BASE = () => ({
  intake: '상담' as const,
  actorTypeText: '당사자', actorType: '학생' as ActorType, actorNameChoice: OTHER, actorNameOther: '', actors: [] as ActorRef[],
  actorGroupId: RELATIONSHIP_DEFAULT_GROUPS[0].id as string,
  actorMemberId: '',
  relTypeText: '상대방', relType: '학부모' as ActorType, relNameChoice: OTHER, relNameOther: '', related: [] as ActorRef[],
  relGroupId: RELATIONSHIP_DEFAULT_GROUPS[0].id as string,
  relMemberId: '',
  placeText: '온라인', place: '온라인' as PlaceType, placeOther: '',
  storeTypeText: '전화', storeType: '전화' as StoreType, storeOther: '',
  lvText: 'LV2', lv: 'LV2' as Sensitivity,
  ts: toLocalInputValue(nowISO()),
  summary: '',
  summaryOverview: '',
  summaryBackground: '',
  summaryIssues: '',
  summaryEvidenceList: '',
  summaryTeacherActions: '',
  summaryOther: '',
  signerLabel: '전자서명',
  sealReason: '',
});
export const draftRecord = RECORD_DRAFT_BASE();
export const draftRecordEdit = RECORD_DRAFT_BASE();

export function resetRecordEditDraft() {
  Object.assign(draftRecordEdit, RECORD_DRAFT_BASE());
}

export function loadRecordEditDraft(record: any) {
  const r = ensureRecordV8(record) as any;
  const parts = summaryPartsFromRecord(r);
  draftRecordEdit.intake = '상담';
  draftRecordEdit.actorType = (r.actor?.type || '학생') as ActorType;
  draftRecordEdit.actorTypeText = actorTypeTextFromInternal(draftRecordEdit.actorType);
  draftRecordEdit.actorNameChoice = OTHER;
  draftRecordEdit.actorNameOther = '';
  draftRecordEdit.actors = Array.isArray(r.actors) && r.actors.length
    ? JSON.parse(JSON.stringify(r.actors))
    : (r.actor?.name ? [{ type: r.actor.type, name: r.actor.name }] : []);
  draftRecordEdit.relTypeText = '상대방';
  draftRecordEdit.relType = '학부모' as ActorType;
  draftRecordEdit.relNameChoice = OTHER;
  draftRecordEdit.relNameOther = '';
  draftRecordEdit.related = Array.isArray(r.related) ? JSON.parse(JSON.stringify(r.related)) : [];
  draftRecordEdit.place = (r.place || '온라인') as PlaceType;
  draftRecordEdit.placeText = String(r.place || '온라인');
  draftRecordEdit.placeOther = String(r.placeOther || '');
  draftRecordEdit.storeType = (r.storeType || '전화') as StoreType;
  draftRecordEdit.storeTypeText = String(r.storeType || '전화');
  draftRecordEdit.storeOther = String(r.storeOther || '');
  draftRecordEdit.lv = (r.lv || 'LV2') as Sensitivity;
  draftRecordEdit.lvText = String(r.lv || 'LV2');
  draftRecordEdit.ts = toLocalInputValue(String(r.ts || nowISO()));
  draftRecordEdit.summary = String(r.summary || '');
  draftRecordEdit.summaryOverview = parts.overview;
  draftRecordEdit.summaryBackground = parts.background;
  draftRecordEdit.summaryIssues = parts.issues;
  draftRecordEdit.summaryEvidenceList = parts.evidenceList;
  draftRecordEdit.summaryTeacherActions = parts.teacherActions;
  draftRecordEdit.summaryOther = parts.other;
  draftRecordEdit.signerLabel = '전자서명';
  draftRecordEdit.sealReason = '';
}

export const draftCase = {
  title: '', query: '', timeFrom: '', timeTo: '', maxResults: 80,
  onlyMainActor: false,
  actors: [] as ActorRef[],
  sensFilterText: 'any', sensFilter: 'any' as CaseSensFilter,
  statusText: '진행중', status: '진행중' as CaseStatus,
  mainActorKey: '',
  relatedActorKey: '',
};
export const draftStep = { ts: toLocalInputValue(nowISO()), name: '', note: '' };

/* selectors */
export const getSelectedCase = (): CaseItem | null => (S.selectedCaseId ? S.cases[S.selectedCaseId] ?? null : null);
export const visibleRecords = () => {
  // 최신순 정렬
  let list = S.records.slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  // 1) 검색창(qRecords)
  if (ui.qRecords.trim()) {
    list = list.filter((r: any) =>
      matchLite([r.summary, recordActorText(r), storeLabel(r.storeType, r.storeOther), placeLabel(r.place, r.placeOther), r.ts].join(' '), ui.qRecords)
    );
  }

  // 2) 메모 필터(적용된 값)
  const fa = String((ui as any).recFilterActor || '').trim();
  const fp = String((ui as any).recFilterPlace || '').trim();
  const fk = String((ui as any).recFilterKeyword || '').trim();

  if (fa) list = list.filter((r: any) => matchLite(recordActorText(r), fa));
  if (fp) list = list.filter((r: any) => String(r.place || '') === fp);
  if (fk) list = list.filter((r: any) => matchLite([r.summary, recordActorText(r), storeLabel(r.storeType, r.storeOther), placeLabel(r.place, r.placeOther), r.ts].join(' '), fk));

  return list;
};
export const visibleCases = () =>
  Object.keys(S.cases).sort((a, b) => String(S.cases[b]?.createdAt || '').localeCompare(String(S.cases[a]?.createdAt || '')));
