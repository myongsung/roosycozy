import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { uid, nowISO, toLocalInputValue, fromLocalInputValue, safeParseJSON, defaultState, normalizeState, loadState, saveState, wipeAll, STATUSES, ensureRecordV8, sealNewRecord, amendSignedRecord, verifyRecordIntegrity, buildSignedBackupEnvelope, verifyBackupEnvelope, reverifyStateRecords, refreshDeviceSignerInfo } from '../utils';
import type { ActorRef, PlaceType, StoreType, Sensitivity, StepItem } from '../engine';
import { OTHER, casesContainingRecord, addActorToList, buildRecordFromDraft, createCaseWithAdvisors, regenerateCaseAdvisors, buildCaseTimeline, getCaseUpdateCandidates, addRecordsToCase, recordsForCase } from '../engine';
import { S, setState, ui, toast, runToastAction, log, openConfirm, closeConfirm, openRecordModal, closeRecordModal,  openCaseCreateModal, closeCaseCreateModal, openTimelineModal, closeTimelineModal, openPaperModal, closePaperModal, openPaperPickModal, closePaperPickModal, openCaseUpdateModal, closeCaseUpdateModal, draftRecord, draftRecordEdit, draftCase, draftStep, actorTypeTextFromInternal, actorTypeInternalFromText, getSelectedCase, logs, actorShort, LVS, PLACE_TYPES, STORE_TYPES, UI_OTHER_ACTOR_LABEL, loadRecordEditDraft, resetRecordEditDraft } from './state';
import { ensurePaperStyles, buildPaperPayload, computeCasePaperHash } from './paper';
import { render as renderView } from './views';

/* ---------- micro helpers ---------- */
const dlg = (id: string) => document.getElementById(id) as HTMLDialogElement | null;
const closeDlg = (id: string) => { const d = dlg(id); if (d?.open) d.close(); };
const openDlg = (id: string) => dlg(id)?.showModal();
const setText = (id: string, text: string) => { const el = document.getElementById(id); if (el) el.textContent = text; };

const SIGNATURE_MODAL_ID = 'signatureModal';
const SIGN_SUCCESS_MODAL_ID = 'signSuccessModal';

const closeSignatureModal = () => {
  ui.signatureModalMode = null;
  closeDlg(SIGNATURE_MODAL_ID);
};
const openSignatureModal = (mode: 'create' | 'amend') => {
  ui.signatureModalMode = mode;
  render();
};
const openSignSuccessModal = (message: string, sub: string) => {
  setText('signSuccessMsg', message);
  setText('signSuccessSub', sub);
  openDlg(SIGN_SUCCESS_MODAL_ID);
  window.setTimeout(() => closeDlg(SIGN_SUCCESS_MODAL_ID), 1900);
};

// render()가 전체 DOM을 갈아엎기 때문에(dialog 포함) 리렌더링 중 close 이벤트로 상태가 날아가는 걸 막고,
// 렌더 후 열려있어야 하는 dialog는 다시 열어준다.
let _isRerendering = false;
const syncDialogs = () => {
  if (ui.viewRecordId) openRecordModal();
  if (ui.caseCreateOpen) openCaseCreateModal();
  if (ui.recordComposerOpen) openDlg('recordComposerModal');
  if (ui.viewTimelineItem) openTimelineModal();
  if (ui.paperPickOpen) openPaperPickModal();
  if (ui.paperCaseId || ui.paperHash) openPaperModal();
  if (ui.updateCaseId) openCaseUpdateModal();
  if (ui.settingsOpen) openDlg('settingsModal');
  if (ui.signatureModalMode) openDlg(SIGNATURE_MODAL_ID);
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


function updateRecordEditUI() {
  const btn = document.getElementById('btnSaveRecordAmend') as HTMLButtonElement | null;
  const pill = document.getElementById('recordEditReqPill') as HTMLSpanElement | null;
  const wSum = document.getElementById('recordEditWarnSummary') as HTMLDivElement | null;
  const wTs = document.getElementById('recordEditWarnTs') as HTMLDivElement | null;
  const wAct = document.getElementById('recordEditWarnActor') as HTMLDivElement | null;
  if (!btn && !pill && !wSum && !wTs && !wAct) return;

  const summaryTxt = String(draftRecordEdit.summary || '').trim();
  const okSummary = summaryTxt.length >= 4;
  const okTs = String(draftRecordEdit.ts || '').trim().length >= 10;
  const actorTypeText = String((draftRecordEdit as any).actorTypeText || '').trim();
  const actorName = String(draftRecordEdit.actorNameOther || '').trim();
  const allowEmptyActorName = actorTypeText === UI_OTHER_ACTOR_LABEL || actorTypeText === '없음';
  const okActor = allowEmptyActorName ? true : actorName.length > 0;

  const reqMissing: string[] = [];
  if (!okSummary) reqMissing.push('내용');
  if (!okTs) reqMissing.push('사건시각');
  if (!okActor) reqMissing.push('주체');
  const canSave = okSummary && okTs && okActor;
  const reqLabel = canSave ? '정정 봉인 가능' : `필수: ${reqMissing.join(' · ')}`;

  if (pill) {
    pill.textContent = reqLabel;
    pill.classList.toggle('ready', canSave);
    pill.classList.toggle('warn', !canSave);
  }
  if (btn) {
    btn.disabled = !canSave;
    btn.setAttribute('aria-disabled', canSave ? 'false' : 'true');
    if (!canSave) btn.setAttribute('title', '내용/사건시각/주체를 채우면 정정 봉인할 수 있어요');
    else btn.removeAttribute('title');
  }
  if (wSum) (wSum as any).hidden = okSummary;
  if (wTs) (wTs as any).hidden = okTs;
  if (wAct) (wAct as any).hidden = okActor;

  const elSum = document.getElementById('recordEditSummary') as HTMLTextAreaElement | null;
  const elTs = document.getElementById('recordEditTs') as HTMLInputElement | null;
  const elActorRow = document.getElementById('recordEditActorRow') as HTMLDivElement | null;
  if (elSum) elSum.classList.toggle('reqWarn', !okSummary);
  if (elTs) elTs.classList.toggle('reqWarn', !okTs);
  if (elActorRow) elActorRow.classList.toggle('reqWarn', !okActor);
}

// 렌더 전: render()가 DOM을 갈아엎기 때문에, <details> 같은 transient UI 상태를 저장해둔다.
function captureTransientUI() {
  const det = document.getElementById('recordRelatedDetails') as HTMLDetailsElement | null;
  if (det) ui.recRelatedOpen = !!det.open;
  const detEdit = document.getElementById('recordEditRelatedDetails') as HTMLDetailsElement | null;
  if (detEdit) ui.recEditRelatedOpen = !!detEdit.open;
}

const render = () => {
  captureTransientUI();
  _isRerendering = true;
  renderView();
  syncDialogs();
  updateRecordComposerUI();
  updateRecordEditUI();
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
  lvText: 'LV2', lv: 'LV2', ts: toLocalInputValue(nowISO()), summary: '',
  signerLabel: '기기 봉인서명', sealReason: ''
});
const DEFAULT_CASE = () => ({
  title: '', query: '', timeFrom: '', timeTo: '', maxResults: 80, actors: [],
  onlyMainActor: false,
  sensFilterText: 'any', sensFilter: 'any', statusText: '진행중', status: '진행중',
  addTypeText: '학생', addType: '학생', addNameChoice: OTHER, addNameOther: ''
});

