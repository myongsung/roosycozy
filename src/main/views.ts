import { esc, trunc, fmt, LS_KEY, ensureRecordV8, verifyRecordIntegrity, getRecordRevisions, shortHash, getRecordRevisionCount, fromLocalInputValue } from '../utils';
import type { CaseItem, RecordItem, AdvisorItem, StepItem, ActorRef, RankedHit } from '../engine';
import { recordActors, recordsForCase, buildCaseTimeline } from '../engine';
import {
  S, ui, $app, logs,
  matchLite,
  renderSelectFromList,
  STORE_TYPES, PLACE_TYPES, UI_ACTOR_TYPES,
  renderNameFieldForType,
  storeLabel, placeLabel, actorLabel, actorShort, recordActorText, recordMainActors,
  draftRecord, draftRecordEdit, draftCase, draftStep,
  getSelectedCase, visibleCases,
  actorEqLite, uniq, tokenizeLite, isWithinRangeISO, daysDiff,
  UI_OTHER_ACTOR_LABEL, STUDENT_NAMES, PARENT_NAMES, ADMIN_NAMES,
  getClassRoster, hasScreenPin,
  getRelationshipGroups, getRelationshipMembers,
  getRecordArchiveMainActors, getRecordArchiveRelatedActors,
  serializeActorChoice
} from './state';
import { renderCasePaperModal } from './paper';

const ENABLE_BACKUP_RESTORE = true; // 설정에서 백업/복구 UI 노출
const HIDE_CASE_ACTIONS_AND_GUIDES = true; // 컬렉션 보기에서 실행 로그/권장 가이드 임시 비노출


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
  chipsMini: (items: string[]) =>
    items.length ? `<div class="chips mini">${items.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : '',
};

const renderSelectWithPlaceholder = (
  items: Array<{ value: string; label: string; disabled?: boolean }>,
  selected: string,
  placeholder: string
) => {
  const selectedValue = String(selected || '');
  const hasSelected = items.some((item) => item.value === selectedValue && !item.disabled);
  const effectiveSelected = hasSelected ? selectedValue : '';
  return [
    `<option value="" ${!effectiveSelected ? 'selected' : ''} disabled>${esc(placeholder)}</option>`,
    ...items.map((item) => `
      <option value="${esc(item.value)}" ${item.value === effectiveSelected ? 'selected' : ''} ${item.disabled ? 'disabled' : ''}>
        ${esc(item.label)}
      </option>
    `),
  ].join('');
};

const renderRelationshipGroupPicker = (action: string, field: string, selected: string, placeholder = '그룹 선택') => {
  const groups = getRelationshipGroups().map((group) => ({
    value: group.id,
    label: group.title,
  }));
  return `<select data-action="${esc(action)}" data-field="${esc(field)}">${renderSelectWithPlaceholder(groups, selected, placeholder)}</select>`;
};

const renderRelationshipMemberPicker = (
  action: string,
  field: string,
  groupId: string,
  selected: string,
  placeholder = '인물 선택'
) => {
  const members = getRelationshipMembers(groupId).map((member) => ({
    value: member.id,
    label: member.name,
  }));
  if (!members.length) {
    return `<select data-action="${esc(action)}" data-field="${esc(field)}" disabled><option value="" selected disabled>${esc('먼저 그룹에 인물을 등록하세요')}</option></select>`;
  }
  return `<select data-action="${esc(action)}" data-field="${esc(field)}">${renderSelectWithPlaceholder(members, selected, placeholder)}</select>`;
};



function riskToneClass(label: number) {
  return label === 2 ? 'riskDanger' : label === 1 ? 'riskWarn' : 'riskNormal';
}

function riskInlineTagStyle(label: number) {
  return label === 2
    ? 'background:rgba(244,214,214,0.72);color:#8f5f5f;border-color:rgba(217,164,164,0.70);'
    : label === 1
      ? 'background:rgba(246,228,206,0.78);color:#8b6b47;border-color:rgba(223,191,152,0.72);'
      : 'background:rgba(219,236,224,0.82);color:#557863;border-color:rgba(173,206,182,0.80);';
}

function riskInlineCardStyle(label: number) {
  const color = label === 2 ? '#e4c1c1' : label === 1 ? '#e8ccb0' : '#bfd8c5';
  return `border-color:${color};--risk-accent:${color};`;
}

function normalizeRisk(risk: any) {
  if (!risk || typeof risk !== 'object') return null;
  const label = Number(risk.label) === 2 ? 2 : Number(risk.label) === 1 ? 1 : 0;
  const labelText = label === 2 ? '높음' : label === 1 ? '주의' : '안정';
  const probs = Array.isArray(risk.probs) ? risk.probs : [0, 0, 0];
  const confidence = Number.isFinite(+risk.confidence) ? Math.max(0, Math.min(1, +risk.confidence)) : Math.max(...probs.map((x: any) => Number(x) || 0));
  const reasons = Array.isArray(risk.reasons) ? risk.reasons.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 4) : [];
  return { label, labelText, confidence, reasons };
}

function renderRiskTag(risk: any) {
  const rr = normalizeRisk(risk);
  if (!rr) return '';
  return `<span class="tag ${riskToneClass(rr.label)}" style="${riskInlineTagStyle(rr.label)}">리스크 ${esc(rr.labelText)}</span>`;
}

function renderRiskSummary(risk: any) {
  const rr = normalizeRisk(risk);
  if (!rr) return `<div class="muted">아직 리스크 신호가 계산되지 않았어요.</div>`;
  const confidencePct = Math.round(rr.confidence * 100);
  const reasonTags = rr.reasons.length
    ? `<div class="tags mini" style="margin-top:8px">${rr.reasons.map((x: any) => `<span class="tag aiReason">${esc(String(x))}</span>`).join('')}</div>`
    : '';
  return `
    <div class="riskBlock">
      <div class="riskHead">
        <span class="tag ${riskToneClass(rr.label)}" style="${riskInlineTagStyle(rr.label)}">리스크 ${esc(rr.labelText)}</span>
        <span class="muted">신뢰도 ${esc(String(confidencePct))}%</span>
      </div>
      ${reasonTags}
    </div>
  `;
}


const dl = (id: string, values: string[]) =>
  `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;

function renderMiniTabs(items: { label: string; action: string; dataKey: string; dataValue: string; active: boolean; extraData?: Record<string, string> }[]) {
  return `
    <div class="sectionTabs" role="tablist">
      ${items
        .map(
          (item) => {
            const extraDataAttrs = Object.entries(item.extraData || {})
              .map(([key, value]) => ` data-${esc(key)}="${esc(value)}"`)
              .join('');
            return `
              <button
                class="sectionTab ${item.active ? 'active' : ''}"
                type="button"
                role="tab"
                aria-selected="${item.active ? 'true' : 'false'}"
                data-action="${esc(item.action)}"
                data-${esc(item.dataKey)}="${esc(item.dataValue)}"${extraDataAttrs}
              >
                ${esc(item.label)}
              </button>
            `;
          }
        )
        .join('')}
    </div>
  `;
}


