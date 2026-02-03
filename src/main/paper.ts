import { nowISO, fmt, esc, trunc } from '../utils';
import type { CaseItem, RecordItem, StepItem } from '../engine';
import { buildCaseTimeline, recordsForCase } from '../engine';
import { S, ui, actorLabel, actorShort, placeLabel, storeLabel, lvLabel } from './state';

/* -------------------- paper styles -------------------- */

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

/* -------------------- Paper helpers (dedupe + formatting) -------------------- */

function normForDedup(s: unknown) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function dateKey(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
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

function shortId(id: string) {
  const t = String(id || '');
  if (t.length <= 10) return t;
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

/* -------------------- Paper HTML (unchanged logic) -------------------- */

function paperHTML(c: CaseItem, recsAll: RecordItem[], eventsAll: any[], generatedAtISO: string, hash: string | null) {
  const scoreMap = (c.scoreByRecordId || {}) as Record<string, number>;
  const hasSnapshot = Array.isArray((c as any).recordIds) && (c as any).recordIds.length > 0;

  const includeBasis = hasSnapshot
    ? '스냅샷 포함: 사건에 명시적으로 포함된 기록(recordIds) 기준'
    : '자동 매칭: 사건 조건(Actor/기간/민감도/키워드)에 따른 포함';

  const recs = dedupeRecords(recsAll).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const parties = (c.actors || []).map(actorLabel).join(', ') || '—';
  const range = c.timeFrom || c.timeTo ? `${c.timeFrom ? fmt(c.timeFrom) : '—'} ~ ${c.timeTo ? fmt(c.timeTo) : '—'}` : '—';
  const keyAdvisors = (c.advisors || []).filter((a) => a.state !== 'dismissed').slice(0, 5);
  const steps = (c.steps || []).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  const byDay = new Map<string, RecordItem[]>();
  for (const r of recs) {
    const dk = dateKey(r.ts || '');
    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk)!.push(r);
  }

  const factBlocks = Array.from(byDay.entries())
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
      const extra = items.length > 8 ? `<div class="muted" style="margin-top:6px;">※ ${items.length - 8}건 추가 기록은 ‘기록 목록’ 표 참조</div>` : '';
      return `<div class="paperFactDay"><div class="paperFactDate">${esc(d)}</div><ul class="paperList">${lines}</ul>${extra}</div>`;
    })
    .join('');

  const seenTL = new Set<string>();
  const events = (eventsAll || [])
    .filter((ev) => ev.kind !== 'advisor')
    .filter((ev) => {
      if (ev.kind !== 'record') return true;
      const r = ev.record as RecordItem;
      const k = recDedupKey(r);
      if (seenTL.has(k)) return false;
      seenTL.add(k);
      return true;
    });

  const timelineRows = events
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

  const evidenceRows = recs
    .map((r) => {
      const score = typeof scoreMap[r.id] === 'number' ? scoreMap[r.id] : null;
      const basis = hasSnapshot ? '스냅샷' : (score !== null ? '자동(랭킹)' : '자동');
      const extra = `${basis}${score !== null ? ` · ${score.toFixed(2)}` : ''}`;
      return `<tr>
        <td><code>${esc(shortId(r.id))}</code></td>
        <td>${esc(fmt(r.ts))}</td>
        <td>${esc(storeLabel(r.storeType, r.storeOther))}</td>
        <td>${esc(lvLabel(r.lv))}</td>
        <td>${esc(actorShort(r.actor))}</td>
        <td>${esc(placeLabel(r.place, r.placeOther))}</td>
        <td>${esc(trunc(r.summary, 180))}<div class="muted" style="margin-top:6px">포함근거: ${esc(extra)}</div></td>
      </tr>`;
    })
    .join('');

  const issue = (c.query || '').trim();

  const advisorBlocks = keyAdvisors.length
    ? keyAdvisors
        .map((a) => {
          const lv = (a as any).lv || '—';
          const tags = (a.tags || []).slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('');
          const level = String((a as any).level || a.kind || 'info');
          return `
            <div class="advisorBlock">
              <div class="advisorTop">
                <div class="advisorTitle">${esc(a.title || a.summary || '권고')}</div>
                <div class="advisorMeta"><span class="chip chipTone">${esc(level)}</span><span class="chip chipTone">${esc(lv)}</span>${tags}</div>
              </div>
              <div class="advisorBody">${esc(a.body || a.detail || a.note || '')}</div>
            </div>
          `;
        })
        .join('')
    : `<div class="muted">현재 사건에 등록된 핵심 권고가 없어요.</div>`;

  const stepLines = steps.length
    ? `<ul class="paperList">${steps
        .map((s) => `<li><b>${esc(fmt(s.ts))}</b> — ${esc(s.name)}: ${esc(trunc(s.note, 160))}</li>`)
        .join('')}</ul>`
    : `<div class="muted">등록된 내 조치 로그가 없어요.</div>`;

  return `
    <div class="paperTitle">${esc(c.title)} — 사실관계·기록·내 조치 로그 정리서</div>
    <div class="paperMeta">사건 ID: ${esc(c.id)} · 생성: ${esc(fmt(c.createdAt))} · 출력: ${esc(fmt(generatedAtISO))}</div>

    <div class="paperGrid">
      <div class="paperK">기간</div><div class="paperV">${esc(range)}</div>
      <div class="paperK">당사자(Actor)</div><div class="paperV">${esc(parties)}</div>
      <div class="paperK">방어 필요 상황 요약</div><div class="paperV">${esc(issue || '—')}</div>
      <div class="paperK">포함 근거</div><div class="paperV">${esc(includeBasis)}</div>
      <div class="paperK">무결성 해시(SHA-256)</div><div class="paperV"><code>${esc(hash || '—')}</code></div>
    </div>

    <div class="paperSection">
      <div class="paperH">1) 핵심 권고(대응 가이드)</div>
      ${advisorBlocks}
    </div>

    <div class="paperSection">
      <div class="paperH">2) 사실관계 요약(날짜별)</div>
      ${factBlocks || `<div class="muted">기록이 없어요.</div>`}
    </div>

    <div class="paperSection">
      <div class="paperH">3) 증거 타임라인(요약)</div>
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
        <tbody>${timelineRows || ''}</tbody>
      </table>
      <div class="paperHint">※ 증거 타임라인 표는 중복(유사 문구)을 1회만 보여줘요. 전체 목록은 아래 ‘기록 목록’ 참고.</div>
    </div>

    <div class="paperSection">
      <div class="paperH">4) 내 조치 로그 내역</div>
      ${stepLines}
    </div>

    <div class="paperSection">
      <div class="paperH">5) 기록 목록</div>
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
        <tbody>${evidenceRows}</tbody>
      </table>
    </div>

    <div class="paperSection">
      <div class="paperH">6) 확인/서명</div>
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
    </div>
  `;
}