function prepareRecordDraftForSeal() {
  const actorTypeText = String((draftRecord as any).actorTypeText || '').trim();
  const placeText = String((draftRecord as any).placeText || '').trim();
  const storeText = String((draftRecord as any).storeTypeText || '').trim();
  const lvText = String((draftRecord as any).lvText || '').trim();

  const tsTxt = String(draftRecord.ts || '').trim();
  const summaryTxt = String(draftRecord.summary || '').trim();
  const actorNameTxt = String(draftRecord.actorNameOther || '').trim();
  const allowEmptyActorName = actorTypeText === UI_OTHER_ACTOR_LABEL || actorTypeText === '없음';
  const okActor = allowEmptyActorName ? true : actorNameTxt.length > 0;

  if (tsTxt.length < 10) return { error: '시간을 입력하세요' };
  if (!actorTypeText || !okActor) return { error: '주체 정보를 입력하세요' };
  if (summaryTxt.length < 4) return { error: '내용을 4글자 이상 입력하세요' };
  if (!placeText || !storeText || !lvText) return { error: '필수 정보를 입력하세요' };

  const placeIsKnown = (PLACE_TYPES as any).includes(placeText as any);
  const storeIsKnown = (STORE_TYPES as any).includes(storeText as any);
  const place: PlaceType = placeIsKnown ? (placeText as any) : ('기타' as any);
  const placeOther = placeText === '기타' ? String(draftRecord.placeOther || '').trim() : (placeIsKnown ? '' : placeText);
  const storeType: StoreType = storeIsKnown ? (storeText as any) : ('기타' as any);
  const storeOther = storeText === '기타' ? String(draftRecord.storeOther || '').trim() : (storeIsKnown ? '' : storeText);
  if (place === '기타' && !placeOther) return { error: '장소 상세(기타)를 입력하세요' };
  if (storeType === '기타' && !storeOther) return { error: '보관형태 상세(기타)를 입력하세요' };

  const relatedClean = (draftRecord.related || []).filter((a) => String((a as any)?.name || '').trim().length > 0);

  return {
    actorTypeText,
    actorNameTxt,
    allowEmptyActorName,
    place,
    placeOther,
    storeType,
    storeOther,
    lvText,
    relatedClean,
    summary: summaryTxt,
    tsISO: fromLocalInputValue(draftRecord.ts),
  };
}

