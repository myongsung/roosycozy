import { esc, trunc, fmt, LS_KEY } from '../utils';
import type { CaseItem, RecordItem, AdvisorItem, StepItem, ActorRef, RankedHit } from '../engine';
import { recordActors, recordsForCase, buildCaseTimeline } from '../engine';
import {
  S, ui, $app, logs,
  matchLite,
  renderSelectFromList,
  STORE_TYPES, PLACE_TYPES, UI_ACTOR_TYPES,
  renderNameFieldForType,
  storeLabel, placeLabel, actorLabel, actorShort,
  draftRecord, draftCase, draftStep,
  getSelectedCase, visibleRecords, visibleCases,
  openCaseCreateModal, openPaperPickModal,
  actorEqLite, uniq, tokenizeLite, isWithinRangeISO, daysDiff,
  UI_OTHER_ACTOR_LABEL, STUDENT_NAMES, PARENT_NAMES, ADMIN_NAMES
} from './state';
import { renderCasePaperModal } from './paper';

const ENABLE_BACKUP_RESTORE = true; // backup/restore (JSON copy/paste) UI disabled


/** ultra-light view helpers (single-file) */
const H = {
  empty: (msg: string, h = 180) => `<div class="empty" style="height:${h}px">${esc(msg)}</div>`,
  btn: (label: string, action: string, extra = '', cls = 'btn') =>
    `<button class="${cls}" data-action="${action}" type="button"${extra}>${label}</button>`,
  btnData: (label: string, action: string, data: Record<string, string>, cls = 'btn') => {
    const extra = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(String(v))}"`).join('');
    return `<button class="${cls}" data-action="${action}" type="button"${extra}>${label}</button>`;
  },
  iconBtn: (label: string, action: string, title: string) =>
    `<button class="iconBtn" data-action="${action}" type="button" title="${esc(title)}">${label}</button>`,
  modal: (id: string, head: string, body: string, cls = 'modal') => `<dialog class="${cls}" id="${id}">${head}${body}</dialog>`,
  modalHead: (title: string, subtitle: string, actions: string) => `
    <div class="modalHead">
      <div>
        <div class="h2">${esc(title)}</div>
        ${subtitle ? `<div class="muted">${esc(subtitle)}</div>` : ''}
      </div>
      ${actions}
    </div>
  `,
  dr: (k: string, v: string) => `<div class="detailRow"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`,
  ds: (k: string, inner: string) => `<div class="detailSection"><div class="k">${esc(k)}</div>${inner}</div>`,
  tags: (tags: string[]) => `<div class="tags mini">${tags.filter(Boolean).join('')}</div>`,
  tag: (label: string, cls = 'tag') => `<span class="${cls}">${esc(label)}</span>`,
  chips: (items: string[]) =>
    items.length ? `<div class="chips">${items.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : `<div class="muted">—</div>`,
};
const dl = (id: string, values: string[]) =>
  `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;

/* ==================== TOAST + <dialog> TOP LAYER FIX ==================== */
// <dialog>.showModal() is rendered in the browser "top layer", so normal z-index can't beat it.
// If a dialog is open, we "portal" the toast element into the top-most open dialog so it stays visible.

let _toastPortalInstalled = false;
let _toastPortalObs: MutationObserver | null = null;

function topOpenDialog(): HTMLDialogElement | null {
  const ae = document.activeElement as Element | null;
  const activeDlg = ae?.closest?.('dialog[open]') as HTMLDialogElement | null;
  if (activeDlg) return activeDlg;

  const ds = Array.from(document.querySelectorAll('dialog[open]')) as HTMLDialogElement[];
  return ds.length ? ds[ds.length - 1] : null;
}

function portalToast() {
  const toast = document.getElementById('toast');
  if (!toast) return;

  const dlg = topOpenDialog();
  const home = (document.querySelector('.container') as HTMLElement | null) ?? document.body;

  const target: HTMLElement = (dlg as any) ?? home;
  if (toast.parentElement !== target) target.appendChild(toast);
}

function installToastPortal() {
  if (_toastPortalInstalled) return;
  _toastPortalInstalled = true;

  const kick = () => requestAnimationFrame(() => portalToast());

  _toastPortalObs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const el = m.target as Element;
        if (el.matches?.('dialog') || (el as HTMLElement).id === 'toast') { kick(); break; }
      } else if (m.type === 'childList') {
        // re-render / dialog insertion / toast replacement
        kick();
        break;
      }
    }
  });

  _toastPortalObs.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open', 'class'],
  });

  // first sync
  kick();
}

// Rust(engine)과 동일한 토크나이즈 규칙
function isEngineWordChar(ch: string) {
  const cp = ch.codePointAt(0) ?? 0;
  const isAsciiNum = cp >= 0x30 && cp <= 0x39;
  const isAsciiUpper = cp >= 0x41 && cp <= 0x5A;
  const isAsciiLower = cp >= 0x61 && cp <= 0x7A;
  const isHangulSyllable = cp >= 0xac00 && cp <= 0xd7a3;
  const isHangulJamo1 = cp >= 0x3131 && cp <= 0x314e;
  const isHangulJamo2 = cp >= 0x314f && cp <= 0x3163;
  return isAsciiNum || isAsciiUpper || isAsciiLower || isHangulSyllable || isHangulJamo1 || isHangulJamo2;
}

function tokenizeEngineLike(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of String(s || '')) {
    const ch = raw.toLowerCase();
    if (isEngineWordChar(ch)) {
      cur += ch;
    } else if (cur) {
      if (cur.length >= 2) out.push(cur);
      cur = '';
    }
  }
  if (cur && cur.length >= 2) out.push(cur);
  return out;
}