/* -------------------- Paper payload builder (unchanged) -------------------- */

function normalizeKey(s: string) {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '');
}

export function buildPaperPayload(
  c: CaseItem,
  recsAll: RecordItem[],
  eventsAll: any[],
  generatedAtISO: string,
  hash: string | null
): PaperPayload {
  const scoreMap = (c.scoreByRecordId || {}) as Record<string, number>;
  const hasSnapshot = Array.isArray((c as any).recordIds) && (c as any).recordIds.length > 0;

  const recs = dedupeRecordsForPaper(recsAll);

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
      : '기록 포함 기준: 자동 매칭(Actor/기간/텍스트) 랭킹 기반'
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

  for (const r of recs) {
    const who = actorShort(r.actor);
    const where = placeLabel(r.place, r.placeOther);
    const when = fmt(r.ts || '');
    const sc = scoreMap[r.id];
    const reason = hasSnapshot
      ? '스냅샷 포함'
      : typeof sc === 'number'
        ? `자동매칭 점수 ${sc.toFixed(2)}`
        : '자동매칭';
    records.push({
      when,
      kind: 'record',
      lv: r.lv || '',
      actor: who,
      place: where,
      summary: (r.summary || '').trim(),
      id: r.id,
      reason
    });
  }

  // ✅ 여기만 변경: step summary를 text || note || name로 채움
  const steps = (c.steps || []).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const s of steps) {
    const name = String(s.name || '').trim();
    const note = String(s.note || '').trim();
    const text = String((s as any).text || '').trim(); // StepItem에 text가 있긴 한데 안전하게

    const summary =
      text ||
      [name, note].filter(Boolean).join(' — ') ||
      '-';

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

/* -------------------- Case Paper Modal (unchanged) -------------------- */

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
