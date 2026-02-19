import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { uid, nowISO, toLocalInputValue, fromLocalInputValue, safeParseJSON, defaultState, normalizeState, loadState, saveState, wipeAll, STATUSES } from '../utils';
import type { ActorRef, PlaceType, StoreType, Sensitivity, StepItem } from '../engine';
import { OTHER, casesContainingRecord, addActorToList, buildRecordFromDraft, createCaseWithAdvisors, regenerateCaseAdvisors, buildCaseTimeline, getCaseUpdateCandidates, addRecordsToCase, recordsForCase } from '../engine';
import { S, setState, ui, toast, runToastAction, log, openConfirm, closeConfirm, openRecordModal, closeRecordModal,  openCaseCreateModal, closeCaseCreateModal, openTimelineModal, closeTimelineModal, openPaperModal, closePaperModal, openPaperPickModal, closePaperPickModal, openCaseUpdateModal, closeCaseUpdateModal, draftRecord, draftCase, draftStep, actorTypeTextFromInternal, actorTypeInternalFromText, getSelectedCase, logs, actorShort, LVS, PLACE_TYPES, STORE_TYPES, UI_OTHER_ACTOR_LABEL } from './state';
import { ensurePaperStyles, buildPaperPayload, computeCasePaperHash } from './paper';
import { render as renderView } from './views';

/* ---------- micro helpers ---------- */
const dlg = (id: string) => document.getElementById(id) as HTMLDialogElement | null;
const closeDlg = (id: string) => { const d = dlg(id); if (d?.open) d.close(); };
const openDlg = (id: string) => dlg(id)?.showModal();
const setText = (id: string, text: string) => { const el = document.getElementById(id); if (el) el.textContent = text; };

// render()가 전체 DOM을 갈아엎기 때문에(dialog 포함) 리렌더링 중 close 이벤트로 상태가 날아가는 걸 막고,
// 렌더 후 열려있어야 하는 dialog는 다시 열어준다.
let _isRerendering = false;
const syncDialogs = () => {
  if (ui.viewRecordId) openRecordModal();
  if (ui.caseCreateOpen) openCaseCreateModal();
  if (ui.viewTimelineItem) openTimelineModal();
  if (ui.paperPickOpen) openPaperPickModal();
  if (ui.paperCaseId || ui.paperHash) openPaperModal();
  if (ui.updateCaseId) openCaseUpdateModal();
};

// 메모 입력폼(컴포저)에서 저장 버튼/필수 경고를 전체 리렌더 없이 즉시 반영
function updateRecordComposerUI() {
  const btn = document.getElementById('btnSaveRecord') as HTMLButtonElement | null;
  const pill = document.getElementById('recordReqPill') as HTMLSpanElement | null;
  const wSum = document.getElementById('recordWarnSummary') as HTMLDivElement | null;
  const wTs = document.getElementById('recordWarnTs') as HTMLDivElement | null;
  const wAct = document.getElementById('recordWarnActor') as HTMLDivElement | null;

  // 현재 화면에 메모 입력폼이 없으면 스킵
  if (!btn && !pill && !wSum && !wTs && !wAct) return;

  const summaryTxt = String(draftRecord.summary || '').trim();
  const okSummary = summaryTxt.length >= 4;

  const okTs = String(draftRecord.ts || '').trim().length >= 10;

  const actorTypeText = String((draftRecord as any).actorTypeText || '').trim();
  const actorName = String(draftRecord.actorNameOther || '').trim();
  const allowEmptyActorName = actorTypeText === UI_OTHER_ACTOR_LABEL || actorTypeText === '없음';
  const okActor = allowEmptyActorName ? true : actorName.length > 0;

  const reqMissing: string[] = [];
  if (!okSummary) reqMissing.push('내용');
  if (!okTs) reqMissing.push('시간');
  if (!okActor) reqMissing.push('주체');
  const canSave = okSummary && okTs && okActor;
  const reqLabel = canSave ? '필수 입력 완료' : `필수: ${reqMissing.join(' · ')}`;

  if (pill) {
    pill.textContent = reqLabel;
    pill.classList.toggle('ready', canSave);
    pill.classList.toggle('warn', !canSave);
  }

  if (btn) {
    btn.disabled = !canSave;
    btn.setAttribute('aria-disabled', canSave ? 'false' : 'true');
    if (!canSave) btn.setAttribute('title', '필수 항목(내용/시간/주체)을 채우면 저장할 수 있어요');
    else btn.removeAttribute('title');
  }

  if (wSum) (wSum as any).hidden = okSummary;
  if (wTs) (wTs as any).hidden = okTs;
  if (wAct) (wAct as any).hidden = okActor;

  // 입력 강조(빨간 테두리 등)
  const elSum = document.getElementById('recordSummary') as HTMLTextAreaElement | null;
  const elTs = document.getElementById('recordTs') as HTMLInputElement | null;
  const elActorRow = document.getElementById('recordActorRow') as HTMLDivElement | null;
  if (elSum) elSum.classList.toggle('reqWarn', !okSummary);
  if (elTs) elTs.classList.toggle('reqWarn', !okTs);
  if (elActorRow) elActorRow.classList.toggle('reqWarn', !okActor);
}

const render = () => {
  _isRerendering = true;
  renderView();
  syncDialogs();
  updateRecordComposerUI();
  window.setTimeout(() => { _isRerendering = false; }, 0);
};