// Rust(engine)과 동일한 norm 규칙
function normEngineLike(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function actorKey(a: ActorRef) {
  return `${String((a as any)?.type || '').trim()}::${String((a as any)?.name || '').trim()}`;
}


/* ==================== PUBLIC ==================== */

export function render() {
  const selected = getSelectedCase();
  const hasCases = Object.keys(S.cases).length > 0;
  const isAI = S.tab === 'cases';

  const mainHtml = S.tab === 'records' ? renderRecordsMain() : renderCasesMain(selected);
  const sideHtml = S.tab === 'records' ? renderRecordSidebar() : renderCaseSidebar(selected);

  const isCases = S.tab === 'cases';
  const showCaseSide = isCases && !!selected;

  const gridClass = S.tab === 'records'
    ? 'grid recGrid'
    : (showCaseSide ? 'grid caseGrid' : 'grid oneCol');

  const gridInner = `<main class="card">${mainHtml}</main><aside class="side">${sideHtml}</aside>`;

  $app.innerHTML = `
    <div class="container">
      <header class="topbar ${isAI ? 'aiFocus' : ''}">
        <div class="topbarInner">
          <div class="brand">
            <div class="name"><span class="brandAccent">r</span>oosycozy <span class="brandAccent">L</span>ite</div>
          </div>

          <nav class="flowSlim" aria-label="흐름">
            <button class="flowSeg ${S.tab === 'records' ? 'active' : ''}" data-action="tab" data-tab="records" type="button" ${S.tab === 'records' ? 'aria-current="step"' : ''}>
              <span class="segNo">1</span><span class="segTxt">메모하기</span>
            </button>
            <button class="flowSeg ${S.tab === 'cases' ? 'active' : ''}" data-action="tab" data-tab="cases" type="button" ${S.tab === 'cases' ? 'aria-current="step"' : ''}>
              <span class="segNo">2</span><span class="segTxt">메모묶음보기</span>
            </button>
            <button class="flowSeg" data-action="open-paper-picker" type="button" title="${hasCases ? '증빙자료를 출력할 메모 묶음을 고르세요' : '증빙자료 출력 화면을 열 수 있어요(빈 상태)'}">
              <span class="segNo">3</span><span class="segTxt">증빙자료출력</span>
            </button>
          </nav>

          <div class="hdrActions">
            <div class="hdrPrimary">
              ${H.btn('<span class="emIco" aria-hidden="true">🚨</span><span class="emLbl">스마트 메모 묶기</span>', 'open-case-create', ' title="비상 시 스마트 메모 묶기(관련 메모 자동 묶기)" aria-label="스마트 메모 묶기"', 'btn hdrEmergency pulse')}
              ${/* H.btn('샘플', 'load-sample', 'title="샘플 불러오기(현재 데이터 덮어쓰기)"', 'btn hdrSub') */''}
            </div>

            <div class="toolGroup" role="group" aria-label="도구">
              <button class="toolBtn" data-action="backup" type="button" title="백업 파일 저장" aria-label="백업">
                <span class="toolLbl">백업</span>
              </button>
              <button class="toolBtn" data-action="open-restore" type="button" title="복구(파일)" aria-label="복구">
                <span class="toolLbl">복구</span>
              </button>
<button class="toolBtn danger" data-action="wipe" type="button" title="전체 삭제" aria-label="전체 삭제">
                <span class="toolIco">⌫</span><span class="toolLbl">삭제</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <section class="${gridClass}">${gridInner}</section>

      <footer class="footer">
        <div>메모 ${S.records.length} · 메모 묶음 ${Object.keys(S.cases).length}</div>
        <div class="muted">저장소: localStorage (${esc(LS_KEY)})</div>
      </footer>

      ${ENABLE_BACKUP_RESTORE ? renderRestoreModal() : ''}
      ${renderLogsModal()}
      ${renderConfirmModal()}

      ${renderCaseCreateModal()}
      ${renderRecordModal()}
      ${renderTimelineDetailModal()}
      ${renderPaperPickModal()}
      ${renderCasePaperModal()}
      ${renderCaseUpdateModal()}

      <div class="toast" id="toast" role="status" aria-live="polite">
        <span class="toastMsg"></span>
        <button class="toastAct" data-action="toast-action" type="button" hidden></button>
      </div>
    </div>
  `;

  // keep open modals alive through re-render
  if (ui.caseCreateOpen) openCaseCreateModal();
  if (ui.paperPickOpen) openPaperPickModal();
  // keep toast visible even when <dialog>.showModal() is open
  installToastPortal();
  portalToast();

}

/* ==================== COMMON MODALS ==================== */


function renderPaperPickModal() {
  const all = Object.values(S.cases || {});
  const q = String(ui.paperPickQuery || '').trim();
  const list = all
    .map((c) => {
      const recs = recordsForCase(S.records, c);
      const last = recs.reduce((m, r) => (String(r.ts || '') > m ? String(r.ts || '') : m), '');
      return { c, recCount: recs.length, lastTs: last };
    })
    .sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));

  const filtered = q
    ? list.filter(({ c }) => matchLite([String((c as any).title || ''), String((c as any).query || ''), String((c as any).status || '')].join(' '), q))
    : list;

  const actions = `
    <div class="rowInline">
      ${H.btn('스마트 메모 모으기', 'paper-open-case-create', '', 'btn')}
      ${H.btn('닫기', 'close-paper-picker')}
    </div>
  `;

  const head = H.modalHead('증빙자료 출력', '어떤 메모 묶음을 증빙자료로 출력할까요?', actions);

  const body = all.length
    ? `
      <div class="paperPickList" role="list">
        ${filtered.length ? filtered.map(({ c, recCount, lastTs }) => `
          <button class="paperPickItem" data-action="pick-paper-case" data-id="${esc((c as any).id)}" type="button" role="listitem">
            <div class="paperPickMain">
              <div class="paperPickTitle">
                ${esc(String((c as any).title || '제목 없는 메모 묶음'))}
                ${S.selectedCaseId === (c as any).id ? `<span class="tag butter" style="margin-left:8px;">현재 열림</span>` : ''}
              </div>
              <div class="paperPickMeta">
                ${esc(trunc(String((c as any).query || ''), 70) || '—')}
              </div>
            </div>
            <div class="paperPickSide">
              <div class="paperPickStat">${esc(String((c as any).status || ''))}</div>
              <div class="paperPickStat muted">${esc(String(recCount))}개 메모</div>
              <div class="paperPickStat muted">${lastTs ? esc(fmt(lastTs)) : '—'}</div>
            </div>
          </button>
        `).join('') : H.empty('검색 결과가 없어요.', 120)}
      </div>

      <div class="muted" style="margin-top:10px; font-size:12px">
        선택 즉시 증빙자료 미리보기로 넘어가요.
      </div>
    `
    : `
      <div class="empty" style="height:160px">
        아직 메모 묶음이 없어요. 먼저 메모를 모아 묶음을 만든 뒤 증빙자료를 출력할 수 있어요.
      </div>
      <div class="rowInline" style="justify-content:flex-end; margin-top:10px">
        ${H.btn('✨ 스마트 메모 모으기', 'paper-open-case-create', '', 'btn primary')}
      </div>
    `;

  return H.modal('paperPickModal', head, body, 'modal paperPickModal');
}


function renderRestoreModal() {
  if (!ENABLE_BACKUP_RESTORE) return '';
  return H.modal(
    'restoreModal',
    H.modalHead('복구', '백업 파일(JSON)을 선택해 복구하세요. (현재 데이터 덮어씀)', H.btn('닫기', 'close-restore')),
    `
      <div class="field" style="margin-top:10px">
        <label>백업 파일</label>
        <div id="restoreDropZone" class="dropZone" data-action="pick-restore-file" role="button" tabindex="0">
          백업 파일을 클릭해서 선택하세요
          <small>또는 파일을 여기로 드래그&amp;드롭</small>
        </div>
        <input id="restoreFile" class="srOnly" type="file" accept=".json,application/json" />
        <div id="restoreFileName" class="muted" style="margin-top:10px; font-size:12px">선택된 파일 없음</div>
      </div>

      <div class="rowInline" style="margin-top:14px">
        ${H.btn('복구', 'do-restore', '', 'btn primary')}
      </div>
      <div class="muted" style="margin-top:10px; font-size:12px">
        복구하면 지금 데이터는 백업 파일 내용으로 덮어써져요.
      </div>
    `
  );
}

function renderLogsModal() {
  return H.modal(
    'logsModal',
    H.modalHead('로그', '클릭/삭제가 안 먹을 때 여기 먼저 확인', H.btn('닫기', 'close-logs')),
    `
      <pre class="logBox" id="logBox">${esc(logs.join('\n'))}</pre>
      <div class="rowInline" style="margin-top:12px">
        ${H.btn('로그 복사', 'copy-logs')}
        ${H.btn('로그 비우기', 'clear-logs')}
      </div>
    `
  );
}

function renderConfirmModal() {
  return H.modal(
    'confirmModal',
    H.modalHead('확인', '', ''),
    `
      <div class="muted" id="confirmMessage"></div>
      <div class="rowInline" style="margin-top:16px">
        ${H.btn('취소', 'confirm-no')}
        ${H.btn('확인', 'confirm-yes', '', 'btn primary')}
      </div>
    `
  );
}

/* ==================== RECORDS ==================== */

function renderRecordModal() {
  const r = ui.viewRecordId ? S.records.find((x) => x.id === ui.viewRecordId) ?? null : null;
  const title = r ? trunc(r.summary, 32) : '메모 상세';
  const related = r?.related || [];
  const relatedHtml = related.length ? H.chips(related.map(actorShort)) : `<div class="muted">관련자 없음</div>`;

  const body = r
    ? `<div class="detailGrid">
        ${H.dr('시간', esc(fmt(r.ts)))}        ${H.dr('보관형태', esc(storeLabel(r.storeType, r.storeOther)))}
        ${H.dr('주 Actor', esc(actorLabel(r.actor)))}
        ${H.dr('장소', esc(placeLabel(r.place, r.placeOther)))}
        ${H.ds('관련자', relatedHtml)}
        ${H.ds('내용', `<div class="detailNote">${esc(r.summary || '')}</div>`)}
      </div>`
    : H.empty('메모를 찾을 수 없어요.');

  return H.modal('recordModal', H.modalHead('메모', String(title), H.btn('닫기', 'close-record')), body);
}


