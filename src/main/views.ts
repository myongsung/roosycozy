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
  CLASS_ROSTER_SIZE, getClassRoster, hasScreenPin
} from './state';
import { renderCasePaperModal } from './paper';

const feedImageUrl = new URL('./feed.png', import.meta.url).href;
const lawyerProfileImageUrl = new URL('./lawyer-profile.png', import.meta.url).href;
const ENABLE_BACKUP_RESTORE = true; // backup/restore (JSON copy/paste) UI disabled
const HIDE_CASE_ACTIONS_AND_GUIDES = true; // 사건조회하기에서 내조치로그/대응가이드 임시 비노출


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
  const labelText = label === 2 ? '위험' : label === 1 ? '경고' : '평범';
  const probs = Array.isArray(risk.probs) ? risk.probs : [0, 0, 0];
  const confidence = Number.isFinite(+risk.confidence) ? Math.max(0, Math.min(1, +risk.confidence)) : Math.max(...probs.map((x: any) => Number(x) || 0));
  const reasons = Array.isArray(risk.reasons) ? risk.reasons.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 4) : [];
  return { label, labelText, confidence, reasons };
}

function renderRiskTag(risk: any) {
  const rr = normalizeRisk(risk);
  if (!rr) return '';
  return `<span class="tag ${riskToneClass(rr.label)}" style="${riskInlineTagStyle(rr.label)}">민원 ${esc(rr.labelText)}</span>`;
}

function renderRiskSummary(risk: any) {
  const rr = normalizeRisk(risk);
  if (!rr) return `<div class="muted">아직 분석되지 않았어요.</div>`;
  const confidencePct = Math.round(rr.confidence * 100);
  const reasonTags = rr.reasons.length
    ? `<div class="tags mini" style="margin-top:8px">${rr.reasons.map((x) => `<span class="tag aiReason">${esc(String(x))}</span>`).join('')}</div>`
    : '';
  return `
    <div class="riskBlock">
      <div class="riskHead">
        <span class="tag ${riskToneClass(rr.label)}" style="${riskInlineTagStyle(rr.label)}">민원 ${esc(rr.labelText)}</span>
        <span class="muted">신뢰도 ${esc(String(confidencePct))}%</span>
      </div>
      ${reasonTags}
    </div>
  `;
}