const SR = async () => { await saveState(S); render(); };
const toastUndo = (msg: string, undo: () => Promise<void>) => toast(msg, { label: '되돌리기', onClick: undo });
const flash = (id: string) => { ui.flashStepId = id; ui.flashStepTimer && clearTimeout(ui.flashStepTimer); ui.flashStepTimer = window.setTimeout(() => (ui.flashStepId = null, render()), 1800); };
const mustCase = (msg = '사건을 먼저 선택하세요') => { const c = getSelectedCase(); if (!c) toast(msg); return c; };
const openUpdate = (caseId: string) => (
  ui.updateCaseId = caseId,
  ui.qUpdate = '',
  ui.updatePickIds = [],
  ui.updFilterActor = ui.updFilterPlace = ui.updFilterKeyword = '',
  ui.updFilterActorDraft = ui.updFilterPlaceDraft = ui.updFilterKeywordDraft = '',
  render(),
  openCaseUpdateModal(),
  void refreshUpdateCandidates(caseId)
);

/* ---------- sample pack (demo) ---------- */
const SAMPLE_PACK_URL = new URL('../ui/sample_pack_v7.json', import.meta.url);
async function loadSamplePackJSON(): Promise<any> {
  const res = await fetch(SAMPLE_PACK_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`sample fetch failed: ${res.status}`);
  return await res.json();
}

/* ---------- case update candidates ---------- */
async function refreshUpdateCandidates(caseId: string) {
  const c = S.cases[caseId]; if (!c) return;
  ui.updateCandidatesLoading = true; ui.updateCandidatesForCaseId = caseId; ui.updateCandidates = null;
  render(); openCaseUpdateModal();
  try {
    const cand = await getCaseUpdateCandidates(c, S.records);
    if (ui.updateCaseId === caseId) ui.updateCandidates = cand;
  } catch (e) {
    ui.updateCandidates = []; log('update candidates failed', e);
  } finally {
    ui.updateCandidatesLoading = false; render(); openCaseUpdateModal();
  }
}

/* ---------- defaults (draft) ---------- */
const DEFAULT_RECORD = () => ({
  intake: '상담', actorTypeText: '학생', actorType: '학생', actorNameChoice: OTHER, actorNameOther: '',
  relTypeText: '학부모', relType: '학부모', relNameChoice: OTHER, relNameOther: '', related: [],
  placeText: '교실', place: '교실', placeOther: '',
  storeTypeText: '전화', storeType: '전화', storeOther: '',
  lvText: 'LV2', lv: 'LV2', ts: toLocalInputValue(nowISO()), summary: ''
});
const DEFAULT_CASE = () => ({
  title: '', query: '', timeFrom: '', timeTo: '', maxResults: 80, actors: [],
  onlyMainActor: false,
  sensFilterText: 'any', sensFilter: 'any', statusText: '진행중', status: '진행중',
  addTypeText: '학생', addType: '학생', addNameChoice: OTHER, addNameOther: ''
});

/* ---------- event binding ---------- */
let _bound = false;

