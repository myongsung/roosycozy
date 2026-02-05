import { esc, trunc, fmt, LS_KEY } from '../utils';
import type { CaseItem, RecordItem, AdvisorItem, StepItem, ActorRef } from '../engine';
import { recordActors, recordsForCase, buildCaseTimeline } from '../engine';
import {
  S, ui, $app, logs,
  matchLite,
  renderSelectFromList,
  STORE_TYPES, PLACE_TYPES, LVS, UI_ACTOR_TYPES,
  renderNameFieldForType,
  storeLabel, placeLabel, lvLabel, actorLabel, actorShort,
  draftRecord, draftCase, draftStep,
  getSelectedCase, visibleRecords, visibleCases,
  openRecordsListModal, openCaseCreateModal, openPaperPickModal,
  actorEqLite, uniq, tokenizeLite, isWithinRangeISO, daysDiff,
  UI_OTHER_ACTOR_LABEL, STUDENT_NAMES, PARENT_NAMES, ADMIN_NAMES
} from './state';
import { renderCasePaperModal } from './paper';

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


// Rust(engine)과 동일한 토크나이즈 규칙(점수 산출 근거를 "정확하게" 표시하기 위함)
// - ASCII 영숫자 + 한글 범위만 단어로 취급
// - 그 외 문자는 단어 분리자
// - 토큰 길이 2 이상만 사용
function isEngineWordChar(ch: string) {
  const cp = ch.codePointAt(0) ?? 0;
  const isAsciiNum = cp >= 0x30 && cp <= 0x39;
  const isAsciiUpper = cp >= 0x41 && cp <= 0x5A;
  const isAsciiLower = cp >= 0x61 && cp <= 0x7A;
  const isHangulSyllable = cp >= 0xac00 && cp <= 0xd7a3; // 가-힣
  const isHangulJamo1 = cp >= 0x3131 && cp <= 0x314e; // ㄱ-ㅎ
  const isHangulJamo2 = cp >= 0x314f && cp <= 0x3163; // ㅏ-ㅣ
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

  const gridClass = isAI ? 'grid aiSwap' : 'grid';
  const gridInner = isAI
    ? `<aside class="side">${sideHtml}</aside><main class="card">${mainHtml}</main>`
    : `<main class="card">${mainHtml}</main><aside class="side">${sideHtml}</aside>`;

  $app.innerHTML = `
    <div class="container">
      <header class="topbar ${isAI ? 'aiFocus' : ''}">
        <div class="brand">
          <div class="name">roosycozy</div>
          <div class="taglineSmall">메모를 남기고 묶어서, 증빙자료로 출력해요.</div>
        </div>

        <nav class="flow" aria-label="흐름">
          <button class="flowStep ${S.tab === 'records' ? 'active' : ''}" data-action="tab" data-tab="records" type="button" ${S.tab === 'records' ? 'aria-current="step"' : ''}>
            <span class="flowNo">1</span><span class="flowTxt">메모하기</span>
          </button>
          <span class="flowArrow">→</span>
          <button class="flowStep ai ${S.tab === 'cases' ? 'active' : ''}" data-action="tab" data-tab="cases" type="button" ${S.tab === 'cases' ? 'aria-current="step"' : ''}>
            <span class="flowNo">2</span><span class="flowTxt">메모묶음보기</span>
          </button>
          <span class="flowArrow">→</span>
          <button class="flowStep ghost ${hasCases ? 'ready' : ''}" data-action="open-paper-picker" type="button" ${hasCases ? '' : 'disabled'} title="${hasCases ? '증빙자료를 출력할 메모 묶음을 고르세요' : '먼저 메모 묶음을 만들어주세요'}">
            <span class="flowNo">3</span><span class="flowTxt">증빙자료출력</span>
          </button>
        </nav>
<div class="actions">
          ${H.btn('✨ 스마트 메모 모으기', 'open-case-create', ' title="스마트 메모 모으기"', 'btn topCta')}
          ${H.btn('🧪 샘플 불러오기', 'load-sample', 'title="샘플 불러오기(현재 데이터 덮어쓰기)"', 'btn')}          
          ${/* ${H.iconBtn('⎘', 'backup', '백업 JSON 복사')}
            ${H.iconBtn('⤒', 'open-restore', '복구(붙여넣기)')}
            ${H.iconBtn('≡', 'open-logs', '로그')} */ ''}
          ${H.iconBtn('⌫', 'wipe', '전체 삭제')}
        </div>
      </header>

      <section class="${gridClass}">${gridInner}</section>

      <footer class="footer">
        <div>메모 ${S.records.length} · 메모 묶음 ${Object.keys(S.cases).length}</div>
        <div class="muted">저장소: localStorage (${esc(LS_KEY)})</div>
      </footer>

      ${renderRestoreModal()}
      ${renderLogsModal()}
      ${renderConfirmModal()}

      ${renderCaseCreateModal()}
      ${renderRecordsListModal()}
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
  if (ui.recordsListOpen) openRecordsListModal();
  if (ui.caseCreateOpen) openCaseCreateModal();
  if (ui.paperPickOpen) openPaperPickModal();
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
      <div class="miniSearch" style="margin-top:10px">
        <input class="searchInput" placeholder="메모 묶음 검색…" value="${esc(q)}" data-action="search-paper-cases" data-field="q" />
      </div>

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
  return H.modal(
    'restoreModal',
    H.modalHead('복구', '백업 JSON을 붙여넣고 복구하세요. (현재 데이터 덮어씀)', H.btn('닫기', 'close-restore')),
    `
      <div class="field" style="margin-top:10px">
        <label>JSON</label>
        <textarea id="restoreText" rows="10" placeholder="여기에 붙여넣기…"></textarea>
      </div>
      <div class="rowInline" style="margin-top:12px">
        ${H.btn('복구', 'do-restore', '', 'btn primary')}
        ${H.btn('현재 데이터 백업 복사', 'copy-backup')}
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
        ${H.dr('시간', esc(fmt(r.ts)))}
        ${H.dr('민감도', esc(lvLabel(r.lv)))}
        ${H.dr('보관형태', esc(storeLabel(r.storeType, r.storeOther)))}
        ${H.dr('주 Actor', esc(actorLabel(r.actor)))}
        ${H.dr('장소', esc(placeLabel(r.place, r.placeOther)))}
        ${H.ds('관련자', relatedHtml)}
        ${H.ds('내용', `<div class="detailNote">${esc(r.summary || '')}</div>`)}
      </div>`
    : H.empty('메모를 찾을 수 없어요.');

  return H.modal('recordModal', H.modalHead('메모', String(title), H.btn('닫기', 'close-record')), body);
}

function renderRecordsListModal() {
  const recs = visibleRecords();
  const total = S.records.length;
  const list = recs.length ? `<div class="list">${recs.map(renderRecordCard).join('')}</div>` : H.empty('검색 결과가 없어요.');

  return H.modal(
    'recordsListModal',
    H.modalHead('메모 데이터', `저장된 메모를 조회/검색/삭제할 수 있어요. (총 ${total}개)`, H.btn('닫기', 'close-records-list')),
      `${/*
          <div class="rowInline" style="margin-top:12px">
            <input class="searchInput" style="width:100%" placeholder="메모 검색…" value="${esc(ui.qRecords)}" data-action="search-records" data-field="q" />
            ${H.btn('지우기', 'clear-records-search')}
          </div>
          */ ''}
    <div style="margin-top:14px">${list}</div>`
  );
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
        ${H.btn('메모 목록', 'open-records-list')}
      </div>
    </div>

    ${renderRecordEntryForm()}

    ${isEmpty ? `
      <div class="helperBox" style="margin-top:14px">
        <b>데모로 한 번에 보고 싶다면</b> 샘플 데이터를 불러올 수 있어요.
        <div class="actionsRow" style="margin-top:10px">
          ${H.btn('샘플 불러오기', 'load-sample', ' title="샘플 데이터를 불러와 현재 데이터를 덮어씁니다"', 'btn demo')}
        </div>
        <div class="muted" style="margin-top:6px; font-size:12px">
          샘플은 로컬스토리지에 저장돼요. 언제든 ⎘로 백업하거나 ⌫로 전체 삭제할 수 있어요.
        </div>
      </div>
    ` : ''}

    <div class="helperBox aiHelp"><b>팁:</b> 메모를 쌓아두면, 다음 탭에서 <b>알고리즘이 메모 묶음으로 자동 모아</b>줘요.</div>
  `;
}