function prepareRecordEditForSeal() {
  const actorTypeText = String((draftRecordEdit as any).actorTypeText || '').trim();
  const placeText = String((draftRecordEdit as any).placeText || '').trim();
  const storeText = String((draftRecordEdit as any).storeTypeText || '').trim();
  const lvText = String((draftRecordEdit as any).lvText || '').trim();
  const tsTxt = String(draftRecordEdit.ts || '').trim();
  const summaryTxt = String(draftRecordEdit.summary || '').trim();
  const actorNameTxt = String(draftRecordEdit.actorNameOther || '').trim();
  const allowEmptyActorName = actorTypeText === UI_OTHER_ACTOR_LABEL || actorTypeText === '없음';
  const okActor = allowEmptyActorName ? true : actorNameTxt.length > 0;

  if (tsTxt.length < 10) return { error: '사건시각을 입력하세요' };
  if (!actorTypeText || !okActor) return { error: '주체 정보를 입력하세요' };
  if (summaryTxt.length < 4) return { error: '내용을 4글자 이상 입력하세요' };
  if (!placeText || !storeText || !lvText) return { error: '필수 정보를 입력하세요' };

  const placeIsKnown = (PLACE_TYPES as any).includes(placeText as any);
  const storeIsKnown = (STORE_TYPES as any).includes(storeText as any);
  const place: PlaceType = placeIsKnown ? (placeText as any) : ('기타' as any);
  const placeOther = placeText === '기타' ? String(draftRecordEdit.placeOther || '').trim() : (placeIsKnown ? '' : placeText);
  const storeType: StoreType = storeIsKnown ? (storeText as any) : ('기타' as any);
  const storeOther = storeText === '기타' ? String(draftRecordEdit.storeOther || '').trim() : (storeIsKnown ? '' : storeText);
  if (place === '기타' && !placeOther) return { error: '장소 상세(기타)를 입력하세요' };
  if (storeType === '기타' && !storeOther) return { error: '보관형태 상세(기타)를 입력하세요' };

  const relatedClean = (draftRecordEdit.related || []).filter((a) => String((a as any)?.name || '').trim().length > 0);

  return {
    actorTypeText,
    actorNameTxt,
    allowEmptyActorName,
    place,
    placeOther,
    storeType,
    storeOther,
    lvText,
    relatedClean,
    summary: summaryTxt,
    tsISO: fromLocalInputValue(draftRecordEdit.ts),
  };
}

/* ---------- event binding ---------- */
let _bound = false;

