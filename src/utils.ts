import { invoke } from '@tauri-apps/api/core';
import type {
  Sensitivity,
  ActorType,
  ActorRef,
  StoreType,
  PlaceType,
  RecordItem,
  CaseSensFilter,
  CaseStatus,
  StepItem,
  AdvisorItem,
  CaseItem,
  RecordRisk,
} from './engine';

export const LS_KEY = 'roosycozy_state_v1';
export const LS_SEED_DISABLED_KEY = 'roosycozy_seed_disabled_v1';
export const LS_DEVICE_SIGNER_FINGERPRINT_KEY = 'roosycozy_device_signer_fingerprint_v1';
export const LS_DEVICE_SIGNER_PUBLIC_KEY_KEY = 'roosycozy_device_signer_public_key_v1';

export const IS_TAURI =
  typeof window !== 'undefined' &&
  (Boolean((window as any).__TAURI__) || (typeof (window as any).isTauri === 'function' && (window as any).isTauri()));

const ls = () => (typeof localStorage === 'undefined' ? null : localStorage);

export const storageGet = async (): Promise<string | null> => ls()?.getItem(LS_KEY) ?? null;
export const storageSet = async (value: string): Promise<void> => void ls()?.setItem(LS_KEY, value);
export const storageRemove = async (): Promise<void> => void ls()?.removeItem(LS_KEY);

export type RecordRevisionAction = 'create' | 'amend' | 'legacy-import';
export type SealAlgorithm = 'rust-ed25519-v1' | 'legacy-chain-v8';
export type SealVerificationStatus = 'verified' | 'legacy' | 'foreign' | 'missing' | 'invalid' | 'pending';

export type CryptoVerificationCache = {
  valid: boolean;
  code: string;
  message: string;
  verifiedAt: string;
  signerFingerprint: string;
  signerPublicKey?: string;
  algorithm: SealAlgorithm;
};

export type RecordRevisionV8 = {
  rev: number;
  revisionId: string;
  action: RecordRevisionAction;
  sealedAt: string;
  eventAt: string;
  reason: string;
  signerLabel: string;
  prevHash: string;
  hash: string;
  payloadHash?: string;
  hashAlgorithm?: 'sha256';
  signature?: string;
  signatureAlgorithm?: SealAlgorithm;
  signerFingerprint?: string;
  signerPublicKey?: string;
  actorSnapshot: ActorRef;
  relatedSnapshot: ActorRef[];
  placeSnapshot: PlaceType;
  placeOtherSnapshot: string;
  storeTypeSnapshot: StoreType;
  storeOtherSnapshot: string;
  lvSnapshot: Sensitivity;
  summarySnapshot: string;
  legacyImported?: boolean;
};

export type RecordIntegrityV8 = {
  schema: 'roosycozy-record/v10' | 'roosycozy-record/v9' | 'roosycozy-record/v8';
  immutable: true;
  recordId: string;
  originalHash: string;
  currentHash: string;
  originalSealedAt: string;
  lastSealedAt: string;
  createdEventAt: string;
  updatedEventAt: string;
  revisionCount: number;
  signatureAlgorithm?: SealAlgorithm;
  signerFingerprint?: string;
  signerPublicKey?: string;
  legacyImported?: boolean;
  crypto?: CryptoVerificationCache;
  revisions: RecordRevisionV8[];
};

export type RecordV8 = RecordItem & { integrity?: RecordIntegrityV8 };

export type AppState = {
  v: 10;
  tab: 'records' | 'cases';
  selectedCaseId: string | null;
  records: RecordV8[];
  cases: Record<string, CaseItem>;
};

export type DeviceSignerInfo = {
  algorithm: SealAlgorithm;
  signerFingerprint: string;
  signerPublicKey: string;
};

export type SignedBackupEnvelope = {
  schema: 'roosycozy-backup/v3';
  exportedAt: string;
  note: string;
  state: AppState;
  manifest: {
    algorithm: SealAlgorithm;
    stateHash: string;
    signature: string;
    signerFingerprint: string;
    signerPublicKey: string;
  };
};

export const STATUSES: CaseStatus[] = ['진행중', '답변 준비', '종결'];

export const uid = (prefix = 'id') => `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
export const nowISO = () => new Date().toISOString();
const z2 = (n: number) => String(n).padStart(2, '0');
export const fmt = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}.${z2(d.getMonth() + 1)}.${z2(d.getDate())}  ${z2(d.getHours())}:${z2(d.getMinutes())}`;
};
export const toLocalInputValue = (iso?: string) => {
  const d = iso ? new Date(iso) : new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
};
export const fromLocalInputValue = (val?: string) => {
  if (!val) return nowISO();
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? nowISO() : d.toISOString();
};
export const safeParseJSON = (text: string): unknown => { try { return JSON.parse(text); } catch { return null; } };
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' } as any)[m]);
export const mustGetEl = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el as T;
};
export const trunc = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t;
};
export const shortHash = (hash: string, left = 10, right = 8) => {
  const s = String(hash || '').trim();
  if (!s) return '—';
  if (/^0+$/.test(s)) return '—';
  if (s.length <= left + right + 1) return s;
  return `${s.slice(0, left)}…${s.slice(-right)}`;
};

const str = (x: any, d = '') => (x === undefined || x === null ? d : String(x));
const obj = (x: any) => (x && typeof x === 'object' ? x : null);
const arr = (x: any) => (Array.isArray(x) ? x : []);
const trim = (x: any) => str(x, '').trim();
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const stableStringify = (value: unknown): string => {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
};