const dl = (id: string, values: string[]) =>
  `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;

function renderMiniTabs(items: { label: string; action: string; dataKey: string; dataValue: string; active: boolean }[]) {
  return `
    <div class="sectionTabs" role="tablist">
      ${items
        .map(
          (item) => `
            <button
              class="sectionTab ${item.active ? 'active' : ''}"
              type="button"
              role="tab"
              aria-selected="${item.active ? 'true' : 'false'}"
              data-action="${esc(item.action)}"
              data-${esc(item.dataKey)}="${esc(item.dataValue)}"
            >
              ${esc(item.label)}
            </button>
          `
        )
        .join('')}
    </div>
  `;
}


function renderAppSidebar(currentTab: string) {
  const isHome = currentTab === 'home';
  return `
    <aside class="serviceSidebar" aria-label="서비스 메뉴">
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
        </button>

        <button class="sidebarIconBtn accent" data-action="open-record-composer" type="button" aria-label="증거 기록하기">
          <span class="sidebarIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 5V19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <path d="M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </span>
        </button>

        <button class="sidebarIconBtn ${ui.classRosterOpen ? 'active' : ''}" data-action="open-class-roster" type="button" aria-label="학생 명부 등록" title="학생 명부 등록">
          <span class="sidebarIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 12.25C14.3472 12.25 16.25 10.3472 16.25 8C16.25 5.65279 14.3472 3.75 12 3.75C9.65279 3.75 7.75 5.65279 7.75 8C7.75 10.3472 9.65279 12.25 12 12.25Z" stroke="currentColor" stroke-width="1.8"/>
              <path d="M5 19.25C5.88949 16.5609 8.66368 14.75 12 14.75C15.3363 14.75 18.1105 16.5609 19 19.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </span>
        </button>

        <button class="sidebarIconBtn ${ui.pinLocked ? 'active lockActive' : ''}" data-action="open-screen-lock" type="button" aria-label="화면 잠금" title="${ui.pinLocked ? '잠금 중' : '화면 잠금'}">
          <span class="sidebarIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8.25 10V7.75C8.25 5.67893 9.92893 4 12 4C14.0711 4 15.75 5.67893 15.75 7.75V10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <rect x="5.75" y="10" width="12.5" height="10" rx="2.25" stroke="currentColor" stroke-width="1.8"/>
              <path d="M12 14.25V15.75" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </span>
          <span class="sidebarPinDot ${ui.pinLocked ? 'isLocked' : hasScreenPin() ? 'isReady' : 'isEmpty'}" aria-hidden="true"></span>
        </button>
      </div>

      <div class="serviceSidebarBottom">
        <button class="sidebarIconBtn sidebarSettingsBtn ${ui.settingsOpen ? 'active' : ''}" data-action="open-settings" type="button" aria-label="설정" title="설정">
          <span class="sidebarIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 8.75C10.2051 8.75 8.75 10.2051 8.75 12C8.75 13.7949 10.2051 15.25 12 15.25C13.7949 15.25 15.25 13.7949 15.25 12C15.25 10.2051 13.7949 8.75 12 8.75Z" stroke="currentColor" stroke-width="1.8"/>
              <path d="M19.2499 13.1875V10.8125L17.5231 10.2418C17.3597 9.72838 17.1524 9.23572 16.9043 8.76765L17.7141 7.13575L16.0357 5.45737L14.4038 6.26718C13.9358 6.01911 13.4431 5.81181 12.9297 5.64844L12.359 3.92163H9.984L9.41327 5.64844C8.89986 5.81181 8.4072 6.01911 7.93913 6.26718L6.30724 5.45737L4.62885 7.13575L5.43866 8.76765C5.19059 9.23572 4.9833 9.72838 4.81992 10.2418L3.09311 10.8125V13.1875L4.81992 13.7582C4.9833 14.2716 5.19059 14.7643 5.43866 15.2323L4.62885 16.8642L6.30724 18.5426L7.93913 17.7328C8.4072 17.9809 8.89986 18.1882 9.41327 18.3516L9.984 20.0784H12.359L12.9297 18.3516C13.4431 18.1882 13.9358 17.9809 14.4038 17.7328L16.0357 18.5426L17.7141 16.8642L16.9043 15.2323C17.1524 14.7643 17.3597 14.2716 17.5231 13.7582L19.2499 13.1875Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
            </svg>
          </span>
        </button>
      </div>
    </aside>
  `;
}

function renderUpdateNotesModal() {
  return H.modal(
    'updateNotesModal',
    H.modalHead('업데이트 노트', '이번 버전에서 바로 확인할 수 있는 핵심 변화만 짧게 정리했어요.', H.btn('닫기', 'close-updates-note')),
    `
      <div class="updatesNoteModalBody">
        <article class="updatesNoteItem">
          <div class="updatesNoteIndex">1</div>
          <div>
            <div class="updatesNoteTitle">증거기록의 세분화</div>
            <div class="updatesNoteDesc">증거 입력을 사안개요·사안경위·쟁점·증거 목록·교사 조치·기타로 나눠서 더 빠르게 정리할 수 있어요.</div>
          </div>
        </article>

        <article class="updatesNoteItem">
          <div class="updatesNoteIndex">2</div>
          <div>
            <div class="updatesNoteTitle">내용증명 생성 기능</div>
            <div class="updatesNoteDesc">사건을 선택하고 발신인·수신인 정보를 입력하면 증거 요약과 검증 정보가 포함된 내용증명 PDF를 만들 수 있어요.</div>
          </div>
        </article>

        <article class="updatesNoteItem">
          <div class="updatesNoteIndex">3</div>
          <div>
            <div class="updatesNoteTitle">원스톱 법률자문 변호사 소개</div>
            <div class="updatesNoteDesc">학교 현장 분쟁 대응용 법률자문 탭에서 전서현 변호사 프로필과 자문 연결용 안내를 바로 볼 수 있어요.</div>
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
            <div class="updatesNoteTitle">학생명렬표 추가 기능</div>
            <div class="updatesNoteDesc">최대 40명까지 학생 명부를 저장하고, 여러 이름을 한 번에 붙여넣어 빠르게 등록할 수 있어요.</div>
          </div>
        </article>
      </div>
    `,
    'modal updatesNoteModal'
  );
}

function renderHomeMain() {
  return `
    <section class="homeSectionStack" aria-label="홈">
      <button class="updatesHeroCard" data-action="open-updates-note" type="button" aria-label="업데이트 노트 열기">
        <div class="updatesHeroCopy">
          <div class="updatesHeroEyebrow">업데이트 노트</div>
          <div class="updatesHeroTitle">최근 추가된 기능을 한 번에 확인하세요</div>
          <div class="updatesHeroMeta">증거기록 세분화 · 내용증명 · 법률자문 · 잠금 · 학생명렬표</div>
        </div>
        <span class="updatesHeroArrow" aria-hidden="true">열기</span>
      </button>

      <section class="homeFeedWrap" aria-label="홈 피드">
        <article class="homeFeedCard homeFeedCardCompact">
          <div class="homeFeedHead">
            <div class="homeFeedUser">
              <div class="homeAvatar">R</div>
              <div>
                <div class="homeFeedName">Roosycozy</div>
                <div class="homeFeedMeta">오늘의 홈 피드</div>
              </div>
            </div>
            <button class="homeGhostBtn" data-action="open-updates-note" type="button" aria-label="업데이트 노트 보기">노트</button>
          </div>

          <div class="homePhotoFrame homePhotoFrameCompact">
            <img class="homeFeedImage homeFeedImageCompact" src="${feedImageUrl}" alt="메인 피드 이미지" />
          </div>

          <div class="homeFeedBody homeFeedBodyCompact">
            <div class="homeFeedStat">좋아요 1</div>
            <div class="homeFeedCaption"><b>roosycozy</b> 봄이왔으면.</div>
            <div class="homeFeedSub">선생님들을 위한 지능형 악성민원방어 시스템 Roosycozy.</div>
          </div>
        </article>
      </section>
    </section>
  `;
}


function getLegalHubTab() {
  return (ui as any).legalTab === 'advisor' ? 'advisor' : 'contentProof';
}

function renderLegalHubTabs(activeTab: 'contentProof' | 'advisor') {
  return renderMiniTabs([
    { label: '내용증명', action: 'switch-legal-tab', dataKey: 'legal-tab', dataValue: 'contentProof', active: activeTab === 'contentProof' },
    { label: '원스톱 법률자문', action: 'switch-legal-tab', dataKey: 'legal-tab', dataValue: 'advisor', active: activeTab === 'advisor' },
  ]);
}

function renderLegalContentProofPanel() {
  return `
    <article class="legalHubPanel legalHubPanelProof" style="display:grid; gap:18px;">
      <div>
        <div class="h2">내용증명 생성</div>
        <div class="muted" style="margin-top:8px">사건을 선택한 뒤 발신인·수신인 이름과 주소를 분리 입력하고, 증거 목록·수정이력·무결성 검증 요약이 포함된 내용증명 PDF를 만들 수 있어요.</div>
      </div>

      <div class="grid2" style="gap:12px;">
        <div class="card" style="padding:16px;">
          <div class="sectionLabel">포함 내용</div>
          <div class="muted" style="margin-top:8px">사안 제목, 증빙자료 목록, 교사의 조치 로그, SHA-256 해시, 리비전(REV) 이력, 기기서명 검증 요약을 한 문서로 정리합니다.</div>
        </div>
        <div class="card" style="padding:16px;">
          <div class="sectionLabel">문구 톤</div>
          <div class="muted" style="margin-top:8px">수사기관·법원 제출을 염두에 둔 형식으로 정리하되, 최종 증거능력과 증명력 판단은 권한기관의 심리에 따른다는 안내를 함께 넣습니다.</div>
        </div>
      </div>

      <div>
        <div class="sectionLabel" style="margin-bottom:10px">사건 선택</div>
        ${renderPaperPickContent()}
      </div>
    </article>
  `;
}

function renderLegalAdvisorPanel() {
  return `
    <article class="legalHubPanel legalAdvisorPanel legalAdvisorPanelCompact" aria-label="원스톱 법률자문">
      <section class="legalAdvisorTop">
        <div class="legalAdvisorIdentity">
          <div class="legalAdvisorPhotoCol">
            <div class="legalAdvisorPhotoFrame legalAdvisorPhotoFrameCompact">
              <img class="legalAdvisorPhoto" src="${lawyerProfileImageUrl}" alt="전서현 변호사 프로필" />
            </div>
          </div>

          <div class="legalAdvisorCopyCol legalAdvisorCopyColCompact">
            <div class="legalAdvisorKicker">원스톱 법률자문</div>
            <div class="legalAdvisorHeadingRow">
              <h2 class="legalAdvisorTitle">전서현 변호사</h2>
              <span class="legalAdvisorMiniBadge">학교폭력 · 형사 · 인권</span>
            </div>
            <div class="legalAdvisorLaunchRow" aria-label="오픈 안내">
              <span class="legalAdvisorOpenBadge">🌸 4월초 오픈예정</span>
              <span class="legalAdvisorOpenHint">원스톱 법률자문 연결 기능을 곧 이용하실 수 있어요.</span>
            </div>
            <div class="legalAdvisorRole">학교 현장 분쟁 대응 자문</div>
          </div>
        </div>

      </section>

      <div class="legalAdvisorGrid legalAdvisorGridCompact legalAdvisorGridBalanced">
        <section class="legalAdvisorCard legalAdvisorCardDense">
          <div class="legalAdvisorCardLabel">주요 자격 · 위원</div>
          <ul class="legalAdvisorList legalAdvisorListDense">
            <li>現 대한변호사협회 인증 학교폭력전문변호사</li>
            <li>現 대한변호사협회 인증 형사전문변호사</li>
            <li>現 교육청 학교폭력대책심의위원회 위원</li>
            <li>現 경기중앙지방변호사회 청소년범죄·학교폭력 대책 위원회</li>
            <li>現 국가인권위원회 전문상담위원</li>
          </ul>
        </section>

        <section class="legalAdvisorCard legalAdvisorCardDense">
          <div class="legalAdvisorCardLabel">학력</div>
          <ul class="legalAdvisorList legalAdvisorListDense">
            <li>한양대학교 정책학 학사</li>
            <li>서울시립대학교 법학전문대학원 전문석사</li>
          </ul>
        </section>

        <section class="legalAdvisorCard legalAdvisorCardDense legalAdvisorCareerCard">
          <div class="legalAdvisorCardLabel">경력</div>
          <ul class="legalAdvisorTimeline legalAdvisorTimelineDense">
            <li><span class="legalAdvisorTimelineTitle">로어스 법률사무소 대표변호사</span></li>
            <li><span class="legalAdvisorTimelineTitle">법무법인 테헤란 형사팀 소속변호사</span></li>
            <li><span class="legalAdvisorTimelineTitle">법무법인 동주 소속변호사</span></li>
          </ul>
        </section>
      </div>
    </article>
  `;
}

function renderLegalConsultMain() {
  const activeTab = getLegalHubTab();
  return `
    <section class="legalHub legalPartnerHub legalHubCompact" aria-label="법률 도구">
      <article class="card legalHubShell" style="padding:18px; display:grid; gap:14px;">
        ${activeTab === 'advisor' ? renderLegalAdvisorPanel() : renderLegalContentProofPanel()}
      </article>
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
      <div class="recMiniMetaLine"><span class="metaK">사건시각</span><span>${esc(fmt(meta.vr.ts || ''))}</span></div>
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
  return `${String((a as any)?.type || '').trim()}::${String((a as any)?.name || '').trim()}`;
}