function renderRecordsMain() {
  const total = S.records.length;
  const isEmpty = total === 0 && Object.keys(S.cases || {}).length === 0;
  return `
    <div class="sectionTitle">
      <div>
        <div class="h2">메모하기 <span class="miniTag">재료</span></div>
        <div class="muted"><b>상담/관찰/비정형/규정</b> 등 뭐든 짧게 메모해두면, AI가 나중에 <b>메모 묶음 타임라인</b>으로 모아줘요.</div>
      </div>
      <div class="titleActions">
        <span class="countPill">총 ${total}개</span>
        <span class="muted" style="font-size:12px">오른쪽에서 필터/검색</span>
      </div>
    </div>

    ${renderRecordEntryForm()}

    ${isEmpty ? `
      <div class="helperBox" style="margin-top:14px">
        <b>데모로 한 번에 보고 싶다면</b> 샘플 데이터를 불러올 수 있어요.
        <div class="actionsRow" style="margin-top:10px">
          ${/* H.btn('샘플 불러오기', 'load-sample', ' title="샘플 데이터를 불러와 현재 데이터를 덮어씁니다"', 'btn demo') */''}
        </div>
        <div class="muted" style="margin-top:6px; font-size:12px">
          샘플은 로컬스토리지에 저장돼요. 언제든 <b>백업</b>으로 저장하거나 <b>삭제</b>로 전체 삭제할 수 있어요.
        </div>
      </div>
    ` : ''}

    <div class="helperBox aiHelp"><b>팁:</b> 메모를 쌓아두면, 다음 탭에서 <b>알고리즘이 메모 묶음으로 자동 모아</b>줘요.</div>
  `;
}

function renderRecordSidebar() {
  const all = (S.records || []).slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const filtered = visibleRecords();

  const actorOpts = uniq(all.map((r) => actorShort(r.actor))).sort((a, b) => a.localeCompare(b));
  const hasFilters = Boolean(String((ui as any).recFilterActor || '').trim() || String((ui as any).recFilterPlace || '').trim() || String((ui as any).recFilterKeyword || '').trim());

  const mini = (r: RecordItem) => `
    <article class="recMini">
      ${H.tags([
        H.tag(trunc(actorShort(r.actor), 18)),
        H.tag(placeLabel(r.place, r.placeOther)),
        `<span class="tag lilac">${esc(storeLabel(r.storeType, r.storeOther))}</span>`,
      ])}
      <div class="recMiniTitle">${esc(trunc(r.summary || '', 92))}</div>
      <div class="recMiniMeta">${esc(fmt(r.ts))}</div>
      <div class="actionsRow">
        ${H.btnData('자세히', 'view-record', { id: r.id }, 'btn')}
        ${H.btnData('복사', 'copy-record', { id: r.id }, 'btn ghost')}
        ${H.btnData('삭제', 'delete-record', { id: r.id }, 'btn danger ghost')}
      </div>
    </article>
  `;

  const listHtml = filtered.length ? filtered.map(mini).join('') : H.empty(hasFilters ? '필터 결과가 없어요.' : '아직 메모가 없어요.', 140);

  const opt = (v: string, label: string, sel: string) =>
    `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`;

  const placeSel = String(((ui as any).recFilterPlaceDraft ?? (ui as any).recFilterPlace) || '');
  const placeOptions =
    `<option value="" ${!placeSel ? 'selected' : ''}>전체</option>` +
    (PLACE_TYPES as any as string[]).map((p) => opt(String(p), String(p), placeSel)).join('');

  const actorVal = String(((ui as any).recFilterActorDraft ?? (ui as any).recFilterActor) || '');
  const kwVal = String(((ui as any).recFilterKeywordDraft ?? (ui as any).recFilterKeyword) || '');

  return `
    <div class="sideStack">

      <section class="card sideCard memoFilterCard">
        <div class="sideCardHead">
          <div class="sideCardTitle">메모 필터</div>
          <div class="sideCardActions">
            ${H.btn('초기화', 'clear-record-filters', '', 'btn ghost')}
          </div>
        </div>

        <div class="memoFilterBar" style="margin-top:8px">
          <label class="srOnly" for="mfActor">주체</label>
          <input id="mfActor" class="mfInput" placeholder="주체" list="dlFilterActor"
            value="${esc(actorVal)}" data-action="draft-record-filters" data-field="actor" />

          <label class="srOnly" for="mfPlace">장소</label>
          <select id="mfPlace" class="mfSelect" data-action="draft-record-filters" data-field="place">${placeOptions}</select>

          <label class="srOnly" for="mfKw">키워드</label>
          <input id="mfKw" class="mfInput" placeholder="키워드" value="${esc(kwVal)}"
            data-action="draft-record-filters" data-field="keyword" />

          <span class="mfStat muted">
            ${hasFilters ? `필터 <b>${esc(String(filtered.length))}</b>/${esc(String(all.length))}` : `총 <b>${esc(String(all.length))}</b>개`}
          </span>

          <button class="btn ghost mfBtn" type="button" data-action="apply-record-filters">적용</button>
        </div>

        ${dl('dlFilterActor', actorOpts)}
      </section>

      <section class="card sideCard">
        <div class="sideCardHead">
          <div class="sideCardTitle">전체 메모</div>
          <div class="sideCardActions"><span class="countPill">${esc(String(filtered.length))}</span></div>
        </div>
        <div style="margin-top:10px; max-height: min(64vh, 720px); overflow:auto; padding-right:6px">
          ${listHtml}
        </div>
      </section>
    </div>
  `;
}



function renderRecordCard(r: RecordItem) {
  return `
    <article class="item simpleItem">
      ${H.tags([
        H.tag(trunc(actorShort(r.actor), 18)),
        H.tag(placeLabel(r.place, r.placeOther)),
        `<span class="tag lilac">${esc(storeLabel(r.storeType, r.storeOther))}</span>`,
      ])}
      <div class="title">${esc(r.summary)}</div>
      <div class="meta">${esc(fmt(r.ts))}</div>
      <div class="actionsRow">
        ${H.btnData('복사', 'copy-record', { id: r.id }, 'btn ghost')}
        ${H.btnData('자세히', 'view-record', { id: r.id })}
        ${H.btnData('삭제', 'delete-record', { id: r.id })}
      </div>
    </article>
  `;
}

