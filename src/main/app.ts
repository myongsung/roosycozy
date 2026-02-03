import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { uid, nowISO, toLocalInputValue, fromLocalInputValue, safeParseJSON, defaultState, normalizeState, loadState, saveState, wipeAll, STATUSES } from '../utils';
import type { ActorRef, PlaceType, StoreType, Sensitivity, StepItem } from '../engine';
import { OTHER, casesContainingRecord, addActorToList, buildRecordFromDraft, createCaseWithAdvisors, regenerateCaseAdvisors, buildCaseTimeline, getCaseUpdateCandidates, addRecordsToCase, recordsForCase } from '../engine';
import { S, setState, ui, toast, runToastAction, log, openConfirm, closeConfirm, openRecordModal, closeRecordModal, openRecordsListModal, closeRecordsListModal, openCaseCreateModal, closeCaseCreateModal, openTimelineModal, closeTimelineModal, openPaperModal, closePaperModal, openPaperPickModal, closePaperPickModal, openCaseUpdateModal, closeCaseUpdateModal, draftRecord, draftCase, draftStep, actorTypeTextFromInternal, actorTypeInternalFromText, getSelectedCase, logs, actorShort, LVS, PLACE_TYPES, STORE_TYPES } from './state';
import { ensurePaperStyles, buildPaperPayload, computeCasePaperHash } from './paper';
import { render } from './views';

/* ---------- micro helpers ---------- */
const dlg = (id: string) => document.getElementById(id) as HTMLDialogElement | null;
const closeDlg = (id: string) => { const d = dlg(id); if (d?.open) d.close(); };
const openDlg = (id: string) => dlg(id)?.showModal();
const setText = (id: string, text: string) => { const el = document.getElementById(id); if (el) el.textContent = text; };
const SR = async () => { await saveState(S); render(); };
const toastUndo = (msg: string, undo: () => Promise<void>) => toast(msg, { label: '되돌리기', onClick: undo });
const flash = (id: string) => { ui.flashStepId = id; ui.flashStepTimer && clearTimeout(ui.flashStepTimer); ui.flashStepTimer = window.setTimeout(() => (ui.flashStepId = null, render()), 1800); };
const mustCase = (msg = '사건을 먼저 선택하세요') => { const c = getSelectedCase(); if (!c) toast(msg); return c; };
const openUpdate = (caseId: string) => (ui.updateCaseId = caseId, render(), openCaseUpdateModal(), void refreshUpdateCandidates(caseId));

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
  sensFilterText: 'any', sensFilter: 'any', statusText: '진행중', status: '진행중',
  addTypeText: '학생', addType: '학생', addNameChoice: OTHER, addNameOther: ''
});

