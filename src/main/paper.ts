import { nowISO, fmt, esc, trunc } from '../utils';
import type { CaseItem, RecordItem, StepItem } from '../engine';
import { buildCaseTimeline, recordsForCase } from '../engine';
import { S, ui, actorLabel, actorShort, placeLabel, storeLabel, lvLabel } from './state';

/* ======================================================
 * Paper styles
 * ====================================================== */

function getPaperCSS(_opts?: { forPrintWindow?: boolean }) {
  return `
dialog.modal.paperModal{
  width: min(96vw, 1400px);
  max-width: 1400px;
  height: min(92vh, 1100px);
  padding: 0;
  border: none;
  border-radius: 18px;
  overflow: hidden;
  background: transparent;
}
dialog.modal.paperModal::backdrop{
  background: rgba(25,31,40,0.50);
  backdrop-filter: blur(6px);
}
dialog.modal.paperModal > .modalHead{
  position: sticky;
  top: 0;
  z-index: 10;
  display:flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: rgba(242,244,246,0.92);
  border-bottom: 1px solid rgba(0,0,0,0.08);
  backdrop-filter: blur(10px);
}
.paperViewport{
  height: calc(100% - 74px);
  overflow: auto;
  padding: 18px;
  background: radial-gradient(1200px 600px at 50% 0%, rgba(49,130,246,0.10), rgba(0,0,0,0) 60%),
              linear-gradient(180deg, rgba(0,0,0,0.04), rgba(0,0,0,0.00));
}
.paperSheet{
  width: min(1120px, 100%);
  margin: 0 auto;
  background: #fff;
  color: #191f28;
  border: 1px solid rgba(0,0,0,0.10);
  border-radius: 16px;
  box-shadow: 0 18px 48px rgba(0,0,0,0.18);
}
.paperContent{
  padding: 18mm 16mm;
  font-family: var(--font-family, -apple-system, BlinkMacSystemFont, system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  word-break: keep-all;
}
.paperTitle{
  font-size: 26px;
  font-weight: 900;
  letter-spacing: -0.6px;
  line-height: 1.25;
  margin: 0 0 6px;
}
.paperMeta{
  font-size: 12px;
  color: rgba(0,0,0,0.55);
  margin: 0 0 18px;
}
.paperH{
  font-size: 15px;
  font-weight: 900;
  margin: 26px 0 10px;
  letter-spacing: -0.2px;
}
.paperHint{
  font-size: 12px;
  color: rgba(0,0,0,0.55);
  margin-top: 10px;
}
.paperGrid{
  display:grid;
  grid-template-columns: 150px 1fr;
  gap: 10px 16px;
  padding: 16px 16px;
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 14px;
  background: #fbfbfc;
}
.paperK{
  font-size: 12px;
  font-weight: 900;
  color: rgba(0,0,0,0.55);
}
.paperV{
  font-size: 14px;
  font-weight: 650;
  color: #191f28;
  min-width: 0;
  overflow-wrap: anywhere;
}
.paperV code{
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 8px;
  background: rgba(0,0,0,0.04);
  border: 1px solid rgba(0,0,0,0.06);
  overflow-wrap: anywhere;
}
.paperList{
  margin: 8px 0 0;
  padding-left: 18px;
}
.paperFactDay{
  padding: 12px 14px;
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 14px;
  background: #fff;
  margin-top: 10px;
}
.paperFactDate{
  font-weight: 900;
  margin-bottom: 6px;
}
.advisorBlock{
  border: 1px solid rgba(49,130,246,0.18);
  background: rgba(49,130,246,0.06);
  border-radius: 14px;
  padding: 12px 14px;
  margin-top: 10px;
}
.advisorTitle{ font-weight: 900; margin-bottom: 6px; }
.advisorMeta{ display:flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.chip{
  display:inline-flex;
  align-items:center;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 850;
  background: rgba(0,0,0,0.04);
  border: 1px solid rgba(0,0,0,0.08);
}
.chipTone{
  background: rgba(49,130,246,0.10);
  border-color: rgba(49,130,246,0.22);
  color: #1b64da;
}
.advisorBody{ color: rgba(0,0,0,0.78); line-height: 1.6; }

.paperReason{
  margin-top: 6px;
  display:flex;
  flex-wrap: wrap;
  gap: 6px;
}

.paperTable{
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  writing-mode: horizontal-tb;
}
.paperTable th, .paperTable td{
  border: 1px solid rgba(0,0,0,0.10);
  padding: 9px 10px;
  vertical-align: top;
  font-size: 13px;
  line-height: 1.45;
  word-break: keep-all;
  overflow-wrap: anywhere;
  white-space: normal;
}
.paperTable th{
  background: #f5f7fb;
  font-weight: 900;
  color: rgba(0,0,0,0.70);
}
.paperTable td code{
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(0,0,0,0.04);
  border: 1px solid rgba(0,0,0,0.06);
}
.paperSignGrid{
  display:grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.sigBox{
  border: 1px solid rgba(0,0,0,0.10);
  border-radius: 14px;
  padding: 14px 14px;
  background: #fff;
}
.sigLabel{ font-weight: 900; color: rgba(0,0,0,0.70); margin-bottom: 10px; }
.sigLine{
  height: 42px;
  border-bottom: 1px solid rgba(0,0,0,0.30);
}
@page{ size: A4; margin: 12mm; }
@media print{
  dialog.modal.paperModal, .paperViewport{ background: #fff !important; }
  .paperSheet{
    width: auto;
    margin: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }
  .paperContent{ padding: 0; }
}
  `.trim();
}