function renderRecordSidebar() {
  return ``;
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

  const mainNameField = renderNameFieldForType({
    typeText: String(draftRecord.actorTypeText || ''),
    value: String(draftRecord.actorNameOther || ''),
    action: 'draft-record',
    field: 'actorNameOther',
    placeholder: '예: 학생1 / 1번 모 / 교장 / 김OO'
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
      ? `<div class="chips" style="margin-top:8px">
          ${(draftRecord.related || [])
            .map(
              (a: ActorRef, idx: number) => `
              <span class="chip">
                ${esc(actorShort(a))}
                <button class="iconBtn" data-action="remove-related" data-idx="${esc(String(idx))}" type="button" title="삭제">×</button>
              </span>
            `
            )
            .join('')}
        </div>`
      : `<div class="muted" style="margin-top:6px">관련자가 없으면 <b>${esc(UI_OTHER_ACTOR_LABEL)} / 없음</b>을 추가해 주세요.</div>`;

  return `
    ${/*
        <div class="intakeBar">
          ${['상담', '관찰', '비정형', '규정']
            .map((k) => `<button class="pill ${((draftRecord as any).intake || '상담') === k ? 'active' : ''}" data-action="record-intake" data-kind="${esc(k)}" type="button">${esc(k)}</button>`)
            .join('')}
        </div>
        */ ''}

    <div class="field">
      <label>시간</label>
      <input type="datetime-local" value="${esc(draftRecord.ts)}" data-action="draft-record" data-field="ts" />
    </div>

    <div class="row">
      <div class="field">
        <label>주체 유형</label>
        <select data-action="draft-record" data-field="actorTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, String(draftRecord.actorTypeText || '학생'))}</select>
      </div>
      <div class="field">
        <label>주체 이름</label>
        ${mainNameField}
      </div>
    </div>

    <div class="field">
      <label>내용</label>
      <textarea rows="4" placeholder="예: 복도에서 언쟁이 있었음 (Ctrl/⌘+Enter 저장)" data-action="draft-record" data-field="summary">${esc(draftRecord.summary)}</textarea>
    </div>

    <div class="row">
      <div class="field">
        <label>장소</label>
        <select data-action="draft-record" data-field="placeText">${renderSelectFromList(PLACE_TYPES as any, String(draftRecord.placeText || '교실'))}</select>
      </div>
      <div class="field">
        <label>민감도</label>
        <select data-action="draft-record" data-field="lvText">${renderSelectFromList(LVS as any, String(draftRecord.lvText || 'LV2'))}</select>
      </div>
    </div>

    ${
      showPlaceOther
        ? `<div class="field">
            <label>장소 상세(기타)</label>
            <input value="${esc(draftRecord.placeOther)}" placeholder="예: 운동장/상담실" data-action="draft-record" data-field="placeOther" />
          </div>`
        : ''
    }

    <div class="field">
      <label>보관형태</label>
      <select data-action="draft-record" data-field="storeTypeText">${renderSelectFromList(STORE_TYPES as any, String(draftRecord.storeTypeText || '전화'))}</select>
    </div>

    ${
      showStoreOther
        ? `<div class="field">
            <label>보관형태 상세(기타)</label>
            <input value="${esc(draftRecord.storeOther)}" placeholder="예: 개인메모/회의록" data-action="draft-record" data-field="storeOther" />
          </div>`
        : ''
    }

    <div class="field" style="margin-top:10px">
      <label>관련자 추가</label>
      <div class="rowInline">
        <select data-action="draft-record" data-field="relTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, String(draftRecord.relTypeText || '학부모'))}</select>
        ${relNameField}
        ${H.btn('추가', 'add-related')}
      </div>
      ${relatedList}
    </div>

    ${dl('dlNameStudent', STUDENT_NAMES as any)}
    ${dl('dlNameParent', PARENT_NAMES as any)}
    ${dl('dlNameAdmin', ADMIN_NAMES as any)}

    <div class="rowInline" style="margin-top:12px">
      ${H.btn('메모 저장', 'save-record', '', 'btn primary')}
      ${H.btn('비우기', 'clear-record-draft')}
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

  return `
    <section class="card">
      <div class="sectionTitle tight">
        <div>
          <div class="h2">내 조치 로그(이 묶음)</div>
          <div class="muted">타임라인 위에 내가 한 대응을 남겨요.</div>
        </div>
      </div>

      <div class="field">
        <label>시간</label>
        <input type="datetime-local" value="${esc(draftStep.ts)}" data-action="draft-step" data-field="ts" />
      </div>

      <div class="field">
        <label>단계</label>
        <input value="${esc(draftStep.name)}" placeholder="예: 1차 안내" data-action="draft-step" data-field="name" />
      </div>

      <div class="field">
        <label>내용</label>
        <textarea rows="3" placeholder="짧게 메모 (Ctrl/⌘+Enter 추가)" data-action="draft-step" data-field="note">${esc(draftStep.note)}</textarea>
      </div>

      <div class="rowInline">
        ${H.btn('내 조치 로그 추가', 'add-step', '', 'btn primary')}
        ${H.btn('대응 가이드 재생성', 'regen-advisors')}
      </div>
    </section>
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
      : `<div class="muted" style="margin-top:6px">Actor가 없으면 <b>${esc(UI_OTHER_ACTOR_LABEL)} / 없음</b>을 추가해 주세요.</div>`;

  // ✅ Actor 1명 이상일 때만 시작 가능
  const canStart = (draftCase.actors || []).length > 0;
  const startExtra = canStart ? '' : ' disabled aria-disabled=\"true\" title=\"Actor를 1명 이상 추가해야 시작할 수 있어요\"';

  return H.modal(
    'caseCreateModal',
    H.modalHead('스마트 메모 모으기', '요약을 입력하면 알고리즘이 관련 메모를 모아 타임라인으로 보여줘요.', H.btn('닫기', 'close-case-create')),
    `
      <div class="field" style="margin-top:14px">
        <label>메모 묶음 요약</label>
        <textarea rows="5" placeholder="예: 복도에서 언쟁 → 학부모 전화 민원 → 이후 지도…" data-action="draft-case" data-field="query">${esc(draftCase.query)}</textarea>
      </div>

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
        <label>메모 묶음 이름</label>
        <input value="${esc(draftCase.title)}" placeholder="예: 3학년 복도 언쟁 민원" data-action="draft-case" data-field="title" />
      </div>

      <div class="field">
        <label>Actor 추가</label>
        <div class="rowInline">
          <select data-action="draft-case" data-field="addTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, String((draftCase as any).addTypeText || '학생'))}</select>
          ${addNameField}
          ${H.btn('추가', 'add-case-actor')}
        </div>
        ${chips}
      </div>

      <div class="rowInline" style="margin-top:12px">
        ${H.btn('메모 모으기 시작', 'create-case', startExtra, 'btn primary aiPrimary')}
        ${H.btn('초기화', 'clear-case-draft')}
      </div>

      <div class="helperBox aiHelp"><b>팁:</b> 메모를 추가한 뒤 <b>업데이트</b>에서 새 후보를 반영할 수 있어요.</div>
    `,
    'modal caseCreateModal'
  );
}

function renderCaseUpdateModal() {
  const c = ui.updateCaseId ? S.cases[ui.updateCaseId] ?? null : null;
  const candidates =
    c && ui.updateCandidatesForCaseId === c.id && Array.isArray(ui.updateCandidates) ? ui.updateCandidates : [];

  const title = c ? trunc(c.title, 40) : '메모 묶음 업데이트';

  const list = ui.updateCandidatesLoading
    ? H.empty('알고리즘이 추가 후보를 찾는 중…')
    : candidates.length
      ? `<div class="list" style="margin-top:12px">
          ${candidates
            .map(({ id, score, record }: any) => {
              const r = record as RecordItem;
              return `
                <label class="item pickItem">
                  <div class="pickRow">
                    <input class="chk" type="checkbox" name="caseUpdPick" value="${esc(id)}" />
                    <div style="flex:1; min-width:0">
                      ${H.tags([
                        `<span class="tag butter">점수 ${esc(score.toFixed(2))}</span>`,
                        H.tag(trunc(actorShort(r.actor), 18)),
                        H.tag(placeLabel(r.place, r.placeOther)),
                      ])}
                      <div class="title">${esc(r.summary)}</div>
                      <div class="meta">${esc(fmt(r.ts))}</div>
                    </div>
                  </div>
                </label>
              `;
            })
            .join('')}
        </div>`
      : H.empty('현재 기준으로 추가 후보가 없어요.');

  const hint = c ? `추가 후보 ${String(ui.updateCandidatesLoading ? '—' : candidates.length)}개` : '메모 묶음을 찾을 수 없어요.';

  return H.modal(
    'caseUpdateModal',
    H.modalHead(
      '메모 묶음 업데이트',
      `${title} · ${hint}`,
      `<div class="rowInline">${H.btn('닫기', 'close-case-update')}${H.btn('선택한 후보 추가', 'apply-case-update', '', 'btn primary')}</div>`
    ),
    list
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
      const caseQuery = (c.query || '').trim();
      const scoreMap = (c.scoreByRecordId || {}) as Record<string, number>;

      // === 점수 규칙(엔진 기준) ===
      // 1) main actor 일치: +2.5
      // 2) related actor 일치: 인당 +1.0
      // 3) 텍스트 유사도: (hitCount / queryTokenCount) * 2.0
      //    - hit: query 토큰이 summary 문자열에 부분 포함되면 hit (형태 변화에도 대응)
      const caseActorKeys = caseActors.filter((a) => String(a?.name || '').trim()).map(actorKey);

      const qTokens = caseQuery ? tokenizeEngineLike(caseQuery) : [];
      const summaryLower = String(r.summary || '').toLowerCase();

      let hitCount = 0;
      const hitTokensForUi: string[] = [];
      for (const qt of qTokens) {
        if (qt.length >= 2 && summaryLower.includes(qt)) {
          hitCount += 1; // ✅ query 토큰 기준 (중복 가능)
          if (!hitTokensForUi.includes(qt)) hitTokensForUi.push(qt); // UI 표시는 중복 제거
        }
      }
      const textSim = qTokens.length ? hitCount / qTokens.length : 0;
      const W_TEXT = 2.0;
      const keywordScore = textSim * W_TEXT;

      const mainActorKey = actorKey(r.actor);
      const mainActorMatch = caseActorKeys.includes(mainActorKey);
      const W_ACTOR = 2.5;
      const actorScore = mainActorMatch ? W_ACTOR : 0;

      const relatedMatches = (Array.isArray(r.related) ? r.related : []).filter((ra) => caseActorKeys.includes(actorKey(ra)));
      const W_RELATED = 1.0;
      const relatedScore = relatedMatches.length * W_RELATED;

      const engineScore = keywordScore + actorScore + relatedScore;

      // 저장된 점수(스냅샷)가 있으면 그걸 우선 표시하고,
      // 혹시 현재 엔진 재계산과 다르면 둘 다 보여줌
      const storedScore = scoreMap[r.id];
      const scoreToShow = typeof storedScore === 'number' ? storedScore : engineScore;

      const within = isWithinRangeISO(r.ts, (c as any).timeFrom || undefined, (c as any).timeTo || undefined);
      const hasRange = !!((c as any).timeFrom || (c as any).timeTo);
      const inSnapshot = Array.isArray((c as any).recordIds) && (c as any).recordIds.includes(r.id);

      // 포함 판정(엔진 기준)
      const MIN_TEXT_SIM = 0.2;
      const includeByRule = mainActorMatch || relatedMatches.length > 0 || (qTokens.length ? textSim >= MIN_TEXT_SIM : true);

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
                아래 값은 <b>현재 엔진 규칙</b>으로 재계산한 근거예요. (저장된 스냅샷 점수와 다를 수 있어요)
              </div>

              <div style="margin-top:10px" class="detailRow"><div class="k">스냅샷 포함</div><div class="v">${esc(inSnapshot ? '예 (recordIds 포함)' : '아니오')}</div></div>
              ${hasRange ? `<div class="detailRow"><div class="k">기간 필터</div><div class="v">${esc(within ? '통과(기간 안)' : '불일치(기간 밖)')}</div></div>` : ''}

              <div class="detailRow">
                <div class="k">총점</div>
                <div class="v">
                  ${esc(scoreToShow.toFixed(2))}
                  ${
                    typeof storedScore === 'number' && Math.abs(storedScore - engineScore) > 0.01
                      ? ` <span class="muted" style="font-weight:650">(재계산 ${engineScore.toFixed(2)})</span>`
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
                    (${esc(String(relatedMatches.length))}명${
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
                  )})</b>
                  ${qTokens.length ? '' : '<span class="muted">(요약이 비어있으면 점수 0이어도 후보가 될 수 있음)</span>'}
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
  return `
    <div class="defenseIntro">
      <div class="defenseIntroTitle">메모가 쌓이면, 알고리즘이 <b>메모 묶음 타임라인</b>으로 모아줘요.</div>
      <div class="defenseIntroGrid">
        <div class="dCard"><div class="dI">🧺</div><div><div class="dT">메모</div><div class="dS">일단 계속 쌓아두기</div></div></div>
        <div class="dCard"><div class="dI">🧾</div><div><div class="dT">선별</div><div class="dS">관련 메모만 자동 선별</div></div></div>
        <div class="dCard"><div class="dI">🛡️</div><div><div class="dT">묶음 보기</div><div class="dS">타임라인/내 조치/대응 가이드</div></div></div>
      </div>
      <div class="muted" style="margin-top:10px">* 메모 추가 후, 각 묶음에서 <b>업데이트</b>를 눌러 새 후보를 반영할 수 있어요.</div>
    </div>
  `;
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
        `<span class="tag butter">선별 메모 ${esc(String(mapped))}개</span>`,
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

function renderDefenseFlow(c: CaseItem, mappedCount: number, totalEvents: number) {
  const totalRecords = S.records.length;
  const steps = (((c as any).steps) || []).length;
  const advisors = ((((c as any).advisors) || []) as any[]).filter((a) => a && a.state !== 'dismissed').length;
  const maxResults = Math.max(1, Math.min(400, Number((c as any).maxResults ?? 80) || 80));
  const pct = Math.round(Math.min(1, mappedCount / maxResults) * 100);

  return `
    <div class="defenseFlow">
      <div class="flowNode">
        <div class="nodeTop"><span class="nodeIcon">🧺</span><div><div class="nodeTitle">메모</div><div class="nodeSub">내 메모 전체</div></div></div>
        <div class="nodeNum">${esc(String(totalRecords))}개</div>
      </div>
      <div class="flowArrow" aria-hidden="true">→</div>
      <div class="flowNode primary">
        <div class="nodeTop"><span class="nodeIcon">🧾</span><div><div class="nodeTitle">선별 메모</div><div class="nodeSub">AI가 포함한 메모</div></div></div>
        <div class="nodeNum">${esc(String(mappedCount))}개</div>
        <div class="bar" aria-label="선별 포함률"><div class="barFill" style="width:${esc(String(pct))}%"></div></div>
        <div class="barMeta">포함률 ${esc(String(pct))}%</div>
      </div>
      <div class="flowArrow" aria-hidden="true">→</div>
      <div class="flowNode">
        <div class="nodeTop"><span class="nodeIcon">🛡️</span><div><div class="nodeTitle">메모 묶음</div><div class="nodeSub">타임라인/내 조치/대응 가이드</div></div></div>
        <div class="nodeNums">
          <span class="miniStat">타임라인 <b>${esc(String(totalEvents))}</b></span>
          <span class="miniStat">내 조치 <b>${esc(String(steps))}</b></span>
          <span class="miniStat">가이드 <b>${esc(String(advisors))}</b></span>
        </div>
      </div>
    </div>
  `;
}

function renderCaseTimeline(c: CaseItem) {
  const { events, mappedCount, hasRange } = buildCaseTimeline(c, S.records, '');
  const filtered = ui.qTimeline.trim()
    ? events.filter((ev: any) => {
        if (ev.kind === 'record') {
          const r = ev.record as RecordItem;
          return matchLite([r.summary, actorShort(r.actor), placeLabel(r.place, r.placeOther), r.ts].join(' '), ui.qTimeline);
        }
        if (ev.kind === 'advisor') {
          const a = ev.advisor as AdvisorItem;
          return matchLite([a.title, a.body, String((a as any).level), a.ts].join(' '), ui.qTimeline);
        }
        const s = ev.step as StepItem;
        return matchLite([s.name, s.note, s.ts].join(' '), ui.qTimeline);
      })
    : events;

  return `
    <div class="sectionTitle">
      <div>
        <div class="h2">${esc((c as any).title)}</div>
        <div class="muted"><span class="badgeAI">AI 선별</span> 메모 ${esc(String(mappedCount))}개</div>
        ${hasRange ? `<div class="muted" style="margin-top:8px">기간: ${esc((c as any).timeFrom ? fmt((c as any).timeFrom) : '—')} ~ ${esc((c as any).timeTo ? fmt((c as any).timeTo) : '—')}</div>` : ''}
        ${((c as any).query || '').trim() ? `<div class="muted" style="margin-top:8px">요약: ${esc(trunc((c as any).query || '', 90))}</div>` : ''}
      </div>

      <div class="aiTopActions">
        ${H.btn('업데이트', 'open-case-update')}
        ${H.btn('증빙자료출력', 'open-paper')}
        ${H.btn('닫기', 'clear-case')}
      </div>
    </div>

    ${renderDefenseFlow(c, mappedCount, events.length)}

    <div class="miniSearch" style="margin-bottom:14px">
      <input class="searchInput" placeholder="이 타임라인에서 검색(표시만)…" value="${esc(ui.qTimeline)}" data-action="search-timeline" data-field="q" />
    </div>

    ${filtered.length ? `<div class="timeline">${filtered.map(renderTimelineEvent).join('')}</div>` : `<div class="empty">표시할 항목이 없어요.</div>`}
  `;
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