function cleanStrategyDisplayText(text: string) {
  return String(text || '')
    .replace(/\uFFFD/g, '')
    .replace(/\s*\.\.\.\s*\(truncated\)\s*/gi, ' ')
    .replace(/\(truncated\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function strategyTextHtml(text: string) {
  return esc(cleanStrategyDisplayText(text)).replace(/\n/g, "<br/>");
}

function windowPlatform() {
  if (typeof navigator === 'undefined') return 'other';
  const ua = String(navigator.userAgent || '');
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X|MacIntel/i.test(ua)) return 'macos';
  return 'other';
}

function renderWindowControls() {
  if (windowPlatform() !== 'windows') return '';
  return `
    <div class="windowControls" aria-label="창 제어">
      <button class="windowControlBtn" data-action="window-minimize" type="button" aria-label="최소화">
        <span class="windowControlGlyph" aria-hidden="true">─</span>
      </button>
      <button class="windowControlBtn" data-action="window-toggle-maximize" type="button" aria-label="최대화 또는 복원">
        <span class="windowControlGlyph windowControlGlyphSquare" aria-hidden="true"></span>
      </button>
      <button class="windowControlBtn close" data-action="window-close" type="button" aria-label="닫기">
        <span class="windowControlGlyph" aria-hidden="true">×</span>
      </button>
    </div>
  `;
}

function formatSidebarThreadAge(iso: string) {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return '';
  const diffDays = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  if (diffDays <= 0) return '오늘';
  if (diffDays < 7) return `${diffDays}일`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}


function renderAppSidebar(currentTab: string) {
  const isHome = currentTab === 'home';
  const strategyPackages = Array.isArray((S as any).strategyThreadPackages)
    ? [ ...((S as any).strategyThreadPackages as any[]) ].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    : [];
  const activeThreadPackageId = String((ui as any).strategyThreadPackageId || '').trim();
  const activeThreadPackage = strategyPackages.find((item) => String(item.id || '') === activeThreadPackageId) || null;
  const currentThreadMessages = Array.isArray((ui as any).strategyChatMessages) ? ((ui as any).strategyChatMessages as any[]) : [];
  const hasDraftThread = currentThreadMessages.some((item) => String(item?.content || '').trim()) && !activeThreadPackage;
  const packageFolders = uniq(
    strategyPackages.map((item) => String(item?.caseTitle || '').trim() || '직접 분석').filter(Boolean)
  ).slice(0, 4);
  const packageFolderHtml = packageFolders.length
    ? packageFolders.map((name) => `
      <div class="sidebarThreadFolder">
        <span class="sidebarThreadFolderIcon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4.75 7.75C4.75 6.7835 5.5335 6 6.5 6H9.3886C9.85293 6 10.2982 6.18437 10.6265 6.51256L11.4874 7.37348C11.8156 7.70167 12.2609 7.88604 12.7252 7.88604H17.5C18.4665 7.88604 19.25 8.66954 19.25 9.63604V16.5C19.25 17.4665 18.4665 18.25 17.5 18.25H6.5C5.5335 18.25 4.75 17.4665 4.75 16.5V7.75Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          </svg>
        </span>
        <span class="sidebarThreadFolderLabel">${esc(name)}</span>
      </div>
    `).join('')
    : '';
  const draftThreadHtml = hasDraftThread ? `
    <div class="sidebarThreadPackageRow draft">
      <div class="sidebarThreadPackageCard draft" aria-label="현재 작업 중인 대화">
        <span class="sidebarThreadPackageGlyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="5.25" y="4.75" width="13.5" height="14.5" rx="2.25" stroke="currentColor" stroke-width="1.6"/>
            <path d="M8.5 9H15.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            <path d="M8.5 12.5H13.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </span>
        <span class="sidebarThreadPackageMain">
          <span class="sidebarThreadPackageTitle">현재 작업 중인 대화</span>
          <span class="sidebarThreadPackageSub">${esc(trunc(String(currentThreadMessages[currentThreadMessages.length - 1]?.content || '대화를 이어가고 있어요.'), 56))}</span>
        </span>
        <span class="sidebarThreadPackageStamp">임시</span>
      </div>
    </div>
  ` : '';
  const packageListHtml = strategyPackages.length
    ? strategyPackages.slice(0, 7).map((item) => {
      const isActive = String(item.id || '') === activeThreadPackageId;
      const itemCaseTitle = String(item.caseTitle || '').trim();
      const stamp = formatSidebarThreadAge(String(item.updatedAt || item.createdAt || ''));
      return `
        <div class="sidebarThreadPackageRow ${isActive ? 'active' : ''}">
          <button class="sidebarThreadPackageCard ${isActive ? 'active' : ''}" data-action="open-strategy-thread-package" data-id="${esc(String(item.id || ''))}" type="button">
            <span class="sidebarThreadPackageGlyph" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="5.25" y="4.75" width="13.5" height="14.5" rx="2.25" stroke="currentColor" stroke-width="1.6"/>
                <path d="M8.5 9H15.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                <path d="M8.5 12.5H13.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              </svg>
            </span>
            <span class="sidebarThreadPackageMain">
              <span class="sidebarThreadPackageTitle">${esc(String(item.title || '사건분석 스레드'))}</span>
              <span class="sidebarThreadPackageSub">${esc(itemCaseTitle || trunc(String(item.summary || '저장된 분석 스레드'), 54))}</span>
            </span>
            <span class="sidebarThreadPackageStamp">${esc(stamp)}</span>
          </button>
          <button class="sidebarThreadPackageRemove" data-action="delete-strategy-thread-package" data-id="${esc(String(item.id || ''))}" type="button" aria-label="${esc(`${String(item.title || '사건분석 스레드')} 삭제`)}">
            <span aria-hidden="true">×</span>
          </button>
        </div>
      `;
    }).join('')
    : `
      <div class="sidebarThreadEmpty">
        아직 저장된 스레드가 없어요. 현재 대화를 저장하면 사건별로 다시 열어 자연스럽게 이어갈 수 있어요.
      </div>
    `;
  return `
    <aside class="serviceSidebar" aria-label="작업 메뉴">
      <button class="serviceLogo ${isHome ? 'active' : ''}" data-action="tab" data-tab="home" data-route-tab="home" type="button" aria-label="홈으로 이동">
        <span class="serviceLogoGlyph" aria-hidden="true">R</span>
      </button>

      <div class="serviceSidebarNav">
        <button class="sidebarIconBtn ${isHome ? 'active' : ''}" data-action="tab" data-tab="home" data-route-tab="home" type="button" aria-label="홈">
          <span class="sidebarIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4.75 10.5L12 4.75L19.25 10.5V18C19.25 18.9665 18.4665 19.75 17.5 19.75H6.5C5.5335 19.75 4.75 18.9665 4.75 18V10.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
              <path d="M9.25 19.75V13.75H14.75V19.75" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="sidebarLabel">홈</span>
        </button>

        <button class="sidebarIconBtn accent" data-action="open-record-composer" type="button" aria-label="빠른 캡처 열기">
          <span class="sidebarIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 5V19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <path d="M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </span>
          <span class="sidebarLabel">빠른 캡처</span>
        </button>

        <button class="sidebarIconBtn ${ui.classRosterOpen ? 'active' : ''}" data-action="open-class-roster" type="button" aria-label="관계 관리 열기" title="관계 관리">
          <span class="sidebarIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 12.25C14.3472 12.25 16.25 10.3472 16.25 8C16.25 5.65279 14.3472 3.75 12 3.75C9.65279 3.75 7.75 5.65279 7.75 8C7.75 10.3472 9.65279 12.25 12 12.25Z" stroke="currentColor" stroke-width="1.8"/>
              <path d="M5 19.25C5.88949 16.5609 8.66368 14.75 12 14.75C15.3363 14.75 18.1105 16.5609 19 19.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </span>
          <span class="sidebarLabel">관계 관리</span>
        </button>

        <button class="sidebarIconBtn ${ui.pinLocked ? 'active lockActive' : ''}" data-action="open-screen-lock" type="button" aria-label="앱 잠금" title="${ui.pinLocked ? '잠금 중' : '앱 잠금'}">
          <span class="sidebarIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8.25 10V7.75C8.25 5.67893 9.92893 4 12 4C14.0711 4 15.75 5.67893 15.75 7.75V10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <rect x="5.75" y="10" width="12.5" height="10" rx="2.25" stroke="currentColor" stroke-width="1.8"/>
              <path d="M12 14.25V15.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </span>
          <span class="sidebarLabel">잠금</span>
          <span class="sidebarPinDot ${ui.pinLocked ? 'isLocked' : hasScreenPin() ? 'isReady' : 'isEmpty'}" aria-hidden="true"></span>
        </button>
      </div>

      <section class="serviceSidebarSection serviceSidebarThreadSection" aria-label="사건분석 스레드">
        <div class="serviceSidebarThreadHeader">
          <div class="serviceSidebarThreadTitleWrap">
            <div class="serviceSidebarThreadTitle">사건분석 스레드</div>
            <div class="serviceSidebarThreadMeta">${activeThreadPackage ? '열린 패키지에서 이어서 정리 중' : '저장한 분석 대화를 간결하게 모아보기'}</div>
          </div>
          <div class="serviceSidebarThreadHeaderActions">
            <button class="sidebarThreadHeaderBtn" data-action="save-strategy-thread-package" type="button" aria-label="${esc(activeThreadPackage ? '현재 패키지 업데이트' : '현재 대화 저장')}" title="${esc(activeThreadPackage ? '현재 패키지 업데이트' : '현재 대화 저장')}">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M6.75 5.75H15.6287C16.093 5.75 16.5383 5.93437 16.8665 6.26256L18.7374 8.13348C19.0656 8.46167 19.25 8.90696 19.25 9.37129V17.25C19.25 18.2165 18.4665 19 17.5 19H6.5C5.5335 19 4.75 18.2165 4.75 17.25V7.75C4.75 6.64543 5.64543 5.75 6.75 5.75Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                <path d="M8 5.75V10.25H15.5V6.25" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                <path d="M8.75 14.25H15.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
              </svg>
            </button>
            <button class="sidebarThreadHeaderBtn" data-action="detach-strategy-thread-package" type="button" aria-label="새 스레드" title="새 스레드">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M12 5V19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                <path d="M5 12H19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        ${packageFolderHtml ? `<div class="sidebarThreadFolderList" aria-label="패키지 묶음">${packageFolderHtml}</div>` : ''}

        <div class="sidebarThreadPackageList">
          ${draftThreadHtml}
          ${packageListHtml}
        </div>
      </section>

      <div class="serviceSidebarBottom">

        <button class="sidebarIconBtn sidebarSettingsBtn ${ui.settingsOpen ? 'active' : ''}" data-action="open-settings" type="button" aria-label="설정" title="설정">
          <span class="sidebarIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 8.75C10.2051 8.75 8.75 10.2051 8.75 12C8.75 13.7949 10.2051 15.25 12 15.25C13.7949 15.25 15.25 13.7949 15.25 12C15.25 10.2051 13.7949 8.75 12 8.75Z" stroke="currentColor" stroke-width="1.8"/>
              <path d="M19.2499 13.1875V10.8125L17.5231 10.2418C17.3597 9.72838 17.1524 9.23572 16.9043 8.76765L17.7141 7.13575L16.0357 5.45737L14.4038 6.26718C13.9358 6.01911 13.4431 5.81181 12.9297 5.64844L12.359 3.92163H9.984L9.41327 5.64844C8.89986 5.81181 8.4072 6.01911 7.93913 6.26718L6.30724 5.45737L4.62885 7.13575L5.43866 8.76765C5.19059 9.23572 4.9833 9.72838 4.81992 10.2418L3.09311 10.8125V13.1875L4.81992 13.7582C4.9833 14.2716 5.19059 14.7643 5.43866 15.2323L4.62885 16.8642L6.30724 18.5426L7.93913 17.7328C8.4072 17.9809 8.89986 18.1882 9.41327 18.3516L9.984 20.0784H12.359L12.9297 18.3516C13.4431 18.1882 13.9358 17.9809 14.4038 17.7328L16.0357 18.5426L17.7141 16.8642L16.9043 15.2323C17.1524 14.7643 17.3597 14.2716 17.5231 13.7582L19.2499 13.1875Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="sidebarLabel">설정</span>
        </button>
      </div>
    </aside>
  `;
}

function renderUpdateNotesModal() {
  return H.modal(
    'updateNotesModal',
    H.modalHead('업데이트 노트', '개인용 AI 기록 워크플로에 맞춘 핵심 변화만 짧게 정리했어요.', H.btn('닫기', 'close-updates-note')),
    `
      <div class="updatesNoteModalBody">
        <article class="updatesNoteItem">
          <div class="updatesNoteIndex">1</div>
          <div>
            <div class="updatesNoteTitle">빠른 캡처 중심 기록 입력</div>
            <div class="updatesNoteDesc">무슨 일이 있었는지부터 적고, 배경·핵심 포인트·메모를 뒤에서 보강하는 흐름으로 더 빠르게 기록할 수 있어요.</div>
          </div>
        </article>

        <article class="updatesNoteItem">
          <div class="updatesNoteIndex">2</div>
          <div>
            <div class="updatesNoteTitle">공유/제출 문서 생성</div>
            <div class="updatesNoteDesc">컬렉션을 선택하고 송달 정보를 입력하면 기록 요약과 무결성 검증 정보가 포함된 PDF를 바로 만들 수 있어요.</div>
          </div>
        </article>

        <article class="updatesNoteItem">
          <div class="updatesNoteIndex">3</div>
          <div>
            <div class="updatesNoteTitle">AI 민원 법무팀 에이전트 <span class="legalExperimentalBadge">현재 실험기능입니다</span></div>
            <div class="updatesNoteDesc">컬렉션에 연결된 기록을 바탕으로 답장 초안, 정리 포인트, 다음 행동 순서를 채팅형으로 빠르게 정리할 수 있어요.</div>
          </div>
        </article>

        <article class="updatesNoteItem">
          <div class="updatesNoteIndex">4</div>
          <div>
            <div class="updatesNoteTitle">잠금 기능 추가</div>
            <div class="updatesNoteDesc">숫자 4자리 PIN으로 화면을 잠그고, 잠금 해제 전까지 내용을 가릴 수 있어요.</div>
          </div>
        </article>

        <article class="updatesNoteItem">
          <div class="updatesNoteIndex">5</div>
          <div>
            <div class="updatesNoteTitle">관계 관리 저장</div>
            <div class="updatesNoteDesc">자주 등장하는 사람이나 대상 이름을 템플릿으로 저장하고, 여러 이름을 한 번에 붙여넣어 빠르게 불러올 수 있어요.</div>
          </div>
        </article>
      </div>
    `,
    'modal updatesNoteModal'
  );
}

function renderHomeMain() {
  const allRecords = S.records.slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const collectionIds = visibleCases();
  const collections = collectionIds.map((id) => S.cases[id]).filter(Boolean);
  const collectionRecordCounts = new Map(collections.map((item) => [String(item.id || ''), recordsForCase(S.records, item).length]));
  const recentRecords = allRecords.slice(0, 4);
  const recentCollections = collections.slice(0, 4);
  const riskyRecords = allRecords
    .filter((record) => (normalizeRisk((record as any).risk)?.label || 0) > 0)
    .slice(0, 4);
  const selectedCollection = getSelectedCase();
  const selectedCollectionRecords = selectedCollection ? recordsForCase(S.records, selectedCollection) : [];
  const selectedCollectionRecordCount = selectedCollectionRecords.length;
  const selectedCollectionLatestTs = selectedCollectionRecords
    .slice()
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))[0]?.ts || '';
  const sharedReadyCount = collections.filter((item) => (collectionRecordCounts.get(String(item.id || '')) || 0) > 0).length;
  const strategyResult = ((ui as any).simulationResult || null) as any;
  const strategyMessages = Array.isArray((ui as any).strategyChatMessages) ? ((ui as any).strategyChatMessages as any[]) : [];
  const progressState = (() => {
    if (!allRecords.length) {
      return {
        label: '시작 전',
        title: '첫 기록을 남기면 워크스페이스가 바로 살아나요',
        desc: '대화, 파일, 사진, 메모 중 하나만 빠르게 캡처해도 홈에서 흐름을 자동으로 정리해드려요.',
        tone: 'is-idle',
      };
    }
    if (!collections.length) {
      return {
        label: '정리 단계',
        title: '관련 기록을 묶어 첫 컬렉션을 만들 시점이에요',
        desc: '비슷한 기록 3~5개만 모아도 타임라인과 AI 민원 법무팀 에이전트의 맥락이 훨씬 또렷해집니다.',
        tone: 'is-active',
      };
    }
    if (!selectedCollection) {
      return {
        label: '포커스 필요',
        title: '최근 컬렉션 하나를 열어 흐름을 잡아보세요',
        desc: '선택된 컬렉션이 있으면 홈과 AI 민원 법무팀 에이전트가 지금 무엇을 먼저 해야 하는지 더 선명하게 보여줍니다.',
        tone: 'is-calm',
      };
    }
    if (!strategyMessages.length && !strategyResult) {
      return {
        label: '분석 준비',
        title: '현재 컬렉션은 AI 민원 법무팀 에이전트를 시작할 준비가 되어 있어요',
        desc: '질문 한 줄만 보내도 답변 초안과 다음 행동 순서를 정리해주는 흐름으로 넘어갈 수 있습니다.',
        tone: 'is-accent',
      };
    }
    if (!sharedReadyCount) {
      return {
        label: '문서화 단계',
        title: '이제 공유 또는 제출용 문서 초안을 만들어둘 차례예요',
        desc: '컬렉션 흐름이 어느 정도 쌓였으니 PDF로 정리해두면 전달과 보관이 훨씬 수월해집니다.',
        tone: 'is-calm',
      };
    }
    return {
      label: '안정화',
      title: '기록, 분석, 문서화 흐름이 안정적으로 이어지고 있어요',
      desc: '최근 캡처와 리스크 신호만 꾸준히 확인하면 전체 맥락을 차분하게 유지할 수 있습니다.',
      tone: 'is-ready',
    };
  })();

  const todoItems = [
    !allRecords.length ? '빠른 캡처로 첫 기록을 남겨보세요.' : '',
    allRecords.length > 0 && !collections.length ? '관련 기록 몇 개를 묶어 첫 컬렉션을 만들어보세요.' : '',
    collections.length > 0 && !selectedCollection ? '최근 컬렉션 하나를 열어 흐름과 타임라인을 점검해보세요.' : '',
    selectedCollection && selectedCollectionRecordCount < 2 ? '현재 컬렉션에 기록을 더 연결해 맥락을 보강해보세요.' : '',
    selectedCollection && !strategyMessages.length ? 'AI 민원 법무팀 에이전트 탭에서 질문 한 줄을 보내 답장 초안과 다음 행동을 받아보세요.' : '',
    sharedReadyCount > 0 ? '공유가 필요하면 공유/제출 문서 탭에서 PDF를 저장해두세요.' : '',
  ].filter(Boolean).slice(0, 4);

  const aiRecommendations = strategyResult
    ? [
        cleanStrategyDisplayText(String(strategyResult.recommendedTone || '')),
        cleanStrategyDisplayText(String(strategyResult.recommendedAction || '')),
      ].filter(Boolean)
    : [
        riskyRecords.length ? '리스크가 높은 기록부터 시각, 원본, 관련 대화 흐름을 다시 확인해보세요.' : '',
        collections.length ? '가장 최근 컬렉션을 기준으로 AI 민원 법무팀 에이전트를 실행해 다음 행동 순서를 정리해보세요.' : '',
        allRecords.length ? '비슷한 기록 3~5개를 묶으면 AI 민원 법무팀 에이전트와 공유 문서 품질이 훨씬 안정적으로 올라갑니다.' : '첫 기록을 남기면 홈에서 최근 캡처와 AI 추천 행동을 자동으로 보여드려요.',
      ].filter(Boolean).slice(0, 3);

  const nextActions = todoItems.length ? todoItems : ['최근 기록을 확인하고 필요한 항목을 컬렉션으로 묶어보세요.'];
  const heroHighlights = [
    selectedCollection
      ? `${selectedCollectionRecordCount}개 기록이 현재 선택된 컬렉션에 연결되어 있어요.`
      : allRecords.length
        ? `최근 캡처 ${allRecords.length}건이 워크스페이스에 정리돼 있어요.`
        : '첫 기록을 남기면 홈이 현재 상황을 자동으로 요약해드려요.',
    riskyRecords.length
      ? `우선 확인할 리스크 항목 ${riskyRecords.length}건이 감지됐어요.`
      : '지금은 눈에 띄는 고위험 신호가 많지 않아요.',
    strategyResult
      ? cleanStrategyDisplayText(String(strategyResult.recommendedAction || 'AI 민원전용 법무팀 결과가 다음 행동을 제안할 준비가 됐어요.'))
      : collections.length
        ? 'AI 민원 법무팀 에이전트 탭에서 다음 대응 순서를 바로 정리할 수 있어요.'
        : '컬렉션을 만들면 분석과 공유 문서 품질이 더 안정적으로 올라가요.',
  ].filter(Boolean).slice(0, 3);

  const recentRecordItems = recentRecords.length
    ? recentRecords.map((record) => `
        <button class="homeEntryButton" data-action="view-record" data-id="${esc(String(record.id || ''))}" type="button">
          <div class="homeEntryTop">
            <span class="homeEntryTitle">${esc(trunc(String(record.summary || '제목 없는 기록'), 56))}</span>
            <span class="homeEntryMeta">${esc(fmt(String(record.ts || '')))}</span>
          </div>
          <div class="homeEntrySub">${esc(trunc(`${recordActorText(record)} · ${placeLabel(record.place, record.placeOther)} · ${storeLabel(record.storeType, record.storeOther)}`, 72))}</div>
        </button>
      `).join('')
    : `<div class="homeEntryEmpty">아직 캡처된 기록이 없어요. 사이드바의 빠른 캡처부터 시작해보세요.</div>`;

  const recentCollectionItems = recentCollections.length
    ? recentCollections.map((item) => {
        const count = collectionRecordCounts.get(String(item.id || '')) || 0;
        return `
          <button class="homeEntryButton" data-action="select-case" data-id="${esc(String(item.id || ''))}" type="button">
            <div class="homeEntryTop">
              <span class="homeEntryTitle">${esc(trunc(String(item.title || '제목 없는 컬렉션'), 48))}</span>
              <span class="homeEntryMeta">${esc(String(count))}개 기록</span>
            </div>
            <div class="homeEntrySub">${esc(trunc(String(item.query || '주제 설명이 아직 없어요.'), 76))}</div>
          </button>
        `;
      }).join('')
    : `<div class="homeEntryEmpty">아직 컬렉션이 없어요. 관련 기록을 묶어 흐름별로 관리해보세요.</div>`;

  const riskyItems = riskyRecords.length
    ? riskyRecords.map((record) => {
      const rr = normalizeRisk((record as any).risk);
      return `
          <button class="homeEntryButton homeEntryButtonRisk" data-action="view-record" data-id="${esc(String(record.id || ''))}" type="button">
            <div class="homeEntryTop homeEntryTopLoose">
              ${renderRiskTag((record as any).risk)}
              <span class="homeEntryMeta">${esc(fmt(String(record.ts || '')))}</span>
            </div>
            <div class="homeEntryTitle homeRiskTitle">${esc(trunc(String(record.summary || '제목 없는 기록'), 70))}</div>
            <div class="homeEntrySub">${esc(trunc(`${recordActorText(record)} · ${placeLabel(record.place, record.placeOther)}${rr?.reasons?.length ? ` · ${rr.reasons[0]}` : ''}`, 78))}</div>
          </button>
        `;
    }).join('')
    : `<div class="homeEntryEmpty">지금은 리스크가 높게 표시된 기록이 없어요.</div>`;

  const collectionFocusHtml = selectedCollection
    ? `
      <div class="homeFocusMetaRow">
        <span class="homeProgressPill ${progressState.tone}">선택된 컬렉션</span>
        ${selectedCollectionLatestTs ? `<span class="homeEntryMeta">${esc(fmt(selectedCollectionLatestTs))}</span>` : ''}
      </div>
      <div class="homeFocusTitle">${esc(String(selectedCollection.title || '제목 없는 컬렉션'))}</div>
      <div class="homeFocusSummary">${esc(String(selectedCollection.query || '주제 설명이 아직 없어요. 관련 기록을 더 연결하면 맥락이 훨씬 선명해집니다.'))}</div>
      <div class="homeFocusTags">
        <span class="homeInlineStat">기록 ${esc(String(selectedCollectionRecordCount))}개</span>
        <span class="homeInlineStat">${sharedReadyCount > 0 ? '공유 문서 흐름 준비 가능' : '문서 초안은 아직 준비 전'}</span>
      </div>
      <div class="homeFocusActionRow">
        ${H.btnData('컬렉션 열기', 'select-case', { id: String(selectedCollection.id || '') }, 'btn primary')}
        ${H.btnData('AI 민원 법무팀 에이전트', 'switch-legal-tab', { 'legal-tab': 'simulation' }, 'btn ghost')}
      </div>
    `
    : `
      <div class="homeFocusMetaRow">
        <span class="homeProgressPill ${progressState.tone}">현재 포커스</span>
      </div>
      <div class="homeFocusTitle">${esc(progressState.title)}</div>
      <div class="homeFocusSummary">${esc(progressState.desc)}</div>
      <div class="homeFocusTags">
        <span class="homeInlineStat">최근 캡처 ${esc(String(allRecords.length))}건</span>
        <span class="homeInlineStat">컬렉션 ${esc(String(collections.length))}개</span>
      </div>
      <div class="homeFocusActionRow">
        ${collections.length
          ? H.btnData('컬렉션 보기', 'switch-case-tab', { 'case-tab': 'list' }, 'btn primary')
          : H.btnData('컬렉션 만들기', 'switch-case-tab', { 'case-tab': 'create' }, 'btn primary')}
        ${allRecords.length
          ? H.btnData('AI 민원 법무팀 에이전트', 'switch-legal-tab', { 'legal-tab': 'simulation' }, 'btn ghost')
          : H.btn('빠른 캡처', 'open-record-composer', '', 'btn ghost')}
      </div>
    `;

  return `
    <section class="homeSectionStack homeDashboard homeWorkspace" aria-label="홈 대시보드">
      <article class="homeHeroPanel" aria-label="홈 핵심 안내">
        <div class="homeHeroContent">
          <div class="homeHeroEyebrow">Evidence Workspace</div>
          <div class="homeHeroTitle">차분하게 기록하고, 필요한 순간 바로 꺼내 쓰는 모던 워크스페이스</div>
          <div class="homeHeroText">흩어진 대화, 사진, 파일, 메모를 한곳에 정리하고 컬렉션, AI 민원 법무팀 에이전트, 공유 문서 흐름으로 자연스럽게 이어가세요.</div>
          <div class="homeHeroActions" aria-label="빠른 작업">
            ${H.btn('빠른 캡처', 'open-record-composer', '', 'btn primary')}
            ${H.btnData('컬렉션 만들기', 'switch-case-tab', { 'case-tab': 'create' }, 'btn ghost')}
            ${H.btnData('AI 민원 법무팀 에이전트', 'switch-legal-tab', { 'legal-tab': 'simulation' }, 'btn ghost')}
            ${H.btn('업데이트 노트', 'open-updates-note', ' aria-label="업데이트 노트 보기"', 'btn ghost homeHeroQuietAction')}
          </div>
        </div>
        <div class="homeHeroAside">
          <div class="homeHeroAsideTop">
            <span class="homeProgressPill ${progressState.tone}">${esc(progressState.label)}</span>
            <span class="homeHeroAsideMeta">${selectedCollection ? '선택된 컬렉션 기준' : '현재 워크플로 상태'}</span>
          </div>
          <div class="homeHeroAsideTitle">${esc(progressState.title)}</div>
          <div class="homeHeroAsideText">${esc(progressState.desc)}</div>
          <div class="homeProgressList">
            ${heroHighlights.map((item) => `<div class="homeProgressItem">${esc(item)}</div>`).join('')}
          </div>
          <div class="homeHeroAsideFooter">
            <span>${selectedCollection ? `포커스: ${esc(trunc(String(selectedCollection.title || '제목 없는 컬렉션'), 30))}` : '포커스 컬렉션을 고르면 더 선명하게 정리돼요.'}</span>
          </div>
        </div>
      </article>

      <section class="homeStatRail" aria-label="현재 상태">
        <article class="homeStatCard">
          <span class="homeStatLabel">최근 캡처</span>
          <strong class="homeStatValue">${esc(String(allRecords.length))}</strong>
          <span class="homeStatNote">${allRecords[0]?.ts ? `마지막 기록 ${esc(fmt(String(allRecords[0].ts || '')))} ` : '아직 기록이 없어요.'}</span>
        </article>
        <article class="homeStatCard">
          <span class="homeStatLabel">컬렉션</span>
          <strong class="homeStatValue">${esc(String(collections.length))}</strong>
          <span class="homeStatNote">${selectedCollection ? `현재 포커스 ${esc(String(selectedCollectionRecordCount))}개 기록` : collections.length ? '최근 흐름을 다시 열어볼 수 있어요.' : '첫 컬렉션을 만들 차례예요.'}</span>
        </article>
        <article class="homeStatCard">
          <span class="homeStatLabel">리스크 항목</span>
          <strong class="homeStatValue">${esc(String(riskyRecords.length))}</strong>
          <span class="homeStatNote">${riskyRecords.length ? '먼저 확인해야 할 항목이 있어요.' : '지금은 비교적 안정적인 상태예요.'}</span>
        </article>
        <article class="homeStatCard">
          <span class="homeStatLabel">공유 준비</span>
          <strong class="homeStatValue">${esc(String(sharedReadyCount))}</strong>
          <span class="homeStatNote">${sharedReadyCount ? '문서 흐름으로 바로 연결할 수 있어요.' : '조금 더 정리하면 문서화가 쉬워져요.'}</span>
        </article>
      </section>

      <section class="homeDashboardMatrix" aria-label="대시보드 영역">
        <article class="homePanel homePanelWide">
          <div class="homePanelHead">
            <div>
              <div class="homePanelTitle">지금 하면 좋은 일</div>
              <div class="homePanelText">작업 흐름이 끊기지 않도록 우선순위를 차분하게 정리했어요.</div>
            </div>
          </div>
          <div class="homeChecklist">
            ${nextActions
              .map((item, index) => `
                <div class="homeChecklistItem">
                  <span class="homeChecklistNumber">${index + 1}</span>
                  <span class="homeChecklistText">${esc(item)}</span>
                </div>
              `).join('')}
          </div>
        </article>

        <article class="homePanel homePanelSide">
          <div class="homePanelHead">
            <div>
              <div class="homePanelTitle">AI 추천 행동</div>
              <div class="homePanelText">현재 기록 흐름을 기준으로 다음 행동을 짧고 선명하게 보여드려요.</div>
            </div>
          </div>
          <div class="homeSignalList">
            ${aiRecommendations.map((item) => `<div class="homeSignalItem">${esc(item)}</div>`).join('')}
          </div>
        </article>

        <article class="homePanel homePanelSoft">
          <div class="homePanelHead">
            <div>
              <div class="homePanelTitle">현재 포커스</div>
              <div class="homePanelText">선택된 컬렉션이나 다음 정리 지점을 기준으로 작업 축을 잡아드려요.</div>
            </div>
          </div>
          ${collectionFocusHtml}
        </article>

        <article class="homePanel">
          <div class="homePanelHead">
            <div>
              <div class="homePanelTitle">최근 캡처</div>
              <div class="homePanelText">방금 추가한 기록을 다시 열어 수정하거나 컬렉션에 묶을 수 있어요.</div>
            </div>
          </div>
          <div class="homeEntryList">${recentRecordItems}</div>
        </article>

        <article class="homePanel">
          <div class="homePanelHead">
            <div>
              <div class="homePanelTitle">최근 컬렉션</div>
              <div class="homePanelText">비슷한 기록을 묶어 흐름과 타임라인을 이어가세요.</div>
            </div>
          </div>
          <div class="homeEntryList">${recentCollectionItems}</div>
        </article>

        <article class="homePanel homePanelFull">
          <div class="homePanelHead">
            <div>
              <div class="homePanelTitle">리스크 높은 항목</div>
              <div class="homePanelText">확인과 정리가 먼저 필요한 기록만 따로 모아 빠르게 볼 수 있게 했어요.</div>
            </div>
          </div>
          <div class="homeEntryList">${riskyItems}</div>
        </article>
      </section>
    </section>
  `;
}