export function ensurePaperStyles() {
  if (document.getElementById('paperStyles')) return;
  const style = document.createElement('style');
  style.id = 'paperStyles';
  style.textContent = getPaperCSS();
  document.head.appendChild(style);
}

/* ======================================================
 * Types
 * ====================================================== */

export type PaperRecordRow = {
  when: string;
  kind: string;
  lv: string;
  actor: string;
  place: string;
  summary: string;
  id: string;
  reason?: string;
};

export type PaperPayload = {
  title: string;
  caseId: string;
  generatedAt: string;
  hashSha256: string;
  overviewLines: string[];
  advisors: string[];
  facts: string[];
  records: PaperRecordRow[];
};

/* ======================================================
 * Helpers: dedupe + formatting
 * ====================================================== */

function normForDedup(s: unknown) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function dateKey(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '').slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function shortId(id: string) {
  const t = String(id || '');
  if (t.length <= 10) return t;
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function recDedupKey(r: RecordItem) {
  const kDate = dateKey(r.ts || '');
  const kActor = actorShort(r.actor);
  const kPlace = placeLabel(r.place, r.placeOther);
  const kSum = normForDedup(r.summary);
  return `${kDate}|${kActor}|${kPlace}|${kSum}`;
}

function dedupeRecords(list: RecordItem[]) {
  const seen = new Set<string>();
  const out: RecordItem[] = [];
  for (const r of list) {
    const k = recDedupKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function normalizeKey(s: string) {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '');
}

function dedupeRecordsForPaper(recs: RecordItem[]) {
  const out: RecordItem[] = [];
  const seen = new Set<string>();
  for (const r of recs) {
    const dk = dateKey(r.ts || '');
    const who = actorShort(r.actor);
    const where = placeLabel(r.place, r.placeOther);
    const key = `${dk}|${normalizeKey(who)}|${normalizeKey(where)}|${normalizeKey(trunc(r.summary || '', 160))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/* ======================================================
 * Inclusion reason (score + explanation)
 * ====================================================== */

type InclusionSignals = {
  isSnapshot: boolean;
  basisLabel: string;

  isMainActor: boolean;
  actorHit: boolean;
  relatedHits: number;

  hasRange: boolean;
  inRange: boolean;

  qHit: number;
  qTotal: number;

  score: number | null;
  rank: number | null;
  total: number;
};

function isWithinRangeISO(ts: string, from?: string, to?: string) {
  const t = String(ts || '');
  const f = String(from || '').trim();
  const e = String(to || '').trim();
  if (!t) return true;
  if (f && t < f) return false;
  if (e && t > e) return false;
  return true;
}

// Rust 쪽 tokenize(간소화)와 유사한 규칙: [a-z0-9 + 한글/자모] + 길이>=2
function tokenizeLoose(s: string) {
  const m = String(s || '').toLowerCase().match(/[a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]+/g) || [];
  return m.map((x) => x.trim()).filter((x) => x.length >= 2);
}

function keywordHits(query: string, text: string) {
  const q = tokenizeLoose(query);
  if (!q.length) return { hit: 0, total: 0 };
  const hay = String(text || '').toLowerCase();
  let hit = 0;
  for (const tok of q) if (hay.includes(tok)) hit++;
  return { hit, total: q.length };
}

function buildRankMap(recs: RecordItem[], scoreMap: Record<string, number>) {
  const rows = recs.map((r) => ({
    id: r.id,
    score: typeof scoreMap[r.id] === 'number' ? scoreMap[r.id] : -Infinity
  }));
  rows.sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)));
  const rankById: Record<string, number> = {};
  rows.forEach((x, i) => {
    if (x.score !== -Infinity) rankById[x.id] = i + 1;
  });
  return { rankById, total: rows.length };
}

function actorEq(a: any, b: any) {
  return (
    String(a?.type ?? '') === String(b?.type ?? '') &&
    String(a?.name ?? '').trim() === String(b?.name ?? '').trim()
  );
}

function computeInclusionSignals(
  r: RecordItem,
  c: CaseItem,
  score: number | null,
  rank: number | null,
  total: number,
  hasSnapshot: boolean
): InclusionSignals {
  const actors = Array.isArray(c.actors) ? c.actors : [];
  const main = actors[0] || null;

  const isMainActor = !!(main && actorEq(r.actor, main));
  const actorHit = actors.some((a) => actorEq(r.actor, a));
  const related = Array.isArray((r as any).related) ? ((r as any).related as any[]) : [];
  const relatedHits = related.filter((rel) => actors.some((a) => actorEq(rel, a))).length;

  const hasRange = !!(c.timeFrom || c.timeTo);
  const inRange = hasRange ? isWithinRangeISO(r.ts || '', c.timeFrom || '', c.timeTo || '') : true;

  const { hit: qHit, total: qTotal } = keywordHits(String(c.query || ''), String(r.summary || ''));

  const isSnapshot = !!hasSnapshot;
  const basisLabel = isSnapshot
    ? '스냅샷'
    : score !== null
      ? '자동(랭킹)'
      : '자동';

  return {
    isSnapshot,
    basisLabel,
    isMainActor,
    actorHit,
    relatedHits,
    hasRange,
    inRange,
    qHit,
    qTotal,
    score,
    rank,
    total
  };
}

function inclusionReasonText(sig: InclusionSignals) {
  const parts: string[] = [];

  parts.push(sig.basisLabel);

  // 정책/설명은 “사람이 납득”이 핵심이라, 먼저 가장 강한 이유부터
  if (sig.isMainActor) parts.push('주요 당사자(기본 포함)');
  else if (sig.actorHit) parts.push('당사자 일치');

  if (sig.relatedHits > 0) parts.push(`관련자 ${sig.relatedHits}`);
  if (sig.qTotal > 0) parts.push(`키워드 ${sig.qHit}/${sig.qTotal}`);
  if (sig.hasRange) parts.push(sig.inRange ? '기간 내' : '기간 외');

  if (typeof sig.score === 'number') {
    const s = sig.score.toFixed(2);
    const rk = sig.rank ? `#${sig.rank}/${sig.total}` : '';
    parts.push(`점수 ${s}${rk ? `(${rk})` : ''}`);
  }

  return parts.join(' · ');
}

function inclusionReasonHTML(sig: InclusionSignals) {
  const chips: string[] = [];

  chips.push(`<span class="chip">${esc(sig.basisLabel)}</span>`);

  if (sig.isMainActor) chips.push(`<span class="chip chipTone">주요 당사자</span>`);
  else if (sig.actorHit) chips.push(`<span class="chip">당사자</span>`);

  if (sig.relatedHits > 0) chips.push(`<span class="chip">관련자 ${esc(String(sig.relatedHits))}</span>`);
  if (sig.qTotal > 0) chips.push(`<span class="chip">키워드 ${esc(`${sig.qHit}/${sig.qTotal}`)}</span>`);
  if (sig.hasRange) chips.push(`<span class="chip">${sig.inRange ? '기간 내' : '기간 외'}</span>`);

  if (typeof sig.score === 'number') {
    const rk = sig.rank ? `#${sig.rank}/${sig.total}` : '';
    chips.push(`<span class="chip chipTone">점수 ${esc(sig.score.toFixed(2))}${rk ? ` ${esc(rk)}` : ''}</span>`);
  }

  return `<div class="paperReason">${chips.join('')}</div>`;
}

/* ======================================================
 * Paper HTML (refactored)
 * ====================================================== */

type PaperRenderCtx = {
  c: CaseItem;
  recs: RecordItem[];
  events: any[];
  generatedAtISO: string;
  hash: string | null;
  scoreMap: Record<string, number>;
  hasSnapshot: boolean;
  rankById: Record<string, number>;
  rankTotal: number;
};

function renderHeader(ctx: PaperRenderCtx) {
  const { c, generatedAtISO } = ctx;
  return `
    <div class="paperTitle">${esc(c.title)} — 사실관계·기록·내 조치 로그 정리서</div>
    <div class="paperMeta">사건 ID: ${esc(c.id)} · 생성: ${esc(fmt(c.createdAt))} · 출력: ${esc(fmt(generatedAtISO))}</div>
  `;
}

function renderOverviewGrid(ctx: PaperRenderCtx) {
  const { c, hash, hasSnapshot } = ctx;

  const parties = (c.actors || []).map(actorLabel).join(', ') || '—';
  const range = c.timeFrom || c.timeTo ? `${c.timeFrom ? fmt(c.timeFrom) : '—'} ~ ${c.timeTo ? fmt(c.timeTo) : '—'}` : '—';
  const issue = (c.query || '').trim();

  // includeBasis: recordIds가 있으면 스냅샷 기반. 그렇지 않으면 자동 매칭 안내.
  const includeBasis = hasSnapshot
    ? '스냅샷 포함: 사건에 명시적으로 포함된 기록(recordIds) 기준'
    : '자동 매칭: 당사자/관련자/기간/키워드 신호 + 점수(랭킹) 기반으로 포함';

  return `
    <div class="paperGrid">
      <div class="paperK">기간</div><div class="paperV">${esc(range)}</div>
      <div class="paperK">당사자(Actor)</div><div class="paperV">${esc(parties)}</div>
      <div class="paperK">방어 필요 상황 요약</div><div class="paperV">${esc(issue || '—')}</div>
      <div class="paperK">포함 근거</div><div class="paperV">${esc(includeBasis)}</div>
      <div class="paperK">무결성 해시(SHA-256)</div><div class="paperV"><code>${esc(hash || '—')}</code></div>
    </div>
  `;
}

function renderAdvisors(ctx: PaperRenderCtx) {
  const { c } = ctx;
  const keyAdvisors = (c.advisors || []).filter((a) => a.state !== 'dismissed').slice(0, 5);

  if (!keyAdvisors.length) return `<div class="muted">현재 사건에 등록된 핵심 권고가 없어요.</div>`;

  return keyAdvisors
    .map((a) => {
      const lv = (a as any).lv || '—';
      const tags = (a.tags || []).slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
      const level = String((a as any).level || a.kind || 'info');
      return `
        <div class="advisorBlock">
          <div class="advisorTop">
            <div class="advisorTitle">${esc(a.title || a.summary || '권고')}</div>
            <div class="advisorMeta">
              <span class="chip chipTone">${esc(level)}</span>
              <span class="chip chipTone">${esc(lv)}</span>
              ${tags}
            </div>
          </div>
          <div class="advisorBody">${esc(a.body || a.detail || a.note || '')}</div>
        </div>
      `;
    })
    .join('');
}

function groupRecordsByDay(recs: RecordItem[]) {
  const byDay = new Map<string, RecordItem[]>();
  for (const r of recs) {
    const dk = dateKey(r.ts || '');
    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk)!.push(r);
  }
  return byDay;
}

function renderFactsByDay(ctx: PaperRenderCtx) {
  const { recs } = ctx;

  if (!recs.length) return `<div class="muted">기록이 없어요.</div>`;

  const byDay = groupRecordsByDay(recs);
  return Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, items]) => {
      const lines = items
        .slice(0, 8)
        .map((r) => {
          const who = actorShort(r.actor);
          const where = placeLabel(r.place, r.placeOther);
          const sum = trunc(r.summary, 120);
          return `<li><b>${esc(who)}</b> <span class="muted">(${esc(where)})</span>: ${esc(sum)} <span class="muted">[${esc(shortId(r.id))}]</span></li>`;
        })
        .join('');
      const extra =
        items.length > 8
          ? `<div class="muted" style="margin-top:6px;">※ ${items.length - 8}건 추가 기록은 ‘기록 목록’ 표 참조</div>`
          : '';
      return `<div class="paperFactDay"><div class="paperFactDate">${esc(d)}</div><ul class="paperList">${lines}</ul>${extra}</div>`;
    })
    .join('');
}