/* ---------- event binding ---------- */
let _bound = false;
function bindEvents() {
  if (_bound) return; _bound = true;

  const click: Record<string, (btn: HTMLElement) => void | Promise<void>> = {
    'toast-action': () => runToastAction(),
    'confirm-yes': () => closeConfirm(true), 'confirm-no': () => closeConfirm(false),

    'close-record': () => (closeRecordModal(), render()),
    'open-records-list': () => (ui.recordsListOpen = true, render(), openRecordsListModal(), log('records list open')),
    'close-records-list': () => (closeRecordsListModal(), render(), log('records list close')),
    'clear-records-search': () => (ui.qRecords = '', render(), log('records search cleared')),
    'close-timeline-detail': () => (closeTimelineModal(), render()),

    // ✅ 여기만 수정: 사건 정리 탭을 누르면 항상 "목록 화면"이 디폴트가 되도록 선택된 사건을 해제
    tab: async (btn) => {
      const nextTab = (btn.dataset.tab === 'cases' ? 'cases' : 'records') as any;

      if (nextTab === 'cases') {
        // "사건 정리" 탭 클릭 시 디폴트 화면(사건 목록)으로
        S.selectedCaseId = null;
        ui.qTimeline = ''; // 타임라인 검색어도 초기화(표시만)
      }

      S.tab = nextTab;
      await saveState(S);
      log(`tab -> ${S.tab}`);
      render();
    },

    'open-case-create': () => (S.tab = 'cases' as any, ui.caseCreateOpen = true, render(), openCaseCreateModal(), void saveState(S), log('case create modal open')),
    'close-case-create': () => (closeCaseCreateModal(), render(), log('case create modal close')),

    backup: async () => { const pack = JSON.stringify({ v: 7, exportedAt: nowISO(), state: S }, null, 2); await navigator.clipboard.writeText(pack); toast('백업 JSON 복사'); log('backup copied'); },
    'copy-backup': async () => click.backup!(document.body as any),


    'load-sample': async () => {
      const hasData = (S.records?.length ?? 0) > 0 || Object.keys(S.cases || {}).length > 0;

      if (hasData) {
        toast('샘플을 불러오면 현재 데이터가 덮어써져요. 먼저 ⎘로 백업을 추천해요.', {
          label: '백업 복사',
          onClick: () => void click.backup!(document.body as any),
        });
      }

      if (!(await openConfirm('샘플 데이터를 불러올까요?(현재 데이터는 샘플로 덮어써집니다)'))) return;

      try {
        const pack = await loadSamplePackJSON();
        const next = normalizeState(pack as any);
        next.tab = 'records';
        next.selectedCaseId = null;

        setState(next);
        await saveState(S);
        syncDraftDefaults();
        render();

        toast('샘플 데이터를 불러왔어요 ✅');
        log('sample loaded');
      } catch (e) {
        log('sample load failed', e);
        toast('샘플 불러오기에 실패했어요');
      }
    },

    'open-restore': () => (openDlg('restoreModal'), log('restore modal open')),
    'close-restore': () => closeDlg('restoreModal'),
    'do-restore': async () => {
      const ta = document.getElementById('restoreText') as HTMLTextAreaElement | null;
      const parsed = safeParseJSON(ta?.value || '');
      if (!parsed || typeof parsed !== 'object') return toast('JSON 형식이 아니에요');
      const next = normalizeState(parsed as any); next.tab = 'cases'; next.selectedCaseId = null;
      setState(next); await saveState(S); syncDraftDefaults(); render(); closeDlg('restoreModal');
      toast('복구 완료'); log('restore ok');
    },

    'open-logs': () => (setText('logBox', logs.join('\n')), openDlg('logsModal')),
    'close-logs': () => closeDlg('logsModal'),
    'copy-logs': async () => (await navigator.clipboard.writeText(logs.join('\n')), toast('로그 복사')),
    'clear-logs': () => (logs.splice(0, logs.length), setText('logBox', ''), toast('로그 비우기')),

    wipe: async () => { if (!(await openConfirm('모든 데이터를 삭제할까요?'))) return; await wipeAll(); setState(defaultState()); (S as any).tab = 'cases'; syncDraftDefaults(); render(); toast('전체 삭제'); log('wipe all'); },

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
      if (!typeText) return toast('관련자 유형을 선택하세요');
      if (!name) return toast('관련자 이름을 입력하세요');
      draftRecord.relNameChoice = OTHER;
      const actor: ActorRef = { type, name };
      draftRecord.related = addActorToList(draftRecord.related || [], actor);
      draftRecord.relNameOther = '';
      render(); toast('관련자 추가'); log('related added', actorShort(actor));
    },
    'remove-related': (btn) => { const idx = Number(btn.dataset.idx ?? '-1'); if (!Number.isNaN(idx) && idx >= 0) (draftRecord.related = (draftRecord.related || []).filter((_, i) => i !== idx), render()); },

    'clear-record-draft': () => (Object.assign(draftRecord, DEFAULT_RECORD()), render()),

    'save-record': async () => {
      const actorTypeText = String((draftRecord as any).actorTypeText || '').trim();
      const placeText = String((draftRecord as any).placeText || '').trim();
      const storeText = String((draftRecord as any).storeTypeText || '').trim();
      const lvText = String((draftRecord as any).lvText || '').trim();

      if (!draftRecord.ts) return toast('시간을 입력하세요');
      if (!actorTypeText) return toast('주체 유형을 입력하세요');
      if (!String(draftRecord.actorNameOther || '').trim()) return toast('주체 이름을 입력하세요');
      if (!String(draftRecord.summary || '').trim()) return toast('내용을 입력하세요');
      if (!placeText) return toast('장소를 입력하세요');
      if (!storeText) return toast('보관형태를 입력하세요');
      if (!lvText) return toast('민감도를 입력하세요');
      if (!((LVS as any).includes(lvText as any))) return toast('민감도는 LV1~LV5 중 하나로 입력하세요');

      const placeIsKnown = (PLACE_TYPES as any).includes(placeText as any);
      const storeIsKnown = (STORE_TYPES as any).includes(storeText as any);

      const place: PlaceType = placeIsKnown ? (placeText as any) : ('기타' as any);
      const placeOther = placeText === '기타' ? String(draftRecord.placeOther || '').trim() : (placeIsKnown ? '' : placeText);

      const storeType: StoreType = storeIsKnown ? (storeText as any) : ('기타' as any);
      const storeOther = storeText === '기타' ? String(draftRecord.storeOther || '').trim() : (storeIsKnown ? '' : storeText);

      if (place === '기타' && !placeOther) return toast('장소 상세(기타)를 입력하세요');
      if (storeType === '기타' && !storeOther) return toast('보관형태 상세(기타)를 입력하세요');
      if (!(draftRecord.related || []).length) return toast('관련자를 최소 1명 추가하세요 (없으면 “기타 / 없음”)');

      const { record, error } = buildRecordFromDraft({
        tsISO: fromLocalInputValue(draftRecord.ts),
        storeType, storeOther,
        lv: lvText as any,
        actorType: draftRecord.actorType,
        actorNameChoice: OTHER,
        actorNameOther: String(draftRecord.actorNameOther || '').trim(),
        related: (draftRecord.related || []).slice(),
        place, placeOther,
        summary: String(draftRecord.summary || '').trim(),
      }, () => uid('REC'));
      if (error) return toast(error);

      S.records.unshift(record!); await saveState(S);
      draftRecord.summary = ''; draftRecord.related = []; render();

      const sel = getSelectedCase();
      sel ? toast('기록 저장됨 · 선택한 사건에 반영하려면 업데이트를 실행하세요', { label: '사건 업데이트', onClick: () => openUpdate(sel.id) })
          : toast('기록 저장됨 · 사건 반영은 [사건 업데이트]에서 진행');
      log('record saved', record!.id);
    },

    'view-record': (btn) => { const id = btn.dataset.id; if (!id) return; ui.recordsListOpen && closeRecordsListModal(); ui.viewRecordId = id; render(); openRecordModal(); log('record view', id); },
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
      if (!typeText) return toast('Actor 유형을 선택하세요');
      if (!name) return toast('Actor 이름을 입력하세요');
      draftCase.addNameChoice = OTHER;
      draftCase.actors = addActorToList(draftCase.actors || [], { type, name });
      draftCase.addNameOther = '';
      render(); toast('Actor 추가');
    },
    'remove-case-actor': (btn) => { const idx = Number(btn.dataset.idx ?? '-1'); if (!Number.isNaN(idx) && idx >= 0) (draftCase.actors = (draftCase.actors || []).filter((_, i) => i !== idx), render()); },

    'clear-case-draft': () => (Object.assign(draftCase, DEFAULT_CASE()), render()),

    'create-case': async () => {

      if (!(draftCase.actors || []).length) {
        toast('Actor를 1명 이상 추가한 뒤 시작할 수 있어요');
        return;
      }

      const title = String(draftCase.title || '').trim();
      const query = String(draftCase.query || '').trim();
      const timeFrom = String(draftCase.timeFrom || '').trim();
      const timeTo = String(draftCase.timeTo || '').trim();

      const { caseItem, error, pickedCount } = await createCaseWithAdvisors({
        title, actors: (draftCase.actors || []).slice(),
        query,
        // ✅ 기간 입력을 비워두면(=필터 없음) nowISO로 바뀌지 않도록 처리
        timeFromISO: timeFrom ? fromLocalInputValue(timeFrom) : '',
        timeToISO: timeTo ? fromLocalInputValue(timeTo) : '',
        sensFilter: 'any' as any,
        status: '진행중' as any,
        maxResults: draftCase.maxResults
      }, S.records, () => uid('CASE'), nowISO);
      if (error) return toast(error);

      const c = caseItem!;
      S.cases[c.id] = c; S.selectedCaseId = c.id; S.tab = 'cases';
      Object.assign(draftCase, DEFAULT_CASE());
      await SR(); closeCaseCreateModal(); render();
      toast(pickedCount ? `AI가 기록 ${pickedCount}개를 모았어요` : 'AI가 포함할 기록을 찾지 못했어요');
      log('case created', c.id);
    },

    'select-case': async (btn) => { const id = btn.dataset.id; if (!id || !S.cases[id]) return; S.selectedCaseId = id; S.tab = 'cases'; await SR(); log('case selected', id); },
    'clear-case': async () => { S.selectedCaseId = null; ui.qTimeline = ''; await SR(); log('case cleared'); },

    'open-paper-picker': () => {
      const ids = Object.keys(S.cases || {});
      if (!ids.length) return toast('먼저 사건을 만들어주세요');
      ui.paperPickOpen = true; ui.paperPickQuery = '';
      render(); openPaperPickModal(); log('paper picker open');
    },
    'close-paper-picker': () => (closePaperPickModal(), render(), log('paper picker close')),
    'pick-paper-case': async (btn) => {
      const id = String(btn.dataset.id || '').trim();
      const c = id ? (S.cases[id] ?? null) : null;
      if (!c) return;
      ui.paperCaseId = c.id; ui.paperHash = await computeCasePaperHash(c);
      closePaperPickModal();
      render(); openPaperModal(); log('paper open (picker)', c.id);
    },
    'paper-open-case-create': () => {
      closePaperPickModal();
      S.tab = 'cases' as any; ui.caseCreateOpen = true;
      render(); openCaseCreateModal(); void saveState(S);
      log('case create modal open (from paper picker)');
    },

    'open-paper': async () => {
      const c = mustCase(); if (!c) return;
      ui.paperCaseId = c.id; ui.paperHash = await computeCasePaperHash(c);
      render(); openPaperModal(); log('paper open', c.id);
    },
    'close-paper': () => (closePaperModal(), render()),

    'print-paper': async () => {
      const c = ui.paperCaseId ? S.cases[ui.paperCaseId] ?? null : null;
      if (!c) return;
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
      } catch (e: any) {
        console.error(e); toast(`PDF 저장 실패: ${String(e?.message || e)}`);
      }
    },

    'open-case-update': () => { const c = mustCase(); if (c) (openUpdate(c.id), log('case update modal open', c.id)); },
    'close-case-update': () => (closeCaseUpdateModal(), render()),

    'apply-case-update': async () => {
      const c = ui.updateCaseId ? S.cases[ui.updateCaseId] ?? null : null;
      if (!c) return toast('사건을 찾을 수 없어요');
      const checked = Array.from(dlg('caseUpdateModal')?.querySelectorAll<HTMLInputElement>('input[name="caseUpdPick"]:checked') || []);
      const ids = checked.map((x) => x.value).filter(Boolean);
      if (!ids.length) return toast('선택된 항목이 없어요');
      S.cases[c.id] = await addRecordsToCase(c, S.records, ids);
      await SR(); closeCaseUpdateModal(); render();
      toast(`AI 후보 ${ids.length}개 추가됨`); log('case records added', c.id, ids.length);
    },

    'delete-case': async (btn) => {
      const id = btn.dataset.id; if (!id || !S.cases[id]) return;
      if (!(await openConfirm('이 사건을 삭제할까요?'))) return;
      const deleted = S.cases[id];
      delete S.cases[id]; if (S.selectedCaseId === id) S.selectedCaseId = null;
      await SR();
      toastUndo('사건 삭제됨', async () => (S.cases[deleted.id] = deleted, await SR(), toast('복구 완료')));
      log('case deleted', id);
    },

    'add-step': async () => {
      const c = mustCase(); if (!c) return;
      const name = draftStep.name.trim(), note = draftStep.note.trim();
      if (!name || !note) return toast('단계/내용은 필수예요');
      const step: StepItem = { id: uid('STEP'), ts: fromLocalInputValue(draftStep.ts), name, note, text: '', place: '', owner: '', lv: '' };
      c.steps = Array.isArray(c.steps) ? c.steps : []; c.steps.push(step);
      draftStep.name = ''; draftStep.note = '';
      flash(step.id);
      await SR(); toast('내 조치 로그 추가됨'); log('step added', step.id);
    },

    'delete-step': async (btn) => {
      const c = mustCase(); const id = btn.dataset.id;
      if (!c || !id) return;
      if (!(await openConfirm('이 단계를 삭제할까요?'))) return;
      const deleted = (c.steps || []).find((s) => s.id === id);
      c.steps = (c.steps || []).filter((s) => s.id !== id);
      await SR();
      toastUndo('단계 삭제됨', async () => { if (!deleted) return; c.steps = Array.isArray(c.steps) ? c.steps : []; c.steps.push(deleted); await SR(); toast('복구 완료'); });
      log('step deleted', id);
    },

    'regen-advisors': async () => {
      const c = mustCase(); if (!c) return;
      if (!(await openConfirm('대응 가이드를 현재 규칙으로 다시 생성할까요? (숨긴 대응 가이드은 사라져요)'))) return;
      c.advisors = await regenerateCaseAdvisors(c, S.records);
      await SR(); toast('대응 가이드 재생성됨'); log('advisors regenerated', c.id);
    },

    'toggle-advisor-done': async (btn) => {
      const c = mustCase(); const id = btn.dataset.id;
      if (!c || !id) return;
      c.advisors = Array.isArray(c.advisors) ? c.advisors : [];
      const a = c.advisors.find((x) => x.id === id); if (!a) return;
      a.state = a.state === 'done' ? 'active' : 'done';
      await SR(); toast(a.state === 'done' ? '완료 처리' : '다시 열기'); log('advisor toggled', id);
    },

    'dismiss-advisor': async (btn) => {
      const c = mustCase(); const id = btn.dataset.id;
      if (!c || !id) return;
      c.advisors = Array.isArray(c.advisors) ? c.advisors : [];
      const a = c.advisors.find((x) => x.id === id); if (!a) return;
      const prev = a.state; a.state = 'dismissed';
      await SR();
      toastUndo('대응 가이드 숨김', async () => (a.state = prev, await SR(), toast('복구 완료')));
      log('advisor dismissed', id);
    },

    'advisor-to-step': async (btn) => {
      const c = mustCase(); const id = btn.dataset.id;
      if (!c || !id) return;
      c.advisors = Array.isArray(c.advisors) ? c.advisors : [];
      const a = c.advisors.find((x) => x.id === id); if (!a) return;

      const step: StepItem = { id: uid('STEP'), ts: String(a.ts || nowISO()), name: `대응 가이드: ${a.title}`.slice(0, 60), note: a.body, text: '', place: '', owner: '', lv: '' };
      c.steps = Array.isArray(c.steps) ? c.steps : []; c.steps.push(step); a.state = 'done';
      flash(step.id);
      await SR(); toast('내 조치 로그로 저장됨'); log('advisor -> step', `${id} -> ${step.id}`);
    },
  };

  document.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
    const action = btn?.dataset.action;
    if (!btn || !action) return;
    try { const fn = click[action]; if (fn) await fn(btn); }
    catch (err) { toast('오류 발생: 로그를 확인하세요'); log('ERROR', err); }
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
    title: (v) => (draftCase.title = v),
    query: (v) => (draftCase.query = v),
    timeFrom: (v) => (draftCase.timeFrom = v),
    timeTo: (v) => (draftCase.timeTo = v),
    maxResults: (v) => (draftCase.maxResults = Math.max(1, Math.min(400, Number(v) || 80))),
    sensFilterText: (v) => { (draftCase as any).sensFilterText = v; const vv = String(v || '').trim(); if (vv === 'any' || vv === '전체') draftCase.sensFilter = 'any'; else if ((LVS as any).includes(vv as any)) draftCase.sensFilter = vv as any; },
    statusText: (v) => { (draftCase as any).statusText = v; const vv = String(v || '').trim(); (STATUSES as any).includes(vv as any) && (draftCase.status = vv as any); },
    addTypeText: (v) => { const t = actorTypeInternalFromText(v); draftCase.addType = t; (draftCase as any).addTypeText = actorTypeTextFromInternal(t); render(); },
    addNameOther: (v) => (draftCase.addNameChoice = OTHER, draftCase.addNameOther = v),
  };

  const step: Record<string, (v: string) => void> = { ts: (v) => (draftStep.ts = v), name: (v) => (draftStep.name = v), note: (v) => (draftStep.note = v) };

  const handle = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
    const action = el.dataset.action, field = el.dataset.field; if (!action || !field) return;
    const v = el.value;
    if (action === 'search-records') return void (ui.qRecords = v, render());
    if (action === 'search-timeline') return void (ui.qTimeline = v, render());
    if (action === 'search-paper-cases') return void (ui.paperPickQuery = v, render());
    const table = action === 'draft-record' ? rec : action === 'draft-case' ? cas : action === 'draft-step' ? step : null;
    table?.[field]?.(v);
  };

  const watch = '[data-action="draft-record"],[data-action="draft-case"],[data-action="draft-step"],[data-action="search-records"],[data-action="search-timeline"],[data-action="search-paper-cases"]';
  document.addEventListener('input', (e) => { const el = (e.target as HTMLElement | null)?.closest<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(watch); el && handle(el); });
  document.addEventListener('change', (e) => { const el = (e.target as HTMLElement | null)?.closest<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-action="draft-record"],[data-action="draft-case"],[data-action="draft-step"]'); el && handle(el); });

  document.addEventListener('close', (e) => {
    const t = e.target as HTMLElement | null; if (!t) return;
    if ((t as any).id === 'recordModal') ui.viewRecordId = null;
    if ((t as any).id === 'recordsListModal') ui.recordsListOpen = false;
    if ((t as any).id === 'paperPickModal') ui.paperPickOpen = false;
    if ((t as any).id === 'paperModal') (ui.paperCaseId = null, ui.paperHash = null);
    if ((t as any).id === 'caseUpdateModal') (ui.updateCaseId = null, ui.updateCandidatesForCaseId = null, ui.updateCandidates = null, ui.updateCandidatesLoading = false);
  }, true);

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const ae = document.activeElement as HTMLElement | null; if (!ae) return;
      if (ae.closest('[data-action="draft-record"][data-field="summary"]')) return void (e.preventDefault(), (document.querySelector('[data-action="save-record"]') as HTMLButtonElement | null)?.click());
      if (ae.closest('[data-action="draft-step"][data-field="note"]')) return void (e.preventDefault(), (document.querySelector('[data-action="add-step"]') as HTMLButtonElement | null)?.click());
      if ((ae as any).id === 'restoreText') return void (e.preventDefault(), (document.querySelector('[data-action="do-restore"]') as HTMLButtonElement | null)?.click());
    }

    if (e.key === 'Escape') {
      const c = dlg('confirmModal'); if (c?.open) return void (e.preventDefault(), closeConfirm(false));
      closeDlg('restoreModal'); closeDlg('logsModal');

      const rec = dlg('recordModal'); if (rec?.open) return void (e.preventDefault(), closeRecordModal(), render());
      const tl = dlg('timelineDetailModal'); if (tl?.open) return void (e.preventDefault(), closeTimelineModal(), render());
      const cu = dlg('caseUpdateModal'); if (cu?.open) return void (e.preventDefault(), closeCaseUpdateModal(), render());
    }
  });
}

/* ---------- startup helpers ---------- */
function syncDraftDefaults() {
  draftRecord.actorNameChoice = OTHER; draftRecord.relNameChoice = OTHER; draftCase.addNameChoice = OTHER;

  (draftRecord as any).placeText ||= draftRecord.place;
  (draftRecord as any).storeTypeText ||= draftRecord.storeType;
  (draftRecord as any).lvText ||= draftRecord.lv;

  (draftRecord as any).actorTypeText ||= actorTypeTextFromInternal(draftRecord.actorType);
  (draftRecord as any).relTypeText ||= actorTypeTextFromInternal(draftRecord.relType);

  (draftCase as any).addTypeText ||= actorTypeTextFromInternal(draftCase.addType);
  (draftCase as any).sensFilterText ||= String(draftCase.sensFilter);
  (draftCase as any).statusText ||= draftCase.status;
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