function getLegalHubTab() {
  return 'simulation';
}

function renderLegalSimulationPanel() {
  const draft = ((ui as any).simulationDraft || {}) as any;
  const baseRecords = S.records.slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const selectedIds = Array.isArray((ui as any).simulationSelectedRecordIds)
    ? ((ui as any).simulationSelectedRecordIds as string[]).map((id) => String(id || ''))
    : [];
  const selectedRecords = baseRecords.filter((record) => selectedIds.includes(String(record.id || '')));
  const result = ((ui as any).simulationResult || null) as any;
  const dirty = !!(ui as any).simulationDirty;
  const simulationCaseId = String((ui as any).simulationCaseId || '').trim();
  const selectedCase = simulationCaseId && S.cases[simulationCaseId] ? S.cases[simulationCaseId] : null;
  const selectedCaseRecordCount = selectedCase ? recordsForCase(S.records, selectedCase).length : 0;
  const chatMessages = Array.isArray((ui as any).strategyChatMessages) ? ((ui as any).strategyChatMessages as any[]) : [];
  const chatPending = !!(ui as any).strategyChatPending;
  const chatPendingStartedAt = String((ui as any).strategyChatPendingStartedAt || '').trim();
  const chatInput = String((ui as any).strategyChatInput || '');
  const chatError = String((ui as any).strategyChatError || '').trim();
  const strategyModelStatus = ((ui as any).strategyModelStatus || null) as any;
  const strategyModelStatusLoading = !!(ui as any).strategyModelStatusLoading;
  const strategyModelDownloadPending = !!(ui as any).strategyModelDownloadPending;
  const strategyModelDownloadMessage = String((ui as any).strategyModelDownloadMessage || '').trim();
  const strategyModelDownloadLabel = String((ui as any).strategyModelDownloadLabel || '').trim();
  const strategyModelDownloads = (((ui as any).strategyModelDownloads || {}) as Record<string, any>);
  const strategyChatModel = 'roosy-hybrid';
  const progressLines = Array.isArray((ui as any).strategyChatProgressLines) ? ((ui as any).strategyChatProgressLines as string[]).slice(-6) : [];
  const progressStage = String((ui as any).strategyChatProgressStage || '').trim();
  const activeThreadPackageId = String((ui as any).strategyThreadPackageId || '').trim();
  const activeThreadPackage = Array.isArray((S as any).strategyThreadPackages)
    ? ((S as any).strategyThreadPackages as any[]).find((item) => String(item?.id || '') === activeThreadPackageId) || null
    : null;
  const strategyHybridDesk = `
    <div class="strategyHybridDesk strategyHybridDeskInline" aria-label="ROOSY-Hybrid 민원 법무팀 에이전트">
      <span class="strategyHybridDeskKicker">민원 법무팀 에이전트</span>
      <span class="strategyHybridDeskRoleInline">
        <strong>HyperCLOVA-X</strong>
        <em>법리·균형</em>
      </span>
      <span class="strategyHybridDeskDivider">+</span>
      <span class="strategyHybridDeskRoleInline">
        <strong>Roosy-X</strong>
        <em>실무·행동</em>
      </span>
    </div>
  `;
  const windowsClient = typeof navigator !== 'undefined' && /Windows/i.test(String(navigator.userAgent || ''));
  const windowsModelDownloadMode = windowsClient && (strategyModelStatus ? !!strategyModelStatus.windowsDownloadMode : true);
  const modelsReady = windowsModelDownloadMode ? !!strategyModelStatus?.allReady : true;
  const modelDownloadCompleted = windowsModelDownloadMode
    && modelsReady
    && /끝났어요|채팅할 수 있어요|바로 채팅/i.test(strategyModelDownloadMessage);
  const modelAvailabilityItems = Array.isArray(strategyModelStatus?.models)
    ? strategyModelStatus.models.map((item: any) => `
        <span class="strategyModelSetupItem ${item?.available ? 'isReady' : ''}">
          <strong>${esc(String(item?.label || 'AI 모델'))}</strong>
          <em>${item?.available ? '준비됨' : '다운로드 필요'}</em>
        </span>
      `).join('')
    : '';
  const strategyModelProgressCards = windowsModelDownloadMode ? [
    { id: 'hyperclova-x', label: 'HyperCLOVA-X' },
    { id: 'roosy-x', label: 'Roosy-X' },
  ].map((item) => {
    const progress = strategyModelDownloads[item.id] || null;
    const available = Array.isArray(strategyModelStatus?.models)
      ? !!strategyModelStatus.models.find((model: any) => String(model?.id || '') === item.id && !!model?.available)
      : false;
    const isDone = !!progress?.done || available;
    const isError = !!progress?.error;
    const isPending = !!progress?.pending || (strategyModelDownloadPending && !isDone && !isError);
    const stateLabel = isDone ? '준비 완료' : isError ? '다시 확인 필요' : isPending ? '다운로드 중' : '대기';
    const message = isDone
      ? '이제 바로 사용할 수 있어요.'
      : isError
        ? String(progress?.message || '다시 내려받기를 시도해주세요.')
        : isPending
          ? '최초 1회만 준비하면 다음부터는 바로 실행돼요.'
          : '곧 준비가 시작돼요.';
    const progressMeta = isDone
      ? '모델 준비 완료'
      : isError
        ? '다운로드를 다시 시도해주세요'
        : isPending
          ? '최대 소요 시간 10분 내외'
          : '곧 확인돼요';
    return `
      <article class="strategyModelSetupProgressCard ${isDone ? 'isDone' : ''} ${isError ? 'isError' : ''} ${isPending ? 'isPending' : ''}">
        <div class="strategyModelSetupProgressHead">
          <strong>${esc(String(progress?.label || item.label))}</strong>
          <span class="strategyModelSetupProgressState">${esc(stateLabel)}</span>
        </div>
        ${isPending && !isDone && !isError ? `<div class="strategyModelSetupProgressAnimation" aria-hidden="true"><span></span><span></span><span></span></div>` : ''}
        <div class="strategyModelSetupProgressText">${esc(message)}</div>
        <div class="strategyModelSetupProgressMeta">${esc(progressMeta)}</div>
      </article>
    `;
  }).join('') : '';
  const modelSetupBanner = windowsModelDownloadMode && (!modelsReady || modelDownloadCompleted) ? `
    <article class="strategyModelSetupBanner">
      <div class="strategyModelSetupKicker">${modelDownloadCompleted ? 'Windows 모델 준비 완료' : 'Windows 모델 준비'}</div>
      <div class="strategyModelSetupTitle">${modelDownloadCompleted ? 'AI 모델 준비가 끝났어요.' : '우선 AI모델을 다운로드 받아주세요.'}</div>
      <div class="strategyModelSetupText">${modelDownloadCompleted ? '모델 두 개를 모두 준비했어요. 이제 바로 채팅을 시작할 수 있어요.' : '프로그램은 가볍게 내려받고, HyperCLOVA-X와 Roosy-X는 앱 안에서 함께 내려받는 구조예요. 이 다운로드는 최초 1회만 필요하고, 한 번 받으면 다음부터는 바로 사용할 수 있어요.'}</div>
      ${modelAvailabilityItems ? `<div class="strategyModelSetupList">${modelAvailabilityItems}</div>` : ''}
      ${strategyModelDownloadPending ? `
        <div class="strategyModelSetupActivity">
          <div class="strategyModelSetupActivityHead">
            <div class="strategyModelSetupActivityBadge">
              <span class="strategyModelSetupActivityPulse" aria-hidden="true"></span>
              <strong>${esc(strategyModelDownloadLabel || 'ROOSY-Hybrid')}</strong>
            </div>
            <span class="strategyModelSetupEta">예상 소요 시간 약 10분</span>
          </div>
          <div class="strategyModelSetupActivityTitle">최초 1회만 AI 모델을 내려받고 있어요.</div>
          <div class="strategyModelSetupActivityText">잠시 다른 일을 보셔도 괜찮아요. 두 모델 준비가 끝나면 바로 채팅을 시작할 수 있어요.</div>
          ${strategyModelProgressCards ? `<div class="strategyModelSetupProgressGrid">${strategyModelProgressCards}</div>` : ''}
          <div class="strategyModelSetupActivityNote">
            <span>이 작업은 최초 1회만 진행돼요.</span>
            <span>최대 소요 시간은 10분 내외예요.</span>
            <span>잠시 다른 일을 보셔도 괜찮아요.</span>
            <span>완료 후에는 다시 받지 않고 바로 실행돼요.</span>
          </div>
        </div>
      ` : modelDownloadCompleted && strategyModelProgressCards ? `
        <div class="strategyModelSetupProgressGrid">${strategyModelProgressCards}</div>
      ` : ''}
      <div class="strategyModelSetupActions">
        ${H.btn(
          modelDownloadCompleted ? '채팅 시작' : strategyModelDownloadPending ? '다운로드 중…' : strategyModelStatusLoading ? '상태 확인 중…' : 'AI 모델 다운로드',
          modelDownloadCompleted ? 'focus-strategy-chat' : 'download-strategy-models',
          strategyModelDownloadPending || strategyModelStatusLoading ? ' disabled aria-disabled="true"' : '',
          'btn primary'
        )}
        <div class="strategyModelSetupHint">${esc(modelDownloadCompleted ? '모델 준비가 끝났어요. 버튼을 누르면 바로 입력창으로 이동해요.' : strategyModelDownloadPending ? '최초 1회만 다운로드하면 이후에는 바로 사용할 수 있어요. 잠시 다른 일을 보셔도 괜찮아요.' : '최초 1회만 다운로드하면, 다음부터는 바로 채팅을 시작할 수 있어요.')}</div>
      </div>
    </article>
  ` : '';

  const goalLabelMap: Record<string, string> = {
    stabilize: '상황을 더 키우지 않는 정리',
    document: '공유를 위한 기록 축적',
    escalate: '기관·제출까지 고려한 정리',
  };
  const presetItems: { key: string; label: string; desc: string }[] = [
    { key: 'shield', label: '완화형', desc: '자극 낮추기' },
    { key: 'balanced', label: '균형형', desc: '설명+기록' },
    { key: 'assertive', label: '단호형', desc: '공유 준비' },
  ];
  const presetLabel = (presetItems.find((item) => item.key === String(draft.scenarioPreset || 'balanced'))?.label) || '균형형';
  const goalLabel = goalLabelMap[String(draft.goal || 'stabilize')] || goalLabelMap.stabilize;
  const recommendedTone = cleanStrategyDisplayText(result?.recommendedTone || '차분하게 핵심만 정리하는 대응이 좋아 보여요.');
  const recommendedAction = cleanStrategyDisplayText(result?.recommendedAction || '현재 기록을 기준으로 가장 안전한 다음 행동을 정리해드릴게요.');
  const contextSummaryLine = [
    selectedCase ? String(selectedCase.title || '선택한 컬렉션').trim() || '선택한 컬렉션' : '직접 분석 모드',
    `기록 ${selectedRecords.length}개`,
    goalLabel,
    presetLabel,
  ].join(' · ');

  const briefingBubble = result
    ? `
      <article class="strategyMsg agent primary strategySummaryMsg">
        <div class="strategyAvatar">AI</div>
        <div class="strategyBubble">
          <div class="strategyInlineMeta">
            <span>${esc(contextSummaryLine)}</span>
            <span>${dirty ? '기록 변경됨' : `마지막 분석 ${esc(fmt(result.calculatedAt))}`}</span>
          </div>
          <div class="strategyLead">${esc(recommendedTone)}</div>
          <div class="strategyParagraph">${esc(recommendedAction)}</div>
          <div class="strategyContextRow">
            <span class="strategyContextPill">근거 ${esc(String(result.evidencePower || 0))}</span>
            <span class="strategyContextPill">논리 ${esc(String(result.counterLogic || 0))}</span>
            <span class="strategyContextPill">확산 ${esc(String(result.escalationRisk || 0))}</span>
            <span class="strategyContextPill">통제 ${esc(String(result.communicationControl || 0))}</span>
          </div>
        </div>
      </article>
    `
    : `
      <article class="strategyMsg agent primary strategySummaryMsg">
        <div class="strategyAvatar">AI</div>
        <div class="strategyBubble">
          <div class="strategyInlineMeta">
            <span>${esc(contextSummaryLine)}</span>
          </div>
          <div class="strategyLead">기록 흐름을 읽고 어떤 말부터 꺼내야 하는지, 무엇을 먼저 정리해야 하는지 바로 정리해드릴게요.</div>
          <div class="strategyParagraph">하단 입력창에 질문만 보내면 답장 초안, 기록 포인트, 다음 행동 순서를 채팅으로 이어서 도와드려요.</div>
        </div>
      </article>
    `;

  const caseSummary = selectedCase
    ? `${String(selectedCase.title || '선택한 컬렉션').trim() || '선택한 컬렉션'} 컬렉션을 기준으로 보고 있어요. 연결된 기록 ${selectedCaseRecordCount}개 중 현재 ${selectedRecords.length}개가 분석에 포함돼 있어요.`
    : selectedRecords.length
      ? `지금은 컬렉션을 고르지 않고 기록 ${selectedRecords.length}개만 붙여 놓은 상태예요. 이 정도면 빠른 1차 분석은 가능해요.`
      : '아직 컬렉션이나 기록이 연결되지 않았어요. 하단의 기록 버튼에서 컬렉션을 고르거나 기록 몇 개만 붙이면 바로 분석을 시작할 수 있어요.';
  const pendingElapsedSeconds = chatPendingStartedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(chatPendingStartedAt).getTime()) / 1000))
    : 0;
  const pendingElapsedLabel = pendingElapsedSeconds >= 60
    ? `${Math.floor(pendingElapsedSeconds / 60)}분 ${String(pendingElapsedSeconds % 60).padStart(2, '0')}초째`
    : `${pendingElapsedSeconds}초째`;
  const pendingStage = progressStage || '준비';
  const pendingStageMeta: Record<string, { title: string, desc: string, step: number }> = {
    '준비': { title: '법무팀이 질문과 사건 묶음을 접수하고 있어요', desc: '현재 질문, 연결 기록, 컬렉션 흐름을 먼저 모아 하이브리드 검토 테이블에 올리는 중이에요.', step: 0 },
    '근거정리': { title: 'HyperCLOVA-X가 사실관계와 핵심 증거를 읽고 있어요', desc: '이번 질문에 꼭 필요한 장면과 기록만 먼저 골라 균형 있게 흐름을 잡는 중이에요.', step: 1 },
    '법령정리': { title: 'HyperCLOVA-X가 관련 법령과 사건 맥락을 대조하고 있어요', desc: '증거와 자연스럽게 이어지는 조문만 추려서 과도한 단정 없이 검토하고 있어요.', step: 1 },
    '초안1': { title: 'HyperCLOVA-X가 신중한 1차 법무 의견을 쓰는 중이에요', desc: '증거 연결과 법리 균형을 중심으로 안전한 답변 뼈대를 먼저 세우고 있어요.', step: 1 },
    '초안2': { title: 'Roosy-X가 바로 쓸 수 있는 실무 문장으로 다듬고 있어요', desc: '현장에서 바로 전달할 말, 남길 기록, 다음 행동이 더 선명하게 보이도록 초안을 정리하는 중이에요.', step: 2 },
    '합성': { title: 'ROOSY-Hybrid 법무팀이 하나의 최종 답변으로 합의 중이에요', desc: '두 모델의 장점을 묶어 더 자연스럽고 길이감 있는 최종 답변으로 정리하고 있어요.', step: 3 },
    '대기': { title: 'ROOSY-Hybrid 법무팀이 답변을 안정적으로 마무리하고 있어요', desc: '출력이 끊기지 않게 모으면서 문장 흐름과 전달 톤을 마지막으로 정리하는 중이에요.', step: 3 },
    '모델로그': { title: '법무팀 추론 상태를 점검하며 출력 품질을 맞추고 있어요', desc: '생성 흐름이 흔들리지 않게 확인하면서 답변 완성도를 다듬는 중이에요.', step: 3 },
  };
  const pendingMeta = pendingStageMeta[pendingStage] || { title: '답변을 다듬고 있어요', desc: '증거와 맥락을 엮어 바로 쓸 수 있는 문장으로 정리하고 있어요.', step: 2 };
  const pendingTeamSteps = [
    {
      label: 'HyperCLOVA-X',
      desc: '법리·균형 검토',
      active: pendingMeta.step >= 1,
      current: ['근거정리', '법령정리', '초안1'].includes(pendingStage),
    },
    {
      label: 'Roosy-X',
      desc: '실무 문장 초안',
      active: pendingMeta.step >= 2,
      current: ['초안2'].includes(pendingStage),
    },
    {
      label: 'Hybrid',
      desc: '최종 합의 답변',
      active: pendingMeta.step >= 3,
      current: ['합성', '대기', '모델로그'].includes(pendingStage),
    },
  ];
  const compactProgressHtml = `
    <div class="strategyProgressConsole strategyProgressConsoleMini">
      ${(progressLines.length ? progressLines.slice(-3) : [`${progressStage || '대기'} · 분석이 시작되면 여기에 최근 단계가 보여요.`])
        .map((line) => `<div class="strategyProgressLine">${esc(String(line || ''))}</div>`).join('')}
    </div>
  `;

  const renderedChatMessages = chatMessages.map((msg) => {
    const role = String(msg.role || 'assistant') === 'user' ? 'user' : 'assistant';
    const bubbleClass = role === 'user' ? 'strategyBubble userBubble strategyUserCard' : 'strategyBubble strategyAssistantCard';
    const wrapperClass = role === 'user' ? 'strategyMsg user strategyUserMsg' : 'strategyMsg agent strategyResponseMsg';
    const headMeta = String(msg.meta || '').trim() || fmt(String(msg.ts || ''));
    return `
      <article class="${wrapperClass}">
        ${role === 'assistant' ? `<div class="strategyAvatar">AI</div>` : ''}
        <div class="${bubbleClass}">
          ${role === 'assistant'
            ? `<div class="strategyBubbleMetaOnly"><span>${esc(headMeta)}</span></div>`
            : ''}
          <div class="strategyParagraph">${strategyTextHtml(String(msg.content || ''))}</div>
        </div>
      </article>
    `;
  }).join('');

  const pendingBubble = chatPending ? `
    <article class="strategyMsg agent strategyStatusMsg">
      <div class="strategyAvatar">AI</div>
      <div class="strategyBubble soft">
        <div class="strategyInlineMeta">
          <span>${esc(`${pendingStage} · ${pendingElapsedLabel}`)}</span>
        </div>
        <div class="strategyPendingHero">
          <div class="strategyPendingPulse" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div class="strategyPendingBody">
            <div class="strategyPendingTeamLabel">ROOSY-Hybrid 민원 법무팀 에이전트</div>
            <div class="strategyPendingTitle">${esc(pendingMeta.title)}</div>
            <div class="strategyPendingDesc">${esc(pendingMeta.desc)}</div>
            <div class="strategyPendingSteps">
              ${pendingTeamSteps.map((step) => `
                <span class="strategyPendingStep ${step.active ? 'isActive' : ''} ${step.current ? 'isCurrent' : ''}">
                  <strong>${esc(step.label)}</strong>
                  <em>${esc(step.desc)}</em>
                </span>
              `).join('')}
            </div>
            <div class="strategyPendingSkeleton" aria-hidden="true">
              <span class="strategyPendingSkeletonLine isWide"></span>
              <span class="strategyPendingSkeletonLine"></span>
              <span class="strategyPendingSkeletonLine isShort"></span>
            </div>
          </div>
        </div>
        ${compactProgressHtml}
      </div>
    </article>
  ` : '';

  const errorBubble = chatError ? `
    <article class="strategyMsg agent strategyStatusMsg">
      <div class="strategyAvatar">AI</div>
      <div class="strategyBubble soft">
        <div class="strategyInlineMeta">
          <span>실행 오류</span>
        </div>
        <div class="strategyParagraph">${strategyTextHtml(chatError)}</div>
      </div>
    </article>
  ` : '';
  const threadPackageBanner = activeThreadPackage ? `
    <article class="strategyThreadPackageBanner">
      <div class="strategyThreadPackageBannerLabel">사건분석 스레드 패키지</div>
      <div class="strategyThreadPackageBannerTitle">${esc(String(activeThreadPackage.title || '사건분석 스레드'))}</div>
      <div class="strategyThreadPackageBannerMeta">${esc(`${String(activeThreadPackage.caseTitle || '직접 분석')} · 메시지 ${Array.isArray(activeThreadPackage.messages) ? activeThreadPackage.messages.length : 0}개`)}</div>
    </article>
  ` : '';
  const starterThread = !chatMessages.length ? `
    <article class="strategyMsg agent strategyIntroMsg">
      <div class="strategyAvatar">AI</div>
      <div class="strategyBubble soft">
        <div class="strategyInlineMeta">
          <span>${esc(contextSummaryLine)}</span>
        </div>
        <div class="strategyParagraph">${esc(caseSummary)}</div>
        <div class="strategyParagraph">질문을 보내면 답변 문구, 기록 포인트, 다음 행동 순서를 짧고 실무적으로 정리해드릴게요.</div>
      </div>
    </article>
  ` : '';

  return `
    <article class="legalHubPanel strategyChatPage" aria-label="AI 민원 법무팀 에이전트">
      <section class="strategyChatOnlyShell">
        <div class="strategyChatThread strategyChatThreadOnly">
          ${modelSetupBanner}
          ${threadPackageBanner}
          ${starterThread}
          ${result ? briefingBubble : ''}
          ${renderedChatMessages}
          ${pendingBubble}
          ${errorBubble}
        </div>

        <footer class="strategyChatOnlyComposer">
          <label class="strategyComposerTextareaWrap strategyComposerTextareaWrapOnly">
            <textarea class="strategyComposerTextarea strategyComposerTextareaOnly" rows="1" placeholder="${esc(modelsReady ? '예: 이 상황을 상대방에게 어떻게 정리해 보낼지 3문장으로 써줘' : '우선 AI모델을 다운로드 받아주세요')}" ${modelsReady ? '' : 'disabled aria-disabled="true"'} data-action="draft-strategy-chat" data-field="input">${esc(chatInput)}</textarea>
          </label>
          <div class="strategyChatOnlyComposerBar">
            <div class="strategyChatOnlyComposerTools">
              ${H.btn(selectedRecords.length ? `기록 ${selectedRecords.length}개` : '기록 붙이기', 'open-simulation-picker', '', 'btn ghost')}
              ${chatPending || !modelsReady ? `<div class="strategyChatOnlyComposerHint">${chatPending ? esc(`${pendingStage} · ${pendingElapsedLabel}`) : '모델 다운로드 후 채팅 가능'}</div>` : ''}
              ${strategyHybridDesk}
            </div>
            <div class="strategyComposerActions">
              ${H.btn(chatPending ? '생성 중…' : '보내기', 'send-strategy-chat', chatPending || !modelsReady ? ' disabled aria-disabled="true"' : '', 'btn primary')}
            </div>
          </div>
        </footer>
      </section>
    </article>
  `;
}