function renderTimelineTable(ctx: PaperRenderCtx) {
  const { events } = ctx;

  const seenTL = new Set<string>();
  const filtered = (events || [])
    .filter((ev) => ev.kind !== 'advisor')
    .filter((ev) => {
      if (ev.kind !== 'record') return true;
      const r = ev.record as RecordItem;
      const k = recDedupKey(r);
      if (seenTL.has(k)) return false;
      seenTL.add(k);
      return true;
    });

  const rows = filtered
    .map((ev: any) => {
      if (ev.kind === 'record') {
        const r = ev.record as RecordItem;
        return `<tr>
          <td>${esc(fmt(r.ts))}</td>
          <td>기록</td>
          <td>${esc(actorShort(r.actor))}</td>
          <td>${esc(placeLabel(r.place, r.placeOther))}</td>
          <td>${esc(lvLabel(r.lv))}</td>
          <td>${esc(trunc(r.summary, 140))}</td>
          <td><code>${esc(shortId(r.id))}</code></td>
        </tr>`;
      }
      const s = ev.step as StepItem;
      return `<tr>
        <td>${esc(fmt(s.ts))}</td>
        <td>내 조치 로그</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>${esc(trunc(`${s.name} — ${s.note}`, 160))}</td>
        <td>—</td>
      </tr>`;
    })
    .join('');

  return `
    <table class="paperTable">
      <thead><tr>
        <th style="width:86px">시간</th>
        <th style="width:52px">유형</th>
        <th style="width:82px">주체</th>
        <th style="width:68px">장소</th>
        <th style="width:48px">LV</th>
        <th>내용</th>
        <th style="width:56px">ID</th>
      </tr></thead>
      <tbody>${rows || ''}</tbody>
    </table>
    <div class="paperHint">※ 증거 타임라인 표는 중복(유사 문구)을 1회만 보여줘요. 전체 목록은 아래 ‘기록 목록’ 참고.</div>
  `;
}