// backup/restore (file)
let _restoreFileText: string | null = null;
let _restoreFileName: string | null = null;
function bindEvents() {
  if (_bound) return; _bound = true;

  const finalizeCreateRecord = async () => {
    const prep = prepareRecordDraftForSeal() as any;
    if (prep.error) return toast(prep.error);

    const { record, error } = buildRecordFromDraft({
      tsISO: prep.tsISO, storeType: prep.storeType, storeOther: prep.storeOther, lv: prep.lvText as any,
      actorType: draftRecord.actorType, actorNameChoice: OTHER, actorNameOther: prep.actorNameTxt || (prep.allowEmptyActorName ? (prep.actorTypeText === '없음' ? '없음' : '기타') : ''),
      related: prep.relatedClean, place: prep.place, placeOther: prep.placeOther, summary: prep.summary,
    }, () => uid('REC'));
    if (error) return toast(error);

    const sealed = await sealNewRecord(record!, {
      sealedAt: nowISO(),
      signerLabel: String((draftRecord as any).signerLabel || '').trim() || '기기 봉인서명',
      reason: String((draftRecord as any).sealReason || '').trim() || '초기 기록 봉인',
    });

    S.records.unshift(sealed);
    const sel = getSelectedCase();
    if (sel) S.cases[sel.id] = await addRecordsToCase(sel, S.records, [sealed.id]);
    await saveState(S);

    draftRecord.summary = '';
    draftRecord.actorNameChoice = OTHER;
    draftRecord.actorNameOther = '';
    draftRecord.relNameChoice = OTHER;
    draftRecord.relNameOther = '';
    draftRecord.related = [];
    draftRecord.ts = toLocalInputValue(nowISO());
    (draftRecord as any).signerLabel = '기기 봉인서명';
    (draftRecord as any).sealReason = '';
    (ui as any).lastSavedRecordId = sealed.id;
    ui.recordComposerOpen = false;

    closeSignatureModal();
    render();

    openSignSuccessModal(
      '성공적으로 서명 및 인증이 완료되었습니다!',
      sel ? '증거가 저장되고 선택한 사건에도 자동 반영되었어요.' : '증거가 저장되었습니다.'
    );

    const sealVerify = verifyRecordIntegrity(sealed as any) as any;
    toast(`봉인 완료 ✅ ${sealVerify.trusted ? '기기서명 확인' : '봉인 저장됨'}`);
    log('record sealed', sealed.id, sealVerify.verificationStatus);
  };

  const finalizeAmendRecord = async () => {
    const id = String(ui.recordEditId || '').trim();
    if (!id) return toast('수정할 기록을 찾을 수 없어요');
    const idx = S.records.findIndex((x) => x.id === id);
    if (idx < 0) return toast('수정할 기록을 찾을 수 없어요');

    const prep = prepareRecordEditForSeal() as any;
    if (prep.error) return toast(prep.error);

    const current = ensureRecordV8(S.records[idx]) as any;
    const nextRecord = {
      ...current,
      id: current.id,
      ts: prep.tsISO,
      actor: { type: draftRecordEdit.actorType, name: prep.actorNameTxt || (prep.allowEmptyActorName ? (prep.actorTypeText === '없음' ? '없음' : '기타') : '') },
      related: prep.relatedClean,
      place: prep.place,
      placeOther: prep.placeOther,
      storeType: prep.storeType,
      storeOther: prep.storeOther,
      lv: prep.lvText as any,
      summary: prep.summary,
    } as any;

    const amended = await amendSignedRecord(current, nextRecord, {
      sealedAt: nowISO(),
      signerLabel: String((draftRecordEdit as any).signerLabel || '').trim() || '기기 봉인서명',
      reason: String((draftRecordEdit as any).sealReason || '').trim() || '기록 정정 및 재봉인',
    });

    S.records[idx] = amended;
    ui.viewRecordId = amended.id;
    ui.recordEditId = null;
    ui.recordModalTab = 'history';
    ui.recEditRelatedOpen = false;
    resetRecordEditDraft();
    await saveState(S);

    closeSignatureModal();
    render();
    openRecordModal();

    openSignSuccessModal('성공적으로 서명 및 인증이 완료되었습니다!', '수정 내용이 저장되고 새 revision으로 재봉인되었어요.');

    const amendVerify = verifyRecordIntegrity(amended as any) as any;
    toast(`정정 봉인 완료 ✅ ${amendVerify.trusted ? '기기서명 확인' : '재봉인 저장됨'}`);
    log('record amended', amended.id, amendVerify.verificationStatus);
  };

  const click: Record<string, (btn: HTMLElement) => void | Promise<void>> = {
    'toast-action': () => runToastAction(),
    'confirm-yes': () => closeConfirm(true), 'confirm-no': () => closeConfirm(false),

    'close-record': () => (closeRecordModal(), render()),
    'open-record-composer': () => { ui.recordComposerOpen = true; render(); window.setTimeout(() => { (document.getElementById('recordSummary') as HTMLTextAreaElement | null)?.focus(); }, 0); log('record composer modal open'); },
    'close-record-composer': () => { ui.recordComposerOpen = false; closeDlg('recordComposerModal'); render(); log('record composer modal close'); },
    'clear-record-filters': () => (ui.recFilterActor = ui.recFilterPlace = ui.recFilterKeyword = '', ui.recFilterActorDraft = ui.recFilterPlaceDraft = ui.recFilterKeywordDraft = '', render(), log('record filters cleared')),
    'apply-record-filters': () => (ui.recFilterActor = ui.recFilterActorDraft, ui.recFilterPlace = ui.recFilterPlaceDraft, ui.recFilterKeyword = ui.recFilterKeywordDraft, render(), log('record filters applied')),
    'apply-update-filters': () => (ui.updFilterActor = ui.updFilterActorDraft, ui.updFilterPlace = ui.updFilterPlaceDraft, ui.updFilterKeyword = ui.updFilterKeywordDraft, render(), log('update filters applied')),
    'clear-update-filters': () => (ui.updFilterActor = ui.updFilterPlace = ui.updFilterKeyword = '', ui.updFilterActorDraft = ui.updFilterPlaceDraft = ui.updFilterKeywordDraft = '', render(), log('update filters cleared')),
    'close-timeline-detail': () => (closeTimelineModal(), render()),

    tab: async (btn) => {
      const nextTab = (btn.dataset.tab === 'cases' ? 'cases' : btn.dataset.tab === 'home' ? 'home' : 'records') as any;
      S.tab = nextTab;
      if (nextTab === 'records') ui.evidenceTab = ui.evidenceTab || 'write';
      if (nextTab === 'cases') ui.caseTab = ui.caseTab || 'create';
      await saveState(S); log(`tab -> ${S.tab}`); render();
    },

    'switch-evidence-tab': (btn) => {
      const next = btn.dataset.evidenceTab === 'list' ? 'list' : 'write';
      ui.evidenceTab = next;
      S.tab = 'records' as any;
      render();
      log('evidence tab ->', next);
    },
    'switch-record-modal-tab': (btn) => {
      const next = btn.dataset.recordModalTab === 'history' ? 'history' : btn.dataset.recordModalTab === 'edit' ? 'edit' : 'current';
      ui.recordModalTab = next as any;
      render();
      openRecordModal();
      log('record modal tab ->', next);
    },
    'switch-case-tab': (btn) => {
      const next = btn.dataset.caseTab === 'list' ? 'list' : btn.dataset.caseTab === 'print' ? 'print' : 'create';
      ui.caseTab = next as any;
      S.tab = 'cases' as any;
      render();
      log('case tab ->', next);
    },

    'open-settings': () => (ui.settingsOpen = true, render(), log('settings modal open')),
    'close-settings': () => (ui.settingsOpen = false, closeDlg('settingsModal'), log('settings modal close')),

    'open-case-create': () => (S.tab = 'cases' as any, ui.caseTab = 'create', ui.caseCreateOpen = false, render(), void saveState(S), log('case create section open')),
    'close-case-create': () => (closeCaseCreateModal(), render(), log('case create modal close')),

    'saved-close': () => closeDlg('savedModal'),
    'saved-view-record': () => { const id = (ui as any).lastSavedRecordId as string | undefined; closeDlg('savedModal'); if (!id) return; ui.viewRecordId = id; ui.recordModalTab = 'current'; render(); openRecordModal(); log('saved modal -> view record', id); },
    'close-signature-modal': () => closeSignatureModal(),
    'close-sign-success': () => closeDlg(SIGN_SUCCESS_MODAL_ID),
    'confirm-signature-submit': async () => {
      if (ui.signatureModalMode === 'amend') return await finalizeAmendRecord();
      return await finalizeCreateRecord();
    },
    'case-created-close': () => closeDlg('caseCreatedModal'),
    'case-created-open': () => { closeDlg('caseCreatedModal'); S.tab = 'cases' as any; ui.caseTab = 'list'; void saveState(S); render(); },
    'case-created-open-paper': async () => { closeDlg('caseCreatedModal'); const c = mustCase(); if (!c) return; ui.paperCaseId = c.id; ui.paperHash = await computeCasePaperHash(c); render(); openPaperModal(); log('paper open (case created modal)', c.id); },

    backup: async () => {
      const envelope = await buildSignedBackupEnvelope(S as any);
      const json = JSON.stringify(envelope, null, 2);
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
      ui.settingsOpen = false; closeDlg('settingsModal');
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

      const restore = await verifyBackupEnvelope(parsed as any);
      if (!restore.ok && !restore.legacy) {
        toast('복구 중단 · 서명 검증 실패');
        log('restore blocked', restore.code, restore.message);
        return;
      }

      const next = await reverifyStateRecords(restore.state as any);
      next.tab = 'cases';
      next.selectedCaseId = null;
      ui.caseTab = 'list';
      ui.evidenceTab = 'write';

      setState(next);
      await saveState(S);
      syncDraftDefaults();
      render();
      closeDlg('restoreModal');
      const trustSummary = next.records.reduce((acc, r) => { const v = verifyRecordIntegrity(r as any) as any; if (!v.valid) acc.warn += 1; else if (v.trusted) acc.verified += 1; else if (v.verificationStatus === 'legacy') acc.legacy += 1; else acc.foreign += 1; return acc; }, { verified: 0, legacy: 0, foreign: 0, warn: 0 });
      toast(`복구 완료 · ${restore.legacy ? '레거시 백업' : '서명확인'} · 검증 ${trustSummary.verified} · 레거시 ${trustSummary.legacy} · 외부 ${trustSummary.foreign} · 경고 ${trustSummary.warn}`);
      log('restore ok', restore.code, trustSummary);
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
      ui.caseTab = 'create';
      ui.evidenceTab = 'write';
      ui.settingsOpen = false;
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
      draftRecord.relNameOther = '';
      ui.recRelatedOpen = true;
      render(); toast('관련자 추가'); log('related added', name);
    },
    'add-related-edit': () => {
      const typeText = String((draftRecordEdit as any).relTypeText || '').trim();
      const type = actorTypeInternalFromText(typeText);
      draftRecordEdit.relType = type; (draftRecordEdit as any).relTypeText = actorTypeTextFromInternal(type);
      const name = String(draftRecordEdit.relNameOther || '').trim();
      if (!typeText || !name) return;
      draftRecordEdit.relNameChoice = OTHER;
      draftRecordEdit.related = addActorToList(draftRecordEdit.related || [], { type, name });
      draftRecordEdit.relNameOther = '';
      ui.recEditRelatedOpen = true;
      render(); toast('관련자 추가'); log('related added(edit)', name);
    },
    'remove-related': (btn) => { const idx = Number(btn.dataset.idx ?? '-1'); if (!Number.isNaN(idx) && idx >= 0) (draftRecord.related = (draftRecord.related || []).filter((_, i) => i !== idx), render()); },
    'remove-related-edit': (btn) => { const idx = Number(btn.dataset.idx ?? '-1'); if (!Number.isNaN(idx) && idx >= 0) (draftRecordEdit.related = (draftRecordEdit.related || []).filter((_, i) => i !== idx), render()); },
    'clear-record-draft': () => (Object.assign(draftRecord, DEFAULT_RECORD()), render()),

    'set-record-now': () => { draftRecord.ts = toLocalInputValue(nowISO()); render(); toast('사건시각: 지금'); log('record ts set now'); },
    'set-record-edit-now': () => { draftRecordEdit.ts = toLocalInputValue(nowISO()); render(); toast('사건시각: 지금'); log('record edit ts set now'); },
    'start-edit-record': (btn) => {
      const id = String(btn.dataset.id || '').trim();
      if (!id) return;
      const r = S.records.find((x) => x.id === id);
      if (!r) return;
      ui.viewRecordId = id;
      ui.recordEditId = id;
      ui.recordModalTab = 'edit';
      ui.recEditRelatedOpen = false;
      loadRecordEditDraft(r);
      render();
      openRecordModal();
      log('record edit open', id);
    },
    'cancel-record-edit': () => {
      ui.recordEditId = null;
      ui.recordModalTab = 'current';
      ui.recEditRelatedOpen = false;
      resetRecordEditDraft();
      render();
      openRecordModal();
      log('record edit cancel');
    },

    'save-record': async () => {
      const prep = prepareRecordDraftForSeal() as any;
      if (prep.error) return toast(prep.error);
      (draftRecord as any).signerLabel = String((draftRecord as any).signerLabel || '').trim() || '기기 봉인서명';
      (draftRecord as any).sealReason = String((draftRecord as any).sealReason || '').trim() || '초기 기록 봉인';
      openSignatureModal('create');
    },

    'save-record-amend': async () => {
      const id = String(ui.recordEditId || '').trim();
      if (!id) return toast('수정할 기록을 찾을 수 없어요');
      const idx = S.records.findIndex((x) => x.id === id);
      if (idx < 0) return toast('수정할 기록을 찾을 수 없어요');
      const prep = prepareRecordEditForSeal() as any;
      if (prep.error) return toast(prep.error);
      (draftRecordEdit as any).signerLabel = String((draftRecordEdit as any).signerLabel || '').trim() || '기기 봉인서명';
      (draftRecordEdit as any).sealReason = String((draftRecordEdit as any).sealReason || '').trim() || '기록 정정 및 재봉인';
      openSignatureModal('amend');
    },

    'view-record': (btn) => { const id = btn.dataset.id; if (!id) return; ui.viewRecordId = id; ui.recordEditId = null; ui.recordModalTab = 'current'; ui.recEditRelatedOpen = false; resetRecordEditDraft(); render(); openRecordModal(); log('record view', id); },
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
      if (!(await openConfirm('이 증거를 이 사건에서 뺄까요? (증거 자체가 삭제되진 않아요)'))) return;
      
      const prevIds = (c.recordIds || []).slice();
      c.recordIds = prevIds.filter((x) => x !== id);
      await SR();
      toastUndo('묶음에서 제외됨', async () => { c.recordIds = prevIds; await SR(); toast('복구 완료'); });
      log('removed from case', id);
    },

    'copy-record': async (btn) => {
      const id = btn.dataset.id; if (!id) return;
      const r = S.records.find((x) => x.id === id); if (!r) return;
      await navigator.clipboard.writeText(JSON.stringify(ensureRecordV8(r), null, 2));
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
      const c = caseItem!; S.cases[c.id] = c; S.selectedCaseId = c.id; S.tab = 'cases'; ui.caseTab = 'list';
      Object.assign(draftCase, DEFAULT_CASE()); await SR(); closeCaseCreateModal(); render();
      setText('caseCreatedMsg', `“${String(c.title || '').trim() || '사건'}” 생성됨`);
      setText('caseCreatedSub', pickedCount ? `AI가 증거 ${pickedCount}개를 모았어요.` : 'AI가 포함할 증거를 찾지 못했어요.');
      openDlg('caseCreatedModal'); window.setTimeout(() => closeDlg('caseCreatedModal'), 2000);
      toast('생성 완료 ✅'); log('case created', c.id);
    },

    'select-case': async (btn) => { const id = btn.dataset.id; if (!id || !S.cases[id]) return; S.selectedCaseId = id; S.tab = 'cases'; ui.caseTab = 'list'; await SR(); log('case selected', id); },
    'clear-case': async () => { S.selectedCaseId = null; ui.qTimeline = ''; ui.caseTab = 'list'; await SR(); log('case cleared'); },

    'open-paper-picker': () => { if (!Object.keys(S.cases || {}).length) return toast('먼저 사건을 만들어주세요'); S.tab = 'cases' as any; ui.caseTab = 'print'; ui.paperPickOpen = false; ui.paperPickQuery = ''; render(); void saveState(S); log('paper section open'); },
    'close-paper-picker': () => (closePaperPickModal(), render(), log('paper picker close')),
    'pick-paper-case': async (btn) => { const id = String(btn.dataset.id || '').trim(); const c = id ? (S.cases[id] ?? null) : null; if (!c) return; ui.paperCaseId = c.id; ui.paperHash = await computeCasePaperHash(c); closePaperPickModal(); render(); openPaperModal(); log('paper open (picker)', c.id); },
    'paper-open-case-create': () => { closePaperPickModal(); S.tab = 'cases' as any; ui.caseTab = 'create'; ui.caseCreateOpen = false; render(); void saveState(S); log('case create section open (from paper picker)'); },

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
      await SR(); closeCaseUpdateModal(); render(); toast(`${ids.length}개 증거 추가됨`); log('case records added', c.id, ids.length);
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
    actorTypeText: (v) => {
      const t = actorTypeInternalFromText(v);
      draftRecord.actorType = t;
      (draftRecord as any).actorTypeText = actorTypeTextFromInternal(t);
      // 타입 변경 시 이전 이름이 남아 다른 분류로 저장되는 걸 방지
      draftRecord.actorNameChoice = OTHER;
      draftRecord.actorNameOther = '';
      render();
    },
    actorNameOther: (v) => (draftRecord.actorNameChoice = OTHER, draftRecord.actorNameOther = v),
    relTypeText: (v) => {
      const t = actorTypeInternalFromText(v);
      const prev = draftRecord.relType;
      draftRecord.relType = t;
      (draftRecord as any).relTypeText = actorTypeTextFromInternal(t);
      // 타입 전환 시 이전 선택값(예: 학생1)이 남아 다른 분류로 잘못 들어가는 걸 방지
      if (t !== prev) { draftRecord.relNameChoice = OTHER; draftRecord.relNameOther = ''; }
      // 관련자 추가 패널이 리렌더 때문에 접히지 않도록 유지
      ui.recRelatedOpen = true;
      render();
    },
    relNameOther: (v) => (draftRecord.relNameChoice = OTHER, draftRecord.relNameOther = v),
    placeText: (v) => { (draftRecord as any).placeText = v; draftRecord.place = (PLACE_TYPES as any).includes(v as any) ? (v as PlaceType) : ('기타' as PlaceType); if (draftRecord.place !== '기타') draftRecord.placeOther = ''; render(); },
    placeOther: (v) => (draftRecord.placeOther = v),
    storeTypeText: (v) => { (draftRecord as any).storeTypeText = v; draftRecord.storeType = (STORE_TYPES as any).includes(v as any) ? (v as StoreType) : ('기타' as StoreType); if (draftRecord.storeType !== '기타') draftRecord.storeOther = ''; render(); },
    storeOther: (v) => (draftRecord.storeOther = v),
    lvText: (v) => ((draftRecord as any).lvText = v, (LVS as any).includes(v as any) && (draftRecord.lv = v as Sensitivity)),
    ts: (v) => (draftRecord.ts = v),
    summary: (v) => (draftRecord.summary = v),
    signerLabel: (v) => ((draftRecord as any).signerLabel = v),
    sealReason: (v) => ((draftRecord as any).sealReason = v),
  };

  const recEdit: Record<string, (v: string) => void> = {
    actorTypeText: (v) => {
      const t = actorTypeInternalFromText(v);
      draftRecordEdit.actorType = t;
      (draftRecordEdit as any).actorTypeText = actorTypeTextFromInternal(t);
      draftRecordEdit.actorNameChoice = OTHER;
      draftRecordEdit.actorNameOther = '';
      render();
    },
    actorNameOther: (v) => (draftRecordEdit.actorNameChoice = OTHER, draftRecordEdit.actorNameOther = v),
    relTypeText: (v) => {
      const t = actorTypeInternalFromText(v);
      const prev = draftRecordEdit.relType;
      draftRecordEdit.relType = t;
      (draftRecordEdit as any).relTypeText = actorTypeTextFromInternal(t);
      if (t !== prev) { draftRecordEdit.relNameChoice = OTHER; draftRecordEdit.relNameOther = ''; }
      ui.recEditRelatedOpen = true;
      render();
    },
    relNameOther: (v) => (draftRecordEdit.relNameChoice = OTHER, draftRecordEdit.relNameOther = v),
    placeText: (v) => { (draftRecordEdit as any).placeText = v; draftRecordEdit.place = (PLACE_TYPES as any).includes(v as any) ? (v as PlaceType) : ('기타' as PlaceType); if (draftRecordEdit.place !== '기타') draftRecordEdit.placeOther = ''; render(); },
    placeOther: (v) => (draftRecordEdit.placeOther = v),
    storeTypeText: (v) => { (draftRecordEdit as any).storeTypeText = v; draftRecordEdit.storeType = (STORE_TYPES as any).includes(v as any) ? (v as StoreType) : ('기타' as StoreType); if (draftRecordEdit.storeType !== '기타') draftRecordEdit.storeOther = ''; render(); },
    storeOther: (v) => (draftRecordEdit.storeOther = v),
    lvText: (v) => ((draftRecordEdit as any).lvText = v, (LVS as any).includes(v as any) && (draftRecordEdit.lv = v as Sensitivity)),
    ts: (v) => (draftRecordEdit.ts = v),
    summary: (v) => (draftRecordEdit.summary = v),
    signerLabel: (v) => ((draftRecordEdit as any).signerLabel = v),
    sealReason: (v) => ((draftRecordEdit as any).sealReason = v),
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
    const table = action === 'draft-record' ? rec : action === 'draft-record-edit' ? recEdit : action === 'draft-case' ? cas : action === 'draft-step' ? step : null;
    table?.[field]?.(v);
    if (action === 'draft-record') updateRecordComposerUI();
    if (action === 'draft-record-edit') updateRecordEditUI();
  };

  const watch = '[data-action="draft-record"],[data-action="draft-record-edit"],[data-action="draft-case"],[data-action="draft-step"],[data-action="draft-record-filters"],[data-action="draft-update-filters"],[data-action="toggle-update-pick"],[data-action="search-timeline"],[data-action="search-paper-cases"],[data-action="search-update-candidates"]';
  document.addEventListener('input', (e) => { const el = (e.target as HTMLElement | null)?.closest<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(watch); el && handle(el); });
  document.addEventListener('change', (e) => { const el = (e.target as HTMLElement | null)?.closest<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-action="draft-record"],[data-action="draft-record-edit"],[data-action="draft-case"],[data-action="draft-step"],[data-action="draft-record-filters"],[data-action="draft-update-filters"],[data-action="toggle-update-pick"]'); el && handle(el); });

  document.addEventListener('close', (e) => {
    const t = e.target as HTMLElement | null; if (!t) return;
    if (_isRerendering) return;
    if ((t as any).id === 'recordModal') { ui.viewRecordId = null; ui.recordEditId = null; ui.recordModalTab = 'current'; ui.recEditRelatedOpen = false; resetRecordEditDraft(); }
    if ((t as any).id === 'recordComposerModal') ui.recordComposerOpen = false;
    if ((t as any).id === 'paperPickModal') ui.paperPickOpen = false;
    if ((t as any).id === 'paperModal') (ui.paperCaseId = null, ui.paperHash = null);
    if ((t as any).id === 'caseUpdateModal') (ui.updateCaseId = null, ui.updatePickIds = [], ui.updFilterActor = ui.updFilterPlace = ui.updFilterKeyword = '', ui.updFilterActorDraft = ui.updFilterPlaceDraft = ui.updFilterKeywordDraft = '', ui.updateCandidatesForCaseId = null, ui.updateCandidates = null, ui.updateCandidatesLoading = false);
    if ((t as any).id === 'settingsModal') ui.settingsOpen = false;
    if ((t as any).id === SIGNATURE_MODAL_ID) ui.signatureModalMode = null;
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
      if (ae.closest('[data-action="draft-record-edit"][data-field="summary"]')) return void (e.preventDefault(), (document.querySelector('[data-action="save-record-amend"]') as HTMLButtonElement | null)?.click());
      if (ae.closest('[data-action="draft-step"][data-field="note"]')) return void (e.preventDefault(), (document.querySelector('[data-action="add-step"]') as HTMLButtonElement | null)?.click());
    }

    if (e.key === 'Escape') {
      const c = dlg('confirmModal'); if (c?.open) return void (e.preventDefault(), closeConfirm(false));
      const sg = dlg(SIGNATURE_MODAL_ID); if (sg?.open) return void (e.preventDefault(), closeSignatureModal());
      const ss = dlg(SIGN_SUCCESS_MODAL_ID); if (ss?.open) return void (e.preventDefault(), closeDlg(SIGN_SUCCESS_MODAL_ID));
      const sm = dlg('savedModal'); if (sm?.open) return void (e.preventDefault(), closeDlg('savedModal'));
      const cm = dlg('caseCreatedModal'); if (cm?.open) return void (e.preventDefault(), closeDlg('caseCreatedModal'));
      closeDlg('restoreModal'); closeDlg('logsModal');
      const st = dlg('settingsModal'); if (st?.open) return void (e.preventDefault(), ui.settingsOpen = false, closeDlg('settingsModal'));
      const composer = dlg('recordComposerModal'); if (composer?.open) return void (e.preventDefault(), ui.recordComposerOpen = false, closeDlg('recordComposerModal'), render());
      const rec = dlg('recordModal'); if (rec?.open) return void (e.preventDefault(), closeRecordModal(), render());
      const tl = dlg('timelineDetailModal'); if (tl?.open) return void (e.preventDefault(), closeTimelineModal(), render());
      const cu = dlg('caseUpdateModal'); if (cu?.open) return void (e.preventDefault(), closeCaseUpdateModal(), render());
    }
  });
}