function renderRecordEntryForm() {
  const showStoreOther = (draftRecord.storeTypeText || '') === '기타';
  const showPlaceOther = (draftRecord.placeText || '') === '기타';

  const actorType = String(draftRecord.actorTypeText || '학생');
  const actorName = String(draftRecord.actorNameOther || '').trim();
  const placeText = String(draftRecord.placeText || '교실');
  const storeTypeText = String(draftRecord.storeTypeText || '전화');

  const summaryTxt = String(draftRecord.summary || '').trim();
  const okSummary = summaryTxt.length >= 4;

  // '기타/없음' 성격의 주체 선택이면 이름 없이도 OK로 취급
  const okActor = actorType === UI_OTHER_ACTOR_LABEL || actorType === '없음' ? true : actorName.length > 0;

  const okTs = String(draftRecord.ts || '').trim().length >= 10;
  const okPlace = placeText.trim().length > 0;

  // 저장 가능(필수): 내용 + 시간 + 주체
  const reqMissing: string[] = [];
  if (!okSummary) reqMissing.push('내용');
  if (!okTs) reqMissing.push('시간');
  if (!okActor) reqMissing.push('주체');
  const canSave = okSummary && okTs && okActor;
  const reqLabel = canSave ? '필수 입력 완료' : `필수: ${reqMissing.join(' · ')}`;

  const mainNameField = renderNameFieldForType({
    typeText: actorType,
    value: String(draftRecord.actorNameOther || ''),
    action: 'draft-record',
    field: 'actorNameOther',
    placeholder: '이름(예: 학생1 / 1번 모 / 교장 / 김OO)'
  });

  const relNameField = renderNameFieldForType({
    typeText: String(draftRecord.relTypeText || ''),
    value: String(draftRecord.relNameOther || ''),
    action: 'draft-record',
    field: 'relNameOther',
    placeholder: '이름(예: 1번 부 / 교감 / 김OO)'
  });

  const relatedList =
    (draftRecord.related || []).length
      ? `<div class="chips mini" style="margin-top:8px">
          ${(draftRecord.related || [])
            .map(
              (a: ActorRef, idx: number) => `
              <span class="chip">
                ${esc(actorShort(a))}
                <button class="chipX" data-action="remove-related" data-idx="${esc(String(idx))}" type="button" title="삭제" aria-label="관련자 삭제">×</button>
              </span>
            `
            )
            .join('')}
        </div>`
      : `<div class="muted" style="margin-top:6px; font-size:12px">관련자가 없으면 비워도 돼요.</div>`;

  return `
    <div class="entryForm v2">
      <div class="composer">
        <div class="composerTop composerTopV3">
          <div class="composerTitleBlock">
            <div class="composerTitleRow">
              <div class="composerTitle">빠른 메모 캡처</div>
              <span id="recordReqPill" class="savePill ${canSave ? 'ready' : 'warn'}">${esc(reqLabel)}</span>
            </div>
            <div class="muted composerSub">사실만 짧게. 나중에 타임라인/증빙으로 정리돼요.</div>
          </div>

          <div class="composerCtas">
            <button id="btnSaveRecord" class="btn saveCta" data-action="save-record" type="button"
              ${canSave ? '' : 'disabled aria-disabled="true" title="필수 항목(내용/시간/주체)을 채우면 저장할 수 있어요"'}>
              <span class="saveIco" aria-hidden="true">✅</span>
              <span class="saveLbl">저장</span>
              <span class="saveKbd">Ctrl/⌘+Enter</span>
            </button>
            ${H.btn('비우기', 'clear-record-draft', '', 'btn ghost')}
          </div>
        </div>

        <div class="field" style="margin-bottom: 10px">
          <label>내용 <span class="reqStar">*</span></label>
          <textarea id="recordSummary" class="entryTa composerTa" rows="5"
            placeholder="예: 2교시 후 복도에서 학생 간 언쟁 발생. 서로 고성, 밀침은 없음."
            data-action="draft-record" data-field="summary">${esc(draftRecord.summary)}</textarea>
          <div id="recordWarnSummary" class="composerInlineWarn" ${okSummary ? 'hidden' : ''}>⚠ 내용은 최소 4글자 이상 입력해 주세요.</div>
        </div>

        <div class="metaInputs">
          <div class="field compact">
            <label>시간 <span class="reqStar">*</span></label>
            <input id="recordTs" class="${okTs ? '' : 'reqWarn'}" type="datetime-local" value="${esc(draftRecord.ts)}" data-action="draft-record" data-field="ts" />
            <div id="recordWarnTs" class="miniWarn" ${okTs ? 'hidden' : ''}>⚠ 시간을 선택해 주세요.</div>
          </div>

          <div class="field compact">
            <label>주체 <span class="reqStar">*</span></label>
            <div id="recordActorRow" class="rowInline compactRow ${okActor ? '' : 'reqWarn'}">
              <select data-action="draft-record" data-field="actorTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, actorType)}</select>
              <div class="grow">${mainNameField}</div>
            </div>
            <div id="recordWarnActor" class="miniWarn" ${okActor ? 'hidden' : ''}>⚠ 이름을 입력해 주세요.</div>
          </div>

          <div class="field compact">
            <label>장소</label>
            <select class="${okPlace ? '' : 'reqWarn'}" data-action="draft-record" data-field="placeText">${renderSelectFromList(PLACE_TYPES as any, placeText)}</select>
            ${
              showPlaceOther
                ? `<input value="${esc(draftRecord.placeOther)}" placeholder="장소 상세(기타)" data-action="draft-record" data-field="placeOther" />`
                : ''
            }
          </div>

          <div class="field compact">
            <label>보관</label>
            <select data-action="draft-record" data-field="storeTypeText">${renderSelectFromList(STORE_TYPES as any, storeTypeText)}</select>
            ${
              showStoreOther
                ? `<input value="${esc(draftRecord.storeOther)}" placeholder="보관형태 상세(기타)" data-action="draft-record" data-field="storeOther" />`
                : ''
            }
          </div>
        </div>

        ${dl('dlNameStudent', STUDENT_NAMES as any)}
        ${dl('dlNameParent', PARENT_NAMES as any)}
        ${dl('dlNameAdmin', ADMIN_NAMES as any)}

        <details class="metaMore">
          <summary>
            <span>관련자 추가</span>
            <span class="metaMoreCount">${esc(String((draftRecord.related || []).length))}명</span>
          </summary>
          <div class="metaMorePanel">
            <div class="field" style="margin-bottom:0">
              <div class="rowInline">
                <select data-action="draft-record" data-field="relTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, String(draftRecord.relTypeText || '학부모'))}</select>
                <div class="grow">${relNameField}</div>
                ${H.btn('추가', 'add-related', '', 'btn small')}
              </div>
              ${relatedList}
            </div>
          </div>
        </details>

        <div class="muted composerBottomHint">시간/주체는 필수예요. 나머지는 필요할 때만 추가하면 돼요.</div>
      </div>
    </div>
  `;
}


/* ==================== CASES ==================== */

function renderCasesMain(selected: CaseItem | null) {
  const ids = visibleCases();

  if (!ids.length) {
    return `
      <div class="sectionTitle">
        <div>
          <div class="h2">메모묶음보기</div>
          <div class="muted">요약을 입력하면 알고리즘이 관련 메모를 자동 선별해 메모 묶음 타임라인으로 모아줘요.</div>
        </div>
      </div>
      ${renderDefenseIntro()}
      <div class="empty">아직 메모 묶음이 없어요. 아래 버튼으로 시작해보세요.
        <div style="margin-top:12px">${H.btn('✨ 스마트 메모 모으기', 'open-case-create', '', 'btn primary aiPrimary')}</div>
      </div>
    `;
  }

  if (!selected) {
    return `
      <div class="sectionTitle">
        <div>
          <div class="h2">메모묶음보기</div>
          <div class="muted">메모 묶음을 열면 관련 메모가 시간순 타임라인으로 보여요.</div>
        </div>
        ${/* <div class="miniSearch">
            <input class="searchInput" placeholder="메모 묶음 제목/내용 검색…" value="" disabled />
          </div>
        */ ''}
      </div>
      ${renderDefenseIntro()}
      <div class="list">${ids.map((id) => renderCaseCard(S.cases[id])).join('')}</div>
    `;
  }

  return renderCaseTimeline(selected);
}