function sha256Ascii(ascii: string): string {
  const rightRotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  const lengthProperty = 'length';
  let i: number;
  let j: number;
  let result = '';
  const words: number[] = [];
  const asciiBitLength = ascii[lengthProperty] * 8;

  const hash: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;
  const isComposite: Record<number, boolean> = {};
  for (let candidate = 2; primeCounter < 64; candidate += 1) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) isComposite[i] = true;
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      primeCounter += 1;
    }
  }

  ascii += '\x80';
  while ((ascii[lengthProperty] % 64) !== 56) ascii += '\x00';
  for (i = 0; i < ascii[lengthProperty]; i += 1) {
    j = ascii.charCodeAt(i);
    words[i >> 2] |= j << (((3 - i) % 4) * 8);
  }
  words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0;
  words[words[lengthProperty]] = asciiBitLength;

  for (j = 0; j < words[lengthProperty];) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash.slice(0, 8);
    const working = hash.slice(0, 8);
    for (i = 0; i < 64; i += 1) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const a = working[0];
      const e = working[4];
      const temp1 = (working[7]
        + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
        + ((e & working[5]) ^ ((~e) & working[6]))
        + k[i]
        + (w[i] = i < 16 ? w[i] : (
          w[i - 16]
          + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
          + w[i - 7]
          + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
        ) | 0)) | 0;
      const temp2 = ((rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) + ((a & working[1]) ^ (a & working[2]) ^ (working[1] & working[2]))) | 0;
      working.unshift((temp1 + temp2) | 0);
      working[4] = (working[4] + temp1) | 0;
      working.pop();
    }
    for (i = 0; i < 8; i += 1) hash[i] = (hash[i] + oldHash[i]) | 0;
  }

  for (i = 0; i < 8; i += 1) {
    for (j = 3; j >= 0; j -= 1) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += ((b < 16) ? '0' : '') + b.toString(16);
    }
  }
  return result;
}
export const sha256Hex = (input: string) => sha256Ascii(unescape(encodeURIComponent(String(input ?? ''))));

const readCachedDeviceSignerInfo = (): DeviceSignerInfo | null => {
  const fp = trim(ls()?.getItem(LS_DEVICE_SIGNER_FINGERPRINT_KEY));
  const pk = trim(ls()?.getItem(LS_DEVICE_SIGNER_PUBLIC_KEY_KEY));
  if (!fp || !pk) return null;
  return { algorithm: 'rust-ed25519-v1', signerFingerprint: fp, signerPublicKey: pk };
};

const cacheDeviceSignerInfo = (info: DeviceSignerInfo | null) => {
  if (!info) return;
  void ls()?.setItem(LS_DEVICE_SIGNER_FINGERPRINT_KEY, info.signerFingerprint || '');
  void ls()?.setItem(LS_DEVICE_SIGNER_PUBLIC_KEY_KEY, info.signerPublicKey || '');
};

export const getCachedDeviceSignerFingerprint = () => readCachedDeviceSignerInfo()?.signerFingerprint || '';

export const refreshDeviceSignerInfo = async (): Promise<DeviceSignerInfo | null> => {
  if (!IS_TAURI) return readCachedDeviceSignerInfo();
  try {
    const info = await invoke<DeviceSignerInfo>('get_device_signer_info');
    if (info && info.signerFingerprint && info.signerPublicKey) {
      cacheDeviceSignerInfo({ algorithm: 'rust-ed25519-v1', signerFingerprint: info.signerFingerprint, signerPublicKey: info.signerPublicKey });
      return { algorithm: 'rust-ed25519-v1', signerFingerprint: info.signerFingerprint, signerPublicKey: info.signerPublicKey };
    }
  } catch {}
  return readCachedDeviceSignerInfo();
};

type SignPayloadResult = {
  algorithm: SealAlgorithm;
  payloadSha256: string;
  signature: string;
  signerFingerprint: string;
  signerPublicKey: string;
};

type VerifyPayloadResult = {
  valid: boolean;
  code: string;
  message: string;
  algorithm: SealAlgorithm;
  payloadSha256: string;
  signerFingerprint: string;
};

const signIntegrityPayload = async (payload: string, label = 'integrity-payload'): Promise<SignPayloadResult> => {
  if (!IS_TAURI) {
    const localHash = sha256Hex(payload);
    return { algorithm: 'legacy-chain-v8', payloadSha256: localHash, signature: '', signerFingerprint: '', signerPublicKey: '' };
  }
  const res = await invoke<SignPayloadResult>('sign_integrity_payload', { args: { payload, label } });
  if (res?.signerFingerprint && res?.signerPublicKey) {
    cacheDeviceSignerInfo({ algorithm: 'rust-ed25519-v1', signerFingerprint: res.signerFingerprint, signerPublicKey: res.signerPublicKey });
  }
  return res;
};

const verifyIntegrityPayload = async (payload: string, signature: string, signerPublicKey: string, signerFingerprint = ''): Promise<VerifyPayloadResult> => {
  if (!IS_TAURI) {
    return {
      valid: false,
      code: 'tauri-unavailable',
      message: 'Rust 검증기를 사용할 수 없어요.',
      algorithm: 'legacy-chain-v8',
      payloadSha256: sha256Hex(payload),
      signerFingerprint,
    };
  }
  return invoke<VerifyPayloadResult>('verify_integrity_payload', { args: { payload, signature, signerPublicKey, signerFingerprint } });
};

const actorMain = (a: any): ActorRef => {
  const o = obj(a) ?? {};
  return { type: (o.type ?? '외부인') as ActorType, name: trim(o.name) };
};
const actorRel = (a: any): ActorRef | null => {
  const a2 = actorMain(a);
  return a2.name ? a2 : null;
};

export type RecordSnapshotV8 = {
  id: string;
  eventAt: string;
  storeType: StoreType;
  storeOther: string;
  lv: Sensitivity;
  actor: ActorRef;
  related: ActorRef[];
  place: PlaceType;
  placeOther: string;
  summary: string;
};

export const getRecordSnapshot = (r: any): RecordSnapshotV8 => ({
  id: str(r?.id, uid('REC')),
  eventAt: str(r?.ts, nowISO()),
  storeType: (r?.storeType ?? '문서') as StoreType,
  storeOther: str(r?.storeOther, ''),
  lv: (r?.lv ?? 'LV2') as Sensitivity,
  actor: actorMain(r?.actor),
  related: arr(r?.related).map(actorRel).filter(Boolean) as ActorRef[],
  place: (r?.place ?? '기타') as PlaceType,
  placeOther: str(r?.placeOther, ''),
  summary: str(r?.summary, ''),
});