/* ==================== PUBLIC ==================== */

export function render() {
  if (ui.caseCreateOpen) {
    S.tab = 'cases';
    ui.caseTab = 'create';
    ui.caseCreateOpen = false;
  }
  if (ui.paperPickOpen) {
    S.tab = 'legal';
    (ui as any).legalTab = 'contentProof';
    ui.paperPickOpen = false;
  }

  const currentTab = normalizePrimaryTab(queuedPrimaryTab || String((S as any).tab || 'home')) || 'home';
  (S as any).tab = currentTab;
  queuedPrimaryTab = '';
  const selected = getSelectedCase();
  const activeCaseTab = ui.caseTab === 'list' ? 'list' : 'create';
  const isHome = currentTab === 'home';
  const isEvidence = currentTab === 'records';
  const isLegal = currentTab === 'legal';
  const legalHubTab = getLegalHubTab();
  const isCasesListView = currentTab === 'cases' && activeCaseTab === 'list';
  const showCaseSide = isCasesListView && !!selected && !HIDE_CASE_ACTIONS_AND_GUIDES;

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
        : renderCasesShell(selected, gridClass, isCasesListView ? gridInner : '');

  $app.innerHTML = `
    <div class="container mobileRefined iphonePremium fluidDesktopShell ${ui.pinLocked ? 'appIsLocked' : ''}">
      <div class="appFrame">
        ${renderAppSidebar(currentTab)}

        <div class="serviceMain">
          <header class="topbar">
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
                  <span class="topNavLabel">증거관리</span>
                </button>
                <button class="topNavBtn ${currentTab === 'cases' ? 'active' : ''}" data-action="tab" data-tab="cases" data-route-tab="cases" type="button" ${currentTab === 'cases' ? 'aria-current="page"' : ''}>
                  <span class="topNavIcon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M3.75 8C3.75 6.75736 4.75736 5.75 6 5.75H9.2C9.8066 5.75 10.3884 5.99553 10.8125 6.43089L11.6875 7.31911C12.1116 7.75447 12.6934 8 13.3 8H18C19.2426 8 20.25 9.00736 20.25 10.25V17C20.25 18.2426 19.2426 19.25 18 19.25H6C4.75736 19.25 3.75 18.2426 3.75 17V8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M3.75 10H20.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                    </svg>
                  </span>
                  <span class="topNavLabel">사건</span>
                </button>
                <button class="topNavBtn topNavBtnLegal ${currentTab === 'legal' && legalHubTab === 'contentProof' ? 'active' : ''}" data-action="switch-legal-tab" data-legal-tab="contentProof" data-route-tab="legal" type="button" ${currentTab === 'legal' && legalHubTab === 'contentProof' ? 'aria-current="page"' : ''}>
                  <span class="topNavIcon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M6.5 4.75H14.5L18.75 9V18C18.75 18.9665 17.9665 19.75 17 19.75H6.5C5.5335 19.75 4.75 18.9665 4.75 18V6.5C4.75 5.5335 5.5335 4.75 6.5 4.75Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M14 4.75V9.25H18.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M8.25 12H15.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                      <path d="M8.25 15.5H13.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                    </svg>
                  </span>
                  <span class="topNavLabel">내용증명</span>
                </button>
                <button class="topNavBtn topNavBtnLegal ${currentTab === 'legal' && legalHubTab === 'advisor' ? 'active' : ''}" data-action="switch-legal-tab" data-legal-tab="advisor" data-route-tab="legal" type="button" ${currentTab === 'legal' && legalHubTab === 'advisor' ? 'aria-current="page"' : ''}>
                  <span class="topNavIcon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 5.25L18.75 8.75L12 12.25L5.25 8.75L12 5.25Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M7.75 11.5V14.25C7.75 15.7688 9.65279 17 12 17C14.3472 17 16.25 15.7688 16.25 14.25V11.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                      <path d="M18.75 8.75V14.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                      <path d="M18.75 14.5C19.4404 14.5 20 15.0596 20 15.75C20 16.4404 19.4404 17 18.75 17C18.0596 17 17.5 16.4404 17.5 15.75C17.5 15.0596 18.0596 14.5 18.75 14.5Z" fill="currentColor"/>
                    </svg>
                  </span>
                  <span class="topNavLabel">원스톱 법률자문</span>
                </button>
              </nav>
            </div>
          </header>

          <div class="serviceContent">
            ${contentHtml}
          </div>
        </div>

        ${ENABLE_BACKUP_RESTORE ? renderRestoreModal() : ''}
        ${renderScreenPinModal()}
        ${renderSettingsModal()}
        ${renderUpdateNotesModal()}
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
    if (settingsDlg && !settingsDlg.open) settingsDlg.showModal();
  }
  installToastPortal();
  portalToast();
}

/* ==================== COMMON MODALS ==================== */


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
        <input class="searchInput paperPickSearch" placeholder="사건 제목/요약 검색" value="${esc(q)}" data-action="search-paper-cases" />
      </div>
      <div class="paperPickList" role="list">
        ${filtered.length ? filtered.map(({ c, recCount, lastTs }) => `
          <button class="paperPickItem" data-action="pick-paper-case" data-id="${esc((c as any).id)}" type="button" role="listitem">
            <div class="paperPickMain">
              <div class="paperPickTitle">
                ${esc(String((c as any).title || '제목 없는 사건'))}
                ${S.selectedCaseId === (c as any).id ? `<span class="tag butter" style="margin-left:8px;">현재 열림</span>` : ''}
              </div>
              <div class="paperPickMeta">
                ${esc(trunc(String((c as any).query || ''), 70) || '—')}
              </div>
            </div>
            <div class="paperPickSide">
              <div class="paperPickStat">${esc(String((c as any).status || ''))}</div>
              <div class="paperPickStat muted">${esc(String(recCount))}개 증거</div>
              <div class="paperPickStat muted">${lastTs ? esc(fmt(lastTs)) : '—'}</div>
            </div>
          </button>
        `).join('') : H.empty('검색 결과가 없어요.', 120)}
      </div>

      <div class="muted" style="margin-top:10px; font-size:12px">
        선택 즉시 내용증명 미리보기로 넘어가요.
      </div>
    `
    : `
      <div class="empty" style="height:160px">
        아직 사건이 없어요. 먼저 사건을 기록한 뒤 출력할 수 있어요.
      </div>
      <div class="rowInline" style="justify-content:flex-end; margin-top:10px">
        ${H.btnData('증거모으기로 이동', 'switch-case-tab', { 'case-tab': 'create' }, 'btn primary')}
      </div>
    `;
}