function renderSimulationPickerModal() {
  const selectedIds = Array.isArray((ui as any).simulationPickerSelectedRecordIds)
    ? ((ui as any).simulationPickerSelectedRecordIds as string[]).map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const baseRecords = S.records.slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const q = String((ui as any).simulationPickerQuery || '').trim().toLowerCase();
  const simulationCaseId = String((ui as any).simulationCaseId || '').trim();
  const selectedCase = simulationCaseId && S.cases[simulationCaseId] ? S.cases[simulationCaseId] : null;
  const visibleRecords = q
    ? baseRecords.filter((record) => [record.summary, recordActorText(record), storeLabel(record.storeType, record.storeOther), placeLabel(record.place, record.placeOther), fmt(record.ts)].join(' ').toLowerCase().includes(q))
    : baseRecords;

  const rows = visibleRecords.length
    ? visibleRecords.map((record) => {
        const safeId = String(record.id || '');
        const active = selectedIds.includes(safeId);
        return `
          <article class="strategyPickerItem ${active ? 'selected' : ''}">
            <button class="strategyPickerToggle" data-action="simulation-toggle-record" data-id="${esc(safeId)}" type="button">
              <span class="strategyPickerToggleMark">${active ? '✓' : '+'}</span>
            </button>
            <div class="strategyPickerMain">
              <div class="strategyPickerTitle">${esc(trunc(String(record.summary || '기록 요약 없음'), 90))}</div>
              <div class="strategyPickerMeta">${esc(trunc(`${recordActorText(record)} · ${storeLabel(record.storeType, record.storeOther)} · ${placeLabel(record.place, record.placeOther)} · ${fmt(record.ts)}`, 110))}</div>
            </div>
            <button class="strategyPickerAction" data-action="simulation-toggle-record" data-id="${esc(safeId)}" type="button">${active ? '제외' : '추가'}</button>
          </article>
        `;
      }).join('')
    : `<div class="strategyPickerEmpty">검색 결과가 없어요.</div>`;

  return H.modal(
    'simulationPickerModal',
    H.modalHead(
      '분석에 넣을 기록 고르기',
      selectedCase ? `${String(selectedCase.title || '선택한 컬렉션').trim() || '선택한 컬렉션'} 컬렉션에 연결할 기록을 골라주세요.` : 'AI 민원 법무팀 에이전트가 읽을 기록을 추가하거나 빼주세요.',
      H.btn('닫기', 'close-simulation-picker', '', 'btn ghost')
    ),
    `
      <div class="strategyPickerSheet">
        <div class="strategyPickerTopbar">
          <div class="strategyPickerTopbarFields">
            <label class="strategyField strategyPickerCaseField">
              <span>기준 컬렉션</span>
              <select data-action="draft-simulation" data-field="caseId">
                <option value="">컬렉션 없이 직접 선택</option>
                ${visibleCases().map((id) => {
                  const item = S.cases[id];
                  const label = String(item?.title || '제목 없는 컬렉션').trim() || '제목 없는 컬렉션';
                  return `<option value="${esc(id)}" ${simulationCaseId === id ? 'selected' : ''}>${esc(trunc(label, 40))}</option>`;
                }).join('')}
              </select>
            </label>
            <label class="strategyField strategyPickerSearchField">
              <span>전체 기록 검색</span>
              <input type="text" value="${esc(String((ui as any).simulationPickerQuery || ''))}" placeholder="요약 / 주체 / 장소 / 보관형태" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="search" data-action="draft-simulation" data-field="pickerQuery" />
            </label>
          </div>
          <div class="strategyPickerCounters">
            <span>전체 ${esc(String(baseRecords.length))}개</span>
            <span>검색 ${esc(String(visibleRecords.length))}개</span>
            <span class="strong">선택 ${esc(String(selectedIds.length))}개</span>
          </div>
        </div>

        <div class="strategyPickerToolbar">
          ${selectedCase ? H.btn('컬렉션 기록 다시 불러오기', 'simulation-reset-to-case', '', 'btn') : ''}
          ${H.btn('비우기', 'simulation-clear-selection', '', 'btn ghost')}
          <div class="strategyPickerHint">여기서 고른 뒤 적용을 눌러야 AI 민원 법무팀 에이전트 화면에 반영돼요.</div>
          ${H.btn(`적용하기 (${selectedIds.length})`, 'simulation-apply-picker', '', 'btn primary')}
        </div>

        <div class="strategyPickerList">${rows}</div>
      </div>
    `,
    'modal simulationPickerModal strategyPickerModal'
  );
}

function renderLegalConsultMain() {
  return `
    <section class="legalHub legalPartnerHub legalHubCompact legalHubChatMode" aria-label="AI 민원 법무팀 에이전트">
      <article class="card legalHubShell legalHubShellFlat">${renderLegalSimulationPanel()}</article>
    </section>
  `;
}


const PRIMARY_TABS = new Set(['home', 'records', 'cases', 'legal']);
let queuedPrimaryTab = '';

function normalizePrimaryTab(value: string) {
  const tab = String(value || '').trim();
  return PRIMARY_TABS.has(tab) ? tab : '';
}

function bindPrimaryTabRouteOverrides(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-route-tab]').forEach((el) => {
    if ((el as any).__routeBound) return;
    (el as any).__routeBound = true;
    el.addEventListener('click', () => {
      const next = normalizePrimaryTab(String(el.dataset.routeTab || ''));
      if (next) queuedPrimaryTab = next;
    });
  });
}


function getRecordIntegrityMeta(record: RecordItem) {
  const vr = ensureRecordV8(record) as any;
  const revisions = getRecordRevisions(vr);
  const revisionCount = revisions.length;
  const amendCount = Math.max(0, revisionCount - 1);
  const originalSealedAt = String(vr?.integrity?.originalSealedAt || revisions[0]?.sealedAt || '');
  const lastSealedAt = String(vr?.integrity?.lastSealedAt || revisions[revisionCount - 1]?.sealedAt || '');
  const currentHash = String(vr?.integrity?.currentHash || '');
  const integrity = verifyRecordIntegrity(vr);
  return { vr, revisions, revisionCount, amendCount, originalSealedAt, lastSealedAt, currentHash, integrity };
}

function renderTimelineRecordMeta(record: RecordItem) {
  const meta = getRecordIntegrityMeta(record);
  const sealLabel = meta.amendCount ? '최종 수정봉인' : '기록 봉인';
  const integrityText = meta.integrity.valid ? '무결성 확인' : '검증 필요';
  const trail = meta.revisions
    .slice()
    .reverse()
    .slice(0, 2)
    .map((rev: any) => {
      const badge = rev?.action === 'amend' ? '정정' : (rev?.action === 'legacy-import' ? '이관' : '원본');
      const reason = String(rev?.reason || '').trim();
      return `
        <div class="timelineRevLine">
          <span class="timelineRevBadge">${esc(badge)}</span>
          <span class="timelineRevText">${esc(fmt(String(rev?.sealedAt || '')))}${reason ? ` · ${esc(trunc(reason, 34))}` : ''}</span>
        </div>
      `;
    })
    .join('');

  return `
    <div class="recMiniTimes timelineMetaBlock">
      <div class="recMiniMetaLine"><span class="metaK">기록 시각</span><span>${esc(fmt(meta.vr.ts || ''))}</span></div>
      <div class="recMiniMetaLine"><span class="metaK">최초 입력봉인</span><span>${esc(meta.originalSealedAt ? fmt(meta.originalSealedAt) : '—')}</span></div>
      <div class="recMiniMetaLine"><span class="metaK">${esc(sealLabel)}</span><span>${esc(meta.lastSealedAt ? fmt(meta.lastSealedAt) : '—')}</span></div>
      <div class="recMiniMetaLine"><span class="metaK">수정이력</span><span>${esc(meta.amendCount ? `정정 ${meta.amendCount}회 / REV ${meta.revisionCount}` : `원본 / REV ${meta.revisionCount}`)}</span></div>
    </div>
    <div class="recMiniHash">현재 해시 ${esc(shortHash(meta.currentHash, 10, 8))} · ${esc(integrityText)}</div>
    ${trail ? `<div class="timelineRevTrail">${trail}</div>` : ''}
  `;
}

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
  return [
    String((a as any)?.type || '').trim(),
    String((a as any)?.name || '').trim(),
    String((a as any)?.groupId || '').trim(),
    String((a as any)?.groupLabel || '').trim(),
  ].join('::');
}


/* ==================== PUBLIC ==================== */

export function render() {
  if (ui.caseCreateOpen) {
    S.tab = 'cases';
    ui.caseTab = 'create';
    ui.caseCreateOpen = false;
  }
  if (ui.paperPickOpen) {
    S.tab = 'cases';
    ui.caseTab = 'proof' as any;
    ui.paperPickOpen = false;
  }

  const currentTab = normalizePrimaryTab(queuedPrimaryTab || String((S as any).tab || 'home')) || 'home';
  (S as any).tab = currentTab;
  queuedPrimaryTab = '';
  const selected = getSelectedCase();
  const activeCaseTab = ui.caseTab === 'list' ? 'list' : ui.caseTab === 'proof' ? 'proof' : 'create';
  const isHome = currentTab === 'home';
  const isEvidence = currentTab === 'records';
  const isLegal = currentTab === 'legal';
  const legalHubTab = getLegalHubTab();
  const isCasesListView = currentTab === 'cases' && activeCaseTab === 'list';
  const showCaseSide = isCasesListView && !!selected && !HIDE_CASE_ACTIONS_AND_GUIDES;
  const platform = windowPlatform();

  const casesMainHtml = renderCasesMain(selected);
  const casesSideHtml = showCaseSide ? renderCaseSidebar(selected) : '';
  const gridClass = showCaseSide ? 'grid caseGrid' : 'grid oneCol';
  const gridInner = showCaseSide
    ? `<aside class="side">${casesSideHtml}</aside><main class="card">${casesMainHtml}</main>`
    : `<main class="card">${casesMainHtml}</main>`;

  const contentHtml = isHome
    ? `<section class="serviceSection homeSection"><main class="homeMain">${renderHomeMain()}</main></section>`
    : isEvidence
      ? `<section class="serviceSection recordsSection"><main class="recordsMain">${renderRecordsMain()}</main></section>`
      : isLegal
        ? `<section class="serviceSection legalSection"><main class="legalMain">${renderLegalConsultMain()}</main></section>`
        : `<section class="serviceSection casesSection"><main class="casesMain">${renderCasesShell(selected, gridClass, isCasesListView ? gridInner : '')}</main></section>`;

  $app.innerHTML = `
    <div class="container mobileRefined iphonePremium fluidDesktopShell ${ui.pinLocked ? 'appIsLocked' : ''}" data-window-platform="${platform}">
      <div class="appFrame">
        ${renderAppSidebar(currentTab)}

        <div class="serviceMain">
          <header class="topbar">
            <div class="windowTitlebarStrip">
              <div class="windowTitlebarDrag" data-tauri-drag-region aria-hidden="true"></div>
              ${renderWindowControls()}
            </div>
            <div class="topbarInner topbarCompact">
              <nav class="topNav topNavShifted" aria-label="주요 메뉴">
                <button class="topNavBtn ${currentTab === 'records' ? 'active' : ''}" data-action="tab" data-tab="records" data-route-tab="records" type="button" ${currentTab === 'records' ? 'aria-current="page"' : ''}>
                  <span class="topNavIcon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M7 3.75H13.5L18 8.25V18.25C18 19.2165 17.2165 20 16.25 20H7C5.89543 20 5 19.1046 5 18V5.75C5 4.64543 5.89543 3.75 7 3.75Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M13 3.75V8.75H18" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M8.5 12H14.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                      <path d="M8.5 15.5H14.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                    </svg>
                  </span>
                  <span class="topNavLabel">기록 보관함</span>
                </button>
                <button class="topNavBtn ${currentTab === 'cases' ? 'active' : ''}" data-action="tab" data-tab="cases" data-route-tab="cases" type="button" ${currentTab === 'cases' ? 'aria-current="page"' : ''}>
                  <span class="topNavIcon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M3.75 8C3.75 6.75736 4.75736 5.75 6 5.75H9.2C9.8066 5.75 10.3884 5.99553 10.8125 6.43089L11.6875 7.31911C12.1116 7.75447 12.6934 8 13.3 8H18C19.2426 8 20.25 9.00736 20.25 10.25V17C20.25 18.2426 19.2426 19.25 18 19.25H6C4.75736 19.25 3.75 18.2426 3.75 17V8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M3.75 10H20.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                    </svg>
                  </span>
                  <span class="topNavLabel">컬렉션</span>
                </button>
                <button class="topNavBtn topNavBtnLegal ${currentTab === 'legal' && legalHubTab === 'simulation' ? 'active' : ''}" data-action="switch-legal-tab" data-legal-tab="simulation" data-route-tab="legal" type="button" ${currentTab === 'legal' && legalHubTab === 'simulation' ? 'aria-current="page"' : ''}>
                  <span class="topNavIcon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 4.75L18.5 8.5L12 12.25L5.5 8.5L12 4.75Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M8 10.5V15.25L12 17.5L16 15.25V10.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M19 14.5L21 15.75L19 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </span>
                  <span class="topNavLabel">AI 민원 법무팀 에이전트 <span class="legalExperimentalBadge">현재 실험기능입니다</span></span>
                </button>
              </nav>
            </div>
          </header>

          <div class="serviceContent${currentTab === 'legal' ? ' serviceContentChatMode' : ''}">
            ${contentHtml}
          </div>
        </div>

        ${ENABLE_BACKUP_RESTORE ? renderRestoreModal() : ''}
        ${renderScreenPinModal()}
        ${renderSettingsModal()}
        ${renderUpdateNotesModal()}
        ${renderSimulationPickerModal()}
        ${renderLogsModal()}
        ${renderConfirmModal()}
        ${renderSignatureModal()}
        ${renderSignSuccessModal()}
        ${renderStudentRosterModal()}
        ${renderRecordComposerModal()}
        ${renderRecordModal()}
        ${renderTimelineDetailModal()}
        ${renderCasePaperModal()}
        ${renderCaseUpdateModal()}

        <div class="toast" id="toast" role="status" aria-live="polite">
          <span class="toastMsg"></span>
          <button class="toastAct" data-action="toast-action" type="button" hidden></button>
        </div>
      </div>
    </div>
  `;

  bindPrimaryTabRouteOverrides($app);

  if (ui.settingsOpen) {
    const settingsDlg = document.getElementById('settingsModal') as HTMLDialogElement | null;
    if (settingsDlg && typeof settingsDlg.showModal === 'function' && !settingsDlg.open) settingsDlg.showModal();
  }
  installToastPortal();
  portalToast();
}

/* ==================== COMMON MODALS ==================== */


function getCaseProofTarget() {
  return ui.paperCaseId ? (S.cases[ui.paperCaseId] ?? null) : null;
}