const revisionPayload = (args: {
  recordId: string;
  rev: number;
  revisionId: string;
  action: RecordRevisionAction;
  sealedAt: string;
  eventAt: string;
  reason: string;
  signerLabel: string;
  prevHash: string;
  actorSnapshot: ActorRef;
  relatedSnapshot: ActorRef[];
  placeSnapshot: PlaceType;
  placeOtherSnapshot: string;
  storeTypeSnapshot: StoreType;
  storeOtherSnapshot: string;
  lvSnapshot: Sensitivity;
  summarySnapshot: string;
  legacyImported?: boolean;
}) => ({
  schema: 'roosycozy-record-revision/v10',
  recordId: args.recordId,
  rev: args.rev,
  revisionId: args.revisionId,
  action: args.action,
  sealedAt: args.sealedAt,
  eventAt: args.eventAt,
  reason: args.reason,
  signerLabel: args.signerLabel,
  prevHash: args.prevHash,
  actorSnapshot: { type: str(args.actorSnapshot?.type, '외부인'), name: trim(args.actorSnapshot?.name) },
  relatedSnapshot: (args.relatedSnapshot || []).map((x) => ({ type: str(x?.type, '외부인'), name: trim(x?.name) })),
  placeSnapshot: args.placeSnapshot,
  placeOtherSnapshot: str(args.placeOtherSnapshot, ''),
  storeTypeSnapshot: args.storeTypeSnapshot,
  storeOtherSnapshot: str(args.storeOtherSnapshot, ''),
  lvSnapshot: args.lvSnapshot,
  summarySnapshot: str(args.summarySnapshot, ''),
  legacyImported: !!args.legacyImported,
});
const hashRevision = (payload: ReturnType<typeof revisionPayload>) => sha256Hex(stableStringify(payload));

const buildRevisionPayloadFromSnapshot = (snapshot: RecordSnapshotV8, args: { rev: number; action: RecordRevisionAction; sealedAt: string; reason: string; signerLabel?: string; prevHash?: string; legacyImported?: boolean; revisionId?: string; }) => revisionPayload({
  recordId: snapshot.id,
  rev: args.rev,
  revisionId: str(args.revisionId, uid('REV')),
  action: args.action,
  sealedAt: args.sealedAt,
  eventAt: snapshot.eventAt,
  reason: str(args.reason, ''),
  signerLabel: str(args.signerLabel, '기기 봉인서명'),
  prevHash: str(args.prevHash, ''),
  actorSnapshot: snapshot.actor,
  relatedSnapshot: snapshot.related,
  placeSnapshot: snapshot.place,
  placeOtherSnapshot: snapshot.placeOther,
  storeTypeSnapshot: snapshot.storeType,
  storeOtherSnapshot: snapshot.storeOther,
  lvSnapshot: snapshot.lv,
  summarySnapshot: snapshot.summary,
  legacyImported: !!args.legacyImported,
});

const makeLegacyRevision = (snapshot: RecordSnapshotV8, args: { rev: number; action: RecordRevisionAction; sealedAt: string; reason: string; signerLabel?: string; prevHash?: string; legacyImported?: boolean; revisionId?: string; }): RecordRevisionV8 => {
  const payload = buildRevisionPayloadFromSnapshot(snapshot, args);
  const hash = hashRevision(payload);
  return {
    ...payload,
    hash,
    payloadHash: hash,
    hashAlgorithm: 'sha256',
    signatureAlgorithm: 'legacy-chain-v8',
  } as RecordRevisionV8;
};

const makeSignedRevision = async (snapshot: RecordSnapshotV8, args: { rev: number; action: RecordRevisionAction; sealedAt: string; reason: string; signerLabel?: string; prevHash?: string; legacyImported?: boolean; revisionId?: string; }): Promise<RecordRevisionV8> => {
  const payload = buildRevisionPayloadFromSnapshot(snapshot, args);
  const canonical = stableStringify(payload);
  const sign = await signIntegrityPayload(canonical, `record:${snapshot.id}:rev:${args.rev}`);
  const payloadHash = sha256Hex(canonical);
  return {
    ...payload,
    hash: sign.payloadSha256 || payloadHash,
    payloadHash: sign.payloadSha256 || payloadHash,
    hashAlgorithm: 'sha256',
    signature: sign.signature || undefined,
    signatureAlgorithm: sign.signature ? 'rust-ed25519-v1' : 'legacy-chain-v8',
    signerFingerprint: sign.signerFingerprint || undefined,
    signerPublicKey: sign.signerPublicKey || undefined,
  } as RecordRevisionV8;
};

const buildIntegrity = (recordId: string, revisions: RecordRevisionV8[], opts?: { crypto?: CryptoVerificationCache }): RecordIntegrityV8 => {
  const first = revisions[0];
  const last = revisions[revisions.length - 1];
  const lastSigned = revisions.slice().reverse().find((x) => x?.signature && x?.signatureAlgorithm === 'rust-ed25519-v1');
  const hasSigned = revisions.some((x) => x?.signature && x?.signatureAlgorithm === 'rust-ed25519-v1');
  return {
    schema: 'roosycozy-record/v10',
    immutable: true,
    recordId,
    originalHash: first?.hash || '',
    currentHash: last?.hash || '',
    originalSealedAt: first?.sealedAt || '',
    lastSealedAt: last?.sealedAt || '',
    createdEventAt: first?.eventAt || '',
    updatedEventAt: last?.eventAt || '',
    revisionCount: revisions.length,
    signatureAlgorithm: hasSigned ? 'rust-ed25519-v1' : 'legacy-chain-v8',
    signerFingerprint: lastSigned?.signerFingerprint || '',
    signerPublicKey: lastSigned?.signerPublicKey || '',
    legacyImported: revisions.some((x) => !!x.legacyImported),
    crypto: opts?.crypto ? clone(opts.crypto) : undefined,
    revisions: clone(revisions),
  };
};