function renderCaseSidebar(selected: CaseItem | null) {
  if (!selected) return ``;

  const steps = (Array.isArray((selected as any).steps) ? (selected as any).steps : []) as StepItem[];
  const sorted = steps
    .slice()
    .sort((a: any, b: any) => String(b?.ts || '').localeCompare(String(a?.ts || '')));

  const stepList = sorted.length
    ? `
      <div class="stepMiniList" role="list" aria-label="내 조치 로그 목록">
        ${sorted
          .slice(0, 10)
          .map(
            (s: any) => `
          <div class="stepMini" role="listitem">
            <div class="stepMiniMain">
              <div class="stepMiniTop">
                <span class="tag butter miniTag">${esc(trunc(String(s?.name || ''), 18) || '단계')}</span>
                <span class="stepMiniTime">${s?.ts ? esc(fmt(String(s.ts))) : '—'}</span>
              </div>
              <div class="stepMiniNote">${esc(trunc(String(s?.note || ''), 90) || '')}</div>
            </div>
            <div class="stepMiniActs">
              ${H.btnData('보기', 'view-timeline', { kind: 'step', id: String(s?.id || '') }, 'btn ghost mini')}
              ${H.btnData('삭제', 'delete-step', { id: String(s?.id || '') }, 'btn ghost mini')}
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    `
    : `<div class="muted" style="padding:10px 0;">아직 저장된 내 조치 로그가 없어요.</div>`;

  return `
    <div class="sideStack">
      <section class="card sideCard actionSide">
        <div class="sideCardHead">
          <div>
            <div class="sideCardTitle">내 조치 로그</div>
            <div class="muted" style="margin-top:2px">이 묶음에서 저장한 대응</div>
          </div>
          <span class="countPill">${esc(String(steps.length))}</span>
        </div>

        <details class="fold actionFold" open>
          <summary>새 로그 추가</summary>
          <div class="fold-content">
            <div class="actionComposer">
              <div class="actionRow2">
                <div class="field compact">
                  <label>시간</label>
                  <input type="datetime-local" value="${esc(draftStep.ts)}" data-action="draft-step" data-field="ts" />
                </div>

                <div class="field compact">
                  <label>단계</label>
                  <input value="${esc(draftStep.name)}" placeholder="예: 1차 안내" data-action="draft-step" data-field="name" />
                </div>
              </div>

              <div class="field compact" style="margin-bottom:0">
                <label>내용</label>
                <textarea rows="3" class="actionTa" placeholder="짧게 메모 (Ctrl/⌘+Enter 추가)" data-action="draft-step" data-field="note">${esc(draftStep.note)}</textarea>
              </div>

              <div class="actionActions">
                ${H.btn('추가', 'add-step', '', 'btn primary small')}
                ${H.btn('가이드 재생성', 'regen-advisors', '', 'btn small')}
              </div>
            </div>
          </div>
        </details>

        <div class="miniSep"></div>
        <div class="muted" style="font-size:12px; margin:10px 0 8px">최근 로그</div>
        ${stepList}
      </section>
    </div>
  `;
}

function renderCaseCreateModal() {
  const addNameField = renderNameFieldForType({
    typeText: String(((draftCase as any).addTypeText || '') as any),
    value: String(draftCase.addNameOther || ''),
    action: 'draft-case',
    field: 'addNameOther',
    placeholder: '이름(예: 학생1 / 1번 모 / 교장 / 김OO)'
  });

  const chips =
    (draftCase.actors || []).length
      ? `<div class="chips" style="margin-top:8px">
          ${(draftCase.actors || [])
            .map(
              (a: ActorRef, idx: number) => `
              <span class="chip">
                ${esc(actorShort(a))}
                <button class="iconBtn" data-action="remove-case-actor" data-idx="${esc(String(idx))}" type="button" title="삭제">×</button>
              </span>
            `
            )
            .join('')}
        </div>`
      : `<div class="muted" style="margin-top:6px">관련자가 없으면 <b>${esc(UI_OTHER_ACTOR_LABEL)} / 없음</b>을 추가해 주세요.</div>`;

  // ✅ Actor 1명 이상일 때만 시작 가능
  const canStart = (draftCase.actors || []).length > 0;
  const startExtra = canStart ? '' : ' disabled aria-disabled=\"true\" title=\"Actor를 1명 이상 추가해야 시작할 수 있어요\"';

  return H.modal(
    'caseCreateModal',
    H.modalHead('스마트 메모 모으기', 'AI가 관련 메모를 자동으로 모아줍니다.', H.btn('닫기', 'close-case-create')),
    `
      <div class="helperBox aiHelp" style="margin-bottom:14px; margin-top:0;">
        <b>사용법:</b> 누구의 기록을 모을지 선택하세요. AI가 해당 인물과 관련된 메모를 우선적으로 찾아옵니다.
      </div>

      <div class="field highlight-section">
        <label style="color:var(--primary-dark); font-size:13px;">① 누구의 기록을 모을까요? (필수)</label>
        <div class="miniOptionRow">
          <label class="miniToggle" title="원하시면 체크하세요. ①에서 첫 번째로 추가한 인물(주요 인물)의 record.actor만 모읍니다.">
            <input type="checkbox" data-action="draft-case" data-field="onlyMainActor" ${((draftCase as any).onlyMainActor ? 'checked' : '')} />
            <span>해당 학생(주요 인물) 기록만</span>
          </label>
          <div class="miniHint">원하시면 위 체크박스를 클릭/체크해 주세요. (①에서 첫 번째로 추가한 인물 기준)</div>
        </div>
        <div class="rowInline">
          <select data-action="draft-case" data-field="addTypeText" style="flex:0 0 100px;">${renderSelectFromList(UI_ACTOR_TYPES as any, String((draftCase as any).addTypeText || '학생'))}</select>
          ${addNameField}
          ${H.btn('추가', 'add-case-actor')}
        </div>
        ${chips}
      </div>

      <div class="field" style="margin-top:16px;">
        <label>② 어떤 사건인가요? (요약/키워드)</label>
        <textarea rows="3" placeholder="예: 복도에서 언쟁, 급식실 안전사고 등 (비워두면 인물 중심으로만 찾습니다)" data-action="draft-case" data-field="query">${esc(draftCase.query)}</textarea>
      </div>

      <details class="fold" style="margin-top:12px;">
        <summary>옵션: 기간 및 제목 직접 설정</summary>
        <div class="fold-content">
          <div class="row">
            <div class="field">
              <label>기간 시작</label>
              <input type="datetime-local" value="${esc(draftCase.timeFrom)}" data-action="draft-case" data-field="timeFrom" />
            </div>
            <div class="field">
              <label>기간 종료</label>
              <input type="datetime-local" value="${esc(draftCase.timeTo)}" data-action="draft-case" data-field="timeTo" />
            </div>
          </div>

          <div class="field">
            <label>메모 묶음 제목 (비워두면 자동 생성)</label>
            <input value="${esc(draftCase.title)}" placeholder="예: 3학년 복도 언쟁 민원" data-action="draft-case" data-field="title" />
          </div>
        </div>
      </details>

      <div class="rowInline" style="margin-top:16px; padding-top:10px; border-top:1px solid var(--grey-200);">
        ${H.btn('메모 모으기 시작', 'create-case', startExtra, 'btn primary aiPrimary')}
        ${H.btn('초기화', 'clear-case-draft')}
      </div>
    `,
    'modal caseCreateModal'
  );
}

// ✅ [중요 수정] 업데이트 모달: 기본으로 '전체 목록'을 보여주고, AI 추천 점수가 있으면 상위 노출
function renderCaseUpdateModal() {
  const c = ui.updateCaseId ? S.cases[ui.updateCaseId] ?? null : null;
  const q = String(ui.qUpdate || '').trim();

  // 1. 현재 케이스에 이미 들어있는 ID 제외
  const existingIds = new Set(c?.recordIds || []);
  
  // 2. AI 추천 정보 맵핑 (id -> {score, reasons, rank})
  const aiMap = new Map((ui.updateCandidates || []).map((cand) => [cand.id, cand]));

  // 3. 전체 레코드 중 '미포함'된 것들만 추림
  let items = S.records
    .filter(r => !existingIds.has(r.id))
    .map(r => {
      const aiInfo = aiMap.get(r.id);
      return {
        id: r.id,
        record: r,
        // AI 추천 정보가 있으면 사용, 없으면 0점
        score: aiInfo ? aiInfo.score : 0,
        rank: aiInfo ? aiInfo.rank : null,
        reasons: aiInfo ? aiInfo.reasons : []
      };
    });
  // 4. 필터(적용된 값) - 적용 버튼을 눌러야 반영
  const baseTotal = items.length;

  const fActor = String((ui as any).updFilterActor || '').trim();
  const fPlace = String((ui as any).updFilterPlace || '').trim();
  const fKw = String((ui as any).updFilterKeyword || '').trim();
  const hasAppliedFilters = Boolean(fActor || fPlace || fKw);

  if (fActor) items = items.filter(item => matchLite(actorShort(item.record.actor), fActor));
  if (fPlace) items = items.filter(item => String(item.record.place || '') === fPlace);
  if (fKw) items = items.filter(item => matchLite([item.record.summary, actorShort(item.record.actor), placeLabel(item.record.place, item.record.placeOther), item.record.ts].join(' '), fKw));

  const filteredTotal = items.length;

  // 5. 정렬: 점수 높은순 -> 최신 날짜순
  items.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.01) return b.score - a.score; // 점수 내림차순
    return String(b.record.ts || '').localeCompare(String(a.record.ts || '')); // 최신순
  });

  const title = c ? trunc(c.title, 40) : '기록 추가';

  // 필터 바 (입력값=draft, 적용값=applied)
  const updPlaceSel = String(((ui as any).updFilterPlaceDraft ?? (ui as any).updFilterPlace) || '');
  const updPlaceOptions =
    `<option value="" ${!updPlaceSel ? 'selected' : ''}>전체</option>` +
    (PLACE_TYPES as any as string[]).map((p) => `<option value="${esc(String(p))}" ${String(p) === updPlaceSel ? 'selected' : ''}>${esc(String(p))}</option>`).join('');

  const updActorVal = String(((ui as any).updFilterActorDraft ?? (ui as any).updFilterActor) || '');
  const updKwVal = String(((ui as any).updFilterKeywordDraft ?? (ui as any).updFilterKeyword) || '');

  const updActorOpts = uniq(S.records.filter(r => !existingIds.has(r.id)).map((r) => actorShort(r.actor))).sort((a, b) => a.localeCompare(b));
  const updFilterBar = `
    <section class="card sideCard memoFilterCard" style="margin-top:0; padding:10px 12px">
      <div class="memoFilterBar">
        <label class="srOnly" for="updActor">주체</label>
        <input id="updActor" class="mfInput" placeholder="주체" list="dlUpdateActor"
          value="${esc(updActorVal)}" data-action="draft-update-filters" data-field="actor" />

        <label class="srOnly" for="updPlace">장소</label>
        <select id="updPlace" class="mfSelect" data-action="draft-update-filters" data-field="place">${updPlaceOptions}</select>

        <label class="srOnly" for="updKw">키워드</label>
        <input id="updKw" class="mfInput" placeholder="키워드" value="${esc(updKwVal)}"
          data-action="draft-update-filters" data-field="keyword" />

        <span class="mfStat muted">
          ${hasAppliedFilters ? `필터 <b>${esc(String(filteredTotal))}</b>/${esc(String(baseTotal))}` : `총 <b>${esc(String(baseTotal))}</b>개`}
        </span>

        <button class="btn ghost mfBtn" type="button" data-action="apply-update-filters">적용</button>
        <button class="btn ghost mfBtn" type="button" data-action="clear-update-filters">초기화</button>
      </div>

      ${dl('dlUpdateActor', updActorOpts)}
    </section>
  `;

  
  // 6. 목록 렌더링
  const listHtml = items.length
    ? `<div class="list" style="margin-top:12px">
        ${items.map((item) => {
          const { id, score, record, reasons, rank } = item;
          
          const tags = [];
          // AI 점수가 유의미하게 있을 때만 뱃지 표시
          if (score > 0) {
            tags.push(`<span class="tag butter">#${rank ?? '?'} 점수 ${esc(score.toFixed(2))}</span>`);
            if (reasons) reasons.forEach((t: string) => tags.push(`<span class="tag aiReason">${esc(t)}</span>`));
          }
          tags.push(H.tag(trunc(actorShort(record.actor), 18)));
          tags.push(H.tag(placeLabel(record.place, record.placeOther)));

          return `
            <label class="item pickItem">
              <div class="pickRow">
                <input class="chk" type="checkbox" name="caseUpdPick" value="${esc(id)}" ${((ui.updatePickIds||[]) as any).includes(id) ? "checked" : ""} data-action="toggle-update-pick" data-field="pick" />
                <div style="flex:1; min-width:0">
                  ${H.tags(tags)}
                  <div class="title" style="margin-top:4px">${esc(record.summary)}</div>
                  <div class="meta">${esc(fmt(record.ts))}</div>
                </div>
              </div>
            </label>
          `;
        }).join('')}
      </div>`
    : H.empty('추가할 수 있는 메모가 없어요.');

  // 안내 메시지: 로딩 중이면 표시하되, 데이터는 보여줌(이미 있는 데이터)
  const loadingMsg = ui.updateCandidatesLoading ? '<span class="muted" style="font-size:12px; margin-left:8px;">(AI 점수 계산 중...)</span>' : '';

  return H.modal(
    'caseUpdateModal',
    H.modalHead('기록 추가', `${title}${loadingMsg}`, `<div class="rowInline">${H.btn('닫기', 'close-case-update')}${H.btn('선택한 항목 추가', 'apply-case-update', '', 'btn primary')}</div>`),
    `
      ${updFilterBar}${listHtml}
    `
  );
}

function renderTimelineDetailModal() {
  const c = getSelectedCase();
  const tl = ui.viewTimelineItem;

  if (!tl || !c) {
    return H.modal(
      'timelineDetailModal',
      H.modalHead('타임라인 상세', '메모 묶음을 먼저 열어주세요.', H.btn('닫기', 'close-timeline-detail')),
      H.empty('표시할 데이터가 없어요.')
    );
  }

  // NOTE: 상세 모달은 "점수 근거"에 집중. (묶음 맥락/이웃 이벤트는 표시하지 않음)
  let title = '타임라인 상세';
  let body = H.empty('데이터를 찾을 수 없어요.');

  if (tl.kind === 'record') {
    const r = S.records.find((x) => x.id === tl.id) ?? null;
    if (r) {
      title = trunc(r.summary, 40);

      const caseActors = (c.actors || []).slice();
      const scoreMap = (c.scoreByRecordId || {}) as Record<string, number>;

      // === Rust 엔진 스냅샷(구성요소) 우선 ===
      // 케이스 생성/업데이트 시 Rust가 계산한 RankedComponents를 case.componentsByRecordId에 저장해두고,
      // 상세 모달에서는 그 값을 "그대로" 표시합니다. (구버전 케이스는 없을 수 있어요)
      const caseActorKeys = caseActors.filter((a) => String(a?.name || '').trim()).map(actorKey);

      const compMap = ((c as any).componentsByRecordId || {}) as Record<string, any>;
      const comp = compMap[r.id] as any | undefined;

      const caseQuery = (c.query || '').trim();
      const qTokens = caseQuery ? tokenizeEngineLike(caseQuery) : [];
      const summaryNorm = normEngineLike(String(r.summary || ''));

      let hitCount = 0;
      const hitTokensForUi: string[] = [];
      for (const qt of qTokens) {
        if (qt.length >= 2 && summaryNorm.includes(qt)) {
          hitCount += 1;
          if (!hitTokensForUi.includes(qt)) hitTokensForUi.push(qt);
        }
      }

      // comp가 있으면 그 값을 "진짜 값"으로 사용 (UI 재계산은 표시용)
      if (comp && typeof comp.qHit === 'number') hitCount = comp.qHit;

      const textSim = comp && typeof comp.textSim === 'number' ? comp.textSim : (qTokens.length ? hitCount / qTokens.length : 0);

      const W_TEXT = comp && typeof comp.wText === 'number' ? comp.wText : 2.0;
      const keywordScore = comp && typeof comp.keywordScore === 'number' ? comp.keywordScore : (textSim * W_TEXT);

      const mainActorKey = actorKey(r.actor);
      const mainActorMatch = comp && typeof comp.actorMatch === 'boolean' ? comp.actorMatch : caseActorKeys.includes(mainActorKey);

      const W_ACTOR = comp && typeof comp.wActor === 'number' ? comp.wActor : 2.5;
      const actorScore = comp && typeof comp.actorScore === 'number' ? comp.actorScore : (mainActorMatch ? W_ACTOR : 0);

      const relatedMatches = (Array.isArray(r.related) ? r.related : []).filter((ra) => caseActorKeys.includes(actorKey(ra)));
      const W_RELATED = comp && typeof comp.wRelated === 'number' ? comp.wRelated : 1.0;

      const relatedHitCount = comp && typeof comp.relatedHits === 'number' ? comp.relatedHits : relatedMatches.length;
      const relatedScore = comp && typeof comp.relatedScore === 'number' ? comp.relatedScore : (relatedHitCount * W_RELATED);

      const engineScore = keywordScore + actorScore + relatedScore;

      // 저장된 점수(스냅샷)가 있으면 그걸 우선 표시하고,
      // 혹시 현재 엔진 재계산과 다르면 둘 다 보여줌
      const storedScore = scoreMap[r.id];
      const scoreToShow = typeof storedScore === 'number' ? storedScore : engineScore;

      const within = isWithinRangeISO(r.ts, (c as any).timeFrom || undefined, (c as any).timeTo || undefined);
      const hasRange = !!((c as any).timeFrom || (c as any).timeTo);
      const inSnapshot = Array.isArray((c as any).recordIds) && (c as any).recordIds.includes(r.id);

      // 포함 판정(엔진 기준: Rust가 보내준 threshold 사용)
      const MIN_TEXT_SIM = comp && typeof comp.minTextSim === 'number' ? comp.minTextSim : 0.34;
      const MIN_SCORE = comp && typeof comp.minScore === 'number' ? comp.minScore : 0.8;
      const includeLogic = mainActorMatch || relatedHitCount > 0 || (qTokens.length ? textSim >= MIN_TEXT_SIM : true);
      const includeByRule = (!hasRange || within) && includeLogic && engineScore >= MIN_SCORE;

      // 디버그: 실제 매칭된 actor들(표시용)
      const matchedActorsPretty = uniq(
        recordActors(r)
          .filter((ra) => caseActors.some((ca) => actorEqLite(ra, ca)))
          .map(actorShort)
      );

      body = `
        <div class="detailGrid">
          ${H.dr('시간', esc(fmt(r.ts)))}
          ${H.dr('주체', esc(actorLabel(r.actor)))}
          ${H.dr('장소', esc(placeLabel(r.place, r.placeOther)))}
          ${H.ds('내용', `<div class="detailNote">${esc(r.summary || '')}</div>`)}

          ${H.ds(
            '점수 산출 근거',
            `
              <div class="muted" style="margin-top:6px">
                아래 값은 <b>Rust 엔진이 계산해 저장한 구성요소(스냅샷)</b> 기준으로 표시해요. ${comp ? '' : '<span class="muted">(구버전 케이스라 구성요소 스냅샷이 없어서, 일부는 UI에서 보조 계산으로 표시될 수 있어요)</span>'}
              </div>

              <div style="margin-top:10px" class="detailRow"><div class="k">스냅샷 포함</div><div class="v">${esc(inSnapshot ? '예 (recordIds 포함)' : '아니오')}</div></div>
              ${hasRange ? `<div class="detailRow"><div class="k">기간 필터</div><div class="v">${esc(within ? '통과(기간 안)' : '불일치(기간 밖)')}</div></div>` : ''}

              <div class="detailRow">
                <div class="k">총점</div>
                <div class="v">
                  ${esc(scoreToShow.toFixed(2))}
                  ${
                    typeof storedScore === 'number' && Math.abs(storedScore - engineScore) > 0.01
                      ? ` <span class="muted" style="font-weight:650">(참고: 계산 ${engineScore.toFixed(2)})</span>`
                      : ''
                  }
                </div>
              </div>

              <div class="detailSection" style="margin-top:12px">
                <div class="k">구성 요소</div>

                <div class="detailRow">
                  <div class="k">키워드 유사도</div>
                  <div class="v">
                    +${esc(keywordScore.toFixed(2))}
                    (${esc(String(hitCount))}/${esc(String(qTokens.length || 0))} · sim=${esc(textSim.toFixed(2))}${
                      hitTokensForUi.length ? ` · ${esc(hitTokensForUi.slice(0, 8).join(', '))}` : ''
                    })
                  </div>
                </div>

                <div class="detailRow">
                  <div class="k">주 Actor 일치</div>
                  <div class="v">${mainActorMatch ? `+${esc(actorScore.toFixed(2))} (일치)` : '0.00 (불일치)'}</div>
                </div>

                <div class="detailRow">
                  <div class="k">관련자 일치</div>
                  <div class="v">
                    +${esc(relatedScore.toFixed(2))}
                    (${esc(String(relatedHitCount))}명${
                      relatedMatches.length ? ` · ${esc(uniq(relatedMatches.map(actorShort)).slice(0, 8).join(', '))}` : ''
                    })
                  </div>
                </div>
              </div>

              <div class="detailSection" style="margin-top:12px">
                <div class="k">판정</div>
                <div class="muted">
                  포함 조건: (1) 기간 필터 통과(설정 시) AND (2) <b>주 Actor 일치 OR 관련자 포함 OR 키워드 유사도(sim ≥ ${MIN_TEXT_SIM.toFixed(
                    2
                  )})</b> AND (3) <b>총점 ≥ ${esc(MIN_SCORE.toFixed(2))}</b>
                  ${qTokens.length ? '' : '<span class="muted">(요약이 비어있어도, Actor/관련자 매칭이 없으면 점수가 낮아 제외될 수 있어요)</span>'}
                </div>

                <div class="detailRow" style="margin-top:10px">
                  <div class="k">엔진 판정</div>
                  <div class="v">${esc(includeByRule ? '포함 후보' : '제외 후보')}</div>
                </div>

                ${
                  qTokens.length
                    ? `<div class="detailRow"><div class="k">요약 토큰</div><div class="v">${esc(qTokens.slice(0, 12).join(', ') || '—')}</div></div>`
                    : ''
                }

                ${
                  matchedActorsPretty.length
                    ? `<div class="chips" style="margin-top:10px">${matchedActorsPretty
                        .map((x) => `<span class="chip">${esc(x)}</span>`)
                        .join('')}</div>`
                    : ''
                }
              </div>
            `
          )}
        </div>
      `;
    }
  } else if (tl.kind === 'advisor') {
    const a = ((c as any).advisors || []).find((x: any) => x.id === tl.id) ?? null;
    if (a) {
      title = trunc(a.title, 44);
      const hintParts: string[] = [];
      if (((c as any).actors || []).length) hintParts.push(`Actor ${String(((c as any).actors || []).length)}명`);
      if (((c as any).query || '').trim()) hintParts.push('요약 있음');
      if ((c as any).timeFrom || (c as any).timeTo) hintParts.push('기간 설정');

      body = `
        <div class="detailGrid">
          ${H.dr('시간', esc(fmt(a.ts)))}
          ${H.dr('레벨', esc(String(a.level)))}
          ${H.dr('상태', esc(String(a.state)))}
          ${(a.ruleId || '').trim() ? H.dr('룰', esc(String(a.ruleId || ''))) : ''}
          ${H.ds('내용', `<div class="detailNote">${esc(a.body)}</div>`)}
          ${H.ds(
            '왜 이 대응 가이드가 뜨나',
            `<div class="muted" style="margin-top:6px">대응 가이드는 메모 묶음 설정(Actor/요약/기간/패턴) 기반으로 생성돼요.</div>
             <div class="chips" style="margin-top:10px">${hintParts.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>`
          )}
        </div>
      `;
    }
  } else {
    const s = ((c as any).steps || []).find((x: any) => x.id === tl.id) ?? null;
    if (s) {
      title = trunc(s.note, 44);
      body = `
        <div class="detailGrid">
          ${H.dr('시간', esc(fmt(s.ts)))}
          ${H.dr('이름', esc(s.name))}
          ${H.ds('내 조치 로그 메모', `<div class="detailNote">${esc(s.note)}</div>`)}
          ${H.ds('왜 포함됐나', `<div class="muted">내 조치 로그는 이 메모 묶음에서 직접 저장된 실행/대응 로그라서 타임라인에 항상 포함돼요.</div>`)}
        </div>
      `;
    }
  }

  return H.modal(
    'timelineDetailModal',
    H.modalHead('타임라인 상세', String(title), H.btn('닫기', 'close-timeline-detail')),
    body
  );
}


function renderDefenseIntro() {
  // (removed) Intro banner shown in screenshots.
  return ``;
}


function renderCaseCard(c: CaseItem) {
  const mapped = recordsForCase(S.records, c).length;
  const qHint = trunc((c as any).query || '', 52);
  const hasRange = !!((c as any).timeFrom || (c as any).timeTo);
  const isSelected = S.selectedCaseId === (c as any).id;

  return `
    <article class="item ${isSelected ? 'selected' : ''}">
      ${H.tags([
        `<span class="tag ai">${esc('AI')}</span>`,
        H.tag(hasRange ? '기간' : '기간없음'),
      ])}
      <div class="title">${esc((c as any).title)}</div>
      ${((c as any).query || '').trim() ? `<div class="muted" style="margin-top:8px">요약: ${esc(qHint || '-')}</div>` : ''}
      <div class="actionsRow">
        ${H.btnData('열기', 'select-case', { id: (c as any).id }, 'btn primary')}
        ${H.btnData('삭제', 'delete-case', { id: (c as any).id })}
      </div>
    </article>
  `;
}

function renderCaseStatsInline(c: CaseItem, mappedCount: number, totalEvents: number) {
  // (removed) Stats pills shown in screenshots.
  return ``;
}


function renderCaseTimeline(c: CaseItem) {
  const { events, mappedCount, hasRange } = buildCaseTimeline(c, S.records, '');
  // 타임라인 검색 UI 제거(스크린샷 영역 제거 요청)
  const filtered = events;

  return `
    <div class="sectionTitle">
      <div class="caseTitleLeft">
        <div class="h2">${esc((c as any).title)}</div>
        <div class="muted"><span class="badgeAI">AI 선별</span> 관련 메모 자동 선별</div>
        ${hasRange ? `<div class="muted" style="margin-top:8px">기간: ${esc((c as any).timeFrom ? fmt((c as any).timeFrom) : '—')} ~ ${esc((c as any).timeTo ? fmt((c as any).timeTo) : '—')}</div>` : ''}
        ${((c as any).query || '').trim() ? `<div class="muted" style="margin-top:8px">요약: ${esc(trunc((c as any).query || '', 90))}</div>` : ''}
      </div>

      <div class="caseTitleRight">
        <div class="aiTopActions">
          ${H.btn('기록추가', 'open-case-update')}
          ${H.btn('증빙자료출력', 'open-paper')}
          ${H.btn('목록으로', 'clear-case')}
        </div>
      </div>
    </div>

    ${filtered.length ? renderTimelineWithDays(filtered) : `<div class="empty">표시할 항목이 없어요.</div>`}
  `;
}

function fmtDay(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '').slice(0, 10);
  // 예: 2026. 02. 16. (일)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const w = d.toLocaleDateString('ko-KR', { weekday: 'short' });
  return `${y}. ${m}. ${day}. (${w})`;
}

function eventTs(ev: any): string {
  try {
    if (!ev) return '';
    if (ev.kind === 'record') return String(ev?.record?.ts || '');
    if (ev.kind === 'advisor') return String(ev?.advisor?.ts || '');
    return String(ev?.step?.ts || '');
  } catch {
    return '';
  }
}

function renderTimelineWithDays(events: any[]) {
  let lastDay = '';
  const parts: string[] = [];
  for (const ev of events || []) {
    const ts = eventTs(ev);
    const dayKey = ts ? String(ts).slice(0, 10) : '';
    if (dayKey && dayKey !== lastDay) {
      parts.push(`<div class="tDay"><span class="tDayPill">${esc(fmtDay(ts))}</span></div>`);
      lastDay = dayKey;
    }
    parts.push(renderTimelineEvent(ev));
  }
  return `<div class="timelineWrap"><div class="timeline timelineEm">${parts.join('')}</div></div>`;
}

function renderTimelineEvent(ev: any) {
  if (ev.kind === 'record') {
    const r = ev.record as RecordItem;
    const score = ev.score as number | undefined;
    return `
      <div class="tItem">
        <div class="dot" aria-hidden="true"></div>
        <div class="tCard">
          ${H.tags([
            typeof score === 'number' ? `<span class="tag butter">AI점수 ${esc(score.toFixed(2))}</span>` : '',
            H.tag(trunc(actorShort(r.actor), 18)),
            H.tag(placeLabel(r.place, r.placeOther)),
          ])}
          <div class="title">${esc(r.summary)}</div>
          <div class="meta">${esc(fmt(r.ts))}</div>
          <div class="actionsRow" style="margin-top:12px">
            ${H.btnData('자세히', 'view-timeline', { kind: 'record', id: r.id })}
            ${H.btnData('묶음에서 제외', 'remove-record-from-case', { id: r.id }, 'btn ghost')}
          </div>
        </div>
      </div>
    `;
  }

  if (ev.kind === 'advisor') {
    const a = ev.advisor as AdvisorItem;
    const done = (a as any).state === 'done';
    return `
      <div class="tItem">
        <div class="dot advisorDot" aria-hidden="true"></div>
        <div class="tCard advisorCard ${done ? 'done' : ''}">
          ${H.tags([`<span class="tag ai">${esc('대응 가이드')}</span>`, H.tag(String((a as any).level))])}
          <div class="title">${esc((a as any).title)}</div>
          <div class="detailNote" style="margin:10px 0 0;">${esc((a as any).body)}</div>
          <div class="meta" style="margin-top:10px">${esc(fmt((a as any).ts))}</div>
          <div class="actionsRow" style="margin-top:12px">
            ${H.btnData('자세히', 'view-timeline', { kind: 'advisor', id: (a as any).id })}
            ${H.btnData(done ? '다시' : '완료', 'toggle-advisor-done', { id: (a as any).id })}
            ${H.btnData('내 조치 로그로 저장', 'advisor-to-step', { id: (a as any).id })}
            ${H.btnData('숨기기', 'dismiss-advisor', { id: (a as any).id })}
          </div>
        </div>
      </div>
    `;
  }

  const s = ev.step as StepItem;
  const isFlash = ui.flashStepId === (s as any).id;

  return `
    <div class="tItem">
      <div class="dot stepDot ${isFlash ? 'flash' : ''}" aria-hidden="true"></div>
      <div class="tCard stepCard ${isFlash ? 'flash' : ''}">
        ${H.tags([`<span class="tag butter">${esc('내 조치 로그')}</span>`, H.tag(trunc((s as any).name, 24))])}
        <div class="title">${esc((s as any).note)}</div>
        <div class="meta">${esc(fmt((s as any).ts))}</div>
        <div class="actionsRow">
          ${H.btnData('자세히', 'view-timeline', { kind: 'step', id: (s as any).id })}
          ${H.btnData('삭제', 'delete-step', { id: (s as any).id })}
        </div>
      </div>
    </div>
  `;
}