// backup/restore (file)
let _restoreFileText: string | null = null;
let _restoreFileName: string | null = null;
function bindEvents() {
  if (_bound) return; _bound = true;

  const click: Record<string, (btn: HTMLElement) => void | Promise<void>> = {
    'toast-action': () => runToastAction(),
    'confirm-yes': () => closeConfirm(true), 'confirm-no': () => closeConfirm(false),

    'close-record': () => (closeRecordModal(), render()),
    'clear-record-filters': () => (ui.recFilterActor = ui.recFilterPlace = ui.recFilterKeyword = '', ui.recFilterActorDraft = ui.recFilterPlaceDraft = ui.recFilterKeywordDraft = '', render(), log('record filters cleared')),
    'apply-record-filters': () => (ui.recFilterActor = ui.recFilterActorDraft, ui.recFilterPlace = ui.recFilterPlaceDraft, ui.recFilterKeyword = ui.recFilterKeywordDraft, render(), log('record filters applied')),
    'apply-update-filters': () => (ui.updFilterActor = ui.updFilterActorDraft, ui.updFilterPlace = ui.updFilterPlaceDraft, ui.updFilterKeyword = ui.updFilterKeywordDraft, render(), log('update filters applied')),
    'clear-update-filters': () => (ui.updFilterActor = ui.updFilterPlace = ui.updFilterKeyword = '', ui.updFilterActorDraft = ui.updFilterPlaceDraft = ui.updFilterKeywordDraft = '', render(), log('update filters cleared')),
    'close-timeline-detail': () => (closeTimelineModal(), render()),

    tab: async (btn) => {
      const nextTab = (btn.dataset.tab === 'cases' ? 'cases' : 'records') as any;
      if (nextTab === 'cases') { S.selectedCaseId = null; ui.qTimeline = ''; }
      S.tab = nextTab; await saveState(S); log(`tab -> ${S.tab}`); render();
    },

    'open-case-create': () => (S.tab = 'cases' as any, ui.caseCreateOpen = true, render(), openCaseCreateModal(), void saveState(S), log('case create modal open')),
    'close-case-create': () => (closeCaseCreateModal(), render(), log('case create modal close')),

    'saved-close': () => closeDlg('savedModal'),
    'saved-view-record': () => { const id = (ui as any).lastSavedRecordId as string | undefined; closeDlg('savedModal'); if (!id) return; ui.viewRecordId = id; render(); openRecordModal(); log('saved modal -> view record', id); },
    'case-created-close': () => closeDlg('caseCreatedModal'),
    'case-created-open': () => { closeDlg('caseCreatedModal'); S.tab = 'cases' as any; void saveState(S); render(); },
    'case-created-open-paper': async () => { closeDlg('caseCreatedModal'); const c = mustCase(); if (!c) return; ui.paperCaseId = c.id; ui.paperHash = await computeCasePaperHash(c); render(); openPaperModal(); log('paper open (case created modal)', c.id); },

    backup: async () => {
      const json = JSON.stringify({ v: 7, exportedAt: nowISO(), state: S }, null, 2);
      const ts = nowISO().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
      const suggested = `roosycozy_backup_${ts}.json`;

      const path = await saveDialog({
        defaultPath: suggested,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return;

      try {
        const saved = await invoke<string>('export_backup_json', { args: { fileName: path, json } });
        toast('백업 파일 저장됨 ✅');
        log('backup saved', saved);
      } catch (e) {
        toast('백업 저장에 실패했어요');
        log('backup save failed', e);
      }
    },
'load-sample': async () => {
      if (!(await openConfirm('샘플 데이터를 불러올까요?(현재 데이터는 샘플로 덮어써집니다)'))) return;
      try {
        const pack = await loadSamplePackJSON();
        const next = normalizeState(pack as any); next.tab = 'records'; next.selectedCaseId = null;
        setState(next); await saveState(S); syncDraftDefaults(); render(); toast('샘플 데이터를 불러왔어요 ✅'); log('sample loaded');
      } catch (e) { log('sample load failed', e); toast('샘플 불러오기에 실패했어요'); }
    },

    'open-restore': () => {
      openDlg('restoreModal');
      const info = document.getElementById('restoreFileName');
      if (info) info.textContent = _restoreFileName ? `선택됨: ${_restoreFileName}` : '선택된 파일 없음';
      log('restore modal open');
    },

    'pick-restore-file': () => {
      const input = document.getElementById('restoreFile') as HTMLInputElement | null;
      input?.click();
    },

    'close-restore': () => closeDlg('restoreModal'),

    'do-restore': async () => {
      const parsed = safeParseJSON(_restoreFileText || '');
      if (!parsed || typeof parsed !== 'object') return toast('백업 파일을 먼저 선택하세요');

      const next = normalizeState(parsed as any);
      next.tab = 'cases';
      next.selectedCaseId = null;

      setState(next);
      await saveState(S);
      syncDraftDefaults();
      render();
      closeDlg('restoreModal');
      toast('복구 완료');
      log('restore ok');
    },

    'open-logs': () => (setText('logBox', logs.join('\n')), openDlg('logsModal')),
    'close-logs': () => closeDlg('logsModal'),
    'copy-logs': async () => (await navigator.clipboard.writeText(logs.join('\n')), toast('로그 복사')),
    'clear-logs': () => (logs.splice(0, logs.length), setText('logBox', ''), toast('로그 비우기')),
    wipe: async () => {
      if (!(await openConfirm('모든 데이터를 삭제할까요?'))) return;
      const prev = JSON.parse(JSON.stringify(S));
      await wipeAll();
      setState(defaultState());
      (S as any).tab = 'cases';
      syncDraftDefaults();
      render();
      toastUndo('전체 삭제됨', async () => {
        setState(prev);
        await saveState(S);
        syncDraftDefaults();
        render();
        toast('복구 완료');
      });
      toast('전체 삭제');
      log('wipe all');
    },

    'record-intake': (btn) => {
      const kind = String(btn.dataset.kind || '').trim(); if (!kind) return;
      (draftRecord as any).intake = kind;
      if (kind === '상담') { draftRecord.storeType = '방문상담'; if (draftRecord.place === '기타') draftRecord.place = '교무실'; }
      else if (kind === '관찰') { draftRecord.storeType = '기타'; if (!draftRecord.storeOther) draftRecord.storeOther = '현장관찰'; if (draftRecord.place === '교무실') draftRecord.place = '복도'; }
      else if (kind === '비정형') draftRecord.storeType = '업무메신저';
      else if (kind === '규정') draftRecord.storeType = '문서';
      (draftRecord as any).storeTypeText = draftRecord.storeType; (draftRecord as any).placeText = draftRecord.place; (draftRecord as any).lvText = draftRecord.lv;
      (draftRecord as any).actorTypeText = actorTypeTextFromInternal(draftRecord.actorType); (draftRecord as any).relTypeText = actorTypeTextFromInternal(draftRecord.relType);
      render(); toast(`채널: ${kind}`); log('record intake changed', kind);
    },

    'add-related': () => {
      const typeText = String((draftRecord as any).relTypeText || '').trim();
      const type = actorTypeInternalFromText(typeText);
      draftRecord.relType = type; (draftRecord as any).relTypeText = actorTypeTextFromInternal(type);
      const name = String(draftRecord.relNameOther || '').trim();
      if (!typeText || !name) return;
      draftRecord.relNameChoice = OTHER;
      draftRecord.related = addActorToList(draftRecord.related || [], { type, name });
      draftRecord.relNameOther = ''; render(); toast('관련자 추가'); log('related added', name);
    },
    'remove-related': (btn) => { const idx = Number(btn.dataset.idx ?? '-1'); if (!Number.isNaN(idx) && idx >= 0) (draftRecord.related = (draftRecord.related || []).filter((_, i) => i !== idx), render()); },
    'clear-record-draft': () => (Object.assign(draftRecord, DEFAULT_RECORD()), render()),

    'set-record-now': () => { draftRecord.ts = toLocalInputValue(nowISO()); render(); toast('시간: 지금'); log('record ts set now'); },

    'save-record': async () => {
      const actorTypeText = String((draftRecord as any).actorTypeText || '').trim();
      const placeText = String((draftRecord as any).placeText || '').trim();
      const storeText = String((draftRecord as any).storeTypeText || '').trim();
      const lvText = String((draftRecord as any).lvText || '').trim();

      const tsTxt = String(draftRecord.ts || '').trim();
      const summaryTxt = String(draftRecord.summary || '').trim();
      const actorNameTxt = String(draftRecord.actorNameOther || '').trim();
      const allowEmptyActorName = actorTypeText === UI_OTHER_ACTOR_LABEL || actorTypeText === '없음';
      const okActor = allowEmptyActorName ? true : actorNameTxt.length > 0;

      if (tsTxt.length < 10) return toast('시간을 입력하세요');
      if (!actorTypeText || !okActor) return toast('주체 정보를 입력하세요');
      if (summaryTxt.length < 4) return toast('내용을 4글자 이상 입력하세요');
      if (!placeText || !storeText || !lvText) return toast('필수 정보를 입력하세요');

      const placeIsKnown = (PLACE_TYPES as any).includes(placeText as any);
      const storeIsKnown = (STORE_TYPES as any).includes(storeText as any);
      const place: PlaceType = placeIsKnown ? (placeText as any) : ('기타' as any);
      const placeOther = placeText === '기타' ? String(draftRecord.placeOther || '').trim() : (placeIsKnown ? '' : placeText);
      const storeType: StoreType = storeIsKnown ? (storeText as any) : ('기타' as any);
      const storeOther = storeText === '기타' ? String(draftRecord.storeOther || '').trim() : (storeIsKnown ? '' : storeText);
      if (place === '기타' && !placeOther) return toast('장소 상세(기타)를 입력하세요');
      if (storeType === '기타' && !storeOther) return toast('보관형태 상세(기타)를 입력하세요');

      const relatedClean = (draftRecord.related || []).filter((a) => String((a as any)?.name || '').trim().length > 0);
      const { record, error } = buildRecordFromDraft({
        tsISO: fromLocalInputValue(draftRecord.ts), storeType, storeOther, lv: lvText as any,
        actorType: draftRecord.actorType, actorNameChoice: OTHER, actorNameOther: actorNameTxt || (allowEmptyActorName ? (actorTypeText === '없음' ? '없음' : '기타') : ''),
        related: relatedClean, place, placeOther, summary: String(draftRecord.summary || '').trim(),
      }, () => uid('REC'));
      if (error) return toast(error);

      S.records.unshift(record!);
      const sel = getSelectedCase();
      if (sel) S.cases[sel.id] = await addRecordsToCase(sel, S.records, [record!.id]);
      await saveState(S);
      draftRecord.summary = ''; draftRecord.related = []; render();
      (ui as any).lastSavedRecordId = record!.id;
      setText('savedMsg', `“${String(record!.summary || '').trim() || '메모'}” 저장됨`);
      setText('savedSub', sel ? '선택한 메모 묶음에 자동 반영됐어요.' : '사건(메모 묶음)에 모으려면 위에서 “스마트 모으기”를 사용해요.');
      openDlg('savedModal'); window.setTimeout(() => closeDlg('savedModal'), 1800);
      toast('저장 완료 ✅'); log('record saved', record!.id);
    },

    'view-record': (btn) => { const id = btn.dataset.id; if (!id) return; ui.viewRecordId = id; render(); openRecordModal(); log('record view', id); },
    'view-timeline': (btn) => { const id = btn.dataset.id; const kind = (btn.dataset.kind as any) || 'record'; if (!id) return; if (kind !== 'record' && kind !== 'advisor' && kind !== 'step') return; ui.viewTimelineItem = { kind, id }; render(); openTimelineModal(); log('timeline view', { kind, id }); },

    'delete-record': async (btn) => {
      const id = btn.dataset.id; if (!id) return;
      const r = S.records.find((x) => x.id === id); if (!r) return;
      const holders = casesContainingRecord(r, S.cases);
      if (holders.length) return void (toast(`사건 ${holders.length}개에 포함된 기록이라 삭제할 수 없어요.`), log('delete-record blocked (in cases)', id));
      if (!(await openConfirm('이 기록을 삭제할까요?'))) return;
      S.records = S.records.filter((x) => x.id !== id); await SR();
      toastUndo('기록 삭제됨', async () => (S.records.unshift(r), await SR(), toast('복구 완료')));
      log('record deleted', id);
    },

    'remove-record-from-case': async (btn) => {
      const c = mustCase(); if (!c) return;
      const id = btn.dataset.id; if (!id) return;
      if (!(await openConfirm('이 메모를 이 묶음에서 뺄까요? (메모 자체가 삭제되진 않아요)'))) return;
      
      const prevIds = (c.recordIds || []).slice();
      c.recordIds = prevIds.filter((x) => x !== id);
      await SR();
      toastUndo('묶음에서 제외됨', async () => { c.recordIds = prevIds; await SR(); toast('복구 완료'); });
      log('removed from case', id);
    },

    'copy-record': async (btn) => {
      const id = btn.dataset.id; if (!id) return;
      const r = S.records.find((x) => x.id === id); if (!r) return;
      await navigator.clipboard.writeText(JSON.stringify(r, null, 2));
      toast('복사'); log('record copied', id);
    },

    'add-case-actor': () => {
      const typeText = String((draftCase as any).addTypeText || '').trim();
      const type = actorTypeInternalFromText(typeText);
      (draftCase as any).addType = type; (draftCase as any).addTypeText = actorTypeTextFromInternal(type);
      const name = String(draftCase.addNameOther || '').trim();
      if (!typeText || !name) return toast('Actor 정보를 입력하세요');
      draftCase.addNameChoice = OTHER;
      draftCase.actors = addActorToList(draftCase.actors || [], { type, name });
      draftCase.addNameOther = ''; render(); toast('Actor 추가');
    },
    'remove-case-actor': (btn) => { const idx = Number(btn.dataset.idx ?? '-1'); if (!Number.isNaN(idx) && idx >= 0) (draftCase.actors = (draftCase.actors || []).filter((_, i) => i !== idx), render()); },
    'clear-case-draft': () => (Object.assign(draftCase, DEFAULT_CASE()), render()),

    'create-case': async () => {
      if (!(draftCase.actors || []).length) return toast('Actor를 1명 이상 추가한 뒤 시작할 수 있어요');

      // ✅ [제목 자동 생성 로직]
      let title = String(draftCase.title || '').trim();
      const query = String(draftCase.query || '').trim();

      if (!title) {
        // 제목이 비어있으면 "{주체} {요약(키워드)} 관련 사건" 포맷으로 생성
        const mainActor = draftCase.actors[0];
        const actorName = mainActor ? actorShort(mainActor) : '미정'; // ex: "학생 홍길동"
        
        // 요약이 너무 길면 잘라서 사용
        const shortQuery = query.length > 12 ? query.slice(0, 12) + '...' : query;
        
        title = `${actorName} ${shortQuery} 관련 사건`.replace(/\s+/g, ' ').trim();
      }

      const { caseItem, error, pickedCount } = await createCaseWithAdvisors({
        title, 
        actors: (draftCase.actors || []).slice(), 
        query,
        timeFromISO: draftCase.timeFrom ? fromLocalInputValue(draftCase.timeFrom) : '', 
        timeToISO: draftCase.timeTo ? fromLocalInputValue(draftCase.timeTo) : '',
        sensFilter: 'any' as any, 
        status: '진행중' as any, 
        maxResults: draftCase.maxResults,
        onlyMainActor: !!(draftCase as any).onlyMainActor
      }, S.records, () => uid('CASE'), nowISO);

      if (error) return toast(error);
      const c = caseItem!; S.cases[c.id] = c; S.selectedCaseId = c.id; S.tab = 'cases';
      Object.assign(draftCase, DEFAULT_CASE()); await SR(); closeCaseCreateModal(); render();
      setText('caseCreatedMsg', `“${String(c.title || '').trim() || '메모 묶음'}” 생성됨`);
      setText('caseCreatedSub', pickedCount ? `AI가 메모 ${pickedCount}개를 모았어요.` : 'AI가 포함할 메모를 찾지 못했어요.');
      openDlg('caseCreatedModal'); window.setTimeout(() => closeDlg('caseCreatedModal'), 2000);
      toast('생성 완료 ✅'); log('case created', c.id);
    },

    'select-case': async (btn) => { const id = btn.dataset.id; if (!id || !S.cases[id]) return; S.selectedCaseId = id; S.tab = 'cases'; await SR(); log('case selected', id); },
    'clear-case': async () => { S.selectedCaseId = null; ui.qTimeline = ''; await SR(); log('case cleared'); },

    'open-paper-picker': () => { if (!Object.keys(S.cases || {}).length) return toast('먼저 사건을 만들어주세요'); ui.paperPickOpen = true; ui.paperPickQuery = ''; render(); openPaperPickModal(); log('paper picker open'); },
    'close-paper-picker': () => (closePaperPickModal(), render(), log('paper picker close')),
    'pick-paper-case': async (btn) => { const id = String(btn.dataset.id || '').trim(); const c = id ? (S.cases[id] ?? null) : null; if (!c) return; ui.paperCaseId = c.id; ui.paperHash = await computeCasePaperHash(c); closePaperPickModal(); render(); openPaperModal(); log('paper open (picker)', c.id); },
    'paper-open-case-create': () => { closePaperPickModal(); S.tab = 'cases' as any; ui.caseCreateOpen = true; render(); openCaseCreateModal(); void saveState(S); log('case create modal open (from paper picker)'); },

    'open-paper': async () => { const c = mustCase(); if (!c) return; ui.paperCaseId = c.id; ui.paperHash = await computeCasePaperHash(c); render(); openPaperModal(); log('paper open', c.id); },
    'close-paper': () => (closePaperModal(), render()),
    'print-paper': async () => {
      const c = ui.paperCaseId ? S.cases[ui.paperCaseId] ?? null : null; if (!c) return;
      try {
        const suggested = `${c.title}__사건보고서.pdf`.replace(/\s+/g, ' ').trim();
        const path = await saveDialog({ defaultPath: suggested, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (!path) return toast('저장 취소됨');
        const generatedAt = nowISO();
        const recs = recordsForCase(S.records, c);
        const { events } = buildCaseTimeline(c, S.records, '');
        const payload = buildPaperPayload(c, recs, events, generatedAt, ui.paperHash);
        const savedPath = await invoke<string>('export_case_pdf', { args: { paper: payload, fileName: path } });
        toast('PDF 저장 완료'); log('paper pdf exported', savedPath);
      } catch (e: any) { console.error(e); toast(`PDF 저장 실패: ${String(e?.message || e)}`); }
    },

    'open-case-update': () => { const c = mustCase(); if (c) (openUpdate(c.id), log('case update modal open', c.id)); },
    'close-case-update': () => (closeCaseUpdateModal(), render()),
    'apply-case-update': async () => {
      const c = ui.updateCaseId ? S.cases[ui.updateCaseId] ?? null : null; if (!c) return toast('사건을 찾을 수 없어요');
      const ids = (ui.updatePickIds || []).slice();
      // fallback (혹시 state가 비어있을 때)
      if (!ids.length) {
        const checked = Array.from(dlg('caseUpdateModal')?.querySelectorAll<HTMLInputElement>('input[name="caseUpdPick"]:checked') || []);
        ids.push(...checked.map((x) => x.value).filter(Boolean));
      }
      if (!ids.length) return toast('선택된 항목이 없어요');
      S.cases[c.id] = await addRecordsToCase(c, S.records, ids);
      await SR(); closeCaseUpdateModal(); render(); toast(`${ids.length}개 메모 추가됨`); log('case records added', c.id, ids.length);
    },
    'delete-case': async (btn) => {
      const id = btn.dataset.id; if (!id || !S.cases[id]) return;
      if (!(await openConfirm('이 사건을 삭제할까요?'))) return;
      const deleted = S.cases[id]; delete S.cases[id]; if (S.selectedCaseId === id) S.selectedCaseId = null;
      await SR(); toastUndo('사건 삭제됨', async () => (S.cases[deleted.id] = deleted, await SR(), toast('복구 완료'))); log('case deleted', id);
    },

    'add-step': async () => {
      const c = mustCase(); if (!c) return;
      const name = draftStep.name.trim(), note = draftStep.note.trim();
      if (!name || !note) return toast('단계/내용은 필수예요');
      const step: StepItem = { id: uid('STEP'), ts: fromLocalInputValue(draftStep.ts), name, note, text: '', place: '', owner: '', lv: '' };
      c.steps = Array.isArray(c.steps) ? c.steps : []; c.steps.push(step);
      draftStep.name = ''; draftStep.note = ''; flash(step.id); await SR(); toast('내 조치 로그 추가됨'); log('step added', step.id);
    },
    'delete-step': async (btn) => {
      const c = mustCase(); const id = btn.dataset.id; if (!c || !id) return;
      if (!(await openConfirm('이 단계를 삭제할까요?'))) return;
      const deleted = (c.steps || []).find((s) => s.id === id); c.steps = (c.steps || []).filter((s) => s.id !== id);
      await SR(); toastUndo('단계 삭제됨', async () => { if (!deleted) return; c.steps = Array.isArray(c.steps) ? c.steps : []; c.steps.push(deleted); await SR(); toast('복구 완료'); }); log('step deleted', id);
    },
    'regen-advisors': async () => {
      const c = mustCase(); if (!c) return;
      if (!(await openConfirm('대응 가이드를 현재 규칙으로 다시 생성할까요? (숨긴 대응 가이드은 사라져요)'))) return;
      c.advisors = await regenerateCaseAdvisors(c, S.records); await SR(); toast('대응 가이드 재생성됨'); log('advisors regenerated', c.id);
    },
    'toggle-advisor-done': async (btn) => {
      const c = mustCase(); const id = btn.dataset.id; if (!c || !id) return;
      c.advisors = Array.isArray(c.advisors) ? c.advisors : []; const a = c.advisors.find((x) => x.id === id); if (!a) return;
      a.state = a.state === 'done' ? 'active' : 'done'; await SR(); toast(a.state === 'done' ? '완료 처리' : '다시 열기'); log('advisor toggled', id);
    },
    'dismiss-advisor': async (btn) => {
      const c = mustCase(); const id = btn.dataset.id; if (!c || !id) return;
      c.advisors = Array.isArray(c.advisors) ? c.advisors : []; const a = c.advisors.find((x) => x.id === id); if (!a) return;
      const prev = a.state; a.state = 'dismissed'; await SR(); toastUndo('대응 가이드 숨김', async () => (a.state = prev, await SR(), toast('복구 완료'))); log('advisor dismissed', id);
    },
    'advisor-to-step': async (btn) => {
      const c = mustCase(); const id = btn.dataset.id; if (!c || !id) return;
      c.advisors = Array.isArray(c.advisors) ? c.advisors : []; const a = c.advisors.find((x) => x.id === id); if (!a) return;
      const step: StepItem = { id: uid('STEP'), ts: String(a.ts || nowISO()), name: `대응 가이드: ${a.title}`.slice(0, 60), note: a.body, text: '', place: '', owner: '', lv: '' };
      c.steps = Array.isArray(c.steps) ? c.steps : []; c.steps.push(step); a.state = 'done'; flash(step.id); await SR(); toast('내 조치 로그로 저장됨'); log('advisor -> step', `${id} -> ${step.id}`);
    },
  };

  document.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    const action = btn?.dataset.action; if (!btn || !action) return;
    try { const fn = click[action]; if (fn) await fn(btn); } catch (err) { toast('오류 발생: 로그를 확인하세요'); log('ERROR', err); }
  });



  /* ---------- restore: file upload ---------- */
  const setRestoreLabel = () => {
    const info = document.getElementById('restoreFileName');
    if (info) info.textContent = _restoreFileName ? `선택됨: ${_restoreFileName}` : '선택된 파일 없음';
  };

  const readRestoreFile = (file: File) => {
    _restoreFileName = file.name || 'backup.json';
    setRestoreLabel();

    const reader = new FileReader();
    reader.onload = () => {
      _restoreFileText = String(reader.result || '');
      setRestoreLabel();
      toast('백업 파일 선택됨');
      log('restore file loaded', _restoreFileName || '');
    };
    reader.onerror = () => {
      _restoreFileText = null;
      toast('파일을 읽지 못했어요');
      log('restore file read error', _restoreFileName || '');
    };
    reader.readAsText(file, 'utf-8');
  };

  // file input change
  document.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement | null;
    if (!input || input.id !== 'restoreFile') return;
    const file = input.files?.[0];
    if (!file) return;
    readRestoreFile(file);
  });

  // drag & drop on drop zone
  const dzOf = (t: EventTarget | null) =>
    (t as HTMLElement | null)?.closest<HTMLElement>('#restoreDropZone');

  document.addEventListener('dragover', (e) => {
    const dz = dzOf(e.target);
    if (!dz) return;
    e.preventDefault();
    dz.classList.add('isDrag');
  });

  document.addEventListener('dragleave', (e) => {
    const dz = dzOf(e.target);
    if (!dz) return;
    dz.classList.remove('isDrag');
  });

  document.addEventListener('drop', (e) => {
    const dz = dzOf(e.target);
    if (!dz) return;
    e.preventDefault();
    dz.classList.remove('isDrag');
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) readRestoreFile(file);
  });

  /* ---------- input/change routing ---------- */
  const rec: Record<string, (v: string) => void> = {
    actorTypeText: (v) => { const t = actorTypeInternalFromText(v); draftRecord.actorType = t; (draftRecord as any).actorTypeText = actorTypeTextFromInternal(t); render(); },
    actorNameOther: (v) => (draftRecord.actorNameChoice = OTHER, draftRecord.actorNameOther = v),
    relTypeText: (v) => { const t = actorTypeInternalFromText(v); draftRecord.relType = t; (draftRecord as any).relTypeText = actorTypeTextFromInternal(t); render(); },
    relNameOther: (v) => (draftRecord.relNameChoice = OTHER, draftRecord.relNameOther = v),
    placeText: (v) => { (draftRecord as any).placeText = v; draftRecord.place = (PLACE_TYPES as any).includes(v as any) ? (v as PlaceType) : ('기타' as PlaceType); if (draftRecord.place !== '기타') draftRecord.placeOther = ''; render(); },
    placeOther: (v) => (draftRecord.placeOther = v),
    storeTypeText: (v) => { (draftRecord as any).storeTypeText = v; draftRecord.storeType = (STORE_TYPES as any).includes(v as any) ? (v as StoreType) : ('기타' as StoreType); if (draftRecord.storeType !== '기타') draftRecord.storeOther = ''; render(); },
    storeOther: (v) => (draftRecord.storeOther = v),
    lvText: (v) => ((draftRecord as any).lvText = v, (LVS as any).includes(v as any) && (draftRecord.lv = v as Sensitivity)),
    ts: (v) => (draftRecord.ts = v),
    summary: (v) => (draftRecord.summary = v),
  };

  const cas: Record<string, (v: string) => void> = {
    title: (v) => (draftCase.title = v), query: (v) => (draftCase.query = v), timeFrom: (v) => (draftCase.timeFrom = v), timeTo: (v) => (draftCase.timeTo = v),
    maxResults: (v) => (draftCase.maxResults = Math.max(1, Math.min(400, Number(v) || 80))),
    sensFilterText: (v) => { (draftCase as any).sensFilterText = v; const vv = String(v || '').trim(); if (vv === 'any' || vv === '전체') draftCase.sensFilter = 'any'; else if ((LVS as any).includes(vv as any)) draftCase.sensFilter = vv as any; },
    statusText: (v) => { (draftCase as any).statusText = v; const vv = String(v || '').trim(); (STATUSES as any).includes(vv as any) && (draftCase.status = vv as any); },
    addTypeText: (v) => { const t = actorTypeInternalFromText(v); draftCase.addType = t; (draftCase as any).addTypeText = actorTypeTextFromInternal(t); render(); },
    addNameOther: (v) => (draftCase.addNameChoice = OTHER, draftCase.addNameOther = v),
    onlyMainActor: (v) => ((draftCase as any).onlyMainActor = (v === 'true')),
  };

  const step: Record<string, (v: string) => void> = { ts: (v) => (draftStep.ts = v), name: (v) => (draftStep.name = v), note: (v) => (draftStep.note = v) };

  const handle = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    const action = el.dataset.action, field = el.dataset.field; if (!action || !field) return;
    const v = (el instanceof HTMLInputElement && el.type === 'checkbox') ? (el.checked ? 'true' : 'false') : el.value;
    if (action === 'draft-record-filters') {
      if (field === 'actor') ui.recFilterActorDraft = v;
      else if (field === 'place') ui.recFilterPlaceDraft = v;
      else if (field === 'keyword') ui.recFilterKeywordDraft = v;
      return;
    }
    if (action === 'draft-update-filters') {
      if (field === 'actor') ui.updFilterActorDraft = v;
      else if (field === 'place') ui.updFilterPlaceDraft = v;
      else if (field === 'keyword') ui.updFilterKeywordDraft = v;
      return;
    }
    if (action === 'toggle-update-pick') {
      const id = String((el as HTMLInputElement).value || '').trim();
      if (!id) return;
      const arr = ui.updatePickIds || (ui.updatePickIds = []);
      const has = arr.includes(id);
      const want = (el as HTMLInputElement).checked;
      if (want && !has) arr.push(id);
      if (!want && has) ui.updatePickIds = arr.filter((x) => x !== id);
      return;
    }
    if (action === 'search-timeline') return void (ui.qTimeline = v, render());
    if (action === 'search-paper-cases') return void (ui.paperPickQuery = v, render());
    if (action === 'search-update-candidates') return void (ui.qUpdate = v, render()); 
    const table = action === 'draft-record' ? rec : action === 'draft-case' ? cas : action === 'draft-step' ? step : null;
    table?.[field]?.(v);
    if (action === 'draft-record') updateRecordComposerUI();
  };

  const watch = '[data-action="draft-record"],[data-action="draft-case"],[data-action="draft-step"],[data-action="draft-record-filters"],[data-action="draft-update-filters"],[data-action="toggle-update-pick"],[data-action="search-timeline"],[data-action="search-paper-cases"],[data-action="search-update-candidates"]';
  document.addEventListener('input', (e) => { const el = (e.target as HTMLElement | null)?.closest<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(watch); el && handle(el); });
  document.addEventListener('change', (e) => { const el = (e.target as HTMLElement | null)?.closest<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-action="draft-record"],[data-action="draft-case"],[data-action="draft-step"],[data-action="draft-record-filters"],[data-action="draft-update-filters"],[data-action="toggle-update-pick"]'); el && handle(el); });

  document.addEventListener('close', (e) => {
    const t = e.target as HTMLElement | null; if (!t) return;
    if (_isRerendering) return;
    if ((t as any).id === 'recordModal') ui.viewRecordId = null;
    if ((t as any).id === 'paperPickModal') ui.paperPickOpen = false;
    if ((t as any).id === 'paperModal') (ui.paperCaseId = null, ui.paperHash = null);
    if ((t as any).id === 'caseUpdateModal') (ui.updateCaseId = null, ui.updatePickIds = [], ui.updFilterActor = ui.updFilterPlace = ui.updFilterKeyword = '', ui.updFilterActorDraft = ui.updFilterPlaceDraft = ui.updFilterKeywordDraft = '', ui.updateCandidatesForCaseId = null, ui.updateCandidates = null, ui.updateCandidatesLoading = false);
  }, true);

  window.addEventListener('keydown', (e) => {
    const ae0 = document.activeElement as HTMLElement | null;
    if (ae0 && (ae0 as any).id === 'restoreDropZone' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const input = document.getElementById('restoreFile') as HTMLInputElement | null;
      input?.click();
      return;
    }


    // Enter로 필터 적용(메모 필터 / 업데이트 필터)
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      const ae = document.activeElement as HTMLElement | null;
      if (ae?.closest('[data-action="draft-record-filters"]')) {
        e.preventDefault();
        (document.querySelector('[data-action="apply-record-filters"]') as HTMLButtonElement | null)?.click();
        return;
      }
      if (ae?.closest('[data-action="draft-update-filters"]')) {
        e.preventDefault();
        (document.querySelector('[data-action="apply-update-filters"]') as HTMLButtonElement | null)?.click();
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const ae = document.activeElement as HTMLElement | null; if (!ae) return;
      if (ae.closest('[data-action="draft-record"][data-field="summary"]')) return void (e.preventDefault(), (document.querySelector('[data-action="save-record"]') as HTMLButtonElement | null)?.click());
      if (ae.closest('[data-action="draft-step"][data-field="note"]')) return void (e.preventDefault(), (document.querySelector('[data-action="add-step"]') as HTMLButtonElement | null)?.click());
    }

    if (e.key === 'Escape') {
      const c = dlg('confirmModal'); if (c?.open) return void (e.preventDefault(), closeConfirm(false));
      const sm = dlg('savedModal'); if (sm?.open) return void (e.preventDefault(), closeDlg('savedModal'));
      const cm = dlg('caseCreatedModal'); if (cm?.open) return void (e.preventDefault(), closeDlg('caseCreatedModal'));
      closeDlg('restoreModal'); closeDlg('logsModal');
      const rec = dlg('recordModal'); if (rec?.open) return void (e.preventDefault(), closeRecordModal(), render());
      const tl = dlg('timelineDetailModal'); if (tl?.open) return void (e.preventDefault(), closeTimelineModal(), render());
      const cu = dlg('caseUpdateModal'); if (cu?.open) return void (e.preventDefault(), closeCaseUpdateModal(), render());
    }
  });
}

function syncDraftDefaults() {
  draftRecord.actorNameChoice = OTHER; draftRecord.relNameChoice = OTHER; draftCase.addNameChoice = OTHER;
  (draftRecord as any).placeText ||= draftRecord.place; (draftRecord as any).storeTypeText ||= draftRecord.storeType; (draftRecord as any).lvText ||= draftRecord.lv;
  (draftRecord as any).actorTypeText ||= actorTypeTextFromInternal(draftRecord.actorType); (draftRecord as any).relTypeText ||= actorTypeTextFromInternal(draftRecord.relType);
  (draftCase as any).addTypeText ||= actorTypeTextFromInternal(draftCase.addType); (draftCase as any).sensFilterText ||= String(draftCase.sensFilter); (draftCase as any).statusText ||= draftCase.status;
}

export function initApp() {
  bindEvents(); ensurePaperStyles(); syncDraftDefaults();
  (S as any).tab = 'cases'; S.tab = 'cases'; render();
  (async () => {
    try { setState(await loadState()); log('state loaded'); }
    catch (e) { log('load failed', e); setState(defaultState()); }
    if (!S.tab) (S as any).tab = 'cases';
    syncDraftDefaults(); render();
  })();
}