const applySnapshot = (base: any, snapshot: RecordSnapshotV8, integrity: RecordIntegrityV8): RecordV8 => ({
  ...(base || {}),
  id: snapshot.id,
  ts: snapshot.eventAt,
  storeType: snapshot.storeType,
  storeOther: snapshot.storeOther,
  lv: snapshot.lv,
  actor: clone(snapshot.actor),
  related: clone(snapshot.related),
  place: snapshot.place,
  placeOther: snapshot.placeOther,
  summary: snapshot.summary,
  integrity: clone(integrity),
}) as RecordV8;

const cryptoCacheForNewSignature = (rev: RecordRevisionV8): CryptoVerificationCache | undefined => {
  if (!rev.signature || !rev.signerFingerprint) return undefined;
  return {
    valid: true,
    code: 'ok',
    message: 'Rust Ed25519 서명이 저장 시점에 확인됐어요.',
    verifiedAt: nowISO(),
    signerFingerprint: String(rev.signerFingerprint || ''),
    signerPublicKey: String(rev.signerPublicKey || ''),
    algorithm: 'rust-ed25519-v1',
  };
};

export const migrateLegacyRecord = (record: any): RecordV8 => {
  const snapshot = getRecordSnapshot(record);
  const rev = makeLegacyRevision(snapshot, {
    rev: 1,
    action: 'legacy-import',
    sealedAt: snapshot.eventAt || nowISO(),
    reason: 'v7/v8 기록을 레거시 봉인 이력으로 이관',
    signerLabel: 'LEGACY IMPORT',
    prevHash: '',
    legacyImported: true,
  });
  return applySnapshot(record, snapshot, buildIntegrity(snapshot.id, [rev]));
};

const hydrateRecord = (record: any, rawIntegrity: any): RecordV8 => {
  const fallback = getRecordSnapshot(record);
  const rawRevs = arr(rawIntegrity?.revisions);
  if (!rawRevs.length) return migrateLegacyRecord(record);

  const revisions: RecordRevisionV8[] = [];
  for (let i = 0; i < rawRevs.length; i += 1) {
    const rr = obj(rawRevs[i]) ?? {};
    const snapshot: RecordSnapshotV8 = {
      id: str(rawIntegrity?.recordId || record?.id, fallback.id),
      eventAt: str(rr.eventAt, fallback.eventAt),
      storeType: (rr.storeTypeSnapshot ?? fallback.storeType) as StoreType,
      storeOther: str(rr.storeOtherSnapshot, fallback.storeOther),
      lv: (rr.lvSnapshot ?? fallback.lv) as Sensitivity,
      actor: actorMain(rr.actorSnapshot ?? fallback.actor),
      related: arr(rr.relatedSnapshot ?? fallback.related).map(actorRel).filter(Boolean) as ActorRef[],
      place: (rr.placeSnapshot ?? fallback.place) as PlaceType,
      placeOther: str(rr.placeOtherSnapshot, fallback.placeOther),
      summary: str(rr.summarySnapshot, fallback.summary),
    };
    const payload = buildRevisionPayloadFromSnapshot(snapshot, {
      rev: typeof rr.rev === 'number' ? rr.rev : i + 1,
      revisionId: str(rr.revisionId, `REV_${i + 1}`),
      action: (rr.action === 'amend' || rr.action === 'legacy-import' ? rr.action : 'create') as RecordRevisionAction,
      sealedAt: str(rr.sealedAt, snapshot.eventAt),
      reason: str(rr.reason, rr.action === 'amend' ? '정정 기록' : '기록 봉인'),
      signerLabel: str(rr.signerLabel, rr.action === 'legacy-import' ? 'LEGACY IMPORT' : '기기 봉인서명'),
      prevHash: str(rr.prevHash, i === 0 ? '' : str(revisions[i - 1]?.hash, '')),
      legacyImported: !!rr.legacyImported,
    });
    const expectedHash = hashRevision(payload);
    const signatureAlgorithm: SealAlgorithm = (rr.signatureAlgorithm === 'rust-ed25519-v1' || !!rr.signature || !!rr.signerPublicKey)
      ? 'rust-ed25519-v1'
      : 'legacy-chain-v8';
    revisions.push({
      ...payload,
      hash: str(rr.hash, expectedHash),
      payloadHash: str(rr.payloadHash, str(rr.hash, expectedHash)),
      hashAlgorithm: 'sha256',
      signature: trim(rr.signature) || undefined,
      signatureAlgorithm,
      signerFingerprint: trim(rr.signerFingerprint) || undefined,
      signerPublicKey: trim(rr.signerPublicKey) || undefined,
      legacyImported: !!rr.legacyImported,
    } as RecordRevisionV8);
  }

  const last = revisions[revisions.length - 1];
  const latest: RecordSnapshotV8 = {
    id: str(rawIntegrity?.recordId || record?.id, fallback.id),
    eventAt: last?.eventAt || fallback.eventAt,
    storeType: (last?.storeTypeSnapshot ?? fallback.storeType) as StoreType,
    storeOther: str(last?.storeOtherSnapshot, fallback.storeOther),
    lv: (last?.lvSnapshot ?? fallback.lv) as Sensitivity,
    actor: actorMain(last?.actorSnapshot ?? fallback.actor),
    related: arr(last?.relatedSnapshot ?? fallback.related).map(actorRel).filter(Boolean) as ActorRef[],
    place: (last?.placeSnapshot ?? fallback.place) as PlaceType,
    placeOther: str(last?.placeOtherSnapshot, fallback.placeOther),
    summary: str(last?.summarySnapshot, fallback.summary),
  };

  const crypto = obj(rawIntegrity?.crypto)
    ? {
        valid: !!rawIntegrity.crypto.valid,
        code: str(rawIntegrity.crypto.code, ''),
        message: str(rawIntegrity.crypto.message, ''),
        verifiedAt: str(rawIntegrity.crypto.verifiedAt, ''),
        signerFingerprint: str(rawIntegrity.crypto.signerFingerprint, ''),
        signerPublicKey: str(rawIntegrity.crypto.signerPublicKey, ''),
        algorithm: (rawIntegrity.crypto.algorithm === 'rust-ed25519-v1' ? 'rust-ed25519-v1' : 'legacy-chain-v8') as SealAlgorithm,
      }
    : undefined;

  return applySnapshot(record, latest, buildIntegrity(latest.id, revisions, { crypto }));
};