function renderCaseContentProofPanel() {
  const ids = visibleCases();
  if (!ids.length) {
    return `
      <div class="caseProofPanel compactMode">
        <div class="empty" style="height:160px">아직 컬렉션이 없어요. 먼저 기록을 묶어 컬렉션을 만든 뒤 공유용 문서를 준비할 수 있어요.</div>
        <div class="rowInline" style="justify-content:flex-end; margin-top:10px">
          ${H.btnData('컬렉션 만들기로 이동', 'switch-case-tab', { 'case-tab': 'create' }, 'btn primary')}
        </div>
      </div>
    `;
  }

  const proofCase = getCaseProofTarget();
  const proofRecords = proofCase ? recordsForCase(S.records, proofCase) : [];
  const lastTs = proofRecords.reduce((m, r) => (String(r.ts || '') > m ? String(r.ts || '') : m), '');

  return `
    <div class="caseProofPanel compactMode">
      <div class="caseProofHero compactMode">
        <div>
          <div class="simulationEyebrow">공유/제출 문서</div>
          <div class="h2">출력할 컬렉션을 먼저 선택하세요</div>
          <div class="muted" style="margin-top:6px">컬렉션 목록에서 하나를 고른 뒤 <b>공유 문서 생성하기</b>를 누르면 미리보기 모달이 열립니다.</div>
        </div>
        <div class="caseProofActionRow compactMode">
          ${proofCase ? H.btn('공유 문서 생성하기', 'open-paper-preview', '', 'btn primary') : '<button class="btn" type="button" disabled>공유 문서 생성하기</button>'}
        </div>
      </div>

      ${proofCase ? `
        <div class="caseProofTargetCard compactMode">
          <div class="caseProofTargetMain">
            <div class="caseProofTargetTitle">${esc(String((proofCase as any).title || '제목 없는 컬렉션'))}</div>
            <div class="caseProofTargetDesc">${esc(trunc(String((proofCase as any).query || ''), 140) || '컬렉션 설명이 아직 비어 있어요.')}</div>
          </div>
          <div class="caseProofStats compactMode">
            <div class="caseProofStat"><span class="k">기록</span><span class="v">${esc(String(proofRecords.length))}</span></div>
            <div class="caseProofStat"><span class="k">최근</span><span class="v">${lastTs ? esc(fmt(lastTs)) : '—'}</span></div>
          </div>
        </div>
      ` : `
        <div class="caseProofHintCard">선택된 컬렉션이 없습니다. 아래 컬렉션 카드 중 하나를 눌러주세요.</div>
      `}

      <div class="caseProofCaseGrid">
        ${ids.map((id) => {
          const c = S.cases[id];
          const recs = recordsForCase(S.records, c);
          const active = !!proofCase && proofCase.id === c.id;
          return `
            <button class="caseProofCaseCard ${active ? 'active' : ''}" data-action="pick-proof-case" data-id="${esc(c.id)}" type="button">
              <div class="caseProofCaseCardTop">
                <span class="caseProofCaseTitle">${esc(trunc(String(c.title || '컬렉션'), 34))}</span>
                <span class="caseProofCaseBadge">${active ? '선택됨' : '선택'}</span>
              </div>
              <div class="caseProofCaseDesc">${esc(trunc(String(c.query || ''), 92) || '컬렉션 설명이 아직 비어 있어요.')}</div>
              <div class="caseProofCaseMeta">${esc(String(recs.length))}개 기록 · ${c.status ? esc(String(c.status)) : '진행중'}</div>
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderPaperPickContent() {
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

  return all.length
    ? `
      <div class="paperPickToolbar">
        <input class="searchInput paperPickSearch" placeholder="컬렉션 제목/설명 검색" value="${esc(q)}" data-action="search-paper-cases" />
      </div>
      <div class="paperPickList" role="list">
        ${filtered.length ? filtered.map(({ c, recCount, lastTs }) => `
          <button class="paperPickItem" data-action="pick-paper-case" data-id="${esc((c as any).id)}" type="button" role="listitem">
            <div class="paperPickMain">
              <div class="paperPickTitle">
                ${esc(String((c as any).title || '제목 없는 컬렉션'))}
                ${S.selectedCaseId === (c as any).id ? `<span class="tag butter" style="margin-left:8px;">현재 열림</span>` : ''}
              </div>
              <div class="paperPickMeta">
                ${esc(trunc(String((c as any).query || ''), 70) || '—')}
              </div>
            </div>
            <div class="paperPickSide">
              <div class="paperPickStat">${esc(String((c as any).status || ''))}</div>
              <div class="paperPickStat muted">${esc(String(recCount))}개 기록</div>
              <div class="paperPickStat muted">${lastTs ? esc(fmt(lastTs)) : '—'}</div>
            </div>
          </button>
        `).join('') : H.empty('검색 결과가 없어요.', 120)}
      </div>

      <div class="muted" style="margin-top:10px; font-size:12px">
        선택 즉시 공유/제출 문서 미리보기로 넘어가요.
      </div>
    `
    : `
      <div class="empty" style="height:160px">
        아직 컬렉션이 없어요. 먼저 컬렉션을 만든 뒤 출력할 수 있어요.
      </div>
      <div class="rowInline" style="justify-content:flex-end; margin-top:10px">
        ${H.btnData('컬렉션 만들기로 이동', 'switch-case-tab', { 'case-tab': 'create' }, 'btn primary')}
      </div>
    `;
}

function renderPaperPickModal() {
  const actions = `
    <div class="rowInline">
      ${H.btn('컬렉션 만들기', 'paper-open-case-create', '', 'btn')}
      ${H.btn('닫기', 'close-paper-picker')}
    </div>
  `;

  const head = H.modalHead('공유/제출 문서', '어떤 컬렉션으로 PDF를 만들까요?', actions);
  return H.modal('paperPickModal', head, renderPaperPickContent(), 'modal paperPickModal');
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


function renderSettingsModal() {
  const pinReady = hasScreenPin();
  return H.modal(
    'settingsModal',
    H.modalHead('설정', '백업, 삭제와 화면 잠금 PIN을 여기에서 관리합니다.', H.btn('닫기', 'close-settings')),
    `
      <div class="settingsGrid">
        <button class="settingsAction" data-action="backup" type="button">
          <div class="settingsActionTitle">백업</div>
          <div class="muted">현재 데이터를 JSON 파일로 저장합니다.</div>
        </button>

        <button class="settingsAction" data-action="open-restore" type="button">
          <div class="settingsActionTitle">복구</div>
          <div class="muted">백업 파일로 현재 데이터를 덮어씁니다.</div>
        </button>

        <button class="settingsAction danger" data-action="wipe" type="button">
          <div class="settingsActionTitle">삭제</div>
          <div class="muted">모든 기록과 컬렉션 데이터를 삭제합니다.</div>
        </button>
      </div>

      <div class="settingsPinCard">
        <div class="settingsPinHead">
          <div>
            <div class="settingsActionTitle">화면 잠금 PIN</div>
            <div class="muted">사이드바 자물쇠 버튼을 눌렀을 때 사용하는 숫자 4자리 PIN입니다.</div>
          </div>
          <span class="settingsPinBadge ${pinReady ? 'ready' : ''}">${pinReady ? '설정됨' : '미설정'}</span>
        </div>

        <div class="settingsPinFields">
          <label class="pinField">
            <span>새 PIN</span>
            <input id="settingsPinInput" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]*" placeholder="4자리 숫자" value="${esc(String(ui.pinSettingsDraft || ''))}" data-action="draft-pin-settings" data-field="pin" />
          </label>
          <label class="pinField">
            <span>PIN 확인</span>
            <input type="password" inputmode="numeric" maxlength="4" pattern="[0-9]*" placeholder="다시 입력" value="${esc(String(ui.pinSettingsConfirmDraft || ''))}" data-action="draft-pin-settings" data-field="confirm" />
          </label>
        </div>

        <div class="rowInline" style="margin-top:14px">
          ${H.btn(pinReady ? 'PIN 변경' : 'PIN 설정', 'save-screen-pin', '', 'btn primary')}
          ${H.btn('PIN 삭제', 'clear-screen-pin', pinReady ? '' : ' disabled', 'btn')}
        </div>
      </div>

      <div class="muted" style="margin-top:12px; font-size:12px">삭제 전에는 현재 데이터를 꼭 백업해 두는 편이 안전합니다.</div>
    `
  );
}


function renderScreenPinModal() {
  const pinReady = hasScreenPin();
  const locked = !!ui.pinLocked;
  const setupMode = !pinReady;
  const title = setupMode ? 'PIN 설정' : '잠금 해제';
  const subtitle = setupMode
    ? '숫자 4자리 PIN을 한 번 설정해두면 사이드바 자물쇠 버튼으로 바로 잠글 수 있어요.'
    : '화면이 잠겨 있어요. PIN 4자리를 입력하면 다시 열립니다.';
  const actions = locked ? '' : H.btn('닫기', 'close-screen-pin');

  return H.modal(
    'screenPinModal',
    H.modalHead(title, subtitle, actions),
    `
      <div class="pinModalBody">
        <div class="pinStatus ${locked ? 'locked' : setupMode ? 'setup' : ''}">
          ${locked ? '현재 화면이 잠겨 있습니다.' : setupMode ? '아직 설정된 PIN이 없습니다.' : 'PIN을 입력해 주세요.'}
        </div>

        <label class="pinField">
          <span>${setupMode ? '새 PIN' : 'PIN 입력'}</span>
          <input
            id="screenPinInput"
            class="pinInput"
            type="password"
            inputmode="numeric"
            maxlength="4"
            pattern="[0-9]*"
            placeholder="4자리 숫자"
            value="${esc(String(ui.pinEntryDraft || ''))}"
            data-action="draft-screen-pin"
            data-field="pin"
          />
        </label>

        ${setupMode ? `
          <label class="pinField">
            <span>PIN 확인</span>
            <input
              class="pinInput"
              type="password"
              inputmode="numeric"
              maxlength="4"
              pattern="[0-9]*"
              placeholder="다시 입력"
              value="${esc(String(ui.pinConfirmDraft || ''))}"
              data-action="draft-screen-pin"
              data-field="confirm"
            />
          </label>
        ` : ''}

        <div class="rowInline" style="margin-top:14px; justify-content:flex-end">
          ${H.btn(setupMode ? 'PIN 설정 완료' : '잠금 해제', 'submit-screen-pin', '', 'btn primary')}
        </div>

        <div class="pinHelp muted">
          ${setupMode ? 'PIN 변경이나 삭제는 설정 화면에서도 할 수 있어요.' : '잠금은 사이드바 자물쇠 버튼을 눌렀을 때만 켜집니다.'}
        </div>
      </div>
    `,
    'modal pinModal'
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

function renderSignatureModal() {
  const mode = ui.signatureModalMode || 'create';
  const isAmend = mode === 'amend';
  const activeDraft = isAmend ? draftRecordEdit : draftRecord;
  const action = isAmend ? 'draft-record-edit' : 'draft-record';
  const title = isAmend ? '정정 전자서명' : '전자서명';
  const subtitle = isAmend ? '수정 저장 전에 전자서명과 봉인 사유를 확인해 주세요.' : '저장 전에 전자서명과 봉인 메모를 확인해 주세요.';
  const primaryLabel = isAmend ? '서명 완료 후 수정 저장' : '서명 완료 후 저장';
  const sealReasonLabel = isAmend ? '정정 사유' : '봉인 메모';
  const sealReasonPlaceholder = isAmend ? '예: 기록 시각 정정 / 표현 보완 / 이름 수정' : '예: 최초 사실기록 / 통화 직후 즉시 기록';
  const summary = String(activeDraft.summary || '').trim() || '내용 없음';
  const actorText = String((isAmend ? draftRecordEdit.actorNameOther : draftRecord.actorNameOther) || '').trim() || '미입력';
  const placeText = String(((activeDraft as any).placeText || activeDraft.place || '')).trim() || '미입력';
  const storeText = String(((activeDraft as any).storeTypeText || activeDraft.storeType || '')).trim() || '미입력';
  const currentRaw = isAmend && ui.recordEditId ? S.records.find((x) => x.id === ui.recordEditId) ?? null : null;
  const record = currentRaw ? ensureRecordV8(currentRaw as any) : null;
  const currentHash = record ? String((record as any)?.integrity?.currentHash || '') : '';

  return H.modal(
    'signatureModal',
    H.modalHead(title, subtitle, H.btn('닫기', 'close-signature-modal', '', 'btn ghost')),
    `
      <div class="signatureFlow">
        <div class="signatureHero">
          <div class="signatureHeroTitle">${esc(isAmend ? '수정 내용을 서명하고 새 revision으로 저장합니다.' : '입력한 기록을 서명하고 봉인 저장합니다.')}</div>
          <div class="muted">서명 완료 시 즉시 인증 처리되고, 이후에는 수정 이력이 append-only로 누적됩니다.</div>
        </div>

        <div class="signatureMetaGrid">
          <div class="signatureMetaCard"><span class="signatureMetaK">내용</span><b>${esc(trunc(summary, 72))}</b></div>
          <div class="signatureMetaCard"><span class="signatureMetaK">기록 시각</span><b>${esc(fmt(fromLocalInputValue(String(activeDraft.ts || ''))))}</b></div>
          <div class="signatureMetaCard"><span class="signatureMetaK">주체</span><b>${esc(actorText)}</b></div>
          <div class="signatureMetaCard"><span class="signatureMetaK">장소 / 보관</span><b>${esc(`${placeText} · ${storeText}`)}</b></div>
          ${isAmend ? `<div class="signatureMetaCard span2"><span class="signatureMetaK">현재 해시</span><b>${esc(shortHash(currentHash || ''))}</b></div>` : `<div class="signatureMetaCard span2"><span class="signatureMetaK">저장 방식</span><b>전자서명 완료 후 즉시 봉인 저장</b></div>`}
        </div>

        <div class="signatureFieldGrid">
          <div class="field compact">
            <label>서명 문구</label>
            <input value="${esc(((activeDraft as any).signerLabel || '기기 봉인서명'))}" data-action="${esc(action)}" data-field="signerLabel" placeholder="기기 봉인서명" />
          </div>
          <div class="field compact">
            <label>${esc(sealReasonLabel)}</label>
            <input value="${esc(((activeDraft as any).sealReason || ''))}" data-action="${esc(action)}" data-field="sealReason" placeholder="${esc(sealReasonPlaceholder)}" />
          </div>
        </div>

        <div class="signatureActions">
          ${H.btn('취소', 'close-signature-modal', '', 'btn ghost')}
          ${H.btn(primaryLabel, 'confirm-signature-submit', '', 'btn primary')}
        </div>
      </div>
    `,
    'modal signatureModal'
  );
}

function renderSignSuccessModal() {
  return H.modal(
    'signSuccessModal',
    H.modalHead('서명 완료', '', H.btn('닫기', 'close-sign-success', '', 'btn ghost')),
    `
      <div class="signSuccessWrap">
        <div class="signSuccessIcon" aria-hidden="true">✓</div>
        <div class="signSuccessTitle" id="signSuccessMsg">성공적으로 서명 및 인증이 완료되었습니다!</div>
        <div class="muted signSuccessSub" id="signSuccessSub">저장 처리가 완료되었습니다.</div>
        <div class="rowInline" style="justify-content:center; margin-top:16px">
          ${H.btn('확인', 'close-sign-success', '', 'btn primary')}
        </div>
      </div>
    `,
    'modal signSuccessModal'
  );
}

/* ==================== RECORDS ==================== */

function renderRecordModal() {
  const raw = ui.viewRecordId ? S.records.find((x) => x.id === ui.viewRecordId) ?? null : null;
  const r = raw ? ensureRecordV8(raw) : null;
  const title = r ? trunc(r.summary, 32) : '기록 상세';

  if (!r) {
    return H.modal('recordModal', H.modalHead('기록 보관함', String(title), H.btn('닫기', 'close-record')), H.empty('기록을 찾을 수 없어요.'));
  }

  const integrity = verifyRecordIntegrity(r as any);
  const revisions = getRecordRevisions(r as any).slice().reverse();
  const currentHash = String((r as any)?.integrity?.currentHash || '');
  const originalHash = String((r as any)?.integrity?.originalHash || '');
  const isEditing = ui.recordEditId === r.id;
  const activeTab = ui.recordModalTab || (isEditing ? 'edit' : 'current');
  const related = r.related || [];
  const relatedHtml = related.length ? H.chips(related.map(actorShort)) : `<div class="muted">관련자 없음</div>`;
  const lastSealLabel = getRecordRevisionCount(r as any) > 1 ? '최종 수정봉인' : '기록 봉인';
  const integrityBadge = integrity.valid
    ? `<span class="integrityBadge ok">무결성 확인</span>`
    : `<span class="integrityBadge bad">무결성 경고</span>`;

  const editActorType = String((draftRecordEdit as any).actorTypeText || '당사자');
  const editPlaceText = String((draftRecordEdit as any).placeText || '온라인');
  const editStoreTypeText = String((draftRecordEdit as any).storeTypeText || '전화');
  const editSummaryOverview = String((draftRecordEdit as any).summaryOverview || '').trim();
  const editSummaryBackground = String((draftRecordEdit as any).summaryBackground || '').trim();
  const editSummaryIssues = String((draftRecordEdit as any).summaryIssues || '').trim();
  const editSummaryEvidenceList = String((draftRecordEdit as any).summaryEvidenceList || '').trim();
  const editSummaryTeacherActions = String((draftRecordEdit as any).summaryTeacherActions || '').trim();
  const editSummaryOther = String((draftRecordEdit as any).summaryOther || '').trim();
  const editSummaryCombined = [editSummaryOverview, editSummaryBackground, editSummaryIssues, editSummaryEvidenceList, editSummaryTeacherActions, editSummaryOther].join(' ').trim();
  const editOkSummary = editSummaryCombined.length >= 4;
  const editOkTs = String(draftRecordEdit.ts || '').trim().length >= 10;
  const editActors = Array.isArray((draftRecordEdit as any).actors) ? ((draftRecordEdit as any).actors as ActorRef[]) : [];
  const editPendingActorName = String(draftRecordEdit.actorNameOther || '').trim();
  const editOkActor = editActors.length > 0 || editPendingActorName.length > 0;
  const editCanSave = editOkSummary && editOkTs && editOkActor;
  const editReqMissing: string[] = [];
  if (!editOkSummary) editReqMissing.push('내용');
  if (!editOkTs) editReqMissing.push('기록 시각');
  if (!editOkActor) editReqMissing.push('사람');
  const editReqLabel = editCanSave ? '정정 봉인 가능' : `필수: ${editReqMissing.join(' · ')}`;
  const showEditPlaceOther = editPlaceText === '기타';
  const showEditStoreOther = editStoreTypeText === '기타';
  const editMainNameField = renderNameFieldForType({
    typeText: editActorType,
    value: String(draftRecordEdit.actorNameOther || ''),
    action: 'draft-record-edit',
    field: 'actorNameOther',
    placeholder: '이름(예: 상대 A / 담당자 / 김OO)'
  });
  const editRelNameField = renderNameFieldForType({
    typeText: String(draftRecordEdit.relTypeText || ''),
    value: String(draftRecordEdit.relNameOther || ''),
    action: 'draft-record-edit',
    field: 'relNameOther',
    placeholder: '이름(예: 관계자 / 담당자 / 김OO)'
  });
  const editActorList =
    editActors.length
      ? `<div class="chips mini" style="margin-top:8px">
          ${editActors
            .map(
              (a: ActorRef, idx: number) => `
              <span class="chip">
                ${esc(actorShort(a))}
                <button class="chipX" data-action="remove-record-actor-edit" data-idx="${esc(String(idx))}" type="button" title="삭제" aria-label="주체 삭제">×</button>
              </span>
            `
            )
            .join('')}
        </div>`
      : `<div class="muted" style="margin-top:6px; font-size:12px">사람을 1명 이상 추가해 주세요. 현재 입력줄은 저장 시 자동 포함돼요.</div>`;
  const editRelatedList =
    (draftRecordEdit.related || []).length
      ? `<div class="chips mini" style="margin-top:8px">
          ${(draftRecordEdit.related || [])
            .map(
              (a: ActorRef, idx: number) => `
              <span class="chip">
                ${esc(actorShort(a))}
                <button class="chipX" data-action="remove-related-edit" data-idx="${esc(String(idx))}" type="button" title="삭제" aria-label="관련자 삭제">×</button>
              </span>
            `
            )
            .join('')}
        </div>`
      : `<div class="muted" style="margin-top:6px; font-size:12px">관련자가 없으면 비워도 돼요.</div>`;

  const editPanel = isEditing ? `
    <section class="recordEditPanel">
      <div class="recordSectionHead">
        <div>
          <div class="recordSectionTitle">수정안 작성</div>
          <div class="muted">원본은 유지되고, 새 해시와 변경 로그가 위로 추가돼요.</div>
        </div>
        <span id="recordEditReqPill" class="savePill ${editCanSave ? 'ready' : 'warn'}">${esc(editReqLabel)}</span>
      </div>

      <div id="recordEditSummaryParts" class="summaryPartsGrid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:10px">
        <div class="field">
          <label>상황 한줄 요약 <span class="reqStar">*</span></label>
          <textarea id="recordEditSummaryOverview" class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryOverview">${esc((draftRecordEdit as any).summaryOverview || '')}</textarea>
        </div>
        <div class="field">
          <label>배경 / 흐름</label>
          <textarea class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryBackground">${esc((draftRecordEdit as any).summaryBackground || '')}</textarea>
        </div>
        <div class="field">
          <label>핵심 포인트</label>
          <textarea class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryIssues">${esc((draftRecordEdit as any).summaryIssues || '')}</textarea>
        </div>
        <div class="field">
          <label>관련 자료 목록</label>
          <textarea class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryEvidenceList">${esc((draftRecordEdit as any).summaryEvidenceList || '')}</textarea>
        </div>
        <div class="field">
          <label>내가 한 대응 / 메모</label>
          <textarea class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryTeacherActions">${esc((draftRecordEdit as any).summaryTeacherActions || '')}</textarea>
        </div>
        <div class="field">
          <label>추가 메모</label>
          <textarea class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryOther">${esc((draftRecordEdit as any).summaryOther || '')}</textarea>
        </div>
      </div>
      <div id="recordEditWarnSummary" class="composerInlineWarn" ${editOkSummary ? 'hidden' : ''}>⚠ 최소 한 칸 이상 채워서 내용 4글자 이상이 되게 입력해 주세요.</div>

      <div class="metaInputs">
        <div class="field compact">
          <label>기록 시각 <span class="reqStar">*</span></label>
          <div class="rowInline compactRow">
            <input id="recordEditTs" class="${editOkTs ? '' : 'reqWarn'}" type="datetime-local" value="${esc(draftRecordEdit.ts)}" data-action="draft-record-edit" data-field="ts" />
            <button class="btn ghost small" type="button" data-action="set-record-edit-now">방금</button>
          </div>
          <div id="recordEditWarnTs" class="miniWarn" ${editOkTs ? 'hidden' : ''}>⚠ 시간을 선택해 주세요.</div>
        </div>

        <div class="field compact">
          <label>사람 <span class="reqStar">*</span></label>
          <div id="recordEditActorRow" class="rowInline compactRow ${editOkActor ? '' : 'reqWarn'}">
            <select data-action="draft-record-edit" data-field="actorTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, editActorType)}</select>
            <div class="grow">${editMainNameField}</div>
            ${H.btn('추가', 'add-record-actor-edit', '', 'btn small')}
          </div>
          <div class="mini muted" style="margin-top:6px">복수 인물을 입력할 수 있어요. 저장 시 하나의 기록으로 묶여 관리됩니다.</div>
          ${editActorList}
          <div id="recordEditWarnActor" class="miniWarn" ${editOkActor ? 'hidden' : ''}>⚠ 주체를 1명 이상 추가해 주세요.</div>
        </div>

        <div class="field compact">
          <label>위치 / 채널</label>
          <select data-action="draft-record-edit" data-field="placeText">${renderSelectFromList(PLACE_TYPES as any, editPlaceText)}</select>
          ${showEditPlaceOther ? `<input value="${esc(draftRecordEdit.placeOther)}" placeholder="장소 상세(기타)" data-action="draft-record-edit" data-field="placeOther" />` : ''}
        </div>

        <div class="field compact">
          <label>자료 형태</label>
          <select data-action="draft-record-edit" data-field="storeTypeText">${renderSelectFromList(STORE_TYPES as any, editStoreTypeText)}</select>
          ${showEditStoreOther ? `<input value="${esc(draftRecordEdit.storeOther)}" placeholder="보관형태 상세(기타)" data-action="draft-record-edit" data-field="storeOther" />` : ''}
        </div>
      </div>

      <details id="recordEditRelatedDetails" class="metaMore" ${ui.recEditRelatedOpen ? 'open' : ''}>
        <summary>
          <span>관계 항목 수정</span>
          <span class="metaMoreCount">${esc(String((draftRecordEdit.related || []).length))}명</span>
        </summary>
        <div class="metaMorePanel">
          <div class="field" style="margin-bottom:0">
            <div class="rowInline">
              <select data-action="draft-record-edit" data-field="relTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, String(draftRecordEdit.relTypeText || '상대방'))}</select>
              <div class="grow">${editRelNameField}</div>
              ${H.btn('추가', 'add-related-edit', '', 'btn small')}
            </div>
            ${editRelatedList}
          </div>
        </div>
      </details>

      <div class="muted composerBottomHint" style="margin-top:12px">수정 저장을 누르면 전자서명 모달이 열리고, 서명이 끝나면 새 revision으로 재봉인돼요.</div>

      <div class="rowInline" style="margin-top:14px">
        ${H.btn('정정 취소', 'cancel-record-edit', '', 'btn ghost')}
        <button id="btnSaveRecordAmend" class="btn primary" data-action="save-record-amend" type="button" ${editCanSave ? '' : 'disabled aria-disabled="true"'}>수정 저장</button>
      </div>
    </section>
  ` : `
    <section class="recordEditHint">
      <div class="recordSectionHead">
        <div>
          <div class="recordSectionTitle">수정</div>
          <div class="muted">기록을 덮어쓰지 않고 새 해시와 로그를 추가해 봉인합니다.</div>
        </div>
        ${H.btnData('이 기록 수정', 'start-edit-record', { id: r.id }, 'btn primary')}
      </div>
    </section>
  `;

  const revisionHtml = revisions.length
    ? `<div class="revisionFeed">
        ${revisions.map((rev, idx) => {
          const actionLabel = rev.action === 'amend' ? '정정 봉인' : (rev.action === 'legacy-import' ? '기존데이터 이관' : '초기 봉인');
          return `
            <article class="revisionItem ${idx === 0 ? 'latest' : ''}">
              <div class="revisionHead">
                <div class="revisionHeadLeft">
                  <span class="revisionBadge ${rev.action === 'amend' ? 'amend' : rev.action === 'legacy-import' ? 'legacy' : 'create'}">${esc(actionLabel)}</span>
                  ${idx === 0 ? '<span class="revisionLatest">최신</span>' : ''}
                </div>
                <div class="revisionNo">rev ${esc(String(rev.rev))}</div>
              </div>
              <div class="revisionGrid">
                <div class="revisionMeta"><span>기록 시각</span><b>${esc(fmt(rev.eventAt))}</b></div>
                <div class="revisionMeta"><span>봉인시각</span><b>${esc(fmt(rev.sealedAt))}</b></div>
                <div class="revisionMeta"><span>서명</span><b>${esc(rev.signerLabel || '전자서명')}</b></div>
                <div class="revisionMeta"><span>사유</span><b>${esc(rev.reason || '—')}</b></div>
                <div class="revisionMeta wide"><span>hash</span><code>${esc(shortHash(rev.hash, 14, 10))}</code></div>
                <div class="revisionMeta wide"><span>prevHash</span><code>${esc(shortHash(rev.prevHash || '', 14, 10))}</code></div>
              </div>
              <div class="revisionSummary">${esc(rev.summarySnapshot || '')}</div>
            </article>
          `;
        }).join('')}
      </div>`
    : `<div class="muted">정정 이력이 없어요.</div>`;

  const currentPanel = `
    <section class="recordHero">
      <div class="recordHeroTop">
        <div class="recordHeroTitle">${esc(r.summary || '')}</div>
        <div class="recordHeroBadges">${renderRiskTag((r as any).risk)}${integrityBadge}<span class="integrityCount">rev ${esc(String(getRecordRevisionCount(r as any)))}</span></div>
      </div>
      <div class="recordHeroMeta">
        <div class="recordHeroMetaItem"><span>기록 시각</span><b>${esc(fmt(r.ts))}</b></div>
        <div class="recordHeroMetaItem"><span>${esc(lastSealLabel)}</span><b>${esc(fmt((r as any)?.integrity?.lastSealedAt || r.ts))}</b></div>
        <div class="recordHeroMetaItem"><span>원본 해시</span><code>${esc(shortHash(originalHash, 14, 10))}</code></div>
        <div class="recordHeroMetaItem"><span>현재 해시</span><code>${esc(shortHash(currentHash, 14, 10))}</code></div>
      </div>
      <div class="muted" style="margin-top:8px">${esc(integrity.message || '')}</div>
    </section>

    <section class="recordCurrentSection">
      <div class="detailGrid trustDetailGrid">
        ${H.dr('주체', esc(recordActorText(r)))}
        ${H.dr('위치 / 채널', esc(placeLabel(r.place, r.placeOther)))}
        ${H.dr('자료 형태', esc(storeLabel(r.storeType, r.storeOther)))}
        ${H.dr('수정 횟수', esc(String(Math.max(0, getRecordRevisionCount(r as any) - 1))))}
        ${H.ds('관련자', relatedHtml)}
        ${H.ds('현재 내용', `<div class="detailNote">${esc(r.summary || '')}</div>`)}
        ${H.ds('AI 리스크 신호', renderRiskSummary((r as any).risk))}
      </div>
    </section>
  `;

  const historyPanel = `
    <section class="recordHistorySection">
      <div class="recordSectionHead">
        <div>
          <div class="recordSectionTitle">버전 이력</div>
          <div class="muted">최신 로그가 위에 쌓입니다. 각 revision은 이전 hash를 참조합니다.</div>
        </div>
      </div>
      ${revisionHtml}
    </section>
  `;

  const tabs = renderMiniTabs([
    { label: '현재 기록', action: 'switch-record-modal-tab', dataKey: 'record-modal-tab', dataValue: 'current', active: activeTab === 'current' },
    { label: '버전 이력', action: 'switch-record-modal-tab', dataKey: 'record-modal-tab', dataValue: 'history', active: activeTab === 'history' },
    { label: '수정', action: 'switch-record-modal-tab', dataKey: 'record-modal-tab', dataValue: 'edit', active: activeTab === 'edit' },
  ]);

  const body = `
    <div class="recordModalTabsWrap">
      ${tabs.replace('sectionTabs', 'sectionTabs recordModalTabs')}
    </div>
    ${activeTab === 'history' ? historyPanel : activeTab === 'edit' ? editPanel : currentPanel}
  `;

  const headActions = `
    <div class="rowInline">
      ${H.btn('닫기', 'close-record')}
    </div>
  `;

  return H.modal('recordModal', H.modalHead('기록 보관함 · 상세', String(title), headActions), body);
}


function renderRecordsMain() {
  const total = S.records.length;

  return `
    <div class="recordsPageShell">
 

      ${renderRecordSidebar()}
    </div>
  `;
}

function renderRecordSidebar() {
  const all = (S.records || []).slice().sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  (ui as any).recFilterPlace = '';
  (ui as any).recFilterPlaceDraft = '';

  const actorOpts = uniq(all.map((r) => recordActorText(r))).sort((a, b) => a.localeCompare(b));
  const actorVal = String(((ui as any).recFilterActorDraft ?? (ui as any).recFilterActor) || '');
  const kwVal = String(((ui as any).recFilterKeywordDraft ?? (ui as any).recFilterKeyword) || '');
  const appliedActor = String((ui as any).recFilterActor || '').trim();
  const appliedKw = String((ui as any).recFilterKeyword || '').trim();
  const hasFilters = Boolean(appliedActor || appliedKw);
  const filtered = all.filter((record) => {
    const actorText = recordActorText(record);
    const keywordText = [record.summary, actorText, placeLabel(record.place, record.placeOther), record.ts].join(' ');
    return (!appliedActor || matchLite(actorText, appliedActor)) && (!appliedKw || matchLite(keywordText, appliedKw));
  });

  const mini = (raw: RecordItem) => {
    const r = ensureRecordV8(raw as any) as any;
    const revCount = getRecordRevisionCount(r);
    const amendCount = Math.max(0, revCount - 1);
    const lastSealedAt = String(r?.integrity?.lastSealedAt || r.ts || '');
    const integrity = verifyRecordIntegrity(r);
    const rr = normalizeRisk((r as any).risk);
    const riskLabel = rr?.label ?? 0;
    return `
      <article class="recMini recMiniTrust ${riskToneClass(riskLabel)} ${amendCount ? 'amended' : ''}" style="${riskInlineCardStyle(riskLabel)}">
        ${H.tags([
          renderRiskTag((r as any).risk),
          H.tag(trunc(recordActorText(r), 28)),
          H.tag(placeLabel(r.place, r.placeOther)),
          `<span class="tag lilac">${esc(storeLabel(r.storeType, r.storeOther))}</span>`,
          `<span class="tag ${integrity.valid ? 'greenTag' : 'redTag'}">${esc(integrity.valid ? '무결성OK' : '검증필요')}</span>`,
          amendCount ? `<span class="tag butter">정정 ${esc(String(amendCount))}</span>` : `<span class="tag">원본</span>`,
        ])}
        <div class="recMiniTitle">${esc(trunc(r.summary || '', 92))}</div>
        <div class="recMiniTimes">
          <div class="recMiniMetaLine"><span class="metaK">기록 시각</span><span>${esc(fmt(r.ts))}</span></div>
          <div class="recMiniMetaLine"><span class="metaK">${esc(amendCount ? '최종 수정봉인' : '기록 봉인')}</span><span>${esc(fmt(lastSealedAt))}</span></div>
        </div>
        <div class="recMiniHash">현재 해시 ${esc(shortHash(String(r?.integrity?.currentHash || ''), 10, 8))}</div>
        <div class="actionsRow">
          ${H.btnData('자세히', 'view-record', { id: r.id }, 'btn')}
          ${H.btnData('수정', 'start-edit-record', { id: r.id }, 'btn primary')}
          ${H.btnData('복사', 'copy-record', { id: r.id }, 'btn ghost')}
          ${H.btnData('삭제', 'delete-record', { id: r.id }, 'btn danger ghost')}
        </div>
      </article>
    `;
  };

  const listHtml = filtered.length ? filtered.map(mini).join('') : H.empty(hasFilters ? '필터 결과가 없어요.' : '아직 기록이 없어요.', 140);

  return `
    <div class="sideStack">

      <section class="card sideCard memoFilterCard compactFilterCard">
        <div class="sideCardHead sideCardHeadFilterRow">
          <div>
            <div class="sideCardTitle">기록 필터</div>
            <div class="sideCardMetaText muted">
              ${hasFilters ? `필터 <b>${esc(String(filtered.length))}</b>/${esc(String(all.length))}` : `총 <b>${esc(String(all.length))}</b>개`}
            </div>
          </div>
          <div class="sideCardActions">
            ${H.btn('초기화', 'clear-record-filters', '', 'btn ghost')}
          </div>
        </div>

        <div class="memoFilterBar compactFilterBar" style="margin-top:8px">
          <div class="mfFields twoUp">
            <div class="mfField mfFieldActor">
              <label class="srOnly" for="mfActor">주체</label>
              <input id="mfActor" class="mfInput" placeholder="주체" list="dlFilterActor"
                value="${esc(actorVal)}" data-action="draft-record-filters" data-field="actor" />
            </div>

            <div class="mfField mfFieldKeyword">
              <label class="srOnly" for="mfKw">키워드</label>
              <input id="mfKw" class="mfInput" placeholder="키워드" value="${esc(kwVal)}"
                data-action="draft-record-filters" data-field="keyword" />
            </div>
          </div>

          <div class="mfActions">
            <button class="btn ghost mfBtn mfIconBtn" type="button" data-action="apply-record-filters" title="필터 적용" aria-label="필터 적용">
              <span class="mfIcon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8"/>
                  <path d="M16 16L20 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                </svg>
              </span>
            </button>
          </div>
        </div>

        ${dl('dlFilterActor', actorOpts)}
      </section>

      <section class="card sideCard">
        <div class="sideCardHead">
          <div>
            <div class="sideCardTitle">전체 기록</div>
            <div class="muted" style="font-size:12px; margin-top:2px">기록 시각 · 봉인 시각 · 수정 횟수</div>
          </div>
          <div class="sideCardActions"><span class="countPill">${esc(String(filtered.length))}</span></div>
        </div>
        <div class="recordsListScroll">
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
        H.tag(trunc(recordActorText(r), 28)),
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

  const placeText = String(draftRecord.placeText || '온라인');
  const storeTypeText = String(draftRecord.storeTypeText || '전화');
  const actorList = (Array.isArray((draftRecord as any).actors) ? ((draftRecord as any).actors as ActorRef[]) : []);
  const pendingActorName = String(draftRecord.actorMemberId || '').trim();
  const actorGroupId = String((draftRecord as any).actorGroupId || getRelationshipGroups()[0]?.id || 'group-1');
  const relGroupId = String((draftRecord as any).relGroupId || getRelationshipGroups()[0]?.id || 'group-1');

  const summaryOverview = String((draftRecord as any).summaryOverview || '').trim();
  const summaryBackground = String((draftRecord as any).summaryBackground || '').trim();
  const summaryIssues = String((draftRecord as any).summaryIssues || '').trim();
  const summaryEvidenceList = String((draftRecord as any).summaryEvidenceList || '').trim();
  const summaryTeacherActions = String((draftRecord as any).summaryTeacherActions || '').trim();
  const summaryOther = String((draftRecord as any).summaryOther || '').trim();

  const okSummaryOverview = summaryOverview.length >= 4;
  const okSummaryBackground = summaryBackground.length >= 2;
  const okSummaryIssues = summaryIssues.length >= 2;
  const okSummaryEvidenceList = summaryEvidenceList.length >= 2;
  const okSummaryTeacherActions = summaryTeacherActions.length >= 2;
  const okSummaryOther = summaryOther.length >= 2;
  const okActor = actorList.length > 0 || pendingActorName.length > 0;
  const okTs = String(draftRecord.ts || '').trim().length >= 10;
  const okPlace = placeText.trim().length > 0 && (!showPlaceOther || String(draftRecord.placeOther || '').trim().length > 0);
  const okStore = storeTypeText.trim().length > 0 && (!showStoreOther || String(draftRecord.storeOther || '').trim().length > 0);

  const reqMissing: string[] = [];
  if (!okSummaryOverview) reqMissing.push('핵심 사실');
  if (!okSummaryBackground) reqMissing.push('이전 흐름·배경');
  if (!okSummaryTeacherActions) reqMissing.push('내가 한 대응');
  if (!okSummaryIssues) reqMissing.push('핵심 포인트');
  if (!okSummaryEvidenceList) reqMissing.push('관련 자료');
  if (!okSummaryOther) reqMissing.push('기타 메모');
  if (!okTs) reqMissing.push('기록 시각');
  if (!okActor) reqMissing.push('사람');
  if (!okPlace) reqMissing.push('위치/채널');
  if (!okStore) reqMissing.push('자료 형태');

  const canSave = reqMissing.length === 0;
  const reqLabel = canSave ? '저장 준비 완료' : `필수 ${reqMissing.length}개 남음`;

  const actorListHtml =
    actorList.length
      ? `<div class="chips mini composerActorChips gatherActorChips">
          ${actorList
            .map(
              (a: ActorRef, idx: number) => `
              <span class="chip">
                ${esc(actorShort(a))}
                <button class="chipX" data-action="remove-record-actor" data-idx="${esc(String(idx))}" type="button" title="삭제" aria-label="주체 삭제">×</button>
              </span>
            `
            )
            .join('')}
        </div>`
      : `<div class="muted composerEmptyHint gatherMutedHint">관련된 사람을 1명 이상 추가해 주세요.</div>`;

  const relatedList =
    (draftRecord.related || []).length
      ? `<div class="chips mini composerActorChips gatherActorChips">
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
      : `<div class="muted composerEmptyHint gatherMutedHint">추가로 엮인 사람이 있으면 함께 남겨주세요.</div>`;

  const missingSummary = reqMissing.length
    ? `남은 항목 ${esc(reqMissing.slice(0, 4).join(' · '))}${reqMissing.length > 4 ? ` 외 ${esc(String(reqMissing.length - 4))}개` : ''}`
    : '이제 바로 저장할 수 있어요.';

  return `
    <div class="entryForm v2 entryFormGather">
      <div class="recordFormSimple">
        <div class="recordFormStatusBar">
          <div>
            <div class="recordFormTitle">기록 추가</div>
            <div class="recordFormSub">필수 항목을 순서대로 입력해 주세요.</div>
          </div>
          <div class="recordFormTopActions">
            <span id="recordReqPill" class="recordFormStatusText ${canSave ? 'ready' : 'warn'}">${esc(reqLabel)}</span>
            <button class="btn ghost clearDraftBtn recordFormGhostBtn" data-action="clear-record-draft" type="button">비우기</button>
          </div>
        </div>

        <section class="recordFormCard">
          <div class="recordFormCardHead">
            <div class="recordFormCardTitle">핵심 사실</div>
            <div class="recordFormCardDesc">무슨 일이 있었는지 먼저 적어주세요.</div>
          </div>

          <div class="field">
            <label>무슨 일이 있었나요? <span class="reqStar">*</span></label>
            <textarea id="recordSummaryOverview" class="entryTa composerTa simpleComposerTextarea ${okSummaryOverview ? '' : 'reqWarn'}" rows="4"
              placeholder="무슨 일이 있었는지 핵심만 적어주세요"
              data-action="draft-record" data-field="summaryOverview">${esc((draftRecord as any).summaryOverview || '')}</textarea>
          </div>
          <div id="recordWarnSummary" class="composerInlineWarn simpleWarn" ${okSummaryOverview ? 'hidden' : ''}>핵심 사실은 4글자 이상 작성해 주세요.</div>
        </section>

        <section class="recordFormCard recordFormSecondaryCard">
          <div class="recordFormCardHead">
            <div class="recordFormCardTitle">추가 내용</div>
            <div class="recordFormCardDesc">배경, 대응, 쟁점, 자료, 메모를 모두 남겨주세요.</div>
          </div>

          <div class="recordFormGrid">
            <div class="field">
              <label>이전 흐름 · 배경 <span class="reqStar">*</span></label>
              <textarea class="entryTa composerTa ${okSummaryBackground ? '' : 'reqWarn'}" rows="3" placeholder="이전 흐름이나 배경" data-action="draft-record" data-field="summaryBackground">${esc((draftRecord as any).summaryBackground || '')}</textarea>
            </div>
            <div class="field">
              <label>내가 한 대응 / 메모 <span class="reqStar">*</span></label>
              <textarea class="entryTa composerTa ${okSummaryTeacherActions ? '' : 'reqWarn'}" rows="3" placeholder="즉시 한 안내나 조치" data-action="draft-record" data-field="summaryTeacherActions">${esc((draftRecord as any).summaryTeacherActions || '')}</textarea>
            </div>
            <div class="field">
              <label>핵심 포인트 <span class="reqStar">*</span></label>
              <textarea class="entryTa composerTa ${okSummaryIssues ? '' : 'reqWarn'}" rows="3" placeholder="핵심 쟁점이나 요청" data-action="draft-record" data-field="summaryIssues">${esc((draftRecord as any).summaryIssues || '')}</textarea>
            </div>
            <div class="field">
              <label>관련 자료 목록 <span class="reqStar">*</span></label>
              <textarea class="entryTa composerTa ${okSummaryEvidenceList ? '' : 'reqWarn'}" rows="3" placeholder="사진, 문자, 통화기록 등" data-action="draft-record" data-field="summaryEvidenceList">${esc((draftRecord as any).summaryEvidenceList || '')}</textarea>
            </div>
          </div>

          <div class="field" style="margin-bottom:0">
            <label>추가 메모 <span class="reqStar">*</span></label>
            <textarea class="entryTa composerTa ${okSummaryOther ? '' : 'reqWarn'}" rows="3" placeholder="추후 확인할 점이나 남겨둘 메모" data-action="draft-record" data-field="summaryOther">${esc((draftRecord as any).summaryOther || '')}</textarea>
          </div>
        </section>

        <section class="recordFormCard recordMetaFoldCard recordFormPrimaryMeta">
          <div class="recordFormCardHead">
            <div class="recordFormCardTitle">기본 정보</div>
            <div class="recordFormCardDesc">기록 시각, 사람, 위치, 자료 형태를 입력해 주세요.</div>
          </div>

          <div class="recordFormGrid">
            <div class="field compact recordFormFieldCard">
              <label>기록 시각 <span class="reqStar">*</span></label>
              <div class="rowInline compactRow gatherInlineRow">
                <input id="recordTs" class="${okTs ? '' : 'reqWarn'}" type="datetime-local" value="${esc(draftRecord.ts)}" data-action="draft-record" data-field="ts" />
                <button class="btn ghost small gatherNowBtn" type="button" data-action="set-record-now" title="지금 시간으로">방금</button>
              </div>
              <div id="recordWarnTs" class="miniWarn simpleWarn" ${okTs ? 'hidden' : ''}>기록 시각을 선택해 주세요.</div>
            </div>

            <div class="field compact recordFormFieldCard">
              <label>위치 / 채널 <span class="reqStar">*</span></label>
              <select class="${okPlace ? '' : 'reqWarn'}" data-action="draft-record" data-field="placeText">${renderSelectFromList(PLACE_TYPES as any, placeText)}</select>
              ${showPlaceOther ? `<input class="${okPlace ? '' : 'reqWarn'}" value="${esc(draftRecord.placeOther)}" placeholder="장소 상세(기타)" data-action="draft-record" data-field="placeOther" />` : ''}
            </div>

            <div class="field compact recordFormFieldCard">
              <label>자료 형태 <span class="reqStar">*</span></label>
              <select class="${okStore ? '' : 'reqWarn'}" data-action="draft-record" data-field="storeTypeText">${renderSelectFromList(STORE_TYPES as any, storeTypeText)}</select>
              ${showStoreOther ? `<input class="${okStore ? '' : 'reqWarn'}" value="${esc(draftRecord.storeOther)}" placeholder="보관형태 상세(기타)" data-action="draft-record" data-field="storeOther" />` : ''}
            </div>

            <div class="field compact recordFormFieldCard recordFormActorCard">
              <label>사람 <span class="reqStar">*</span></label>
              <div id="recordActorRow" class="rowInline compactRow gatherActorRow ${okActor ? '' : 'reqWarn'}">
                <div class="grow">${renderRelationshipGroupPicker('draft-record', 'actorGroupId', actorGroupId, '대분류 그룹')}</div>
                <div class="grow">${renderRelationshipMemberPicker('draft-record', 'actorMemberId', actorGroupId, String((draftRecord as any).actorMemberId || ''), '소분류 인물')}</div>
                ${H.btn('추가', 'add-record-actor', '', 'btn small')}
              </div>
              ${actorListHtml}
              <div id="recordWarnActor" class="miniWarn simpleWarn" ${okActor ? 'hidden' : ''}>사람을 1명 이상 추가해 주세요.</div>
            </div>
          </div>
        </section>
      </section>

        ${dl('dlNameStudent', STUDENT_NAMES as any)}
        ${dl('dlNameClassRoster', getClassRoster() as any)}
        ${dl('dlNameParent', PARENT_NAMES as any)}
        ${dl('dlNameAdmin', ADMIN_NAMES as any)}

        <details id="recordRelatedDetails" class="metaMore recordRelatedDetails" ${ui.recRelatedOpen ? 'open' : ''}>
          <summary>
            <span>관련자 추가</span>
            <span class="metaMoreCount">${esc(String((draftRecord.related || []).length))}명</span>
          </summary>
          <div class="metaMorePanel recordRelatedPanel">
            <div class="field" style="margin-bottom:0">
              <div class="rowInline gatherRelatedRow">
                <div class="grow">${renderRelationshipGroupPicker('draft-record', 'relGroupId', relGroupId, '대분류 그룹')}</div>
                <div class="grow">${renderRelationshipMemberPicker('draft-record', 'relMemberId', relGroupId, String((draftRecord as any).relMemberId || ''), '소분류 인물')}</div>
                ${H.btn('추가', 'add-related', '', 'btn small')}
              </div>
              ${relatedList}
            </div>
          </div>
        </details>

        <div class="recordFormFooter">
          <div class="recordFormFooterText">${missingSummary}</div>
          <button id="btnSaveRecord" class="btn primary saveCta recordFormSaveBtn" data-action="save-record" type="button"
            ${canSave ? '' : 'disabled aria-disabled="true" title="모든 필수 항목을 작성하면 저장할 수 있어요"'}>
            기록 저장
          </button>
          <button id="btnSaveRecordBottom" class="srOnly" data-action="save-record" type="button" ${canSave ? '' : 'disabled aria-disabled="true"'}>기록 저장</button>
        </div>
      </div>
    </div>
  `;
}


function renderRecordComposerModal() {
  const headActions = `
    <div class="rowInline">
      ${H.btn('닫기', 'close-record-composer')}
    </div>
  `;

  const body = `
    <div class="recordComposerModalBody">
      ${renderRecordEntryForm()}
    </div>
  `;

  return H.modal('recordComposerModal', H.modalHead('빠른 캡처', '필수 입력을 순서대로 작성한 뒤 저장하세요.', headActions), body, 'modal recordComposerModal');
}



function renderStudentRosterModal() {
  if (!ui.classRosterOpen) return '';

  const groups = Array.isArray(ui.classRosterDraft) && ui.classRosterDraft.length
    ? ui.classRosterDraft
    : getRelationshipGroups();
  const filled = groups.reduce((acc, group) => (
    acc + (Array.isArray(group.members) ? group.members.filter((member) => String(member?.name || '').trim()).length : 0)
  ), 0);
  const canAddGroup = groups.length < 12;
  const selectedGroupId = String(
    groups.some((group) => String(group.id || '') === String((ui as any).classRosterGroupId || ''))
      ? (ui as any).classRosterGroupId
      : groups[0]?.id || 'group-1'
  );
  const selectedGroupIndex = Math.max(0, groups.findIndex((group) => String(group.id || '') === selectedGroupId));
  const selectedGroup = groups[selectedGroupIndex] || groups[0];
  const headActions = `
    <div class="rowInline">
      ${H.btn('닫기', 'close-class-roster', '', 'btn ghost')}
      ${H.btn('저장', 'save-class-roster', '', 'btn primary')}
    </div>
  `;
  const folderRows = groups.map((group, groupIndex) => {
    const memberCount = Array.isArray(group.members)
      ? group.members.filter((member) => String(member?.name || '').trim()).length
      : 0;
    const active = String(group.id || '') === selectedGroupId;
    return `
      <button
        class="relationshipFolderItem ${active ? 'active' : ''}"
        type="button"
        data-action="select-relationship-group"
        data-group-id="${esc(String(group.id || ''))}"
      >
        <span class="relationshipFolderGlyph" aria-hidden="true">▸</span>
        <span class="relationshipFolderText">
          <span class="relationshipFolderTitle">${esc(String(group.title || `그룹${groupIndex + 1}`))}</span>
          <span class="relationshipFolderMeta">${esc(String(memberCount))}명</span>
        </span>
      </button>
    `;
  }).join('');
  const members = Array.isArray(selectedGroup?.members) ? selectedGroup.members : [];
  const memberRows = members.length
    ? members.map((member, memberIndex) => `
        <div class="classRosterRow relationshipMemberRow">
          <div class="classRosterNo">${esc(String(memberIndex + 1))}</div>
          <input
            class="classRosterInput"
            value="${esc(String(member.name || ''))}"
            placeholder="이름 입력"
            data-action="draft-relationship-member-name"
            data-group-index="${esc(String(selectedGroupIndex))}"
            data-member-index="${esc(String(memberIndex))}"
          />
          <button
            class="btn ghost small relationshipRemoveBtn"
            type="button"
            data-action="remove-relationship-member"
            data-group-index="${esc(String(selectedGroupIndex))}"
            data-member-index="${esc(String(memberIndex))}"
          >
            삭제
          </button>
        </div>
      `).join('')
    : `<div class="muted relationshipEmptyHint">아직 등록된 인물이 없어요. 오른쪽 상단의 + 버튼으로 이 그룹에 사람을 추가해보세요.</div>`;

  return `
    <div class="classRosterLayer" id="classRosterModal" role="presentation">
      <section class="classRosterPanel" role="dialog" aria-modal="true" aria-labelledby="classRosterModalTitle">
        ${H.modalHead('관계 관리', '그룹을 만들고 그 안에 인물을 등록해두면 빠른 캡처에서 그룹 > 인물 순서로 바로 선택할 수 있어요.', headActions).replace('<div class="h2">', '<div class="h2" id="classRosterModalTitle">')}
        <div class="classRosterModalBody">
          <div class="classRosterHero">
            <div>
              <div class="classRosterTitle">그룹을 폴더처럼 관리하고, 오른쪽에서 사람을 입력하세요.</div>
              <div class="muted">기존에 저장돼 있던 사람 목록은 자동으로 첫 번째 그룹에 연결됩니다. 그룹 이름을 바꾸면 빠른 캡처의 대분류 이름도 같이 바뀌고, 새 그룹도 계속 추가할 수 있어요.</div>
            </div>
            <div class="classRosterCount"><span id="classRosterFilledCount">${esc(String(filled))}</span>명</div>
          </div>
          <div class="relationshipManagerShell">
            <aside class="relationshipSidebar" aria-label="관계 그룹 폴더">
              <div class="relationshipSidebarHead">
                <div class="relationshipSidebarLabel">폴더</div>
                <button class="btn small relationshipSidebarAddBtn" type="button" data-action="add-relationship-group" ${canAddGroup ? '' : 'disabled aria-disabled="true"'}>+ 폴더 추가</button>
              </div>
              <div class="relationshipFolderList">
                ${folderRows}
              </div>
              <div class="relationshipSidebarHint">최대 12개까지 만들 수 있어요.</div>
            </aside>
            <section class="relationshipEditorCard" aria-label="선택한 그룹 사람 목록">
              <div class="relationshipEditorHead">
                <div>
                  <div class="relationshipEditorLabel">선택된 폴더</div>
                  <input
                    class="classRosterInput relationshipGroupTitleInput"
                    value="${esc(String(selectedGroup?.title || ''))}"
                    placeholder="그룹 이름"
                    data-action="draft-relationship-group-title"
                    data-group-index="${esc(String(selectedGroupIndex))}"
                  />
                </div>
                <button class="btn small relationshipAddBtn" type="button" data-action="add-relationship-member" data-group-index="${esc(String(selectedGroupIndex))}">+ 인원 추가</button>
              </div>
              <div class="relationshipEditorMeta">이 폴더 안 인물 ${esc(String(members.filter((member) => String(member?.name || '').trim()).length))}명</div>
              <div class="classRosterGrid relationshipMemberGrid" role="table" aria-label="선택한 그룹 사람 목록">
                ${memberRows}
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  `;
}

/* ==================== CASES ==================== */


function renderCasesShell(selected: CaseItem | null, gridClass: string, gridInner: string) {
  const active = ui.caseTab === 'list' ? 'list' : ui.caseTab === 'proof' ? 'proof' : 'create';
  const isList = active === 'list';

  const panel = active === 'create'
    ? `
      <div class="caseCommandPanel caseCommandPanelCreate">
        <div class="subTabHint muted">컬렉션 만들기는 이 화면 안에서 바로 이어집니다.</div>
        <div class="caseCommandPanelScroll">
          ${renderCaseCreateContent()}
        </div>
      </div>
    `
    : active === 'proof'
      ? `
        <div class="caseCommandPanel caseCommandPanelProof">
          <div class="caseCommandPanelScroll">
            ${renderCaseContentProofPanel()}
          </div>
        </div>
      `
      : `
        <div class="caseCommandMeta muted">컬렉션 목록과 타임라인은 보기 탭에서 확인할 수 있어요.</div>
      `;

  return `
    <section class="caseShell caseShellWorkspace ${isList ? 'caseShellList' : 'caseShellSolo'}">
      <div class="card caseCommandDeck">

        ${renderMiniTabs([
          { label: '컬렉션 만들기', action: 'switch-case-tab', dataKey: 'case-tab', dataValue: 'create', active: active === 'create' },
          { label: '컬렉션 보기', action: 'switch-case-tab', dataKey: 'case-tab', dataValue: 'list', active: active === 'list' },
          { label: '공유/제출 문서', action: 'switch-case-tab', dataKey: 'case-tab', dataValue: 'proof', active: active === 'proof' },
        ])}

        ${panel}
      </div>

      ${isList ? `<section class="${gridClass} caseBodyGrid">${gridInner}</section>` : ''}
    </section>
  `;
}

function renderCasesMain(selected: CaseItem | null) {
  const ids = visibleCases();
  const listHtml = `<div class="list">${ids.map((id) => renderCaseCard(S.cases[id])).join('')}</div>`;
  const isFocused = !!selected;

  const header = `
    <div class="sectionTitle caseMainTitle">
      <div>
        <div class="h2">컬렉션</div>
        <div class="muted">${isFocused ? '열어둔 컬렉션의 타임라인을 보고 있어요. 목록으로를 누르면 컬렉션 목록으로 돌아갑니다.' : '컬렉션 목록에서 열기를 누르면 이 자리에서 타임라인이 열립니다.'}</div>
      </div>
      <div class="titleActions">
        <span class="countPill">총 ${ids.length}개</span>
      </div>
    </div>
  `;

  if (!ids.length) {
    return `${header}
      <div class="empty">아직 컬렉션이 없어요. 위의 컬렉션 만들기에서 먼저 시작해보세요.</div>
    `;
  }

  if (selected) {
    return `${header}
      <div class="caseWorkspace caseWorkspaceSingle">
        <section class="caseWorkspacePane caseWorkspaceTimelinePane caseWorkspaceFocusPane">
          <div class="caseTimelineScroll">${renderCaseTimeline(selected)}</div>
        </section>
      </div>
    `;
  }

  return `${header}
    <div class="caseWorkspace caseWorkspaceSingle">
      <section class="caseWorkspacePane caseWorkspaceListPane">
        <div class="caseWorkspacePaneHead">
          <div class="title">컬렉션 목록</div>
          <div class="muted">열기를 누르면 이 자리에서 타임라인이 열려요.</div>
        </div>
        <div class="caseListScroll">${listHtml}</div>
      </section>
    </div>
  `;
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
            <div class="sideCardTitle">실행 로그</div>
            <div class="muted" style="margin-top:2px">이 컬렉션에서 남긴 내 메모와 조치</div>
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
                  <label>이름</label>
                  <input value="${esc(draftStep.name)}" placeholder="예: 1차 정리" data-action="draft-step" data-field="name" />
                </div>
              </div>

              <div class="field compact" style="margin-bottom:0">
                <label>내용</label>
                <textarea rows="3" class="actionTa" placeholder="짧게 기록 (Ctrl/⌘+Enter 추가)" data-action="draft-step" data-field="note">${esc(draftStep.note)}</textarea>
              </div>

              <div class="actionActions">
                ${H.btn('추가', 'add-step', '', 'btn primary small')}
                ${H.btn('AI 권장 행동 갱신', 'regen-advisors', '', 'btn small')}
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

function renderCaseCreateContent() {
  const mainActorOptions = getRecordArchiveMainActors().map((actor) => ({
    value: serializeActorChoice(actor),
    label: actorShort(actor),
  }));
  const relatedActorOptions = getRecordArchiveRelatedActors().map((actor) => ({
    value: serializeActorChoice(actor),
    label: actorShort(actor),
  }));

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
      : `<div class="muted" style="margin-top:6px">대상이 아직 없어요. 최소 1명은 추가해 주세요.</div>`;

  const canStart = (draftCase.actors || []).length > 0;
  const startExtra = canStart ? '' : ' disabled aria-disabled="true" title="관련자를 1명 이상 추가해야 시작할 수 있어요"';

  return `
    <div class="caseCreateFlow">
      <div class="helperBox" style="margin-bottom:14px; margin-top:0;">
        <b>사용법:</b> 기록 보관함에 저장된 주체와 관련자 중 필요한 사람을 고르면 AI가 관련 기록을 우선적으로 모아 컬렉션을 구성해줍니다.
      </div>

      <div class="field highlight-section">
        <label style="font-size:13px;">① 기록 보관함에서 중심 인물을 고르세요 (필수)</label>
        <div class="miniOptionRow">
          <label class="miniToggle" title="체크하면 선택한 인물 중심의 기록만 우선 모아요.">
            <input type="checkbox" data-action="draft-case" data-field="onlyMainActor" ${((draftCase as any).onlyMainActor ? 'checked' : '')} />
            <span>선택한 사람 중심 기록만 우선 모으기</span>
          </label>
        </div>
        <div class="fieldSubLabel">주체 목록</div>
        <div class="rowInline">
          <select data-action="draft-case" data-field="mainActorKey">${renderSelectWithPlaceholder(mainActorOptions, String((draftCase as any).mainActorKey || ''), mainActorOptions.length ? '기록 보관함 주체 선택' : '기록 보관함 주체 없음')}</select>
          ${H.btn('추가', 'add-case-main-actor')}
        </div>
        <div class="fieldSubLabel" style="margin-top:10px">관련자 목록</div>
        <div class="rowInline">
          <select data-action="draft-case" data-field="relatedActorKey">${renderSelectWithPlaceholder(relatedActorOptions, String((draftCase as any).relatedActorKey || ''), relatedActorOptions.length ? '기록 보관함 관련자 선택' : '기록 보관함 관련자 없음')}</select>
          ${H.btn('추가', 'add-case-related-actor')}
        </div>
        ${chips}
      </div>

      <div class="field" style="margin-top:16px;">
        <label>② 이 컬렉션의 상황/주제를 적어주세요</label>
        <textarea rows="3" placeholder="예: 메신저 대화 정리, 계약 변경 요청, 반복 연락 이슈 등" data-action="draft-case" data-field="query">${esc(draftCase.query)}</textarea>
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
            <label>컬렉션 제목 (비워두면 자동 생성)</label>
            <input value="${esc(draftCase.title)}" placeholder="예: 반복 연락 정리 / 프로젝트 이슈 모음" data-action="draft-case" data-field="title" />
          </div>
        </div>
      </details>

      <div class="rowInline caseCreateActions" style="margin-top:16px; padding-top:10px; border-top:1px solid var(--grey-200);">
        ${H.btn('컬렉션 만들기 시작', 'create-case', startExtra, 'btn primary')}
        ${H.btn('초기화', 'clear-case-draft')}
      </div>
    </div>
  `;
}

function renderCaseCreateModal() {
  return H.modal(
    'caseCreateModal',
    H.modalHead('컬렉션 만들기', 'AI가 관련 기록을 자동 선별해 첫 컬렉션을 제안합니다.', H.btn('닫기', 'close-case-create')),
    renderCaseCreateContent(),
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

  if (fActor) items = items.filter(item => matchLite(recordActorText(item.record), fActor));
  if (fPlace) items = items.filter(item => String(item.record.place || '') === fPlace);
  if (fKw) items = items.filter(item => matchLite([item.record.summary, recordActorText(item.record), placeLabel(item.record.place, item.record.placeOther), item.record.ts].join(' '), fKw));

  const filteredTotal = items.length;

  // 5. 정렬: 점수 높은순 -> 최신 날짜순
  items.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.01) return b.score - a.score; // 점수 내림차순
    return String(b.record.ts || '').localeCompare(String(a.record.ts || '')); // 최신순
  });

  const title = c ? trunc(c.title, 40) : '컬렉션에 기록 추가';

  // 필터 바 (입력값=draft, 적용값=applied)
  const updPlaceSel = String(((ui as any).updFilterPlaceDraft ?? (ui as any).updFilterPlace) || '');
  const updPlaceOptions =
    `<option value="" ${!updPlaceSel ? 'selected' : ''}>전체</option>` +
    (PLACE_TYPES as any as string[]).map((p) => `<option value="${esc(String(p))}" ${String(p) === updPlaceSel ? 'selected' : ''}>${esc(String(p))}</option>`).join('');

  const updActorVal = String(((ui as any).updFilterActorDraft ?? (ui as any).updFilterActor) || '');
  const updKwVal = String(((ui as any).updFilterKeywordDraft ?? (ui as any).updFilterKeyword) || '');

  const updActorOpts = uniq(S.records.filter(r => !existingIds.has(r.id)).map((r) => recordActorText(r))).sort((a, b) => a.localeCompare(b));
  const updFilterBar = `
    <section class="card sideCard memoFilterCard compactFilterCard" style="margin-top:0; padding:10px 12px">
      <div class="memoFilterBar compactFilterBar">
        <div class="mfFields">
          <div class="mfField mfFieldActor">
            <label class="srOnly" for="updActor">주체</label>
            <input id="updActor" class="mfInput" placeholder="주체" list="dlUpdateActor"
              value="${esc(updActorVal)}" data-action="draft-update-filters" data-field="actor" />
          </div>

          <div class="mfField mfFieldPlace">
            <label class="srOnly" for="updPlace">장소</label>
            <select id="updPlace" class="mfSelect" data-action="draft-update-filters" data-field="place">${updPlaceOptions}</select>
          </div>

          <div class="mfField mfFieldKeyword">
            <label class="srOnly" for="updKw">키워드</label>
            <input id="updKw" class="mfInput" placeholder="키워드" value="${esc(updKwVal)}"
              data-action="draft-update-filters" data-field="keyword" />
          </div>
        </div>

        <div class="mfActions">
          <span class="mfStat muted">
            ${hasAppliedFilters ? `필터 <b>${esc(String(filteredTotal))}</b>/${esc(String(baseTotal))}` : `총 <b>${esc(String(baseTotal))}</b>개`}
          </span>

          <button class="btn ghost mfBtn" type="button" data-action="apply-update-filters" title="Enter로도 적용할 수 있어요">적용</button>
          <button class="btn ghost mfBtn" type="button" data-action="clear-update-filters">초기화</button>
        </div>
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
          tags.push(renderRiskTag((record as any).risk));
          tags.push(H.tag(trunc(recordActorText(record), 28)));
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
    : H.empty('추가할 수 있는 기록이 없어요.');

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
      H.modalHead('타임라인 상세', '컬렉션을 먼저 열어주세요.', H.btn('닫기', 'close-timeline-detail')),
      H.empty('표시할 데이터가 없어요.')
    );
  }

  // NOTE: 상세 모달은 "점수 근거"에 집중. (묶음 맥락/이웃 이벤트는 표시하지 않음)
  let title = '타임라인 상세';
  let body = H.empty('데이터를 찾을 수 없어요.');

  if (tl.kind === 'record') {
    const r = S.records.find((x) => x.id === tl.id) ?? null;
    if (r) {
      const meta = getRecordIntegrityMeta(r);
      const vr = meta.vr as any;
      title = trunc(vr.summary, 40);

      const caseActors = (c.actors || []).slice();
      const scoreMap = (c.scoreByRecordId || {}) as Record<string, number>;

      // === Rust 엔진 스냅샷(구성요소) 우선 ===
      // 케이스 생성/업데이트 시 Rust가 계산한 RankedComponents를 case.componentsByRecordId에 저장해두고,
      // 상세 모달에서는 그 값을 "그대로" 표시합니다. (구버전 케이스는 없을 수 있어요)
      const caseActorKeys = caseActors.filter((a) => String(a?.name || '').trim()).map(actorKey);

      const compMap = ((c as any).componentsByRecordId || {}) as Record<string, any>;
      const comp = compMap[vr.id] as any | undefined;

      const caseQuery = (c.query || '').trim();
      const qTokens = caseQuery ? tokenizeEngineLike(caseQuery) : [];
      const summaryNorm = normEngineLike(String(vr.summary || ''));

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

      const mainActorKey = actorKey(vr.actor);
      const mainActorMatch = comp && typeof comp.actorMatch === 'boolean' ? comp.actorMatch : caseActorKeys.includes(mainActorKey);

      const W_ACTOR = comp && typeof comp.wActor === 'number' ? comp.wActor : 2.5;
      const actorScore = comp && typeof comp.actorScore === 'number' ? comp.actorScore : (mainActorMatch ? W_ACTOR : 0);

      const relatedMatches = (Array.isArray(vr.related) ? vr.related : []).filter((ra: ActorRef) => caseActorKeys.includes(actorKey(ra)));
      const W_RELATED = comp && typeof comp.wRelated === 'number' ? comp.wRelated : 1.0;

      const relatedHitCount = comp && typeof comp.relatedHits === 'number' ? comp.relatedHits : relatedMatches.length;
      const relatedScore = comp && typeof comp.relatedScore === 'number' ? comp.relatedScore : (relatedHitCount * W_RELATED);

      const engineScore = keywordScore + actorScore + relatedScore;

      // 저장된 점수(스냅샷)가 있으면 그걸 우선 표시하고,
      // 혹시 현재 엔진 재계산과 다르면 둘 다 보여줌
      const storedScore = scoreMap[vr.id];
      const scoreToShow = typeof storedScore === 'number' ? storedScore : engineScore;

      const within = isWithinRangeISO(vr.ts, (c as any).timeFrom || undefined, (c as any).timeTo || undefined);
      const hasRange = !!((c as any).timeFrom || (c as any).timeTo);
      const inSnapshot = Array.isArray((c as any).recordIds) && (c as any).recordIds.includes(vr.id);

      // 포함 판정(엔진 기준: Rust가 보내준 threshold 사용)
      const MIN_TEXT_SIM = comp && typeof comp.minTextSim === 'number' ? comp.minTextSim : 0.34;
      const MIN_SCORE = comp && typeof comp.minScore === 'number' ? comp.minScore : 0.8;
      const includeLogic = mainActorMatch || relatedHitCount > 0 || (qTokens.length ? textSim >= MIN_TEXT_SIM : true);
      const includeByRule = (!hasRange || within) && includeLogic && engineScore >= MIN_SCORE;

      // 디버그: 실제 매칭된 actor들(표시용)
      const matchedActorsPretty = uniq(
        recordActors(vr)
          .filter((ra) => caseActors.some((ca) => actorEqLite(ra, ca)))
          .map(actorShort)
      );

      const revisionTrailHtml = meta.revisions
        .slice()
        .reverse()
        .map((rev: any) => {
          const badge = rev?.action === 'amend' ? '정정' : (rev?.action === 'legacy-import' ? '이관' : '원본');
          const reason = String(rev?.reason || '').trim() || (rev?.action === 'amend' ? '정정 봉인' : '초기 봉인');
          return `
            <div class="detailRow">
              <div class="k">REV ${esc(String(rev?.rev || ''))}</div>
              <div class="v">
                <div>${esc(badge)} · ${esc(fmt(String(rev?.sealedAt || '')))}</div>
                <div class="muted" style="margin-top:4px">${esc(reason)} · ${esc(shortHash(String(rev?.hash || ''), 10, 8))}</div>
              </div>
            </div>
          `;
        })
        .join('');

      body = `
        <div class="detailGrid">
          ${H.dr('기록 시각', esc(fmt(vr.ts)))}
          ${H.dr('주체', esc(recordActorText(vr)))}
          ${H.dr('위치 / 채널', esc(placeLabel(vr.place, vr.placeOther)))}
          ${H.ds('내용', `<div class="detailNote">${esc(vr.summary || '')}</div>`)}

          ${H.ds(
            '봉인 / 수정 이력',
            `
              <div class="detailRow"><div class="k">최초 입력봉인</div><div class="v">${esc(meta.originalSealedAt ? fmt(meta.originalSealedAt) : '—')}</div></div>
              <div class="detailRow"><div class="k">최종 수정봉인</div><div class="v">${esc(meta.lastSealedAt ? fmt(meta.lastSealedAt) : '—')}</div></div>
              <div class="detailRow"><div class="k">수정이력</div><div class="v">${esc(meta.amendCount ? `정정 ${meta.amendCount}회 / REV ${meta.revisionCount}` : `원본 / REV ${meta.revisionCount}`)}</div></div>
              <div class="detailRow"><div class="k">현재 해시</div><div class="v">${esc(shortHash(meta.currentHash, 10, 8))}</div></div>
              <div class="detailRow"><div class="k">무결성</div><div class="v">${esc(meta.integrity.valid ? '무결성 확인' : '검증 필요')}</div></div>
              ${revisionTrailHtml ? `<div class="detailSection" style="margin-top:12px"><div class="k">Revision 로그</div>${revisionTrailHtml}</div>` : ''}
            `
          )}

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
            '왜 이 권장 행동이 떴나',
            `<div class="muted" style="margin-top:6px">AI 권장 행동은 컬렉션 설정(관련 인물/설명/기간/패턴) 기반으로 생성돼요.</div>
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
          ${H.ds('내 실행 로그 메모', `<div class="detailNote">${esc(s.note)}</div>`)}
          ${H.ds('왜 포함됐나', `<div class="muted">내 실행 로그는 이 컬렉션 안에서 직접 저장된 항목이라 타임라인에 항상 포함돼요.</div>`)}
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
    <article class="item caseCollectionCard ${isSelected ? 'selected' : ''}">
      <div class="caseCollectionCardTop">
        ${H.tags([
          `<span class="tag ai">${esc('AI')}</span>`,
          H.tag(hasRange ? '기간 지정' : '상시'),
        ])}
        <span class="countPill">기록 ${esc(String(mapped))}개</span>
      </div>
      <div class="title">${esc((c as any).title)}</div>
      ${((c as any).query || '').trim()
        ? `<div class="muted caseCollectionSummary">요약: ${esc(qHint || '-')}</div>`
        : `<div class="muted caseCollectionSummary">요약 설명이 아직 없어요.</div>`}
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
  const filtered = HIDE_CASE_ACTIONS_AND_GUIDES ? events.filter((ev: any) => ev?.kind === 'record') : events;
  const recordCount = events.filter((ev: any) => ev?.kind === 'record').length;
  const advisorCount = events.filter((ev: any) => ev?.kind === 'advisor').length;
  const stepCount = events.filter((ev: any) => ev?.kind === 'step').length;
  const allEventTimes = events.map((ev: any) => eventTs(ev)).filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)));
  const latestEventTs = allEventTimes[0] || '';
  const earliestEventTs = allEventTimes[allEventTimes.length - 1] || '';
  const periodText = hasRange
    ? `${esc((c as any).timeFrom ? fmt((c as any).timeFrom) : '—')} ~ ${esc((c as any).timeTo ? fmt((c as any).timeTo) : '—')}`
    : earliestEventTs && latestEventTs
      ? `${esc(fmt(earliestEventTs))} ~ ${esc(fmt(latestEventTs))}`
      : '기간 정보 없음';
  const summaryText = String((c as any).query || '').trim();

  const ctx = {
    actors: ((c as any).actors || []) as ActorRef[],
    queryTokens: tokenizeLite(String((c as any).query || '')),
    timeFrom: String((c as any).timeFrom || ''),
    timeTo: String((c as any).timeTo || ''),
  };

  return `
    <div class="caseTimelineShell">
      <section class="caseTimelineHero">
        <div class="caseTimelineHeroMain">
          <div class="caseTimelineHeroTop">
            ${H.tags([
              `<span class="tag ai">${esc('AI 선별')}</span>`,
              H.tag(hasRange ? '기간 지정' : '자동 범위'),
              H.tag(`기록 ${recordCount}개`),
            ])}
          </div>
          <div class="caseTimelineHeroTitle">${esc((c as any).title)}</div>
          <div class="caseTimelineHeroDesc">${summaryText ? esc(summaryText) : '설명은 아직 비어 있지만, 연결된 기록 흐름은 이 화면에서 바로 점검할 수 있어요.'}</div>
          <div class="caseTimelineHeroMeta">
            <span class="caseTimelineMetaItem">기간 ${periodText}</span>
            ${latestEventTs ? `<span class="caseTimelineMetaItem">최근 기록 ${esc(fmt(latestEventTs))}</span>` : ''}
          </div>
        </div>

        <div class="caseTimelineHeroSide">
          <div class="caseTimelineStatRail">
            <article class="caseTimelineStatCard">
              <span>타임라인</span>
              <strong>${esc(String(filtered.length))}</strong>
              <small>현재 화면에 표시되는 항목</small>
            </article>
            <article class="caseTimelineStatCard">
              <span>전체 기록</span>
              <strong>${esc(String(mappedCount))}</strong>
              <small>컬렉션에 연결된 기록 수</small>
            </article>
            <article class="caseTimelineStatCard">
              <span>보조 항목</span>
              <strong>${esc(String(advisorCount + stepCount))}</strong>
              <small>가이드와 조치 로그 포함</small>
            </article>
          </div>
          <div class="caseTimelineActionRow">
            ${H.btn('기록추가', 'open-case-update')}
            ${H.btnData('공유 문서', 'switch-case-tab', { 'case-tab': 'proof' }, 'btn')}
            ${H.btn('목록으로', 'clear-case')}
          </div>
        </div>
      </section>

      <section class="caseTimelineTrack">
        ${filtered.length ? renderTimelineWithDays(filtered, ctx) : `<div class="empty">표시할 항목이 없어요.</div>`}
      </section>
    </div>
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

function renderTimelineWithDays(events: any[], ctx?: any) {
  let lastDay = '';
  const parts: string[] = [];
  for (const ev of events || []) {
    const ts = eventTs(ev);
    const dayKey = ts ? String(ts).slice(0, 10) : '';
    if (dayKey && dayKey !== lastDay) {
      parts.push(`<div class="tDay"><span class="tDayPill">${esc(fmtDay(ts))}</span></div>`);
      lastDay = dayKey;
    }
    parts.push(renderTimelineEvent(ev, ctx));
  }
  return `<div class="timelineWrap"><div class="timeline timelineEm">${parts.join('')}</div></div>`;
}

function renderTimelineEvent(ev: any, ctx?: any) {
  if (ev.kind === 'record') {
    const r = ev.record as RecordItem;
    const score = ev.score as number | undefined;
    return `
      <div class="tItem">
        <div class="dot" aria-hidden="true"></div>
        <div class="tCard">
          ${H.tags([
            typeof score === 'number' ? `<span class="tag butter">AI점수 ${esc(score.toFixed(2))}</span>` : '',
            H.tag(trunc(recordActorText(r), 28)),
            H.tag(placeLabel(r.place, r.placeOther)),
          ])}
          ${(() => {
            const reasons: string[] = [];
            try {
              const actors = (ctx?.actors || []) as ActorRef[];
              if (actors.length && recordMainActors(r).some((ra) => actors.some((a) => actorEqLite(a, ra)))) reasons.push('주체일치');
              const tf = String(ctx?.timeFrom || '').trim();
              const tt = String(ctx?.timeTo || '').trim();
              if ((tf || tt) && isWithinRangeISO(String(r.ts || ''), tf || undefined, tt || undefined)) reasons.push('기간내');
              const qTokens = (ctx?.queryTokens || []) as string[];
              if (qTokens.length) {
                const sum = String(r.summary || '').toLowerCase();
                const picks = qTokens.filter((t) => t && sum.includes(String(t).toLowerCase())).slice(0, 2);
                for (const t of picks) reasons.push(`키워드:${t}`);
              }
            } catch {}
            return H.chipsMini(reasons);
          })()}
          <div class="title">${esc(r.summary)}</div>
          ${renderTimelineRecordMeta(r)}
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