function syncDraftDefaults() {
  draftRecord.actorNameChoice = OTHER; draftRecord.relNameChoice = OTHER; draftCase.addNameChoice = OTHER; draftRecordEdit.actorNameChoice = OTHER; draftRecordEdit.relNameChoice = OTHER;
  (draftRecord as any).placeText ||= draftRecord.place; (draftRecord as any).storeTypeText ||= draftRecord.storeType; (draftRecord as any).lvText ||= draftRecord.lv;
  (draftRecord as any).actorTypeText ||= actorTypeTextFromInternal(draftRecord.actorType); (draftRecord as any).relTypeText ||= actorTypeTextFromInternal(draftRecord.relType);
  (draftRecord as any).signerLabel ||= '기기 봉인서명'; (draftRecord as any).sealReason ||= '';
  (draftRecordEdit as any).placeText ||= draftRecordEdit.place; (draftRecordEdit as any).storeTypeText ||= draftRecordEdit.storeType; (draftRecordEdit as any).lvText ||= draftRecordEdit.lv;
  (draftRecordEdit as any).actorTypeText ||= actorTypeTextFromInternal(draftRecordEdit.actorType); (draftRecordEdit as any).relTypeText ||= actorTypeTextFromInternal(draftRecordEdit.relType);
  (draftRecordEdit as any).signerLabel ||= '기기 봉인서명'; (draftRecordEdit as any).sealReason ||= '';
  (draftCase as any).addTypeText ||= actorTypeTextFromInternal(draftCase.addType); (draftCase as any).sensFilterText ||= String(draftCase.sensFilter); (draftCase as any).statusText ||= draftCase.status;
}

export function initApp() {
  bindEvents(); ensurePaperStyles(); syncDraftDefaults();

  const focusRecordComposer = () => window.setTimeout(() => {
    (document.getElementById('recordSummary') as HTMLTextAreaElement | null)?.focus();
  }, 0);

  // ✅ 앱 실행 시 첫 화면: 홈
  (S as any).tab = 'home' as any; S.tab = 'home' as any; render();

  (async () => {
    try {
      await refreshDeviceSignerInfo();
      setState(await reverifyStateRecords(await loadState()));
      log('state loaded');
    }
    catch (e) { log('load failed', e); setState(defaultState()); }

    // ✅ 로컬에 마지막 탭이 무엇이었든, 실행 시작은 home으로 고정
    (S as any).tab = 'home' as any; S.tab = 'home' as any;

    syncDraftDefaults(); render();
  })();
}