export const ensureRecordV8 = (record: any): RecordV8 => {
  const o = obj(record) ?? {};
  const integrity = obj((o as any).integrity);
  return integrity ? hydrateRecord(o, integrity) : migrateLegacyRecord(o);
};

export const sealNewRecord = async (record: RecordItem, opts?: { sealedAt?: string; signerLabel?: string; reason?: string; }): Promise<RecordV8> => {
  const snapshot = getRecordSnapshot(record);
  const rev = IS_TAURI
    ? await makeSignedRevision(snapshot, {
        rev: 1,
        action: 'create',
        sealedAt: str(opts?.sealedAt, nowISO()),
        reason: str(opts?.reason, '초기 기록 봉인'),
        signerLabel: str(opts?.signerLabel, '기기 봉인서명'),
      })
    : makeLegacyRevision(snapshot, {
        rev: 1,
        action: 'create',
        sealedAt: str(opts?.sealedAt, nowISO()),
        reason: str(opts?.reason, '초기 기록 봉인'),
        signerLabel: str(opts?.signerLabel, '레거시 봉인'),
      });
  return applySnapshot(record, snapshot, buildIntegrity(snapshot.id, [rev], { crypto: cryptoCacheForNewSignature(rev) }));
};

export const amendSignedRecord = async (prevRecord: any, nextRecord: RecordItem, opts?: { sealedAt?: string; signerLabel?: string; reason?: string; }): Promise<RecordV8> => {
  const current = ensureRecordV8(prevRecord || nextRecord) as any;
  const integrity = current.integrity as RecordIntegrityV8;
  const snapshot = getRecordSnapshot({ ...nextRecord, id: current.id });
  const rev = IS_TAURI
    ? await makeSignedRevision(snapshot, {
        rev: (integrity?.revisions || []).length + 1,
        action: 'amend',
        sealedAt: str(opts?.sealedAt, nowISO()),
        reason: str(opts?.reason, '기록 정정 및 재봉인'),
        signerLabel: str(opts?.signerLabel, '기기 봉인서명'),
        prevHash: integrity?.currentHash || '',
      })
    : makeLegacyRevision(snapshot, {
        rev: (integrity?.revisions || []).length + 1,
        action: 'amend',
        sealedAt: str(opts?.sealedAt, nowISO()),
        reason: str(opts?.reason, '기록 정정 및 재봉인'),
        signerLabel: str(opts?.signerLabel, '레거시 봉인'),
        prevHash: integrity?.currentHash || '',
      });
  return applySnapshot(current, snapshot, buildIntegrity(snapshot.id, [...(integrity?.revisions || []), rev], { crypto: cryptoCacheForNewSignature(rev) }));
};

export const getRecordRevisions = (record: any): RecordRevisionV8[] => {
  const r = ensureRecordV8(record) as any;
  return arr(r?.integrity?.revisions) as RecordRevisionV8[];
};
export const getRecordRevisionCount = (record: any) => getRecordRevisions(record).length;

const revisionPayloadFromRevision = (rev: any) => revisionPayload({
  recordId: str(rev.recordId, ''),
  rev: typeof rev.rev === 'number' ? rev.rev : 1,
  revisionId: str(rev.revisionId, 'REV_1'),
  action: (rev.action === 'amend' || rev.action === 'legacy-import' ? rev.action : 'create') as RecordRevisionAction,
  sealedAt: str(rev.sealedAt, ''),
  eventAt: str(rev.eventAt, ''),
  reason: str(rev.reason, ''),
  signerLabel: str(rev.signerLabel, ''),
  prevHash: str(rev.prevHash, ''),
  actorSnapshot: actorMain(rev.actorSnapshot),
  relatedSnapshot: arr(rev.relatedSnapshot).map(actorRel).filter(Boolean) as ActorRef[],
  placeSnapshot: (rev.placeSnapshot ?? '기타') as PlaceType,
  placeOtherSnapshot: str(rev.placeOtherSnapshot, ''),
  storeTypeSnapshot: (rev.storeTypeSnapshot ?? '문서') as StoreType,
  storeOtherSnapshot: str(rev.storeOtherSnapshot, ''),
  lvSnapshot: (rev.lvSnapshot ?? 'LV2') as Sensitivity,
  summarySnapshot: str(rev.summarySnapshot, ''),
  legacyImported: !!rev.legacyImported,
});

