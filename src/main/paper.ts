import { nowISO, fmt, esc, trunc, ensureRecordV8, shortHash, getRecordRevisions, verifyRecordIntegrity } from '../utils';
import type { CaseItem, RecordItem, StepItem, ActorRef } from '../engine';
import { actorEq, recordsForCase } from '../engine';
import { S, ui, actorLabel, actorShort, placeLabel, storeLabel, lvLabel } from './state';

function recordMainActors(r: any): ActorRef[] {
  const raw = Array.isArray(r?.actors) && r.actors.length ? r.actors : [r?.actor];
  const out: ActorRef[] = [];
  for (const item of raw) {
    const a = { type: (item?.type ?? '외부인') as any, name: String(item?.name ?? '').trim() } as ActorRef;
    if (!a.name) continue;
    if (!out.some((x) => actorEq(x, a))) out.push(a);
  }
  return out;
}

function recordActorText(r: any) {
  const mains = recordMainActors(r);
  return mains.length ? mains.map(actorShort).join(' · ') : '—';
}

/* ======================================================
 * Paper styles
 * ====================================================== */

function getPaperCSS(_opts?: { forPrintWindow?: boolean }) {
  return `
dialog.modal.paperModal{
  width: min(calc(100vw - 24px), 1400px);
  max-width: 1400px;
  height: min(calc(100dvh - 24px), 1100px);
  max-height: min(calc(100dvh - 24px), 1100px);
  padding: 0;
  border: none;
  border-radius: 20px;
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
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: rgba(242,244,246,0.92);
  border-bottom: 1px solid rgba(0,0,0,0.08);
  backdrop-filter: blur(10px);
}
.paperModalLead{
  min-width: 0;
}
.paperModalActions{
  display:flex;
  align-items:center;
  gap: 8px;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.paperViewport{
  height: calc(100% - 74px);
  overflow: auto;
  padding: 18px;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  background: radial-gradient(1200px 600px at 50% 0%, rgba(17,24,39,0.10), rgba(0,0,0,0) 60%),
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
.paperSection + .paperSection{
  margin-top: 8px;
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
  border: 1px solid rgba(17,24,39,0.18);
  background: rgba(17,24,39,0.06);
  border-radius: 14px;
  padding: 12px 14px;
  margin-top: 10px;
}
.advisorTitle{ font-weight: 900; margin-bottom: 6px; }
.advisorMeta{ display:flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.chip{
  display:inline-flex;
  align-items:center;
  min-height: 26px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 850;
  background: rgba(0,0,0,0.04);
  border: 1px solid rgba(0,0,0,0.08);
}
.chipTone{
  background: rgba(17,24,39,0.10);
  border-color: rgba(17,24,39,0.22);
  color: #111827;
}
.advisorBody{ color: rgba(0,0,0,0.78); line-height: 1.6; }

.paperReason{
  margin-top: 6px;
  display:flex;
  flex-wrap: wrap;
  gap: 6px;
}

.paperTableWrap{
  width: 100%;
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

@media (max-width: 960px){
  dialog.modal.paperModal{
    width: min(calc(100vw - 16px), 1000px);
    height: min(calc(100dvh - 16px), 1000px);
    max-height: min(calc(100dvh - 16px), 1000px);
    border-radius: 18px;
  }
  dialog.modal.paperModal > .modalHead{
    gap: 10px;
    padding: 12px 14px;
  }
  .paperModalActions .btn{
    height: 38px;
    padding: 0 12px;
  }
  .paperViewport{
    padding: 14px;
  }
  .paperContent{
    padding: 18px 16px 22px;
  }
  .paperTitle{
    font-size: 23px;
  }
  .paperGrid{
    grid-template-columns: 112px minmax(0, 1fr);
    gap: 8px 12px;
    padding: 14px;
  }
}

@media (max-width: 720px){
  dialog.modal.paperModal{
    width: calc(100vw - 8px);
    height: calc(100dvh - 8px);
    max-height: calc(100dvh - 8px);
    border-radius: 16px;
  }
  dialog.modal.paperModal > .modalHead{
    flex-direction: column;
    align-items: stretch;
  }
  .paperModalActions{
    display:grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;
  }
  .paperModalActions .btn{
    width: 100%;
    justify-content: center;
  }
  .paperViewport{
    height: calc(100% - 116px);
    padding: 10px;
  }
  .paperSheet{
    border-radius: 14px;
    box-shadow: 0 10px 28px rgba(0,0,0,0.14);
  }
  .paperContent{
    padding: 14px 13px 18px;
  }
  .paperTitle{
    font-size: 20px;
    line-height: 1.32;
  }
  .paperMeta{
    margin-bottom: 14px;
    font-size: 11.5px;
  }
  .paperH{
    font-size: 14px;
    margin: 22px 0 8px;
  }
  .paperGrid{
    grid-template-columns: 1fr;
    gap: 6px;
    padding: 12px;
  }
  .paperK{
    font-size: 11px;
  }
  .paperV{
    font-size: 13px;
  }
  .paperFactDay,
  .advisorBlock,
  .sigBox{
    padding: 11px 12px;
    border-radius: 12px;
  }
  .paperSignGrid{
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .chip{
    font-size: 11.5px;
  }
  .paperTableResponsive thead{
    display: none;
  }
  .paperTableResponsive,
  .paperTableResponsive tbody,
  .paperTableResponsive tr,
  .paperTableResponsive td{
    display: block;
    width: 100%;
  }
  .paperTableResponsive tr{
    border: 1px solid rgba(0,0,0,0.10);
    border-radius: 14px;
    background: #fff;
    margin-bottom: 10px;
    padding: 10px 12px;
  }
  .paperTableResponsive td{
    border: none;
    border-bottom: 1px dashed rgba(0,0,0,0.10);
    padding: 7px 0;
    font-size: 12.5px;
  }
  .paperTableResponsive td:last-child{
    border-bottom: none;
    padding-bottom: 0;
  }
  .paperTableResponsive td::before{
    content: attr(data-label);
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    font-weight: 900;
    color: rgba(0,0,0,0.52);
  }
}

@media (max-width: 420px){
  dialog.modal.paperModal > .modalHead{
    padding: 11px 12px;
  }
  .paperViewport{
    padding: 8px;
  }
  .paperContent{
    padding: 12px 11px 16px;
  }
  .paperModalActions{
    grid-template-columns: 1fr;
  }
  .paperViewport{
    height: calc(100% - 156px);
  }
}


.paperProofForm{
  display:grid;
  gap: 16px;
  margin-bottom: 20px;
  padding: 16px;
  border: 1px solid rgba(15,23,42,0.08);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(248,250,252,0.98), rgba(241,245,249,0.92));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.75);
}
.paperProofFormHead{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:12px;
  flex-wrap:wrap;
}
.paperProofFormTitle{ font-size:15px; font-weight:900; color:#111827; }
.paperProofFormHint{ font-size:12px; color:#64748b; margin-top:4px; }
.paperProofStatus{
  display:inline-flex;
  align-items:center;
  gap:6px;
  min-height:32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid rgba(15,23,42,0.10);
  background: rgba(255,255,255,0.88);
  color:#334155;
  font-size:12px;
  font-weight:800;
}
.paperProofStatus.ready{
  border-color: rgba(22,163,74,0.24);
  background: rgba(240,253,244,0.96);
  color:#166534;
}
.paperProofGrid{
  display:grid;
  grid-template-columns: repeat(2, minmax(0,1fr));
  gap: 14px;
}
.paperProofPartyCard{
  display:grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid rgba(15,23,42,0.08);
  border-radius: 16px;
  background:#fff;
  box-shadow: 0 8px 22px rgba(15,23,42,0.05);
  transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease;
}
.paperProofPartyCard.ready{
  border-color: rgba(22,163,74,0.20);
  box-shadow: 0 10px 24px rgba(22,163,74,0.08);
}
.paperProofPartyHead{ display:flex; align-items:center; justify-content:space-between; gap:10px; }
.paperProofPartyTitle{ font-size:14px; font-weight:900; color:#0f172a; }
.paperProofPartyBadge{
  display:inline-flex;
  align-items:center;
  min-height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: rgba(226,232,240,0.68);
  color:#475569;
  font-size:11px;
  font-weight:800;
}
.paperProofPartyCard.ready .paperProofPartyBadge{
  background: rgba(220,252,231,0.92);
  color:#166534;
}
.paperProofField{ display:grid; gap:7px; }
.paperProofField label{ font-size:12px; font-weight:800; color:#475569; }
.paperProofField input,
.paperProofField textarea{
  width:100%;
  border:1px solid rgba(15,23,42,0.12);
  border-radius:12px;
  padding:11px 13px;
  font:inherit;
  background:#fff;
  color:#111827;
  transition: border-color .15s ease, box-shadow .15s ease, background-color .15s ease;
}
.paperProofField textarea{
  min-height: 88px;
  resize: vertical;
  line-height: 1.55;
}
.paperProofField input:focus,
.paperProofField textarea:focus{
  outline:none;
  border-color: rgba(37,99,235,0.42);
  box-shadow: 0 0 0 4px rgba(59,130,246,0.12);
  background:#fff;
}
.paperProofMiniHint{ font-size:11px; color:#94a3b8; line-height:1.45; }
.paperProofQuickHint{
  font-size: 12px;
  color: #475569;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255,255,255,0.74);
  border: 1px dashed rgba(15,23,42,0.10);
}
.paperContentProof{ display:grid; gap:18px; }
.paperDocTitle{ text-align:center; font-size:24px; font-weight:900; letter-spacing:0.35em; }
.paperPartyGrid{ display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:12px; }
.paperPartyBox{ border:1px solid rgba(15,23,42,0.12); border-radius:16px; padding:14px; background:#fff; }
.paperPartyTitle{ font-size:13px; font-weight:900; margin-bottom:10px; }
.paperPartyRow{ display:grid; grid-template-columns:72px 1fr; gap:10px; padding:5px 0; align-items:start; }
.paperPartyKey{ font-weight:800; color:#4b5563; }
.paperPartyVal{ font-weight:700; color:#111827; white-space:pre-wrap; }
.paperPartyVal.isEmpty{ color:#94a3b8; font-weight:600; }
.paperSubjectBox{ display:grid; grid-template-columns:72px 1fr; gap:12px; align-items:start; padding:12px 14px; border:1px solid rgba(15,23,42,0.12); border-radius:14px; }
.paperSubjectLabel{ font-weight:900; }
.paperSubjectValue{ font-weight:800; }
.paperIntegrityHero{
  display:grid;
  grid-template-columns: repeat(4, minmax(0,1fr));
  gap:10px;
}
.paperIntegrityStat{
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(15,23,42,0.08);
  background: #fbfcfe;
}
.paperIntegrityStatK{ font-size: 11px; font-weight: 800; color:#64748b; }
.paperIntegrityStatV{ margin-top: 4px; font-size: 18px; font-weight: 900; color:#0f172a; }
.paperProofList{ list-style:none; margin:0; padding:0; display:grid; gap:10px; }
.paperProofList li{ display:grid; grid-template-columns:34px 1fr; gap:10px; align-items:start; }
.paperNo{ font-weight:900; }
.paperVerdictTag{
  display:inline-flex;
  align-items:center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 900;
  border: 1px solid rgba(15,23,42,0.10);
  background: rgba(241,245,249,0.92);
  color:#334155;
}
.paperVerdictTag.ok{ background: rgba(220,252,231,0.92); border-color: rgba(22,163,74,0.20); color:#166534; }
.paperVerdictTag.warn{ background: rgba(254,249,195,0.94); border-color: rgba(202,138,4,0.22); color:#854d0e; }
.paperVerdictTag.risk{ background: rgba(254,226,226,0.94); border-color: rgba(220,38,38,0.22); color:#991b1b; }
.paperEvidenceMeta{ display:grid; gap:6px; }
.paperEvidenceSub{ font-size: 12px; color:#475569; line-height:1.5; }
.paperEvidenceMono{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 11.5px; }
.paperHashBox{ margin-top:10px; padding:10px 12px; border-radius:12px; background:rgba(248,250,252,0.9); border:1px solid rgba(15,23,42,0.08); word-break:break-all; }
.paperProofFoot{ margin-top:8px; text-align:center; }

@media (max-width: 860px){
  .paperProofGrid,
  .paperPartyGrid,
  .paperIntegrityHero{
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px){
  .paperProofForm{
    padding: 13px;
    gap: 12px;
  }
  .paperProofFormHead{
    flex-direction: column;
    align-items: stretch;
  }
  .paperProofStatus{
    width: 100%;
    justify-content: center;
  }
  .paperProofPartyCard{
    padding: 12px;
  }
  .paperDocTitle{
    font-size: 21px;
    letter-spacing: 0.26em;
  }
  .paperSubjectBox,
  .paperPartyRow{
    grid-template-columns: 1fr;
    gap: 6px;
  }
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

export type ContentProofDraft = {
  senderName: string;
  senderAddress: string;
  recipientName: string;
  recipientAddress: string;
};

export type PaperRecordRow = {
  when: string;
  kind: string;
  lv: string;
  actor: string;
  place: string;
  summary: string;
  id: string;
  reason?: string;
  originalSealedAt?: string;
  lastSealedAt?: string;
  revisionCount?: number;
  integrityHash?: string;
  revisionTrail?: string[];
  verificationStatus?: string;
  verificationMessage?: string;
  signatureAlgorithm?: string;
  signerFingerprint?: string;
  trusted?: boolean;
  signedOnThisDevice?: boolean;
  integrityVerdict?: string;
  integrityEvidence?: string;
};

export type PaperPayload = {
  title: string;
  caseId: string;
  generatedAt: string;
  hashSha256: string;
  senderName: string;
  senderAddress: string;
  recipientName: string;
  recipientAddress: string;
  subject: string;
  statementLines: string[];
  actionLines: string[];
  integrityLines: string[];
  records: PaperRecordRow[];
};

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

function sanitizePartyName(v: string) {
  const s = String(v || '').trim();
  return s || '미입력';
}

function sanitizeAddress(v: string) {
  const s = String(v || '').trim();
  return s || '주소 미입력';
}

function partyBlockHTML(label: string, nameField: string, addressField: string, name: string, address: string) {
  return `
    <div class="paperPartyBox">
      <div class="paperPartyTitle">${esc(label)}</div>
      <div class="paperPartyRow"><span class="paperPartyKey">성명</span><span class="paperPartyVal" data-proof-bind="${esc(nameField)}" data-proof-empty="미입력">${esc(sanitizePartyName(name))}</span></div>
      <div class="paperPartyRow"><span class="paperPartyKey">주소</span><span class="paperPartyVal" data-proof-bind="${esc(addressField)}" data-proof-empty="주소 미입력">${esc(sanitizeAddress(address))}</span></div>
    </div>
  `;
}

function integrityVerdictTone(status: string, trusted: boolean) {
  const s = String(status || '').trim();
  if (trusted || s === 'verified' || s === 'foreign') return 'ok';
  if (s === 'legacy' || s === 'pending' || s === 'missing' || s === 'process-log') return 'warn';
  return 'risk';
}

function formatIntegrityVerdict(row: Partial<PaperRecordRow>) {
  const status = String(row.verificationStatus || '').trim();
  if (String(row.kind || '') !== 'record') return '사건 대응 조치 로그';
  if (row.trusted || status === 'verified') return row.signedOnThisDevice ? '기기서명·해시체인 검증완료' : '기기서명 검증완료';
  if (status === 'foreign') return '해시체인 일치 · 타기기 서명';
  if (status === 'legacy') return 'SHA-256 리비전 체인 보존';
  if (status === 'pending') return '해시체인 일치 · 서명검증 대기';
  if (status === 'missing') return '해시체인 점검 가능 · 메타 보강 필요';
  if (status === 'process-log') return '사건 대응 조치 로그';
  return '추가 포렌식 검토 필요';
}

function formatIntegrityEvidence(row: Partial<PaperRecordRow>) {
  if (String(row.kind || '') !== 'record') {
    return row.verificationMessage || '발신인이 별도로 남긴 사건 대응 경과 로그입니다.';
  }
  const parts = [
    `REV ${Number(row.revisionCount || 0)}`,
    row.lastSealedAt ? `최종 봉인 ${row.lastSealedAt}` : '',
    row.integrityHash ? `SHA-256 ${shortHash(String(row.integrityHash || ''), 14, 10)}` : '',
    row.signatureAlgorithm === 'rust-ed25519-v1' ? 'Ed25519 전자서명' : '해시 체인 봉인',
    row.signerFingerprint ? `지문 ${shortHash(String(row.signerFingerprint || ''), 12, 10)}` : '',
  ].filter(Boolean);
  const tail = String(row.verificationMessage || '').trim();
  return [parts.join(' · '), tail].filter(Boolean).join(' / ');
}

function countIntegrityStats(records: PaperRecordRow[]) {
  const onlyRecords = records.filter((r) => r.kind === 'record');
  return {
    total: onlyRecords.length,
    verified: onlyRecords.filter((r) => String(r.verificationStatus || '') === 'verified' || !!r.trusted).length,
    foreign: onlyRecords.filter((r) => String(r.verificationStatus || '') === 'foreign').length,
    legacy: onlyRecords.filter((r) => String(r.verificationStatus || '') === 'legacy').length,
    review: onlyRecords.filter((r) => ['invalid', 'missing'].includes(String(r.verificationStatus || ''))).length,
  };
}

function kindLabel(k: string) {
  const s = String(k || '').trim().toLowerCase();
  if (s === 'record') return '기록';
  if (s === 'step') return '조치';
  if (s === 'advisor') return '권고';
  return '기타';
}

function dedupeRecordsForPaper(recs: RecordItem[]) {
  const seen = new Set<string>();
  const out: RecordItem[] = [];
  for (const r of recs) {
    const key = [dateKey(r.ts || ''), recordActorText(r), placeLabel(r.place, r.placeOther), String(r.summary || '').trim()].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function getPaperRecordMeta(record: RecordItem) {
  const vr = ensureRecordV8(record) as any;
  const revisions = getRecordRevisions(vr);
  const revisionCount = revisions.length;
  const amendCount = Math.max(0, revisionCount - 1);
  const originalSealedAt = String(vr?.integrity?.originalSealedAt || revisions[0]?.sealedAt || '');
  const lastSealedAt = String(vr?.integrity?.lastSealedAt || revisions[revisionCount - 1]?.sealedAt || '');
  const integrityHash = String(vr?.integrity?.currentHash || '');
  const revisionTrail = revisions
    .slice()
    .reverse()
    .map((rev: any) => {
      const badge = rev?.action === 'amend' ? '정정' : (rev?.action === 'legacy-import' ? '이관' : '원본');
      const reason = String(rev?.reason || '').trim() || (rev?.action === 'amend' ? '정정 봉인' : '초기 봉인');
      return `${badge} · ${fmt(String(rev?.sealedAt || ''))}${reason ? ` · ${reason}` : ''} · ${shortHash(String(rev?.hash || ''), 10, 8)}`;
    });
  return { vr, revisionCount, amendCount, originalSealedAt, lastSealedAt, integrityHash, revisionTrail };
}

function buildFactsSummary(recs: RecordItem[]) {
  const byDay = new Map<string, RecordItem[]>();
  for (const r of recs) {
    const dk = dateKey(r.ts || '');
    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk)!.push(r);
  }
  return Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([day, items]) => {
      const joined = items.slice(0, 2).map((r) => `${recordActorText(r)}(${placeLabel(r.place, r.placeOther)}): ${trunc(String(r.summary || '').trim(), 70)}`).join(' / ');
      return `${day} 기준 주요 경위는 다음과 같습니다. ${joined}`;
    });
}

function buildActionSummary(c: CaseItem) {
  const steps = (c.steps || []).slice().sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  if (!steps.length) return '발신인은 본 사안과 관련하여 별도 조치 로그를 정리·보관 중입니다.';
  const joined = steps.slice(0, 3).map((s) => `${fmt(String(s.ts || ''))} ${String(s.name || '').trim()}${String(s.note || '').trim() ? `(${trunc(String(s.note || '').trim(), 40)})` : ''}`).join(' / ');
  return `발신인의 확인·대응 조치로는 ${joined} 등이 있습니다.`;
}

function buildIntegritySummary(records: PaperRecordRow[]) {
  const total = records.filter((r) => r.kind === 'record').length;
  const verified = records.filter((r) => r.kind === 'record' && (String(r.verificationStatus || '') === 'verified' || !!r.trusted)).length;
  const foreign = records.filter((r) => r.kind === 'record' && String(r.verificationStatus || '') === 'foreign').length;
  const legacy = records.filter((r) => r.kind === 'record' && String(r.verificationStatus || '') === 'legacy').length;
  const amended = records.filter((r) => r.kind === 'record' && Number(r.revisionCount || 0) > 1).length;
  const review = records.filter((r) => r.kind === 'record' && ['invalid', 'missing'].includes(String(r.verificationStatus || ''))).length;
  return [
    '각 기록은 사건시각·주체·장소·요약 등 핵심 스냅샷을 정규화한 payload를 기준으로 SHA-256 해시를 산출하고, 각 리비전을 prevHash → currentHash 형태로 연쇄 연결해 관리합니다.',
    '서명 가능한 기록은 Rust Ed25519 전자서명, 공개키, 공개키 지문(fingerprint)을 함께 보관하여, 동일한 payload 재계산 결과와 전자서명 검증 결과를 이중으로 확인할 수 있도록 구성하였습니다.',
    `검증 분류: 총 ${total}건 중 기기서명·해시체인 검증완료 ${verified}건, 타기기 서명 포함 해시체인 일치 ${foreign}건, 레거시 해시체인 보존 ${legacy}건, 추가 검토 필요 ${review}건, 정정 이력 존재 ${amended}건입니다.`,
    '각 항목별 상세에는 최초 입력봉인 시각, 최종 수정봉인 시각, REV, 현재 SHA-256, 공개키 지문, revision trail을 병기하여 입력 이후 변경 여부를 추적할 수 있도록 하였습니다.',
    '다만 위 기술적 검증 결과는 증거보전과 설명을 위한 자료이며, 최종적인 증거능력과 증명력 판단은 원본 대조, 제출 경위, 증인신문 등과 함께 수사기관·법원의 심리에 따라 이루어집니다.',
  ];
}

function buildPaperPayload(
  c: CaseItem,
  recsAll: RecordItem[],
  _eventsAll: any[],
  generatedAtISO: string,
  hash: string | null,
  proofDraft?: Partial<ContentProofDraft>
): PaperPayload {
  const recs = dedupeRecordsForPaper(recsAll).slice().sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  const facts = buildFactsSummary(recs);
  const actionSummary = buildActionSummary(c);
  const subject = `[${String(c.title || '사안').trim() || '사안'}] 증거 증빙의 건`;

  const records: PaperRecordRow[] = recs.map((r) => {
    const meta = getPaperRecordMeta(r);
    const verified = verifyRecordIntegrity(meta.vr);
    const base: PaperRecordRow = {
      when: fmt(r.ts || ''),
      kind: 'record',
      lv: r.lv || '',
      actor: recordActorText(r),
      place: placeLabel(r.place, r.placeOther),
      summary: String(r.summary || '').trim(),
      id: r.id,
      reason: '사건 관련 증빙자료',
      originalSealedAt: meta.originalSealedAt ? fmt(meta.originalSealedAt) : '',
      lastSealedAt: meta.lastSealedAt ? fmt(meta.lastSealedAt) : '',
      revisionCount: meta.revisionCount,
      integrityHash: meta.integrityHash,
      revisionTrail: meta.revisionTrail,
      verificationStatus: String(verified.verificationStatus || ''),
      verificationMessage: String(verified.message || ''),
      signatureAlgorithm: String(verified.signatureAlgorithm || ''),
      signerFingerprint: String(verified.signerFingerprint || ''),
      trusted: !!verified.trusted,
      signedOnThisDevice: !!verified.signedOnThisDevice,
    };
    return {
      ...base,
      integrityVerdict: formatIntegrityVerdict(base),
      integrityEvidence: formatIntegrityEvidence(base),
    } as PaperRecordRow;
  });

  const steps = (c.steps || []).slice().sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  for (const s of steps) {
    records.push({
      when: fmt(String(s.ts || '')),
      kind: 'step',
      lv: String(s.lv || ''),
      actor: String(s.owner || '').trim() || '발신인',
      place: String(s.place || '').trim() || '-',
      summary: [String(s.name || '').trim(), String(s.note || '').trim()].filter(Boolean).join(' — ') || '-',
      id: String(s.id || ''),
      verificationStatus: 'process-log',
      verificationMessage: '사건 대응 경과를 설명하는 조치 로그입니다.',
      integrityVerdict: '사건 대응 조치 로그',
      integrityEvidence: '발신인이 보관 중인 조치 경과 기록입니다.',
    });
  }

  const integrityLines = buildIntegritySummary(records);

  return {
    title: subject,
    caseId: c.id,
    generatedAt: fmt(generatedAtISO),
    hashSha256: hash || '',
    senderName: sanitizePartyName(String(proofDraft?.senderName || '')),
    senderAddress: sanitizeAddress(String(proofDraft?.senderAddress || '')),
    recipientName: sanitizePartyName(String(proofDraft?.recipientName || '')),
    recipientAddress: sanitizeAddress(String(proofDraft?.recipientAddress || '')),
    subject,
    statementLines: [
      `귀하와 관련된 「${String(c.title || '').trim() || '사안'}」 사안에 관하여, 사실관계 및 증빙자료를 아래와 같이 정리하여 통지합니다.`,
      ...facts,
      actionSummary,
      '별지 기재 각 자료는 본 사안의 경위, 관련 의사소통, 조치 내용 및 후속 대응 필요성을 확인하기 위한 증빙자료입니다.',
    ],
    actionLines: [
      '귀하는 본 통지서를 수령한 즉시 본 사안과 관련된 문자, 메신저, 이메일, 녹음, 사진, 문서 기타 원본 자료를 임의로 삭제·수정·은닉하지 마시기 바랍니다.',
      '귀하의 입장이나 소명자료가 있는 경우 서면으로 회신해 주시기 바랍니다.',
      '향후 사실과 다른 주장 또는 추가적인 불이익 조치가 계속될 경우, 발신인은 본 통지서 및 첨부 증빙을 토대로 관계 기관 제출, 수사기관 신고, 법률 검토 및 민·형사상 절차 진행 여부를 검토할 예정입니다.',
    ],
    integrityLines,
    records,
  };
}

export { buildPaperPayload };

function koreanOutlineMarker(idx: number) {
  const markers = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카', '타', '파', '하'];
  return markers[idx] ?? `${idx + 1}`;
}

function renderContentProofHTML(payload: PaperPayload) {
  const statementItems = payload.statementLines
    .map((line, idx) => `<li><span class="paperNo">${idx + 1}.</span><span>${esc(line)}</span></li>`)
    .join('');
  const actionItems = payload.actionLines
    .map((line, idx) => `<li><span class="paperNo">${koreanOutlineMarker(idx)}.</span><span>${esc(line)}</span></li>`)
    .join('');
  const integrityItems = payload.integrityLines
    .map((line) => `<li>${esc(line)}</li>`)
    .join('');
  const stats = countIntegrityStats(payload.records);
  const evidenceRows = payload.records
    .map((r, idx) => {
      const tone = integrityVerdictTone(String(r.verificationStatus || ''), !!r.trusted);
      return `
      <tr>
        <td data-label="번호">${idx + 1}</td>
        <td data-label="구분">${esc(kindLabel(r.kind))}</td>
        <td data-label="일시">${esc(r.when || '-')}</td>
        <td data-label="증빙 요지">${esc(trunc(r.summary || '-', 82))}</td>
        <td data-label="무결성 결론"><span class="paperVerdictTag ${esc(tone)}">${esc(String(r.integrityVerdict || formatIntegrityVerdict(r)))}</span></td>
        <td data-label="검증 근거"><div class="paperEvidenceMeta"><div class="paperEvidenceSub">${esc(String(r.integrityEvidence || formatIntegrityEvidence(r) || '-'))}</div></div></td>
      </tr>
    `;
    })
    .join('');

  return `
    <div class="paperContentProof">
      <div class="paperDocTitle">내 용 증 명 서</div>
      <div class="paperPartyGrid">
        ${partyBlockHTML('발신인', 'senderName', 'senderAddress', payload.senderName, payload.senderAddress)}
        ${partyBlockHTML('수신인', 'recipientName', 'recipientAddress', payload.recipientName, payload.recipientAddress)}
      </div>

      <div class="paperSubjectBox">
        <div class="paperSubjectLabel">제목</div>
        <div class="paperSubjectValue">${esc(payload.subject)}</div>
      </div>

      <div class="paperIntegrityHero">
        <div class="paperIntegrityStat"><div class="paperIntegrityStatK">총 증빙기록</div><div class="paperIntegrityStatV">${stats.total}건</div></div>
        <div class="paperIntegrityStat"><div class="paperIntegrityStatK">검증완료</div><div class="paperIntegrityStatV">${stats.verified}건</div></div>
        <div class="paperIntegrityStat"><div class="paperIntegrityStatK">타기기/레거시</div><div class="paperIntegrityStatV">${stats.foreign + stats.legacy}건</div></div>
        <div class="paperIntegrityStat"><div class="paperIntegrityStatK">추가검토</div><div class="paperIntegrityStatV">${stats.review}건</div></div>
      </div>

      <div class="paperSection">
        <div class="paperH">1) 통지 내용</div>
        <ol class="paperProofList">${statementItems}</ol>
      </div>

      <div class="paperSection">
        <div class="paperH">2) 요구 및 향후 조치</div>
        <ol class="paperProofList">${actionItems}</ol>
      </div>

      <div class="paperSection">
        <div class="paperH">3) 증빙자료 목록</div>
        <div class="paperTableWrap">
          <table class="paperTable paperTableResponsive">
            <thead><tr><th style="width:48px">번호</th><th style="width:64px">구분</th><th style="width:102px">일시</th><th>증빙 요지</th><th style="width:188px">무결성 결론</th><th style="width:280px">검증 근거</th></tr></thead>
            <tbody>${evidenceRows}</tbody>
          </table>
        </div>
      </div>

      <div class="paperSection">
        <div class="paperH">4) 무결성 검증 요약</div>
        <ul class="paperList">${integrityItems}</ul>
        <div class="paperHashBox">문서 전체 SHA-256: <code>${esc(payload.hashSha256 || '-')}</code></div>
      </div>

      <div class="paperProofFoot">
        <div>${esc(payload.generatedAt)}</div>
        <div style="margin-top:28px">발신인 <span data-proof-bind="senderName" data-proof-empty="미입력">${esc(payload.senderName)}</span></div>
      </div>
    </div>
  `;
}

export function renderCasePaperModal() {
  const c = ui.paperCaseId ? S.cases[ui.paperCaseId] ?? null : null;
  if (!c) return '';

  const generatedAt = nowISO();
  const recs = recordsForCase(S.records, c);
  const draft = ((ui as any).contentProofDraft || { senderName: '', senderAddress: '', recipientName: '', recipientAddress: '' }) as ContentProofDraft;
  const payload = buildPaperPayload(c, recs, [], generatedAt, ui.paperHash, draft);
  const inner = renderContentProofHTML(payload);

  return `
  <dialog class="modal paperModal" id="paperModal">
    <div class="modalHead">
      <div class="paperModalLead">
        <div class="h2">내용증명 생성</div>
        <div class="muted">발신인·수신인 이름과 주소를 분리 입력한 뒤, 증빙자료 및 무결성 검증 요약이 포함된 PDF를 저장할 수 있어요.</div>
      </div>
      <div class="paperModalActions">
        <button class="btn primary" data-action="print-paper" type="button">PDF로 저장</button>
        <button class="btn" data-action="close-paper" type="button">닫기</button>
      </div>
    </div>

    <div class="paperViewport" aria-label="내용증명 미리보기">
      <div class="paperSheet">
        <div class="paperContent">
          <div class="paperProofForm">
            <div class="paperProofFormHead">
              <div>
                <div class="paperProofFormTitle">송달 정보 입력</div>
                <div class="paperProofFormHint">이름과 주소를 분리 입력하면 PDF에서 내용증명서 형식으로 정렬되고, 주소 줄바꿈도 그대로 반영돼요.</div>
              </div>
              <div class="paperProofStatus" id="contentProofStatus">송달 정보 0/4 입력</div>
            </div>
            <div class="paperProofGrid">
              <section class="paperProofPartyCard" data-proof-party="sender">
                <div class="paperProofPartyHead">
                  <div class="paperProofPartyTitle">발신인</div>
                  <div class="paperProofPartyBadge">보내는 사람</div>
                </div>
                <div class="paperProofField">
                  <label for="contentProofSenderName">발신인 이름</label>
                  <input id="contentProofSenderName" type="text" autocomplete="name" value="${esc(draft.senderName || '')}" data-action="draft-content-proof" data-field="senderName" placeholder="예: 홍길동" />
                </div>
                <div class="paperProofField">
                  <label for="contentProofSenderAddress">발신인 주소</label>
                  <textarea id="contentProofSenderAddress" rows="3" autocomplete="street-address" data-action="draft-content-proof" data-field="senderAddress" placeholder="예: 서울특별시 ○○구 ○○로 00, ○○아파트 101동 1001호">${esc(draft.senderAddress || '')}</textarea>
                  <div class="paperProofMiniHint">상세주소까지 적으면 PDF에서도 줄바꿈을 유지해서 배치합니다.</div>
                </div>
              </section>
              <section class="paperProofPartyCard" data-proof-party="recipient">
                <div class="paperProofPartyHead">
                  <div class="paperProofPartyTitle">수신인</div>
                  <div class="paperProofPartyBadge">받는 사람</div>
                </div>
                <div class="paperProofField">
                  <label for="contentProofRecipientName">수신인 이름</label>
                  <input id="contentProofRecipientName" type="text" autocomplete="name" value="${esc(draft.recipientName || '')}" data-action="draft-content-proof" data-field="recipientName" placeholder="예: 김영희" />
                </div>
                <div class="paperProofField">
                  <label for="contentProofRecipientAddress">수신인 주소</label>
                  <textarea id="contentProofRecipientAddress" rows="3" autocomplete="street-address" data-action="draft-content-proof" data-field="recipientAddress" placeholder="예: 경기도 ○○시 ○○로 00, ○○빌라 202호">${esc(draft.recipientAddress || '')}</textarea>
                  <div class="paperProofMiniHint">법인/기관이면 기관명과 담당자 표기를 함께 적어도 됩니다.</div>
                </div>
              </section>
            </div>
            <div class="paperProofQuickHint">PDF에는 원본 보고서 대신 내용증명서 형식으로, 증거별 SHA-256·REV·봉인시각·전자서명/공개키 지문 기반 검증근거가 함께 정리됩니다.</div>
          </div>
          ${inner}
        </div>
      </div>
    </div>
  </dialog>
  `;
}

/* ======================================================
 * Hash (unchanged)
 * ====================================================== */

export async function computeCasePaperHash(c: CaseItem) {
  try {
    const payload = JSON.stringify({
      case: c,
      records: dedupeRecordsForPaper(recordsForCase(S.records, c)),
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