function renderPaperPickModal() {
  const actions = `
    <div class="rowInline">
      ${H.btn('증거모으기', 'paper-open-case-create', '', 'btn')}
      ${H.btn('닫기', 'close-paper-picker')}
    </div>
  `;

  const head = H.modalHead('내용증명 생성', '어떤 사건으로 내용증명서를 만들까요?', actions);
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
    H.modalHead('설정', '백업, 복구, 삭제와 화면 잠금 PIN을 여기에서 관리합니다.', H.btn('닫기', 'close-settings')),
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
          <div class="muted">모든 증거와 사건 데이터를 삭제합니다.</div>
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

      <div class="muted" style="margin-top:12px; font-size:12px">복구와 삭제는 되돌리기 전에 현재 데이터를 꼭 백업해 두는 편이 안전합니다.</div>
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
  const sealReasonPlaceholder = isAmend ? '예: 사건시각 정정 / 표현 보완 / 주체 오기 수정' : '예: 최초 사실기록 / 통화 직후 즉시 기록';
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
          <div class="signatureHeroTitle">${esc(isAmend ? '수정 내용을 서명하고 새 revision으로 저장합니다.' : '입력한 증거를 서명하고 봉인 저장합니다.')}</div>
          <div class="muted">서명 완료 시 즉시 인증 처리되고, 이후에는 수정 이력이 append-only로 누적됩니다.</div>
        </div>

        <div class="signatureMetaGrid">
          <div class="signatureMetaCard"><span class="signatureMetaK">내용</span><b>${esc(trunc(summary, 72))}</b></div>
          <div class="signatureMetaCard"><span class="signatureMetaK">사건시각</span><b>${esc(fmt(fromLocalInputValue(String(activeDraft.ts || ''))))}</b></div>
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
  const title = r ? trunc(r.summary, 32) : '증거 상세';

  if (!r) {
    return H.modal('recordModal', H.modalHead('증거관리', String(title), H.btn('닫기', 'close-record')), H.empty('증거를 찾을 수 없어요.'));
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

  const editActorType = String((draftRecordEdit as any).actorTypeText || '학생');
  const editPlaceText = String((draftRecordEdit as any).placeText || '교실');
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
  if (!editOkTs) editReqMissing.push('사건시각');
  if (!editOkActor) editReqMissing.push('주체');
  const editReqLabel = editCanSave ? '정정 봉인 가능' : `필수: ${editReqMissing.join(' · ')}`;
  const showEditPlaceOther = editPlaceText === '기타';
  const showEditStoreOther = editStoreTypeText === '기타';
  const editMainNameField = renderNameFieldForType({
    typeText: editActorType,
    value: String(draftRecordEdit.actorNameOther || ''),
    action: 'draft-record-edit',
    field: 'actorNameOther',
    placeholder: '이름(예: 학생1 / 1번 모 / 교장 / 김OO)'
  });
  const editRelNameField = renderNameFieldForType({
    typeText: String(draftRecordEdit.relTypeText || ''),
    value: String(draftRecordEdit.relNameOther || ''),
    action: 'draft-record-edit',
    field: 'relNameOther',
    placeholder: '이름(예: 1번 부 / 교감 / 김OO)'
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
      : `<div class="muted" style="margin-top:6px; font-size:12px">주체를 1명 이상 추가해 주세요. 현재 입력줄은 저장 시 자동 포함돼요.</div>`;
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
          <div class="recordSectionTitle">정정 작성</div>
          <div class="muted">원본은 지워지지 않고, 새 해시와 정정 로그가 위로 추가돼요.</div>
        </div>
        <span id="recordEditReqPill" class="savePill ${editCanSave ? 'ready' : 'warn'}">${esc(editReqLabel)}</span>
      </div>

      <div id="recordEditSummaryParts" class="summaryPartsGrid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:10px">
        <div class="field">
          <label>사안개요 <span class="reqStar">*</span></label>
          <textarea id="recordEditSummaryOverview" class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryOverview">${esc((draftRecordEdit as any).summaryOverview || '')}</textarea>
        </div>
        <div class="field">
          <label>사안경위</label>
          <textarea class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryBackground">${esc((draftRecordEdit as any).summaryBackground || '')}</textarea>
        </div>
        <div class="field">
          <label>쟁점별정리</label>
          <textarea class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryIssues">${esc((draftRecordEdit as any).summaryIssues || '')}</textarea>
        </div>
        <div class="field">
          <label>증거 목록</label>
          <textarea class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryEvidenceList">${esc((draftRecordEdit as any).summaryEvidenceList || '')}</textarea>
        </div>
        <div class="field">
          <label>교사의 조치 기록</label>
          <textarea class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryTeacherActions">${esc((draftRecordEdit as any).summaryTeacherActions || '')}</textarea>
        </div>
        <div class="field">
          <label>기타 내용</label>
          <textarea class="entryTa composerTa" rows="3" data-action="draft-record-edit" data-field="summaryOther">${esc((draftRecordEdit as any).summaryOther || '')}</textarea>
        </div>
      </div>
      <div id="recordEditWarnSummary" class="composerInlineWarn" ${editOkSummary ? 'hidden' : ''}>⚠ 최소 한 칸 이상 채워서 내용 4글자 이상이 되게 입력해 주세요.</div>

      <div class="metaInputs">
        <div class="field compact">
          <label>사건시각 <span class="reqStar">*</span></label>
          <div class="rowInline compactRow">
            <input id="recordEditTs" class="${editOkTs ? '' : 'reqWarn'}" type="datetime-local" value="${esc(draftRecordEdit.ts)}" data-action="draft-record-edit" data-field="ts" />
            <button class="btn ghost small" type="button" data-action="set-record-edit-now">방금</button>
          </div>
          <div id="recordEditWarnTs" class="miniWarn" ${editOkTs ? 'hidden' : ''}>⚠ 시간을 선택해 주세요.</div>
        </div>

        <div class="field compact">
          <label>주체 <span class="reqStar">*</span></label>
          <div id="recordEditActorRow" class="rowInline compactRow ${editOkActor ? '' : 'reqWarn'}">
            <select data-action="draft-record-edit" data-field="actorTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, editActorType)}</select>
            <div class="grow">${editMainNameField}</div>
            ${H.btn('추가', 'add-record-actor-edit', '', 'btn small')}
          </div>
          <div class="mini muted" style="margin-top:6px">복수 주체를 입력할 수 있어요. 저장 시 하나로 묶여 기록됩니다.</div>
          ${editActorList}
          <div id="recordEditWarnActor" class="miniWarn" ${editOkActor ? 'hidden' : ''}>⚠ 주체를 1명 이상 추가해 주세요.</div>
        </div>

        <div class="field compact">
          <label>장소</label>
          <select data-action="draft-record-edit" data-field="placeText">${renderSelectFromList(PLACE_TYPES as any, editPlaceText)}</select>
          ${showEditPlaceOther ? `<input value="${esc(draftRecordEdit.placeOther)}" placeholder="장소 상세(기타)" data-action="draft-record-edit" data-field="placeOther" />` : ''}
        </div>

        <div class="field compact">
          <label>보관</label>
          <select data-action="draft-record-edit" data-field="storeTypeText">${renderSelectFromList(STORE_TYPES as any, editStoreTypeText)}</select>
          ${showEditStoreOther ? `<input value="${esc(draftRecordEdit.storeOther)}" placeholder="보관형태 상세(기타)" data-action="draft-record-edit" data-field="storeOther" />` : ''}
        </div>
      </div>

      <details id="recordEditRelatedDetails" class="metaMore" ${ui.recEditRelatedOpen ? 'open' : ''}>
        <summary>
          <span>관련자 정정</span>
          <span class="metaMoreCount">${esc(String((draftRecordEdit.related || []).length))}명</span>
        </summary>
        <div class="metaMorePanel">
          <div class="field" style="margin-bottom:0">
            <div class="rowInline">
              <select data-action="draft-record-edit" data-field="relTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, String(draftRecordEdit.relTypeText || '학부모'))}</select>
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
          <div class="recordSectionTitle">정정</div>
          <div class="muted">수정은 덮어쓰지 않고 새 해시와 로그를 추가해 봉인합니다.</div>
        </div>
        ${H.btnData('이 기록 정정', 'start-edit-record', { id: r.id }, 'btn primary')}
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
                <div class="revisionMeta"><span>사건시각</span><b>${esc(fmt(rev.eventAt))}</b></div>
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
        <div class="recordHeroMetaItem"><span>사건시각</span><b>${esc(fmt(r.ts))}</b></div>
        <div class="recordHeroMetaItem"><span>${esc(lastSealLabel)}</span><b>${esc(fmt((r as any)?.integrity?.lastSealedAt || r.ts))}</b></div>
        <div class="recordHeroMetaItem"><span>원본 해시</span><code>${esc(shortHash(originalHash, 14, 10))}</code></div>
        <div class="recordHeroMetaItem"><span>현재 해시</span><code>${esc(shortHash(currentHash, 14, 10))}</code></div>
      </div>
      <div class="muted" style="margin-top:8px">${esc(integrity.message || '')}</div>
    </section>

    <section class="recordCurrentSection">
      <div class="detailGrid trustDetailGrid">
        ${H.dr('주체', esc(recordActorText(r)))}
        ${H.dr('장소', esc(placeLabel(r.place, r.placeOther)))}
        ${H.dr('보관형태', esc(storeLabel(r.storeType, r.storeOther)))}
        ${H.dr('정정 횟수', esc(String(Math.max(0, getRecordRevisionCount(r as any) - 1))))}
        ${H.ds('관련자', relatedHtml)}
        ${H.ds('현재 내용', `<div class="detailNote">${esc(r.summary || '')}</div>`)}
        ${H.ds('AI 민원 위험도', renderRiskSummary((r as any).risk))}
      </div>
    </section>
  `;

  const historyPanel = `
    <section class="recordHistorySection">
      <div class="recordSectionHead">
        <div>
          <div class="recordSectionTitle">수정 이력</div>
          <div class="muted">최신 로그가 위에 쌓입니다. 각 revision은 이전 hash를 참조합니다.</div>
        </div>
      </div>
      ${revisionHtml}
    </section>
  `;

  const tabs = renderMiniTabs([
    { label: '현재기록', action: 'switch-record-modal-tab', dataKey: 'record-modal-tab', dataValue: 'current', active: activeTab === 'current' },
    { label: '수정이력', action: 'switch-record-modal-tab', dataKey: 'record-modal-tab', dataValue: 'history', active: activeTab === 'history' },
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

  return H.modal('recordModal', H.modalHead('증거관리 · 상세', String(title), headActions), body);
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
          <div class="recMiniMetaLine"><span class="metaK">사건시각</span><span>${esc(fmt(r.ts))}</span></div>
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

  const listHtml = filtered.length ? filtered.map(mini).join('') : H.empty(hasFilters ? '필터 결과가 없어요.' : '아직 증거가 없어요.', 140);

  return `
    <div class="sideStack">

      <section class="card sideCard memoFilterCard compactFilterCard">
        <div class="sideCardHead sideCardHeadFilterRow">
          <div>
            <div class="sideCardTitle">증거 필터</div>
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
            <div class="sideCardTitle">전체 증거</div>
            <div class="muted" style="font-size:12px; margin-top:2px">사건시각 · 기록/수정 봉인시각 · 정정 횟수</div>
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

  const actorType = String(draftRecord.actorTypeText || '학생');
  const placeText = String(draftRecord.placeText || '교실');
  const storeTypeText = String(draftRecord.storeTypeText || '전화');
  const actorList = (Array.isArray((draftRecord as any).actors) ? ((draftRecord as any).actors as ActorRef[]) : []);
  const pendingActorName = String(draftRecord.actorNameOther || '').trim();

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
  if (!okSummaryTeacherActions) reqMissing.push('내가 바로 한 조치');
  if (!okSummaryIssues) reqMissing.push('쟁점·요청 정리');
  if (!okSummaryEvidenceList) reqMissing.push('증거 목록');
  if (!okSummaryOther) reqMissing.push('기타 메모');
  if (!okTs) reqMissing.push('시간');
  if (!okActor) reqMissing.push('주체');
  if (!okPlace) reqMissing.push('장소');
  if (!okStore) reqMissing.push('보관 형태');

  const canSave = reqMissing.length === 0;
  const reqLabel = canSave ? '저장 가능' : `미작성 ${reqMissing.length}개`;

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
      : `<div class="muted composerEmptyHint gatherMutedHint">주체를 1명 이상 추가해 주세요.</div>`;

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
      : `<div class="muted composerEmptyHint gatherMutedHint">관련자가 있으면 추가해 주세요.</div>`;

  const missingSummary = reqMissing.length
    ? `아직 ${esc(reqMissing.slice(0, 4).join(' · '))}${reqMissing.length > 4 ? ` 외 ${esc(String(reqMissing.length - 4))}개` : ''}`
    : '모든 항목을 작성했어요.';

  return `
    <div class="entryForm v2 entryFormGather">
      <div class="recordFormSimple">
        <div class="recordFormStatusBar">
          <div>
            <div class="recordFormKicker">증거 기록</div>
            <div class="recordFormTitle">모든 항목을 작성한 뒤 저장하세요</div>
            <div class="recordFormSub">이번 화면은 기존 항목 전체가 필수예요.</div>
          </div>
          <div class="recordFormTopActions">
            <span id="recordReqPill" class="recordFormStatusPill ${canSave ? 'ready' : 'warn'}">${esc(reqLabel)}</span>
            <button class="btn ghost clearDraftBtn recordFormGhostBtn" data-action="clear-record-draft" type="button">비우기</button>
          </div>
        </div>

        <section class="recordFormCard">
          <div class="recordFormCardHead">
            <div class="recordFormCardTitle">기록 내용</div>
            <div class="recordFormCardDesc">짧고 명확하게 적되, 모든 칸을 채워 주세요.</div>
          </div>

          <div class="field">
            <label>핵심 사실 <span class="reqStar">*</span></label>
            <textarea id="recordSummaryOverview" class="entryTa composerTa simpleComposerTextarea ${okSummaryOverview ? '' : 'reqWarn'}" rows="4"
              placeholder="무슨 일이 있었는지 한 번에 이해되게 적어주세요"
              data-action="draft-record" data-field="summaryOverview">${esc((draftRecord as any).summaryOverview || '')}</textarea>
          </div>
          <div id="recordWarnSummary" class="composerInlineWarn simpleWarn" ${okSummaryOverview ? 'hidden' : ''}>핵심 사실은 4글자 이상 작성해 주세요.</div>

          <div class="recordFormGrid">
            <div class="field">
              <label>이전 흐름 · 배경 <span class="reqStar">*</span></label>
              <textarea class="entryTa composerTa ${okSummaryBackground ? '' : 'reqWarn'}" rows="3" placeholder="이 일 이전의 흐름이나 배경" data-action="draft-record" data-field="summaryBackground">${esc((draftRecord as any).summaryBackground || '')}</textarea>
            </div>
            <div class="field">
              <label>내가 바로 한 조치 <span class="reqStar">*</span></label>
              <textarea class="entryTa composerTa ${okSummaryTeacherActions ? '' : 'reqWarn'}" rows="3" placeholder="즉시 한 안내나 조치" data-action="draft-record" data-field="summaryTeacherActions">${esc((draftRecord as any).summaryTeacherActions || '')}</textarea>
            </div>
            <div class="field">
              <label>쟁점 · 요청 정리 <span class="reqStar">*</span></label>
              <textarea class="entryTa composerTa ${okSummaryIssues ? '' : 'reqWarn'}" rows="3" placeholder="상대가 제기한 핵심 쟁점이나 요청" data-action="draft-record" data-field="summaryIssues">${esc((draftRecord as any).summaryIssues || '')}</textarea>
            </div>
            <div class="field">
              <label>증거 목록 <span class="reqStar">*</span></label>
              <textarea class="entryTa composerTa ${okSummaryEvidenceList ? '' : 'reqWarn'}" rows="3" placeholder="사진, 문자, 통화기록 등" data-action="draft-record" data-field="summaryEvidenceList">${esc((draftRecord as any).summaryEvidenceList || '')}</textarea>
            </div>
          </div>

          <div class="field" style="margin-bottom:0">
            <label>기타 메모 <span class="reqStar">*</span></label>
            <textarea class="entryTa composerTa ${okSummaryOther ? '' : 'reqWarn'}" rows="3" placeholder="추후 확인할 점이나 남겨둘 메모" data-action="draft-record" data-field="summaryOther">${esc((draftRecord as any).summaryOther || '')}</textarea>
          </div>
        </section>

        <section class="recordFormCard">
          <div class="recordFormCardHead">
            <div class="recordFormCardTitle">기본 정보</div>
            <div class="recordFormCardDesc">시간, 주체, 장소, 보관 형태도 모두 입력해야 저장돼요.</div>
          </div>

          <div class="recordFormGrid">
            <div class="field compact recordFormFieldCard">
              <label>시간 <span class="reqStar">*</span></label>
              <div class="rowInline compactRow gatherInlineRow">
                <input id="recordTs" class="${okTs ? '' : 'reqWarn'}" type="datetime-local" value="${esc(draftRecord.ts)}" data-action="draft-record" data-field="ts" />
                <button class="btn ghost small gatherNowBtn" type="button" data-action="set-record-now" title="지금 시간으로">방금</button>
              </div>
              <div id="recordWarnTs" class="miniWarn simpleWarn" ${okTs ? 'hidden' : ''}>시간을 선택해 주세요.</div>
            </div>

            <div class="field compact recordFormFieldCard">
              <label>장소 <span class="reqStar">*</span></label>
              <select class="${okPlace ? '' : 'reqWarn'}" data-action="draft-record" data-field="placeText">${renderSelectFromList(PLACE_TYPES as any, placeText)}</select>
              ${showPlaceOther ? `<input class="${okPlace ? '' : 'reqWarn'}" value="${esc(draftRecord.placeOther)}" placeholder="장소 상세(기타)" data-action="draft-record" data-field="placeOther" />` : ''}
            </div>

            <div class="field compact recordFormFieldCard">
              <label>보관 형태 <span class="reqStar">*</span></label>
              <select class="${okStore ? '' : 'reqWarn'}" data-action="draft-record" data-field="storeTypeText">${renderSelectFromList(STORE_TYPES as any, storeTypeText)}</select>
              ${showStoreOther ? `<input class="${okStore ? '' : 'reqWarn'}" value="${esc(draftRecord.storeOther)}" placeholder="보관형태 상세(기타)" data-action="draft-record" data-field="storeOther" />` : ''}
            </div>

            <div class="field compact recordFormFieldCard recordFormActorCard">
              <label>주체 <span class="reqStar">*</span></label>
              <div id="recordActorRow" class="rowInline compactRow gatherActorRow ${okActor ? '' : 'reqWarn'}">
                <select data-action="draft-record" data-field="actorTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, actorType)}</select>
                <div class="grow">${mainNameField}</div>
                ${H.btn('추가', 'add-record-actor', '', 'btn small')}
              </div>
              ${actorListHtml}
              <div id="recordWarnActor" class="miniWarn simpleWarn" ${okActor ? 'hidden' : ''}>주체를 1명 이상 추가해 주세요.</div>
            </div>
          </div>
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
                <select data-action="draft-record" data-field="relTypeText">${renderSelectFromList(UI_ACTOR_TYPES as any, String(draftRecord.relTypeText || '학부모'))}</select>
                <div class="grow">${relNameField}</div>
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
            저장하기
          </button>
          <button id="btnSaveRecordBottom" class="srOnly" data-action="save-record" type="button" ${canSave ? '' : 'disabled aria-disabled="true"'}>저장하기</button>
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

  return H.modal('recordComposerModal', H.modalHead('증거 기록하기', '모든 항목을 작성한 뒤 저장하세요.', headActions), body, 'modal recordComposerModal');
}



function renderStudentRosterModal() {
  const roster = Array.isArray(ui.classRosterDraft) && ui.classRosterDraft.length === CLASS_ROSTER_SIZE
    ? ui.classRosterDraft
    : getClassRoster();
  const filled = roster.filter((name) => String(name || '').trim()).length;
  const headActions = `
    <div class="rowInline">
      ${H.btn('닫기', 'close-class-roster', '', 'btn ghost')}
      ${H.btn('저장', 'save-class-roster', '', 'btn primary')}
    </div>
  `;
  const rows = Array.from({ length: CLASS_ROSTER_SIZE }, (_, index) => {
    const no = index + 1;
    return `
      <div class="classRosterRow">
        <div class="classRosterNo">${esc(String(no))}</div>
        <input
          class="classRosterInput"
          value="${esc(String(roster[index] || ''))}"
          placeholder="이름 입력 또는 여러 줄 붙여넣기"
          data-action="draft-class-roster"
          data-index="${esc(String(index))}"
        />
      </div>
    `;
  }).join('');
  const body = `
    <div class="classRosterModalBody">
      <div class="classRosterHero">
        <div>
          <div class="classRosterTitle">1번부터 40번까지 학생 이름을 등록하세요.</div>
          <div class="muted">아무 칸에나 여러 줄 붙여넣기하면 아래로 자동 배치됩니다. 저장 후 증거기록/증거모으기의 <b>우리반</b> 항목에서 바로 선택할 수 있어요.</div>
        </div>
        <div class="classRosterCount"><span id="classRosterFilledCount">${esc(String(filled))}</span> / ${esc(String(CLASS_ROSTER_SIZE))}</div>
      </div>
      <div class="classRosterGrid" role="table" aria-label="학생 명부 등록표">
        ${rows}
      </div>
    </div>
  `;
  return H.modal('classRosterModal', H.modalHead('학생 명부 등록', '우리반 리스트를 한 번 등록해두면 기록 입력 때 바로 불러옵니다.', headActions), body, 'modal classRosterModal');
}

/* ==================== CASES ==================== */


function renderCasesShell(selected: CaseItem | null, gridClass: string, gridInner: string) {
  const ids = visibleCases();
  const active = ui.caseTab === 'list' ? 'list' : 'create';
  const isList = active === 'list';

  const panel = active === 'create'
    ? `
      <div class="caseCommandPanel caseCommandPanelCreate">
        <div class="subTabHint muted">증거모으기는 이 화면 안에서 바로 이어집니다.</div>
        <div class="caseCommandPanelScroll">
          ${renderCaseCreateContent()}
        </div>
      </div>
    `
    : `
        <div class="caseCommandMeta muted">사건 목록과 타임라인은 조회 탭에서만 보여줍니다.</div>
      `;

  return `
    <section class="caseShell ${isList ? 'caseShellList' : 'caseShellSolo'}">
      <div class="card caseCommandDeck">

        ${renderMiniTabs([
          { label: '증거모으기', action: 'switch-case-tab', dataKey: 'case-tab', dataValue: 'create', active: active === 'create' },
          { label: '사건조회하기', action: 'switch-case-tab', dataKey: 'case-tab', dataValue: 'list', active: active === 'list' },
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
        <div class="h2">사건</div>
        <div class="muted">${isFocused ? '열어둔 사건의 타임라인을 보고 있어요. 목록으로를 누르면 사건 목록으로 돌아갑니다.' : '사건 목록에서 열기를 누르면 이 자리에서 타임라인이 열립니다.'}</div>
      </div>
      <div class="titleActions">
        <span class="countPill">총 ${ids.length}개</span>
      </div>
    </div>
  `;

  if (!ids.length) {
    return `${header}
      <div class="empty">아직 사건이 없어요. 위의 증거모으기에서 먼저 시작해보세요.</div>
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
          <div class="title">사건 목록</div>
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
                <textarea rows="3" class="actionTa" placeholder="짧게 기록 (Ctrl/⌘+Enter 추가)" data-action="draft-step" data-field="note">${esc(draftStep.note)}</textarea>
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

function renderCaseCreateContent() {
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

  const canStart = (draftCase.actors || []).length > 0;
  const startExtra = canStart ? '' : ' disabled aria-disabled="true" title="관련자를 1명 이상 추가해야 시작할 수 있어요"';

  return `
      <div class="helperBox" style="margin-bottom:14px; margin-top:0;">
        <b>사용법:</b> 누구의 기록을 모을지 선택하면 AI가 해당 인물과 관련된 증거를 우선적으로 찾아옵니다.
      </div>

      <div class="field highlight-section">
        <label style="font-size:13px;">① 누구의 기록을 모을까요? (필수)</label>
        <div class="miniOptionRow">
          <label class="miniToggle" title="체크하면 증거에서 주요인물로 추가한 사람의 기록만 모아요.">
            <input type="checkbox" data-action="draft-case" data-field="onlyMainActor" ${((draftCase as any).onlyMainActor ? 'checked' : '')} />
            <span>원하는 주요인물 기록만 모으려면 체크</span>
          </label>
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
            <label>사건 제목 (비워두면 자동 생성)</label>
            <input value="${esc(draftCase.title)}" placeholder="예: 3학년 복도 언쟁 민원" data-action="draft-case" data-field="title" />
          </div>
        </div>
      </details>

      <div class="rowInline" style="margin-top:16px; padding-top:10px; border-top:1px solid var(--grey-200);">
        ${H.btn('증거모으기 시작', 'create-case', startExtra, 'btn primary')}
        ${H.btn('초기화', 'clear-case-draft')}
      </div>
    `;
}

function renderCaseCreateModal() {
  return H.modal(
    'caseCreateModal',
    H.modalHead('증거모으기', '스마트모으기로 관련 증거를 자동 선별합니다.', H.btn('닫기', 'close-case-create')),
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

  const title = c ? trunc(c.title, 40) : '기록 추가';

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
    : H.empty('추가할 수 있는 증거가 없어요.');

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
      H.modalHead('타임라인 상세', '사건을 먼저 열어주세요.', H.btn('닫기', 'close-timeline-detail')),
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
          ${H.dr('사건시각', esc(fmt(vr.ts)))}
          ${H.dr('주체', esc(recordActorText(vr)))}
          ${H.dr('장소', esc(placeLabel(vr.place, vr.placeOther)))}
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
            '왜 이 대응 가이드가 뜨나',
            `<div class="muted" style="margin-top:6px">대응 가이드는 사건 설정(관련자/요약/기간/패턴) 기반으로 생성돼요.</div>
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
          ${H.ds('왜 포함됐나', `<div class="muted">내 조치 로그는 이 사건에서 직접 저장된 실행/대응 로그라서 타임라인에 항상 포함돼요.</div>`)}
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
  const filtered = HIDE_CASE_ACTIONS_AND_GUIDES ? events.filter((ev: any) => ev?.kind === 'record') : events;

  const ctx = {
    actors: ((c as any).actors || []) as ActorRef[],
    queryTokens: tokenizeLite(String((c as any).query || '')),
    timeFrom: String((c as any).timeFrom || ''),
    timeTo: String((c as any).timeTo || ''),
  };

  return `
    <div class="sectionTitle">
      <div class="caseTitleLeft">
        <div class="h2">${esc((c as any).title)}</div>
        <div class="muted"><span class="badgeAI">AI 선별</span> 관련 증거 자동 선별</div>
        ${hasRange ? `<div class="muted" style="margin-top:8px">기간: ${esc((c as any).timeFrom ? fmt((c as any).timeFrom) : '—')} ~ ${esc((c as any).timeTo ? fmt((c as any).timeTo) : '—')}</div>` : ''}
        ${((c as any).query || '').trim() ? `<div class="muted" style="margin-top:8px">요약: ${esc(trunc((c as any).query || '', 90))}</div>` : ''}
      </div>

      <div class="caseTitleRight">
        <div class="aiTopActions">
          ${H.btn('기록추가', 'open-case-update')}
          ${H.btn('내용증명 생성', 'open-paper')}
          ${H.btn('목록으로', 'clear-case')}
        </div>
      </div>
    </div>

    ${filtered.length ? renderTimelineWithDays(filtered, ctx) : `<div class="empty">표시할 항목이 없어요.</div>`}
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