export const reverifyRecordIntegrityCrypto = async (record: any): Promise<RecordV8> => {
  const current = ensureRecordV8(record);
  const revisions = getRecordRevisions(current);
  const signedRev = revisions.slice().reverse().find((x) => x?.signature && x?.signerPublicKey);
  if (!signedRev) {
    const integrity = buildIntegrity(current.id, revisions, {
      crypto: {
        valid: true,
        code: 'legacy',
        message: '서명 없는 레거시 봉인 기록이에요.',
        verifiedAt: nowISO(),
        signerFingerprint: '',
        algorithm: 'legacy-chain-v8',
      },
    });
    return applySnapshot(current, getRecordSnapshot(current), integrity);
  }

  try {
    const payload = stableStringify(revisionPayloadFromRevision(signedRev));
    const verified = await verifyIntegrityPayload(payload, String(signedRev.signature || ''), String(signedRev.signerPublicKey || ''), String(signedRev.signerFingerprint || ''));
    const integrity = buildIntegrity(current.id, revisions, {
      crypto: {
        valid: !!verified.valid,
        code: str(verified.code, verified.valid ? 'ok' : 'signature-invalid'),
        message: str(verified.message, verified.valid ? 'Rust 서명 검증을 통과했어요.' : 'Rust 서명 검증에 실패했어요.'),
        verifiedAt: nowISO(),
        signerFingerprint: str(verified.signerFingerprint || signedRev.signerFingerprint || ''),
        signerPublicKey: String(signedRev.signerPublicKey || ''),
        algorithm: 'rust-ed25519-v1',
      },
    });
    return applySnapshot(current, getRecordSnapshot(current), integrity);
  } catch (e: any) {
    const integrity = buildIntegrity(current.id, revisions, {
      crypto: {
        valid: false,
        code: 'verify-error',
        message: str(e?.message || e, 'Rust 서명 검증 중 오류가 발생했어요.'),
        verifiedAt: nowISO(),
        signerFingerprint: String(signedRev.signerFingerprint || ''),
        signerPublicKey: String(signedRev.signerPublicKey || ''),
        algorithm: 'rust-ed25519-v1',
      },
    });
    return applySnapshot(current, getRecordSnapshot(current), integrity);
  }
};

export const reverifyStateRecords = async (state: AppState): Promise<AppState> => {
  await refreshDeviceSignerInfo();
  const normalized = normalizeState(state);
  const next = { ...normalized, records: [] as RecordV8[] } as AppState;
  for (const r of normalized.records) next.records.push(await reverifyRecordIntegrityCrypto(r));
  return next;
};

export const verifyRecordIntegrity = (record: any) => {
  const raw = obj(record) ?? {};
  const integrity = obj((raw as any).integrity);
  if (!integrity) return {
    valid: false,
    trusted: false,
    verificationStatus: 'missing' as SealVerificationStatus,
    code: 'unsigned' as const,
    message: '봉인 정보가 없어요.',
    originalHash: '',
    currentHash: '',
    revisionCount: 0,
    legacyImported: false,
    signatureAlgorithm: 'legacy-chain-v8' as SealAlgorithm,
    signerFingerprint: '',
    signedOnThisDevice: false,
    hasLegacyRevisions: true,
    hasSignedRevisions: false,
    mixedChain: false,
  };

  const revs = arr((integrity as any).revisions);
  if (!revs.length) return {
    valid: false,
    trusted: false,
    verificationStatus: 'missing' as SealVerificationStatus,
    code: 'empty' as const,
    message: '리비전이 비어 있어요.',
    originalHash: '',
    currentHash: '',
    revisionCount: 0,
    legacyImported: false,
    signatureAlgorithm: 'legacy-chain-v8' as SealAlgorithm,
    signerFingerprint: '',
    signedOnThisDevice: false,
    hasLegacyRevisions: true,
    hasSignedRevisions: false,
    mixedChain: false,
  };

  const base = getRecordSnapshot(raw);
  const localFingerprint = getCachedDeviceSignerFingerprint();
  let prevHash = '';
  let valid = true;
  let code: 'ok' | 'chain' | 'revision-hash' | 'current-mismatch' | 'signature-missing' | 'signature-invalid' = 'ok';
  let hasLegacyRevisions = false;
  let hasSignedRevisions = false;
  let hasMissingSignature = false;
  let signerFingerprint = str((integrity as any).signerFingerprint, '');
  let signerPublicKey = str((integrity as any).signerPublicKey, '');

  const rebuilt = revs.map((rr: any, i: number) => {
    const payload = revisionPayloadFromRevision({
      ...rr,
      recordId: str((integrity as any).recordId || raw.id, base.id),
    });
    const expectedHash = hashRevision(payload);
    const storedPrevHash = str(rr.prevHash, '');
    const storedHash = str(rr.hash, '');
    if (storedPrevHash !== prevHash && code === 'ok') { valid = false; code = 'chain'; }
    if (storedHash !== expectedHash && code === 'ok') { valid = false; code = 'revision-hash'; }
    const isSigned = (rr.signatureAlgorithm === 'rust-ed25519-v1' || !!rr.signature || !!rr.signerPublicKey);
    if (isSigned) {
      hasSignedRevisions = true;
      signerFingerprint = str(rr.signerFingerprint, signerFingerprint);
      signerPublicKey = str(rr.signerPublicKey, signerPublicKey);
      if (!trim(rr.signature) || !trim(rr.signerPublicKey)) {
        hasMissingSignature = true;
        if (code === 'ok') { valid = false; code = 'signature-missing'; }
      }
    } else {
      hasLegacyRevisions = true;
    }
    prevHash = storedHash;
    return payload;
  });

  const last = rebuilt[rebuilt.length - 1] as any;
  if (last) {
    if (
      base.eventAt !== str(last.eventAt, base.eventAt) ||
      base.summary !== str(last.summarySnapshot, base.summary) ||
      str(base.actor?.type) !== str(last.actorSnapshot?.type) ||
      str(base.actor?.name) !== str(last.actorSnapshot?.name) ||
      str(base.place) !== str(last.placeSnapshot) ||
      str(base.placeOther) !== str(last.placeOtherSnapshot) ||
      str(base.storeType) !== str(last.storeTypeSnapshot) ||
      str(base.storeOther) !== str(last.storeOtherSnapshot) ||
      str(base.lv) !== str(last.lvSnapshot)
    ) { valid = false; if (code === 'ok') code = 'current-mismatch'; }
  }

  const originalHash = str(revs[0]?.hash, '');
  const currentHash = str(revs[revs.length - 1]?.hash, '');
  if (str((integrity as any).originalHash, '') !== originalHash || str((integrity as any).currentHash, '') !== currentHash) {
    valid = false;
    if (code === 'ok') code = 'revision-hash';
  }

  const crypto = obj((integrity as any).crypto) as CryptoVerificationCache | null;
  const mixedChain = hasLegacyRevisions && hasSignedRevisions;
  let verificationStatus: SealVerificationStatus = 'pending';
  let trusted = false;

  if (!valid) verificationStatus = hasMissingSignature ? 'missing' : 'invalid';
  else if (!hasSignedRevisions) verificationStatus = 'legacy';
  else if (!crypto) verificationStatus = 'pending';
  else if (!crypto.valid && crypto.code === 'legacy') verificationStatus = 'legacy';
  else if (!crypto.valid) verificationStatus = crypto.code === 'signer-key-missing' ? 'missing' : 'invalid';
  else if (localFingerprint && signerFingerprint && signerFingerprint !== localFingerprint) verificationStatus = 'foreign';
  else verificationStatus = 'verified';

  trusted = valid && hasSignedRevisions && !mixedChain && verificationStatus === 'verified';

  let message = '기록의 봉인 정보를 점검해 주세요.';
  if (!valid) message = '기록의 봉인 정보가 현재 데이터와 맞지 않아요.';
  else if (trusted) message = 'Rust Ed25519 기기서명과 리비전 체인이 확인됐어요.';
  else if (mixedChain) message = '레거시 해시봉인 위에 새 기기서명이 이어진 혼합 봉인 기록이에요.';
  else if (verificationStatus === 'foreign') message = '다른 기기에서 서명된 기록이에요. 체인은 맞지만 이 기기 키와는 달라요.';
  else if (verificationStatus === 'legacy') message = '서명 없는 레거시 해시봉인 기록이에요.';
  else if (verificationStatus === 'pending') message = 'Rust 서명 검증 캐시가 아직 갱신되지 않았어요.';
  else if (verificationStatus === 'missing') message = '서명 메타데이터가 일부 비어 있어요.';
  else if (crypto?.message) message = String(crypto.message || message);

  return {
    valid,
    trusted,
    verificationStatus,
    code: !valid && code === 'ok' ? 'signature-invalid' : code,
    message,
    originalHash,
    currentHash,
    revisionCount: revs.length,
    legacyImported: !!(integrity as any).legacyImported,
    signatureAlgorithm: hasSignedRevisions ? 'rust-ed25519-v1' : 'legacy-chain-v8',
    signerFingerprint,
    signerPublicKey,
    signedOnThisDevice: !!(trusted && signerFingerprint && localFingerprint && signerFingerprint === localFingerprint),
    hasLegacyRevisions,
    hasSignedRevisions,
    mixedChain,
  };
};