function renderSteps(ctx: PaperRenderCtx) {
  const { c } = ctx;
  const steps = (c.steps || []).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  if (!steps.length) return `<div class="muted">등록된 내 조치 로그가 없어요.</div>`;

  const lines = steps
    .map((s) => `<li><b>${esc(fmt(s.ts))}</b> — ${esc(s.name)}: ${esc(trunc(s.note, 160))}</li>`)
    .join('');

  return `<ul class="paperList">${lines}</ul>`;
}

function renderRecordsTable(ctx: PaperRenderCtx) {
  const { c, recs, scoreMap, hasSnapshot, rankById, rankTotal } = ctx;

  const rows = recs
    .map((r) => {
      const score = typeof scoreMap[r.id] === 'number' ? scoreMap[r.id] : null;
      const rank = typeof rankById[r.id] === 'number' ? rankById[r.id] : null;

      const sig = computeInclusionSignals(r, c, score, rank, rankTotal, hasSnapshot);
      const reasonText = inclusionReasonText(sig);

      return `<tr>
        <td><code>${esc(shortId(r.id))}</code></td>
        <td>${esc(fmt(r.ts))}</td>
        <td>${esc(storeLabel(r.storeType, r.storeOther))}</td>
        <td>${esc(lvLabel(r.lv))}</td>
        <td>${esc(actorShort(r.actor))}</td>
        <td>${esc(placeLabel(r.place, r.placeOther))}</td>
        <td>
          ${esc(trunc(r.summary, 180))}
          <div class="muted" style="margin-top:6px">포함근거: ${esc(reasonText)}</div>
          ${inclusionReasonHTML(sig)}
        </td>
      </tr>`;
    })
    .join('');

  return `
    <table class="paperTable">
      <thead><tr>
        <th style="width:56px">ID</th>
        <th style="width:86px">시간</th>
        <th style="width:56px">유형</th>
        <th style="width:46px">LV</th>
        <th style="width:76px">주체</th>
        <th style="width:60px">장소</th>
        <th>요약</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderSignature() {
  return `
    <div class="paperSignGrid">
      <div class="sigBox">
        <div class="sigLabel">작성자</div>
        <div class="sigLine"></div>
        <div class="muted" style="margin-top:8px">성명/직위 · 서명</div>
      </div>
      <div class="sigBox">
        <div class="sigLabel">확인자(검토)</div>
        <div class="sigLine"></div>
        <div class="muted" style="margin-top:8px">성명/직위 · 서명</div>
      </div>
    </div>
  `;
}

function paperHTML(
  c: CaseItem,
  recsAll: RecordItem[],
  eventsAll: any[],
  generatedAtISO: string,
  hash: string | null
) {
  const scoreMap = (c.scoreByRecordId || {}) as Record<string, number>;
  const hasSnapshot = Array.isArray((c as any).recordIds) && (c as any).recordIds.length > 0;

  const recs = dedupeRecordsForPaper(recsAll).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const { rankById, total } = buildRankMap(recs, scoreMap);

  const ctx: PaperRenderCtx = {
    c,
    recs,
    events: eventsAll || [],
    generatedAtISO,
    hash,
    scoreMap,
    hasSnapshot,
    rankById,
    rankTotal: total
  };

  return `
    ${renderHeader(ctx)}
    ${renderOverviewGrid(ctx)}

    <div class="paperSection">
      <div class="paperH">1) 핵심 권고(대응 가이드)</div>
      ${renderAdvisors(ctx)}
    </div>

    <div class="paperSection">
      <div class="paperH">2) 사실관계 요약(날짜별)</div>
      ${renderFactsByDay(ctx)}
    </div>

    <div class="paperSection">
      <div class="paperH">3) 증거 타임라인(요약)</div>
      ${renderTimelineTable(ctx)}
    </div>

    <div class="paperSection">
      <div class="paperH">4) 내 조치 로그 내역</div>
      ${renderSteps(ctx)}
    </div>

    <div class="paperSection">
      <div class="paperH">5) 기록 목록</div>
      ${renderRecordsTable(ctx)}
    </div>

    <div class="paperSection">
      <div class="paperH">6) 확인/서명</div>
      ${renderSignature()}
    </div>
  `;
}

/* ======================================================
 * Paper payload builder (PDF export uses this)
 * ====================================================== */

export function buildPaperPayload(
  c: CaseItem,
  recsAll: RecordItem[],
  eventsAll: any[],
  generatedAtISO: string,
  hash: string | null
): PaperPayload {
  const scoreMap = (c.scoreByRecordId || {}) as Record<string, number>;
  const hasSnapshot = Array.isArray((c as any).recordIds) && (c as any).recordIds.length > 0;

  const recs = dedupeRecordsForPaper(recsAll).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const { rankById, total } = buildRankMap(recs, scoreMap);

  const parties = (c.actors || []).map(actorLabel).join(', ') || '-';
  const range =
    c.timeFrom || c.timeTo
      ? `${c.timeFrom ? fmt(c.timeFrom) : '-'} ~ ${c.timeTo ? fmt(c.timeTo) : '-'}`
      : '-';

  const overviewLines = [
    `기간: ${range}`,
    `당사자(Actor): ${parties}`,
    `방어 필요 상황 요약: ${(c.query || '').trim() || '-'}`,
    hasSnapshot
      ? '기록 포함 기준: 스냅샷(recordIds)에 명시된 기록'
      : '기록 포함 기준: 자동 매칭(당사자/관련자/기간/키워드) + 점수(랭킹) 기반'
  ];

  const keyAdvisors = (c.advisors || []).slice(0, 5);
  const advisors = keyAdvisors.map((a) => {
    const head = `[${(a.level || '').toUpperCase()}] ${(a.title || '').trim()}`;
    const body1 = (a.body || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    return body1 ? `${head} — ${body1}` : head;
  });

  const byDay = new Map<string, RecordItem[]>();
  for (const r of recs) {
    const dk = dateKey(r.ts || '');
    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk)!.push(r);
  }

  const facts: string[] = [];
  for (const [d, items] of Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const top = items.slice(0, 6).map((r) => {
      const who = actorShort(r.actor);
      const where = placeLabel(r.place, r.placeOther);
      const sum = trunc(r.summary, 120);
      return `${who}(${where}): ${sum} [${shortId(r.id)}]`;
    });
    facts.push(`${d} — ${top.join(' / ')}`);
  }

  const records: PaperRecordRow[] = [];

  // record rows (with reason)
  for (const r of recs) {
    const who = actorShort(r.actor);
    const where = placeLabel(r.place, r.placeOther);
    const when = fmt(r.ts || '');

    const score = typeof scoreMap[r.id] === 'number' ? scoreMap[r.id] : null;
    const rank = typeof rankById[r.id] === 'number' ? rankById[r.id] : null;

    const sig = computeInclusionSignals(r, c, score, rank, total, hasSnapshot);

    records.push({
      when,
      kind: 'record',
      lv: r.lv || '',
      actor: who,
      place: where,
      summary: (r.summary || '').trim(),
      id: r.id,
      reason: inclusionReasonText(sig)
    });
  }

  // step rows (keep existing behavior)
  const steps = (c.steps || []).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const s of steps) {
    const name = String(s.name || '').trim();
    const note = String(s.note || '').trim();
    const text = String((s as any).text || '').trim();

    const summary = text || [name, note].filter(Boolean).join(' — ') || '-';

    records.push({
      when: fmt(String(s.ts || '')),
      kind: 'step',
      lv: (s.lv || '').toString(),
      actor: (s.owner || '').toString() || '-',
      place: (s.place || '').toString() || '-',
      summary,
      id: String(s.id || '')
    });
  }

  return {
    title: `${c.title} — 상황 경위 및 기록 정리서`,
    caseId: c.id,
    generatedAt: fmt(generatedAtISO),
    hashSha256: hash || '',
    overviewLines,
    advisors,
    facts,
    records
  };
}

/* ======================================================
 * Hash (unchanged)
 * ====================================================== */

export async function computeCasePaperHash(c: CaseItem) {
  try {
    const payload = JSON.stringify({
      case: c,
      records: dedupeRecords(recordsForCase(S.records, c)),
      generatedAt: nowISO()
    });
    const enc = new TextEncoder().encode(payload);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex;
  } catch {
    return null;
  }
}

/* ======================================================
 * Case Paper Modal (unchanged)
 * ====================================================== */

export function renderCasePaperModal() {
  const c = ui.paperCaseId ? S.cases[ui.paperCaseId] ?? null : null;
  if (!c) return '';

  const generatedAt = nowISO();
  const recs = recordsForCase(S.records, c);
  const { events } = buildCaseTimeline(c, S.records, '');
  const inner = paperHTML(c, recs, events, generatedAt, ui.paperHash);

  return `
  <dialog class="modal paperModal" id="paperModal">
    <div class="modalHead">
      <div>
        <div class="h2">사건 보고서(페이퍼)</div>
        <div class="muted">A4 문서 형식으로 바로 PDF 저장할 수 있어요.</div>
      </div>
      <div class="rowInline">
        <button class="btn primary" data-action="print-paper" type="button">PDF로 저장</button>
        <button class="btn" data-action="close-paper" type="button">닫기</button>
      </div>
    </div>

    <div class="paperViewport" aria-label="페이퍼 미리보기">
      <div class="paperSheet">
        <div class="paperContent">
          ${inner}
        </div>
      </div>
    </div>
  </dialog>
  `;
}