export const buildSignedBackupEnvelope = async (state: AppState): Promise<SignedBackupEnvelope> => {
  const normalized = normalizeState(state);
  const canonicalState = stableStringify(normalized);
  const signed = await signIntegrityPayload(canonicalState, 'backup-state');
  return {
    schema: 'roosycozy-backup/v3',
    exportedAt: nowISO(),
    note: '백업 JSON에는 비공개 서명키가 포함되지 않으며, state 본문은 Rust Ed25519 서명으로 검증됩니다.',
    state: normalized,
    manifest: {
      algorithm: signed.signature ? 'rust-ed25519-v1' : 'legacy-chain-v8',
      stateHash: signed.payloadSha256,
      signature: signed.signature || '',
      signerFingerprint: signed.signerFingerprint || '',
      signerPublicKey: signed.signerPublicKey || '',
    },
  };
};

export const verifyBackupEnvelope = async (raw: any): Promise<{ ok: boolean; state: AppState; signed: boolean; legacy: boolean; code: string; message: string; signerFingerprint: string; }> => {
  const o = obj(raw) ?? {};
  if (str(o.schema, '') !== 'roosycozy-backup/v3') {
    return {
      ok: true,
      state: normalizeState(raw),
      signed: false,
      legacy: true,
      code: 'legacy-backup',
      message: '서명 없는 레거시 백업으로 복구합니다.',
      signerFingerprint: '',
    };
  }

  const state = normalizeState(o.state);
  const canonicalState = stableStringify(state);
  const expectedHash = sha256Hex(canonicalState);
  const manifest = obj(o.manifest) ?? {};
  const stateHash = str(manifest.stateHash, '');
  const signature = str(manifest.signature, '');
  const signerPublicKey = str(manifest.signerPublicKey, '');
  const signerFingerprint = str(manifest.signerFingerprint, '');

  if (!signature || !signerPublicKey) {
    return {
      ok: false,
      state,
      signed: true,
      legacy: false,
      code: 'backup-signature-missing',
      message: '백업 서명 정보가 비어 있어요.',
      signerFingerprint,
    };
  }
  if (stateHash !== expectedHash) {
    return {
      ok: false,
      state,
      signed: true,
      legacy: false,
      code: 'backup-hash-mismatch',
      message: '백업 본문이 서명 당시 state와 달라요. 위변조 가능성이 있어요.',
      signerFingerprint,
    };
  }

  const verified = await verifyIntegrityPayload(canonicalState, signature, signerPublicKey, signerFingerprint);
  return {
    ok: !!verified.valid,
    state,
    signed: true,
    legacy: false,
    code: str(verified.code, verified.valid ? 'ok' : 'backup-signature-invalid'),
    message: str(verified.message, verified.valid ? '백업 서명이 확인됐어요.' : '백업 서명 검증에 실패했어요.'),
    signerFingerprint: signerFingerprint || str(verified.signerFingerprint, ''),
  };
};

export const defaultState = (): AppState => ({ v: 10, tab: 'records', selectedCaseId: null, records: [], cases: {} });


const normRisk = (raw: any): RecordRisk | undefined => {
  const r = obj(raw) ?? {};
  const labelNum = Number(r.label);
  const label = labelNum === 2 ? 2 : labelNum === 1 ? 1 : 0;
  const probsRaw = Array.isArray(r.probs) ? r.probs : [];
  const p0 = Number.isFinite(+probsRaw[0]) ? Math.max(0, Math.min(1, +probsRaw[0])) : 0;
  const p1 = Number.isFinite(+probsRaw[1]) ? Math.max(0, Math.min(1, +probsRaw[1])) : 0;
  const p2 = Number.isFinite(+probsRaw[2]) ? Math.max(0, Math.min(1, +probsRaw[2])) : 0;
  const confidence = Number.isFinite(+r.confidence) ? Math.max(0, Math.min(1, +r.confidence)) : Math.max(p0, p1, p2);
  const labelText = label === 2 ? '위험' : label === 1 ? '경고' : '평범';
  return {
    label: label as 0 | 1 | 2,
    labelText,
    probs: [p0, p1, p2],
    confidence,
    reasons: arr(r.reasons).map((x) => trim(x)).filter(Boolean).slice(0, 6),
    modelVersion: trim(r.modelVersion) || 'unknown',
    scoredAt: trim(r.scoredAt) || undefined,
  } as RecordRisk;
};

const normRecord = (r: any): RecordV8 => {
  const o = obj(r) ?? {};
  const risk = normRisk(o.risk);
  const base: RecordItem = {
    id: str(o.id, uid('REC')),
    ts: str(o.ts, nowISO()),
    storeType: (o.storeType ?? '문서') as StoreType,
    storeOther: str(o.storeOther, ''),
    lv: (o.lv ?? 'LV2') as Sensitivity,
    actor: actorMain(o.actor),
    related: arr(o.related).map(actorRel).filter(Boolean) as ActorRef[],
    place: (o.place ?? '기타') as PlaceType,
    placeOther: str(o.placeOther, ''),
    summary: str(o.summary, ''),
    ...(risk ? { risk } : {}),
  };
  return ensureRecordV8({ ...base, integrity: o.integrity });
};
const normStep = (s: any): StepItem => {
  const o = obj(s) ?? {};
  return { id: str(o.id, uid('STEP')), ts: str(o.ts, nowISO()), name: trim(o.name), note: trim(o.note), text: str(o.text, ''), place: str(o.place, ''), owner: str(o.owner, ''), lv: str(o.lv, '') } as StepItem;
};
const normAdvisor = (a: any): AdvisorItem => {
  const o = obj(a) ?? {};
  const level = o.level === 'warn' || o.level === 'critical' ? o.level : 'info';
  const state = o.state === 'done' || o.state === 'dismissed' ? o.state : 'active';
  return { id: str(o.id, uid('ADV')), ts: str(o.ts, nowISO()), title: trim(o.title), body: trim(o.body), level, tags: arr(o.tags).map((x) => trim(x)).filter(Boolean), state, ruleId: o.ruleId ? str(o.ruleId) : undefined } as AdvisorItem;
};
const normCase = (raw: any, key: string): CaseItem => {
  const c = obj(raw) ?? {};
  const st = STATUSES.includes(c.status) ? c.status : '진행중';
  const m = c.mode === 'smart' ? 'smart' : c.mode === 'normal' ? 'normal' : undefined;
  return { id: str(c.id, key), title: (trim(c.title) || '케이스') as any, actors: arr(c.actors).map(actorRel).filter(Boolean) as ActorRef[], onlyMainActor: !!c.onlyMainActor, sensFilter: (c.sensFilter ?? 'any') as CaseSensFilter, status: st as CaseStatus, createdAt: str(c.createdAt, nowISO()), steps: arr(c.steps).map(normStep) as any, advisors: arr(c.advisors).map(normAdvisor) as any, query: str(c.query, ''), timeFrom: str(c.timeFrom, ''), timeTo: str(c.timeTo, ''), maxResults: typeof c.maxResults === 'number' ? c.maxResults : undefined, recordIds: Array.isArray(c.recordIds) ? c.recordIds.map((x: any) => str(x)) : undefined, scoreByRecordId: c.scoreByRecordId && typeof c.scoreByRecordId === 'object' ? c.scoreByRecordId : undefined, mode: m as any } as CaseItem;
};

export const normalizeState = (anyObj: any): AppState => {
  const base = defaultState();
  const o = obj(anyObj?.state && typeof anyObj.state === 'object' ? anyObj.state : anyObj);
  if (!o) return base;
  base.tab = o.tab === 'cases' ? 'cases' : 'records';
  base.selectedCaseId = typeof o.selectedCaseId === 'string' ? o.selectedCaseId : null;
  base.records = arr(o.records).map(normRecord);
  const cs = obj(o.cases) ?? {};
  const out: Record<string, CaseItem> = {};
  for (const id of Object.keys(cs)) out[id] = normCase((cs as any)[id], id);
  base.cases = out;
  return base;
};

const SAMPLE_PACK_URL = new URL('./sample_pack_v7.json', import.meta.url);
const SEED_ON_EMPTY = ((import.meta as any)?.env?.VITE_SEED_SAMPLE ?? '') === '1' || String((import.meta as any)?.env?.MODE ?? '') === 'production';
const loadSamplePack = async (): Promise<any | null> => {
  try {
    const res = await fetch(SAMPLE_PACK_URL);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

export const loadState = async (): Promise<AppState> => {
  const raw = await storageGet();
  if (raw) return normalizeState(safeParseJSON(raw));
  if (ls()?.getItem(LS_SEED_DISABLED_KEY) === '1') return defaultState();
  if (!SEED_ON_EMPTY) return defaultState();
  const pack = await loadSamplePack();
  if (!pack) return defaultState();
  const seeded = normalizeState(pack);
  await storageSet(JSON.stringify(seeded));
  void ls()?.removeItem(LS_SEED_DISABLED_KEY);
  return seeded;
};
export const saveState = async (s: AppState) => { void ls()?.removeItem(LS_SEED_DISABLED_KEY); return storageSet(JSON.stringify(normalizeState(s))); };
export const wipeAll = async () => { await storageRemove(); void ls()?.setItem(LS_SEED_DISABLED_KEY, '1'); };
