use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
#[cfg(target_os = "windows")]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH}; // 시간 처리를 위한 표준 라이브러리 추가
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};

const RISK_LABEL_TEXT: [&str; 3] = ["평범", "경고", "위험"];
const RISK_MODEL_BYTES: &[u8] = include_bytes!("risk_model_v1.bin");

#[derive(Debug, Clone)]
struct RiskLinearModel {
  version: String,
  dims: usize,
  bias: [f32; 3],
  weights: [Vec<f32>; 3],
}

static RISK_MODEL: OnceLock<RiskLinearModel> = OnceLock::new();
static STRATEGY_LEGAL_DATASET: OnceLock<StrategyLegalDataset> = OnceLock::new();
static STRATEGY_LEGAL_FLAT_CHUNKS: OnceLock<Vec<StrategyLegalFlatChunk>> = OnceLock::new();
static STRATEGY_MODEL_DOWNLOAD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static STRATEGY_MODEL_DOWNLOAD_RUNNING: OnceLock<Mutex<bool>> = OnceLock::new();
static STRATEGY_MODEL_DOWNLOAD_LAST_EVENT: OnceLock<Mutex<Option<(String, String, usize, usize)>>> =
  OnceLock::new();

fn read_u32_le(bytes: &[u8], pos: &mut usize) -> Result<u32, String> {
  let end = *pos + 4;
  let chunk = bytes.get(*pos..end).ok_or_else(|| "risk model truncated while reading u32".to_string())?;
  *pos = end;
  Ok(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
}

fn read_f32_le(bytes: &[u8], pos: &mut usize) -> Result<f32, String> {
  let end = *pos + 4;
  let chunk = bytes.get(*pos..end).ok_or_else(|| "risk model truncated while reading f32".to_string())?;
  *pos = end;
  Ok(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
}

fn load_risk_model_from_bytes(bytes: &[u8]) -> Result<RiskLinearModel, String> {
  let magic = bytes.get(0..8).ok_or_else(|| "risk model too short".to_string())?;
  if magic != b"RCZRISK1" {
    return Err("invalid risk model magic".to_string());
  }

  let mut pos = 8usize;
  let version_len = read_u32_le(bytes, &mut pos)? as usize;
  let version_bytes = bytes
    .get(pos..pos + version_len)
    .ok_or_else(|| "risk model truncated while reading version".to_string())?;
  let version = String::from_utf8(version_bytes.to_vec()).map_err(|_| "risk model version is not valid utf-8".to_string())?;
  pos += version_len;

  let dims = read_u32_le(bytes, &mut pos)? as usize;
  let class_count = read_u32_le(bytes, &mut pos)? as usize;
  if class_count != 3 {
    return Err(format!("unsupported risk class count: {}", class_count));
  }

  let mut bias = [0.0f32; 3];
  for i in 0..3 {
    bias[i] = read_f32_le(bytes, &mut pos)?;
  }

  let mut weights = [Vec::<f32>::with_capacity(dims), Vec::<f32>::with_capacity(dims), Vec::<f32>::with_capacity(dims)];
  for cls in 0..3 {
    for _ in 0..dims {
      weights[cls].push(read_f32_le(bytes, &mut pos)?);
    }
  }

  Ok(RiskLinearModel { version, dims, bias, weights })
}

fn risk_model() -> &'static RiskLinearModel {
  RISK_MODEL.get_or_init(|| load_risk_model_from_bytes(RISK_MODEL_BYTES).expect("failed to load risk_model_v1.bin"))
}

/* -------------------- tiny helpers -------------------- */

fn norm(s: &str) -> String {
  s.to_lowercase()
    .replace('\u{200B}', "")
    .replace('\u{200C}', "")
    .replace('\u{200D}', "")
    .replace('\u{FEFF}', "")
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
}

fn within_range(ts: &str, from: &str, to: &str) -> bool {
  if !from.is_empty() && ts < from {
    return false;
  }
  if !to.is_empty() && ts > to {
    return false;
  }
  true
}

fn is_word_char(cp: u32) -> bool {
  let is_ascii_num = cp >= 0x30 && cp <= 0x39;
  let is_ascii_upper = cp >= 0x41 && cp <= 0x5A;
  let is_ascii_lower = cp >= 0x61 && cp <= 0x7A;
  let is_hangul_syllable = cp >= 0xAC00 && cp <= 0xD7A3;
  let is_hangul_jamo1 = cp >= 0x3131 && cp <= 0x314E;
  let is_hangul_jamo2 = cp >= 0x314F && cp <= 0x3163;
  is_ascii_num || is_ascii_upper || is_ascii_lower || is_hangul_syllable || is_hangul_jamo1 || is_hangul_jamo2
}

fn tokenize(s: &str) -> Vec<String> {
  let mut out: Vec<String> = Vec::new();
  let mut cur = String::new();

  for ch in s.chars() {
    let cp = ch as u32;
    if is_word_char(cp) {
      cur.push(ch);
    } else {
      let t = norm(&cur);
      if t.len() >= 2 {
        out.push(t);
      }
      cur.clear();
    }
  }
  let t = norm(&cur);
  if t.len() >= 2 {
    out.push(t);
  }
  out
}

fn text_similarity_stats(q_tokens: &[String], summary: &str) -> (usize, usize, f32) {
  if q_tokens.is_empty() {
    return (0, 0, 0.0);
  }
  let s = norm(summary);
  let mut hit = 0usize;
  for qt in q_tokens {
    if qt.len() >= 2 && s.contains(qt) {
      hit += 1;
    }
  }
  let total = q_tokens.len();
  let ratio = hit as f32 / total as f32;
  (hit, total, ratio)
}


fn record_main_actor_names(r: &RecordItem) -> Vec<String> {
  let mut out = Vec::<String>::new();
  let mut seen = HashSet::<String>::new();

  for a in &r.actors {
    let n = norm(&a.name);
    if !n.is_empty() && seen.insert(n.clone()) {
      out.push(n);
    }
  }

  let fallback = norm(&r.actor.name);
  if !fallback.is_empty() && seen.insert(fallback.clone()) {
    out.push(fallback);
  }

  out
}

fn has_actor_type(r: &RecordItem, actor_type: &str) -> bool {
  let target = actor_type.trim();
  if !target.is_empty() {
    if r.actor.r#type.trim() == target {
      return true;
    }
    for a in &r.actors {
      if a.r#type.trim() == target {
        return true;
      }
    }
  }
  false
}


/* -------------------- shared types (proto) -------------------- */

pub type Sensitivity = String;
pub type StoreType = String;
pub type PlaceType = String;
pub type CaseSensFilter = String;
pub type CaseStatus = String;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordSummaryParts {
  #[serde(default)]
  pub overview: String,
  #[serde(default)]
  pub background: String,
  #[serde(default)]
  pub issues: String,
  #[serde(default)]
  pub evidence_list: String,
  #[serde(default)]
  pub teacher_actions: String,
  #[serde(default)]
  pub other: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorRef {
  #[serde(rename = "type")]
  pub r#type: String,
  pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordItem {
  pub id: String,
  pub ts: String,
  pub store_type: StoreType,
  pub store_other: String,
  pub lv: Sensitivity,
  pub actor: ActorRef,
  #[serde(default)]
  pub actors: Vec<ActorRef>,
  #[serde(default)]
  pub related: Vec<ActorRef>,
  pub place: PlaceType,
  pub place_other: String,
  pub summary: String,
  #[serde(default)]
  pub summary_parts: Option<RecordSummaryParts>,
  #[serde(default)]
  pub risk: Option<RiskPrediction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseItem {
  pub id: String,
  pub title: String,

  #[serde(default)]
  pub query: String,

  #[serde(default)]
  pub time_from: String,
  #[serde(default)]
  pub time_to: String,

  #[serde(default)]
  pub max_results: Option<u32>,

  #[serde(default)]
  pub actors: Vec<ActorRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankWeights {
  #[serde(default)]
  pub actor: Option<f32>,
  #[serde(default)]
  pub related: Option<f32>,
  #[serde(default)]
  pub text: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankOpts {
  #[serde(default, alias = "limit", alias = "maxResults")]
  pub max_results: Option<u32>,

  #[serde(default)]
  pub weights: Option<RankWeights>,

  #[serde(default, alias = "minScore")]
  pub min_score: Option<f32>,

  #[serde(default, alias = "minTextSim")]
  pub min_text_sim: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RankedComponents {
  pub keyword_score: f32,
  pub text_sim: f32,
  pub q_hit: u32,
  pub q_total: u32,

  pub actor_score: f32,
  pub actor_match: bool,
  #[serde(default)]
  pub actor_hits: u32,
  pub is_main_actor: bool,

  pub related_score: f32,
  pub related_hits: u32,

  pub in_range: Option<bool>,

  pub w_actor: f32,
  pub w_related: f32,
  pub w_text: f32,
  pub min_score: f32,
  pub min_text_sim: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedHit {
  pub id: String,
  pub score: f32,
  pub rank: u32,
  #[serde(default)]
  pub reasons: Vec<String>,
  #[serde(default)]
  pub components: RankedComponents,
}

/* -------------------- core: rank -------------------- */

pub fn rank_records_for_case(
  records: &[RecordItem],
  case_item: &CaseItem,
  opts: Option<RankOpts>,
) -> Vec<RankedHit> {
  let (k, w_actor, w_related, w_text, min_score, min_text_sim) = {
    let k = opts
      .as_ref()
      .and_then(|o| o.max_results)
      .or(case_item.max_results)
      .unwrap_or(80)
      .clamp(1, 400) as usize;

    let w = opts.as_ref().and_then(|o| o.weights.clone());
    let w_actor = w.as_ref().and_then(|x| x.actor).unwrap_or(2.5);
    let w_related = w.as_ref().and_then(|x| x.related).unwrap_or(1.0);
    let w_text = w.as_ref().and_then(|x| x.text).unwrap_or(2.0);

    let min_score = opts.as_ref().and_then(|o| o.min_score).unwrap_or(0.8);
    let min_text_sim = opts.as_ref().and_then(|o| o.min_text_sim).unwrap_or(0.34);

    (k, w_actor, w_related, w_text, min_score, min_text_sim)
  };

  let q = case_item.query.trim();
  let q_tokens = if q.is_empty() { vec![] } else { tokenize(q) };

  let case_actor_names: HashSet<String> = case_item
    .actors
    .iter()
    .map(|a| norm(&a.name))
    .filter(|s| !s.is_empty())
    .collect();

  let main_actor_name = case_item
    .actors
    .get(0)
    .map(|a| norm(&a.name))
    .filter(|s| !s.is_empty());

  let has_range = !case_item.time_from.is_empty() || !case_item.time_to.is_empty();

  #[derive(Clone)]
  struct Tmp {
    id: String,
    score: f32,
    ts: String,
    reasons: Vec<String>,
    components: RankedComponents,
  }

  let mut main_hits: Vec<Tmp> = Vec::new();
  let mut candidates: Vec<Tmp> = Vec::new();

  for r in records {
    let in_range = if has_range {
      within_range(&r.ts, &case_item.time_from, &case_item.time_to)
    } else {
      true
    };
    if has_range && !in_range {
      continue;
    }

    let r_actor_names = record_main_actor_names(r);
    let actor_hits = r_actor_names
      .iter()
      .filter(|name| case_actor_names.contains(*name))
      .count();
    let actor_match_any = actor_hits > 0;

    let is_main_actor = main_actor_name
      .as_ref()
      .map(|m| r_actor_names.iter().any(|name| name == m))
      .unwrap_or(false);

    let main_actor_name_set: HashSet<String> = r_actor_names.iter().cloned().collect();
    let mut related_hits = 0usize;
    for ra in &r.related {
      let rn = norm(&ra.name);
      if !rn.is_empty() && !main_actor_name_set.contains(&rn) && case_actor_names.contains(&rn) {
        related_hits += 1;
      }
    }

    let (q_hit, q_total, sim) = text_similarity_stats(&q_tokens, &r.summary);

    let actor_bonus = if actor_hits > 1 {
      (((actor_hits - 1) as f32) * (w_actor * 0.35)).min(w_actor * 0.75)
    } else {
      0.0
    };
    let actor_score = if actor_match_any { w_actor + actor_bonus } else { 0.0 };
    let related_score = (related_hits as f32) * w_related;
    let keyword_score = sim * w_text;
    let score: f32 = actor_score + related_score + keyword_score;

    let mut reasons: Vec<String> = Vec::new();
    reasons.push("자동(랭킹)".into());
    if is_main_actor {
      reasons.push("주요 당사자 포함".into());
    }
    if actor_hits > 0 {
      reasons.push(format!("주체 일치 {}명", actor_hits));
    }
    if related_hits > 0 {
      reasons.push(format!("관련자 일치 {}명", related_hits));
    }
    if !q_tokens.is_empty() {
      reasons.push(format!("키워드 {}/{}", q_hit, q_total));
    }
    if has_range {
      reasons.push(if in_range { "기간 내".into() } else { "기간 밖".into() });
    }

    let components = RankedComponents {
      keyword_score,
      text_sim: sim,
      q_hit: q_hit as u32,
      q_total: q_total as u32,

      actor_score,
      actor_match: actor_match_any,
      actor_hits: actor_hits as u32,
      is_main_actor,

      related_score,
      related_hits: related_hits as u32,

      in_range: if has_range { Some(in_range) } else { None },

      w_actor,
      w_related,
      w_text,
      min_score,
      min_text_sim,
    };

    let tmp = Tmp {
      id: r.id.clone(),
      score,
      ts: r.ts.clone(),
      reasons,
      components,
    };

    if is_main_actor {
      main_hits.push(tmp);
      continue;
    }

    let passes_logic = actor_match_any
      || related_hits > 0
      || (!q_tokens.is_empty() && sim >= min_text_sim);

    if passes_logic && score >= min_score {
      candidates.push(tmp);
    }
  }

  main_hits.sort_by(|a, b| match b.ts.cmp(&a.ts) {
    Ordering::Equal => match b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal) {
      Ordering::Equal => a.id.cmp(&b.id),
      other => other,
    },
    other => other,
  });

  candidates.sort_by(|a, b| match b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal) {
    Ordering::Equal => match b.ts.cmp(&a.ts) {
      Ordering::Equal => a.id.cmp(&b.id),
      other => other,
    },
    other => other,
  });

  let mut merged: Vec<Tmp> = Vec::new();

  for t in main_hits.into_iter().take(k) {
    merged.push(t);
  }

  if merged.len() < k {
    let remain = k - merged.len();
    for t in candidates.into_iter().take(remain) {
      if merged.iter().any(|x| x.id == t.id) {
        continue;
      }
      merged.push(t);
    }
  }

  merged
    .into_iter()
    .enumerate()
    .map(|(i, t)| RankedHit {
      id: t.id,
      score: t.score,
      rank: (i + 1) as u32,
      reasons: t.reasons,
      components: t.components,
    })
    .collect()
}


/* -------------------- complaint risk classify -------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskPrediction {
  pub label: u8,
  pub label_text: String,
  pub probs: [f32; 3],
  pub confidence: f32,
  #[serde(default)]
  pub reasons: Vec<String>,
  pub model_version: String,
}

const RISK_COUNT_CAP: f32 = 3.0;

const LEGAL_KWS: &[&str] = &["고소", "고발", "변호사", "손해배상", "법적", "경찰", "신고", "아동학대"];
const AUTHORITY_KWS: &[&str] = &["교육청", "국민신문고", "감사", "장학사", "기관"];
const RECORDING_KWS: &[&str] = &["녹취", "녹음", "캡처", "증거", "증빙"];
const PUBLICATION_KWS: &[&str] = &["언론", "제보", "온라인", "커뮤니티", "맘카페", "공개", "실명", "배포"];
const PRESSURE_KWS: &[&str] = &["압박", "재촉", "즉답", "즉시", "오늘 중", "답변 기한", "책임", "과실", "문제 삼음", "납득하지 못"];
const REPEAT_KWS: &[&str] = &["반복 연락", "여러 번호", "같은 내용", "재차", "계속", "반복"];
const VISIT_KWS: &[&str] = &["직접 찾아오", "학교로 직접", "방문", "면담"];
const ADMIN_KWS: &[&str] = &["교감", "교장", "관리자", "동석"];

fn fnv1a64_mod(s: &str, dims: usize) -> usize {
  let mut hash: u64 = 0xcbf29ce484222325;
  for b in s.as_bytes() {
    hash ^= *b as u64;
    hash = hash.wrapping_mul(0x100000001b3);
  }
  (hash % dims as u64) as usize
}

fn clean_summary_for_ngrams(s: &str) -> Vec<char> {
  norm(s)
    .chars()
    .filter(|ch| ch.is_alphanumeric() || is_word_char(*ch as u32))
    .collect::<Vec<char>>()
}

fn add_feature(feats: &mut HashMap<usize, f32>, feature: &str) {
  let idx = fnv1a64_mod(feature, risk_model().dims);
  let entry = feats.entry(idx).or_insert(0.0);
  *entry = (*entry + 1.0).min(RISK_COUNT_CAP);
}

fn add_category_features(feats: &mut HashMap<usize, f32>, summary: &str, category: &str, kws: &[&str]) -> bool {
  let mut hit = false;
  for kw in kws {
    if summary.contains(kw) {
      hit = true;
      add_feature(feats, &format!("kw={}", kw));
    }
  }
  if hit {
    add_feature(feats, &format!("kwcat={}", category));
  }
  hit
}

fn risk_feature_counts(r: &RecordItem) -> HashMap<usize, f32> {
  let mut feats = HashMap::<usize, f32>::new();
  let summary = norm(&r.summary);

  let related_bucket = match r.related.len() {
    0 => "0",
    1 => "1",
    _ => "2+",
  };

  let summary_len_bucket = if summary.len() < 40 {
    "short"
  } else if summary.len() < 90 {
    "mid"
  } else {
    "long"
  };

  add_feature(&mut feats, &format!("actor={}", r.actor.r#type.trim()));
  for a in &r.actors {
    let actor_type = a.r#type.trim();
    if !actor_type.is_empty() {
      add_feature(&mut feats, &format!("actor={}", actor_type));
    }
  }
  add_feature(&mut feats, &format!("place={}", r.place.trim()));
  add_feature(&mut feats, &format!("store={}", r.store_type.trim()));
  add_feature(&mut feats, &format!("lv={}", r.lv.trim()));
  add_feature(&mut feats, &format!("related_bucket={}", related_bucket));
  add_feature(&mut feats, &format!("place_store={}|{}", r.place.trim(), r.store_type.trim()));
  add_feature(&mut feats, &format!("summary_len={}", summary_len_bucket));

  for tok in tokenize(&summary) {
    add_feature(&mut feats, &format!("tok={}", tok));
  }

  let chars = clean_summary_for_ngrams(&summary);
  for n in 2usize..=4usize {
    if chars.len() >= n {
      for i in 0..=(chars.len() - n) {
        let gram: String = chars[i..i + n].iter().collect();
        add_feature(&mut feats, &format!("cg{}={}", n, gram));
      }
    }
  }

  add_category_features(&mut feats, &summary, "legal", LEGAL_KWS);
  add_category_features(&mut feats, &summary, "authority", AUTHORITY_KWS);
  add_category_features(&mut feats, &summary, "recording", RECORDING_KWS);
  add_category_features(&mut feats, &summary, "publication", PUBLICATION_KWS);
  add_category_features(&mut feats, &summary, "pressure", PRESSURE_KWS);
  add_category_features(&mut feats, &summary, "repeat", REPEAT_KWS);
  add_category_features(&mut feats, &summary, "visit", VISIT_KWS);
  add_category_features(&mut feats, &summary, "admin", ADMIN_KWS);

  feats
}

fn softmax3(logits: &mut [f32; 3]) {
  let max_v = logits
    .iter()
    .copied()
    .fold(f32::NEG_INFINITY, f32::max);
  let mut sum = 0.0f32;
  for x in logits.iter_mut() {
    *x = (*x - max_v).exp();
    sum += *x;
  }
  let denom = if sum <= 0.0 { 1.0 } else { sum };
  for x in logits.iter_mut() {
    *x /= denom;
  }
}

fn push_reason(out: &mut Vec<String>, reason: &str) {
  if !out.iter().any(|x| x == reason) {
    out.push(reason.to_string());
  }
}

fn reason_hits(summary: &str, kws: &[&str]) -> bool {
  kws.iter().any(|kw| summary.contains(kw))
}

fn collect_risk_reasons(r: &RecordItem, label: usize, confidence: f32) -> Vec<String> {
  let summary = norm(&r.summary);
  let mut out = Vec::<String>::new();

  if reason_hits(&summary, AUTHORITY_KWS) {
    push_reason(&mut out, "교육청·외부기관 언급");
  }
  if reason_hits(&summary, LEGAL_KWS) {
    push_reason(&mut out, "법적 조치·신고 표현");
  }
  if reason_hits(&summary, RECORDING_KWS) {
    push_reason(&mut out, "녹취·캡처·증빙 확보 언급");
  }
  if reason_hits(&summary, PUBLICATION_KWS) {
    push_reason(&mut out, "온라인 공개·언론 확산 우려");
  }
  if reason_hits(&summary, PRESSURE_KWS) {
    push_reason(&mut out, "압박성 요구·즉답 촉구");
  }
  if reason_hits(&summary, REPEAT_KWS) {
    push_reason(&mut out, "반복 연락·지속 압박");
  }
  if reason_hits(&summary, VISIT_KWS) {
    push_reason(&mut out, "직접 방문·면담 압박");
  }
  if reason_hits(&summary, ADMIN_KWS) {
    push_reason(&mut out, "관리자 동석·공유 필요");
  }

  if out.is_empty() {
    match label {
      2 => push_reason(&mut out, "즉시 대응이 필요한 고위험 신호"),
      1 => push_reason(&mut out, "민원으로 번질 수 있는 경고 신호"),
      _ => push_reason(&mut out, "일반 안내·공유 수준"),
    }
  }

  if label >= 1 && has_actor_type(r, "학부모") {
    push_reason(&mut out, "학부모 직접 민원 반응");
  }

  if label == 2 && confidence >= 0.80 {
    push_reason(&mut out, "고신뢰 위험 판정");
  }

  out.truncate(4);
  out
}

fn predict_risk(record: &RecordItem) -> RiskPrediction {
  let feats = risk_feature_counts(record);
  let model = risk_model();

  let mut logits = [
    model.bias[0],
    model.bias[1],
    model.bias[2],
  ];

  for (idx, val) in feats.iter() {
    let i = *idx;
    let v = *val;
    logits[0] += model.weights[0][i] * v;
    logits[1] += model.weights[1][i] * v;
    logits[2] += model.weights[2][i] * v;
  }

  softmax3(&mut logits);

  let mut best = 0usize;
  for i in 1..3 {
    if logits[i] > logits[best] {
      best = i;
    }
  }

  let label_text = RISK_LABEL_TEXT[best].to_string();
  let confidence = logits[best];
  let reasons = collect_risk_reasons(record, best, confidence);

  RiskPrediction {
    label: best as u8,
    label_text,
    probs: logits,
    confidence,
    reasons,
    model_version: model.version.clone(),
  }
}

pub fn classify_records_risk(records: &[RecordItem]) -> Vec<RiskPrediction> {
  records.iter().map(predict_risk).collect()
}


/* -------------------- core: advise -------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorItem {
  pub id: String,
  pub ts: String,
  pub title: String,
  pub body: String,
  pub level: String,
  #[serde(default)]
  pub tags: Vec<String>,
  pub state: String,
  pub rule_id: Option<String>,
}

// [수정] js_sys::Date::now() 대신 Rust 표준 라이브러리 사용
fn uid(prefix: &str) -> String {
  let start = SystemTime::now();
  let since_the_epoch = start
    .duration_since(UNIX_EPOCH)
    .expect("Time went backwards");
  let timestamp = since_the_epoch.as_millis();
  format!("{}_{}", prefix, timestamp)
}

fn chrono_like_now_iso() -> String {
  // TODO: 실제 ISO8601 문자열이 필요하면 chrono::Utc::now().to_rfc3339() 등을 사용
  "1970-01-01T00:00:00Z".into()
}

pub fn generate_advisors_for_case(case_item: &CaseItem, _records: &[RecordItem]) -> Vec<AdvisorItem> {
  let ts = chrono_like_now_iso();
  let mut out: Vec<AdvisorItem> = Vec::new();

  out.push(AdvisorItem {
    id: uid("ADV"),
    ts: ts.clone(),
    title: "증빙 정리".into(),
    body: "시간순으로 사실만 정리하고, 원본 증빙(녹취/문서/메신저)을 함께 묶어두세요.".into(),
    level: "info".into(),
    tags: vec!["정리".into()],
    state: "active".into(),
    rule_id: Some("proto:pack".into()),
  });

  out.push(AdvisorItem {
    id: uid("ADV"),
    ts: ts.clone(),
    title: "상대에게 전달".into(),
    body: "감정 표현 대신 사실과 조치만 전달하고, 필요하면 외부 전문기관/관리자 경로를 안내하세요.".into(),
    level: "warn".into(),
    tags: vec!["대화".into()],
    state: "active".into(),
    rule_id: Some("proto:talk".into()),
  });

  out.push(AdvisorItem {
    id: uid("ADV"),
    ts,
    title: "후속 조치".into(),
    body: "내부 보고/기록 보관/재발 방지 계획을 남겨두면 추후 방어에 도움이 됩니다.".into(),
    level: "info".into(),
    tags: vec!["후속".into()],
    state: "active".into(),
    rule_id: Some("proto:follow".into()),
  });

  out
}


const STRATEGY_MODEL_DEFAULT_ID: &str = "hyperclova-x";
const STRATEGY_MODEL_ROOSY_ID: &str = "roosy-x";
const STRATEGY_MODEL_HYBRID_ID: &str = "roosy-hybrid";
const STRATEGY_MODEL_FILENAME: &str = "HyperCLOVAX-SEED-Text-Instruct-0.5B-q4_0.gguf";
const STRATEGY_MODEL_RESOURCE_PATH: &str = "models/HyperCLOVAX-SEED-Text-Instruct-0.5B-q4_0.gguf";
const STRATEGY_MODEL_ROOSY_FILENAME: &str = "hyperclovax_roosy_Q4_K_M.gguf";
const STRATEGY_MODEL_ROOSY_RESOURCE_PATH: &str = "models/hyperclovax_roosy_Q4_K_M.gguf";
const STRATEGY_MODEL_DEFAULT_URL: &str = "https://github.com/myongsung/roosycozy-models/releases/download/model_v1/HyperCLOVAX-SEED-Text-Instruct-0.5B-q4_0.gguf";
const STRATEGY_MODEL_ROOSY_DEFAULT_URL: &str = "https://github.com/myongsung/roosycozy-models2/releases/download/model/hyperclovax_roosy_Q4_K_M.gguf";
const STRATEGY_SIDECAR_STEM: &str = "llama-sidecar";
const STRATEGY_PROGRESS_EVENT: &str = "strategy-chat-progress";
const STRATEGY_CHAT_TIMEOUT_SECS: u64 = 90;
const STRATEGY_LEGAL_RAG_JSON: &str = include_str!("../legal/kr_school_guidance_laws_rag_expanded.json");
const STRATEGY_LEGAL_RAG_JSONL: &str = include_str!("../legal/kr_school_guidance_laws_rag_expanded_flat.jsonl");
#[cfg(target_os = "windows")]
const STRATEGY_CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
const STRATEGY_SIDECAR_GENERIC_FILENAME: &str = "llama-sidecar.exe";
#[cfg(not(target_os = "windows"))]
const STRATEGY_SIDECAR_GENERIC_FILENAME: &str = STRATEGY_SIDECAR_STEM;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const STRATEGY_SIDECAR_FILENAME: &str = "llama-sidecar-aarch64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const STRATEGY_SIDECAR_FILENAME: &str = "llama-sidecar-x86_64-apple-darwin";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const STRATEGY_SIDECAR_FILENAME: &str = "llama-sidecar-x86_64-pc-windows-msvc.exe";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const STRATEGY_SIDECAR_FILENAME: &str = "llama-sidecar-x86_64-unknown-linux-gnu";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const STRATEGY_SIDECAR_FILENAME: &str = "llama-sidecar-aarch64-unknown-linux-gnu";
#[cfg(not(any(
  all(target_os = "macos", target_arch = "aarch64"),
  all(target_os = "macos", target_arch = "x86_64"),
  all(target_os = "windows", target_arch = "x86_64"),
  all(target_os = "linux", target_arch = "x86_64"),
  all(target_os = "linux", target_arch = "aarch64")
)))]
const STRATEGY_SIDECAR_FILENAME: &str = "llama-sidecar";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyChatTurn {
  pub role: String,
  pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StrategyChatOptions {
  #[serde(default)]
  pub model: Option<String>,
  #[serde(default)]
  pub max_tokens: Option<u32>,
  #[serde(default)]
  pub n_ctx: Option<u32>,
  #[serde(default)]
  pub threads: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyChatRunResult {
  pub answer: String,
  pub model_path: String,
  pub runner: String,
  pub prompt_chars: usize,
  pub records_used: usize,
  pub retrieval_query: String,
  pub evidence_packet: StrategyEvidencePacket,
}

#[derive(Debug, Clone)]
struct StrategyModelExecution {
  answer: String,
  model_path: String,
  runner: String,
  prompt_chars: usize,
}

#[derive(Debug, Clone, Copy)]
struct StrategyRuntimeConfig {
  n_ctx: u32,
  threads: u32,
  n_gpu_layers: u32,
  device: &'static str,
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn strategy_default_threads() -> u32 {
  let logical_cores = thread::available_parallelism()
    .map(|value| value.get() as u32)
    .unwrap_or(4);
  let tuned = ((logical_cores as f32) * 0.75).round() as u32;
  tuned.max(1).clamp(1, 10)
}

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
fn strategy_default_threads() -> u32 {
  let logical_cores = thread::available_parallelism()
    .map(|value| value.get() as u32)
    .unwrap_or(4);
  let reserve = if logical_cores >= 10 { 2 } else { 1 };
  logical_cores.saturating_sub(reserve).max(1).clamp(1, 12)
}

fn strategy_runtime_device_config() -> (&'static str, u32) {
  ("none", 0)
}

fn strategy_runtime_config(
  requested_n_ctx: Option<u32>,
  requested_threads: Option<u32>,
) -> StrategyRuntimeConfig {
  let (device, n_gpu_layers) = strategy_runtime_device_config();
  let n_ctx = requested_n_ctx.unwrap_or(4096).clamp(2048, 4096);
  let threads = requested_threads.unwrap_or_else(strategy_default_threads).clamp(1, 12);
  StrategyRuntimeConfig {
    n_ctx,
    threads,
    n_gpu_layers,
    device,
  }
}

fn strategy_hybrid_draft_n_ctx(base_n_ctx: u32) -> u32 {
  base_n_ctx.min(3584).max(2560)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StrategyQuestionRoute {
  FastRoosy,
  Hybrid,
}

fn strategy_question_is_comparison(message: &str) -> bool {
  let compact = strategy_compact_text(message);
  [
    "누가가장문제",
    "누가더문제",
    "누가문제",
    "누가더잘못",
    "누가잘못",
    "누가더책임",
    "책임은누구",
    "가해자",
    "a의잘못",
    "b의잘못",
    "비하면어떰",
    "비하면어때",
  ]
  .iter()
  .any(|keyword| compact.contains(keyword))
}

fn strategy_question_is_message_drafting(message: &str) -> bool {
  let compact = strategy_compact_text(message);
  [
    "뭐라고말",
    "어떻게말",
    "어떻게정리",
    "답장",
    "문자",
    "보낼지",
    "써줘",
  ]
  .iter()
  .any(|keyword| compact.contains(keyword))
}

fn strategy_question_route(message: &str) -> StrategyQuestionRoute {
  let compact = strategy_compact_text(message);
  let is_trivial_smalltalk = [
    "안녕",
    "반가워",
    "고마워",
    "감사",
    "오케이",
    "확인",
    "좋아",
  ]
  .iter()
  .any(|keyword| compact.contains(keyword))
    && compact.chars().count() <= 12;

  if is_trivial_smalltalk {
    StrategyQuestionRoute::FastRoosy
  } else {
    StrategyQuestionRoute::Hybrid
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StrategyEvidenceRecord {
  pub ref_id: String,
  pub record_id: String,
  pub ts: String,
  pub actor: String,
  pub place: String,
  pub store: String,
  pub summary: String,
  pub score: f32,
  #[serde(default)]
  pub risk_label: String,
  #[serde(default)]
  pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StrategyEvidencePacket {
  #[serde(default)]
  pub mode: String,
  #[serde(default)]
  pub case_title: String,
  #[serde(default)]
  pub focus_summary: String,
  #[serde(default)]
  pub overview: String,
  #[serde(default)]
  pub actor_summary: Vec<String>,
  #[serde(default)]
  pub timeline_summary: Vec<String>,
  #[serde(default)]
  pub risk_summary: Vec<String>,
  #[serde(default)]
  pub gaps: Vec<String>,
  #[serde(default)]
  pub evidence_records: Vec<StrategyEvidenceRecord>,
  #[serde(default)]
  pub legal_references: Vec<StrategyLegalReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StrategyLegalReference {
  pub ref_id: String,
  pub law_id: String,
  pub law_name: String,
  #[serde(default)]
  pub short_name: String,
  #[serde(default)]
  pub article_ref: String,
  #[serde(default)]
  pub article_title: String,
  #[serde(default)]
  pub legal_point: String,
  #[serde(default)]
  pub teacher_use_case: String,
  #[serde(default)]
  pub source_url: String,
  #[serde(default)]
  pub status_label: String,
  #[serde(default)]
  pub relevance_reasons: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct StrategyLegalDataset {
  retrieval_boosters: StrategyLegalRetrievalBoosters,
  records: Vec<StrategyLegalLawRecord>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct StrategyLegalRetrievalBoosters {
  concept_map: HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct StrategyLegalLawRecord {
  record_id: String,
  official_name: String,
  short_name: String,
  current_status_label: String,
  source_url: String,
  school_relevance: String,
  rag: StrategyLegalLawRag,
  key_articles: Vec<StrategyLegalArticle>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct StrategyLegalLawRag {
  aliases: Vec<String>,
  topical_tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct StrategyLegalArticle {
  article_no: String,
  article_title: String,
  legal_point: String,
  teacher_use_case: String,
  keywords: Vec<String>,
  retrieval_text: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct StrategyLegalFlatChunk {
  record_id: String,
  official_name: String,
  short_name: String,
  current_status_label: String,
  source_url: String,
  school_relevance: String,
  topical_tags: Vec<String>,
  aliases: Vec<String>,
  chunk_type: String,
  chunk_id: String,
  article_no: String,
  article_title: String,
  legal_point: String,
  teacher_use_case: String,
  keywords: Vec<String>,
  retrieval_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StrategyProgressPayload {
  stage: String,
  message: String,
}

fn strategy_trim(s: &str, limit: usize) -> String {
  s.chars().take(limit).collect::<String>()
}

fn strategy_is_supported_char(ch: char) -> bool {
  let cp = ch as u32;
  if cp > 0xFFFF {
    return false;
  }
  if (0xE000..=0xF8FF).contains(&cp) {
    return false;
  }
  if (0xFDD0..=0xFDEF).contains(&cp) {
    return false;
  }
  if (cp & 0xFFFF) == 0xFFFE || (cp & 0xFFFF) == 0xFFFF {
    return false;
  }
  true
}

fn strategy_sanitize_text(input: &str) -> String {
  let mut out = String::with_capacity(input.len());
  let mut prev_blank = false;
  for ch in input.chars() {
    if ch == '\u{fffd}' {
      continue;
    }
    if !strategy_is_supported_char(ch) {
      continue;
    }
    if ch == '\r' {
      continue;
    }
    let normalized = if ch == '\t' { ' ' } else { ch };
    if normalized == '\n' {
      if prev_blank {
        continue;
      }
      out.push('\n');
      prev_blank = true;
      continue;
    }
    if normalized.is_control() {
      continue;
    }
    if normalized.is_whitespace() {
      out.push(' ');
      prev_blank = false;
      continue;
    }
    out.push(normalized);
    prev_blank = false;
  }
  out.trim().to_string()
}

fn strategy_compact_text(input: &str) -> String {
  strategy_sanitize_text(input)
    .chars()
    .filter(|ch| !ch.is_whitespace())
    .collect::<String>()
}

fn strategy_question_focus_hint(message: &str) -> Option<String> {
  if strategy_question_is_comparison(message) {
    return Some(
      "- 이번 질문은 책임·잘못 비교 요청이다.\n- 첫 문장에서 바로 비교 결론을 답하라.\n- 현재 증거만으로 한쪽이 더 문제라고 단정하기 어렵다면 그 점을 첫 문장에서 분명히 말하라.\n- 증거 목록 나열보다 결론 → 이유 → 바로 쓸 말 순서로 정리하라.".to_string(),
    );
  }

  if strategy_question_is_message_drafting(message) {
    return Some(
      "- 이번 질문은 바로 전달할 문장을 원하는 요청이다.\n- 첫 문단에서 상황판단을 짧게 말한 뒤, 바로 복사해 쓸 수 있는 문장을 먼저 제시하라.".to_string(),
    );
  }

  None
}

fn strategy_question_needs_legal_refs(message: &str) -> bool {
  let compact = strategy_compact_text(message);
  [
    "법",
    "법적",
    "조문",
    "근거",
    "규정",
    "법령",
    "위법",
    "처벌",
    "고소",
    "신고",
  ]
  .iter()
  .any(|keyword| compact.contains(keyword))
}

fn write_strategy_prompt_file(prefix: &str, content: &str) -> Result<PathBuf, String> {
  let dir = std::env::temp_dir().join("roosycozy_strategy");
  fs::create_dir_all(&dir).map_err(|e| format!("전략자문 임시 폴더를 만들지 못했어요: {e}"))?;
  let stamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  let name = format!("{}_{}_{}.txt", prefix, std::process::id(), stamp);
  let path = dir.join(name);
  fs::write(&path, content.as_bytes()).map_err(|e| format!("전략자문 임시 프롬프트를 쓰지 못했어요: {e}"))?;
  Ok(path)
}

fn cleanup_strategy_prompt_file(path: &Path) {
  let _ = fs::remove_file(path);
}

fn strategy_fit_prompt_to_budget(input: &str, n_ctx: u32, max_tokens: u32) -> String {
  let budget = (n_ctx as usize).saturating_sub(max_tokens as usize + 320).max(1400);
  let char_count = input.chars().count();
  if char_count <= budget {
    return input.to_string();
  }

  let head_len = ((budget as f32) * 0.68) as usize;
  let tail_len = budget.saturating_sub(head_len + 18);
  let head = input.chars().take(head_len).collect::<String>();
  let tail_chars = input.chars().rev().take(tail_len).collect::<Vec<_>>();
  let tail = tail_chars.into_iter().rev().collect::<String>();
  format!("{}\n\n[중간 맥락 일부 압축]\n\n{}", head.trim_end(), tail.trim_start())
}

fn strategy_strip_prompt_echo(input: &str) -> String {
  const MARKERS: [&str; 20] = [
    "[현재 사건 맥락]",
    "[증거 패킷 요약]",
    "[핵심 인물]",
    "[시간 흐름]",
    "[위험 신호]",
    "[비어 있는 정보]",
    "[증거 참조표]",
    "[관련 법령 참조표]",
    "[전략 메모]",
    "[직전 대화]",
    "[이번 요청]",
    "[응답 조건]",
    "[중간 맥락 일부 압축]",
    "[질문]",
    "[핵심 근거]",
    "[관련 법령]",
    "[HyperCLOVA-X 초안]",
    "[Roosy-X 초안]",
    "[합성 지침]",
    "[추가 정보]",
  ];

  let mut cut = input.len();
  for marker in MARKERS {
    if let Some(idx) = input.find(marker) {
      if idx > 80 && idx < cut {
        cut = idx;
      }
    }
  }
  input[..cut].trim_end().to_string()
}

fn emit_strategy_progress(app: Option<&AppHandle>, stage: &str, message: impl Into<String>) {
  let safe_stage = stage.trim();
  let safe_message = message.into().trim().to_string();
  if safe_message.is_empty() {
    return;
  }
  eprintln!("[strategy-chat:{}] {}", safe_stage, safe_message);
  if let Some(app) = app {
    let _ = app.emit(
      STRATEGY_PROGRESS_EVENT,
      StrategyProgressPayload {
        stage: safe_stage.to_string(),
        message: safe_message,
      },
    );
  }
}

fn push_unique_path(out: &mut Vec<PathBuf>, path: PathBuf) {
  if !out.iter().any(|p| p == &path) {
    out.push(path);
  }
}

fn strategy_runner_filenames() -> Vec<&'static str> {
  let mut out = vec![STRATEGY_SIDECAR_FILENAME];
  if STRATEGY_SIDECAR_GENERIC_FILENAME != STRATEGY_SIDECAR_FILENAME {
    out.push(STRATEGY_SIDECAR_GENERIC_FILENAME);
  }
  out
}

fn strategy_runner_hint_text() -> String {
  if STRATEGY_SIDECAR_GENERIC_FILENAME == STRATEGY_SIDECAR_FILENAME {
    return format!("{} 파일", STRATEGY_SIDECAR_FILENAME);
  }
  format!(
    "{} 또는 {} 파일",
    STRATEGY_SIDECAR_FILENAME,
    STRATEGY_SIDECAR_GENERIC_FILENAME
  )
}

fn normalize_strategy_model_id(raw: Option<&str>) -> &'static str {
  match raw.unwrap_or("").trim().to_ascii_lowercase().as_str() {
    STRATEGY_MODEL_HYBRID_ID => STRATEGY_MODEL_HYBRID_ID,
    STRATEGY_MODEL_ROOSY_ID => STRATEGY_MODEL_ROOSY_ID,
    _ => STRATEGY_MODEL_DEFAULT_ID,
  }
}

fn strategy_model_filename_for_id(model_id: &str) -> &'static str {
  match normalize_strategy_model_id(Some(model_id)) {
    STRATEGY_MODEL_ROOSY_ID => STRATEGY_MODEL_ROOSY_FILENAME,
    _ => STRATEGY_MODEL_FILENAME,
  }
}

fn strategy_model_resource_path_for_id(model_id: &str) -> &'static str {
  match normalize_strategy_model_id(Some(model_id)) {
    STRATEGY_MODEL_ROOSY_ID => STRATEGY_MODEL_ROOSY_RESOURCE_PATH,
    _ => STRATEGY_MODEL_RESOURCE_PATH,
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyModelAvailability {
  pub id: String,
  pub label: String,
  pub filename: String,
  pub available: bool,
  pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyModelStatus {
  pub windows_download_mode: bool,
  pub download_supported: bool,
  pub all_ready: bool,
  pub storage_dir: String,
  pub models: Vec<StrategyModelAvailability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StrategyModelDownloadProgress {
  stage: String,
  model_id: String,
  label: String,
  message: String,
  completed: usize,
  total: usize,
  downloaded_bytes: u64,
  total_bytes: u64,
  percent: u8,
  indeterminate: bool,
}

fn strategy_model_min_size_bytes(model_id: &str) -> u64 {
  match normalize_strategy_model_id(Some(model_id)) {
    STRATEGY_MODEL_ROOSY_ID => 300 * 1024 * 1024,
    _ => 220 * 1024 * 1024,
  }
}

fn strategy_model_integrity_error(path: &Path, model_id: &str) -> Option<String> {
  let meta = fs::metadata(path).ok()?;
  if !meta.is_file() {
    return Some("모델 경로가 일반 파일이 아니에요.".to_string());
  }

  let file_size = meta.len();
  let min_size = strategy_model_min_size_bytes(model_id);
  if file_size < min_size {
    return Some(format!(
      "파일 크기가 너무 작아요. {:.1}MB만 내려받힌 상태예요.",
      file_size as f64 / (1024.0 * 1024.0)
    ));
  }

  let mut file = fs::File::open(path).ok()?;
  let mut magic = [0_u8; 4];
  if file.read_exact(&mut magic).is_err() {
    return Some("모델 파일 헤더를 읽지 못했어요.".to_string());
  }
  if &magic != b"GGUF" {
    return Some("모델 파일 시작 부분이 GGUF 형식이 아니에요.".to_string());
  }

  None
}

fn strategy_model_runtime_hint(path: &Path, model_id: &str) -> String {
  let mut hints = Vec::new();
  if let Some(reason) = strategy_model_integrity_error(path, model_id) {
    hints.push(format!("파일 상태: {}", reason));
  }
  #[cfg(target_os = "windows")]
  {
    if path.to_string_lossy().chars().any(|ch| !ch.is_ascii()) {
      hints.push("현재 모델 경로에 한글/특수문자가 있어 일부 Windows PC에서 추론기가 파일을 못 여는 경우가 있어요.".to_string());
    }
  }
  if hints.is_empty() {
    hints.push("파일 자체는 있지만, 특정 PC에서는 백신 격리·권한 문제·메모리 부족 때문에 로딩이 실패할 수 있어요.".to_string());
  }
  hints.join(" ")
}

fn strategy_model_label_for_id(model_id: &str) -> &'static str {
  match normalize_strategy_model_id(Some(model_id)) {
    STRATEGY_MODEL_HYBRID_ID => "ROOSY-Hybrid",
    STRATEGY_MODEL_ROOSY_ID => "Roosy-X",
    _ => "HyperCLOVA-X",
  }
}

#[cfg(target_os = "windows")]
fn configure_strategy_child_process(command: &mut Command) {
  command.creation_flags(STRATEGY_CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_strategy_child_process(_command: &mut Command) {}

fn looks_like_windows_path_line(s: &str) -> bool {
  let bytes = s.as_bytes();
  bytes.len() > 3 && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/')
}

fn is_strategy_runtime_noise(trimmed: &str) -> bool {
  let lower = trimmed.to_ascii_lowercase();
  looks_like_windows_path_line(trimmed)
    || lower.contains("using custom system prompt")
    || lower.contains("llama-sidecar")
    || lower.contains("llama-cli")
    || lower.contains("llama-server")
    || lower.contains(".gguf")
    || lower.starts_with("main: ")
    || lower.starts_with("system info")
    || lower.starts_with("sampler ")
    || lower.starts_with("generate: ")
    || lower.starts_with("n_ctx")
    || lower.starts_with("n_batch")
    || lower.starts_with("build info")
    || lower.starts_with("load_tensors")
    || lower.starts_with("load_backend")
    || lower.starts_with("common params")
    || lower.starts_with("print_info")
    || lower.starts_with("encode ")
    || lower.starts_with("decode ")
    || lower.starts_with("slot ")
    || lower.starts_with("srv ")
}

fn should_emit_strategy_runtime_log(trimmed: &str) -> bool {
  let lower = trimmed.to_ascii_lowercase();
  !is_strategy_runtime_noise(trimmed)
    && (lower.contains("error")
      || lower.contains("failed")
      || lower.contains("cannot")
      || lower.contains("invalid")
      || lower.contains("exception"))
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<(), String> {
  let meta = fs::metadata(path).map_err(|e| format!("cannot inspect sidecar permissions: {e}"))?;
  let mut perms = meta.permissions();
  let mode = perms.mode();
  if mode & 0o111 == 0 {
    perms.set_mode(mode | 0o755);
    fs::set_permissions(path, perms).map_err(|e| format!("cannot mark sidecar executable: {e}"))?;
  }
  Ok(())
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> Result<(), String> {
  Ok(())
}

#[cfg(target_os = "windows")]
fn strategy_sidecar_storage_dir(app: Option<&AppHandle>) -> Option<PathBuf> {
  if let Some(app) = app {
    if let Ok(path) = app.path().resolve("sidecar", BaseDirectory::AppData) {
      return Some(path);
    }
  }
  None
}

#[cfg(not(target_os = "windows"))]
fn strategy_sidecar_storage_dir(_app: Option<&AppHandle>) -> Option<PathBuf> {
  None
}

#[cfg(target_os = "windows")]
fn copy_strategy_runtime_tree(source: &Path, target: &Path) -> Result<(), String> {
  if !source.exists() {
    return Ok(());
  }
  fs::create_dir_all(target).map_err(|e| format!("AI 런타임 폴더를 만들지 못했어요: {}", e))?;
  for entry in fs::read_dir(source).map_err(|e| format!("AI 런타임 폴더를 읽지 못했어요: {}", e))? {
    let entry = entry.map_err(|e| format!("AI 런타임 폴더 항목을 읽지 못했어요: {}", e))?;
    let source_path = entry.path();
    let target_path = target.join(entry.file_name());
    if source_path.is_dir() {
      copy_strategy_runtime_tree(&source_path, &target_path)?;
    } else {
      if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("AI 런타임 하위 폴더를 만들지 못했어요: {}", e))?;
      }
      fs::copy(&source_path, &target_path).map_err(|e| format!("AI 런타임 파일 복사에 실패했어요: {}", e))?;
    }
  }
  Ok(())
}

#[cfg(target_os = "windows")]
fn hydrate_strategy_runtime_to_appdata(app: Option<&AppHandle>) {
  let Some(target_dir) = strategy_sidecar_storage_dir(app) else {
    return;
  };

  let has_all_required = strategy_runner_filenames()
    .iter()
    .any(|name| target_dir.join(name).exists())
    && target_dir.join("llama.dll").exists()
    && target_dir.join("mtmd.dll").exists();
  if has_all_required {
    return;
  }

  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      let bootstrap_candidates = [
        dir.join("RoosyCozy").join("sidecar"),
        dir.join("sidecar"),
      ];
      for source in bootstrap_candidates {
        if source.exists() {
          let _ = copy_strategy_runtime_tree(&source, &target_dir);
          break;
        }
      }
    }
  }
}

#[cfg(not(target_os = "windows"))]
fn hydrate_strategy_runtime_to_appdata(_app: Option<&AppHandle>) {}

fn strategy_runner_candidates(_app: Option<&AppHandle>) -> Vec<PathBuf> {
  let mut out = Vec::<PathBuf>::new();
  hydrate_strategy_runtime_to_appdata(_app);

  if let Some(dir) = strategy_sidecar_storage_dir(_app) {
    for file_name in strategy_runner_filenames() {
      push_unique_path(&mut out, dir.join(file_name));
    }
  }

  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      for file_name in strategy_runner_filenames() {
        push_unique_path(&mut out, dir.join("RoosyCozy").join("sidecar").join(file_name));
      }
      for file_name in strategy_runner_filenames() {
        push_unique_path(&mut out, dir.join("sidecar").join(file_name));
      }
    }
  }

  #[cfg(debug_assertions)]
  {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for file_name in strategy_runner_filenames() {
      push_unique_path(&mut out, manifest.join("binaries").join(file_name));
      push_unique_path(&mut out, manifest.join("resources").join("sidecar").join(file_name));
    }
  }

  out
}

fn resolve_strategy_runner_path(app: Option<&AppHandle>) -> Result<PathBuf, String> {
  for candidate in strategy_runner_candidates(app) {
    if candidate.exists() {
      let _ = ensure_executable(&candidate);
      return Ok(candidate);
    }
  }
  #[cfg(target_os = "windows")]
  {
    return Err(format!(
      "전략자문 추론기 파일을 찾지 못했어요. 먼저 AI 모델 다운로드를 완료했는지 확인해주세요. 실행 파일은 AppData 쪽 sidecar에서 찾고 있어요. 필요한 파일: {}",
      strategy_runner_hint_text()
    ));
  }

  #[cfg(not(target_os = "windows"))]
  {
    Err(format!(
      "전략자문 추론기 파일을 찾지 못했어요. 앱 번들의 sidecar 안에 {}이(가) 함께 포함되어야 해요.",
      strategy_runner_hint_text()
    ))
  }
}

struct StrategyModelDownloadSpec {
  model_id: &'static str,
  label: &'static str,
  filename: &'static str,
  default_url: &'static str,
}

fn strategy_model_download_specs() -> [StrategyModelDownloadSpec; 2] {
  [
    StrategyModelDownloadSpec {
      model_id: STRATEGY_MODEL_DEFAULT_ID,
      label: strategy_model_label_for_id(STRATEGY_MODEL_DEFAULT_ID),
      filename: STRATEGY_MODEL_FILENAME,
      default_url: STRATEGY_MODEL_DEFAULT_URL,
    },
    StrategyModelDownloadSpec {
      model_id: STRATEGY_MODEL_ROOSY_ID,
      label: strategy_model_label_for_id(STRATEGY_MODEL_ROOSY_ID),
      filename: STRATEGY_MODEL_ROOSY_FILENAME,
      default_url: STRATEGY_MODEL_ROOSY_DEFAULT_URL,
    },
  ]
}

fn emit_strategy_model_download_progress(
  app: &AppHandle,
  stage: &str,
  model_id: &str,
  label: &str,
  message: impl Into<String>,
  completed: usize,
  total: usize,
  downloaded_bytes: u64,
  total_bytes: u64,
  percent: u8,
  indeterminate: bool,
) {
  let event_key = (stage.to_string(), model_id.to_string(), completed, total);
  let last_event = STRATEGY_MODEL_DOWNLOAD_LAST_EVENT.get_or_init(|| Mutex::new(None));
  if let Ok(mut guard) = last_event.lock() {
    if stage == "downloading" {
      if let Some(previous) = guard.as_ref() {
        if previous == &event_key {
          return;
        }
      }
    }
    *guard = Some(event_key);
  }

  let payload = StrategyModelDownloadProgress {
    stage: stage.to_string(),
    model_id: model_id.to_string(),
    label: label.to_string(),
    message: message.into(),
    completed,
    total,
    downloaded_bytes,
    total_bytes,
    percent,
    indeterminate,
  };
  let _ = app.emit("strategy-model-download-progress", payload);
}

#[cfg(target_os = "windows")]
fn strategy_program_data_root() -> Option<PathBuf> {
  std::env::var_os("PROGRAMDATA")
    .map(PathBuf::from)
    .or_else(|| std::env::var_os("ALLUSERSPROFILE").map(PathBuf::from))
    .map(|base| base.join("co.roosycozy.app"))
}

#[cfg(target_os = "windows")]
fn strategy_program_data_models_dir() -> Option<PathBuf> {
  strategy_program_data_root().map(|root| root.join("models"))
}

#[cfg(target_os = "windows")]
fn strategy_program_data_sidecar_dir() -> Option<PathBuf> {
  strategy_program_data_root().map(|root| root.join("sidecar"))
}

#[cfg(target_os = "windows")]
fn strategy_program_data_resources_dir() -> Option<PathBuf> {
  strategy_program_data_root().map(|root| root.join("resources"))
}

fn strategy_model_status_inner(app: Option<&AppHandle>) -> StrategyModelStatus {
  let specs = strategy_model_download_specs();
  let storage_dir = strategy_model_storage_dir(app)
    .unwrap_or_else(|| PathBuf::from("."))
    .display()
    .to_string();
  let models = specs
    .iter()
    .map(|spec| {
      let path = strategy_existing_model_path(app, spec.model_id);
      StrategyModelAvailability {
        id: spec.model_id.to_string(),
        label: spec.label.to_string(),
        filename: spec.filename.to_string(),
        available: path.is_some(),
        path: path.map(|item| item.display().to_string()).unwrap_or_default(),
      }
    })
    .collect::<Vec<_>>();
  let all_ready = models.iter().all(|item| item.available);
  StrategyModelStatus {
    windows_download_mode: cfg!(target_os = "windows"),
    download_supported: cfg!(target_os = "windows"),
    all_ready,
    storage_dir,
    models,
  }
}

pub fn strategy_model_status(app: Option<&AppHandle>) -> Result<StrategyModelStatus, String> {
  Ok(strategy_model_status_inner(app))
}

#[cfg(target_os = "windows")]
fn download_strategy_model_file<F>(url: &str, target: &Path, mut on_progress: F) -> Result<(), String>
where
  F: FnMut(u64, u64, u8),
{
  let client = reqwest::blocking::Client::builder()
    .user_agent("roosycozy/1.0 (windows-model-downloader)")
    .build()
    .map_err(|err| format!("다운로드 클라이언트를 준비하지 못했어요: {err}"))?;
  let mut response = client
    .get(url)
    .send()
    .map_err(|err| format!("모델 다운로드를 시작하지 못했어요: {err}"))?;
  if !response.status().is_success() {
    return Err(format!("모델 다운로드 응답이 올바르지 않아요: HTTP {}", response.status()));
  }
  let total_bytes = response.content_length().unwrap_or(0);
  let tmp_path = target.with_extension("part");
  if tmp_path.exists() {
    let _ = std::fs::remove_file(&tmp_path);
  }
  if let Some(parent) = tmp_path.parent() {
    std::fs::create_dir_all(parent).map_err(|err| format!("모델 저장 폴더를 만들지 못했어요: {err}"))?;
  }
  let mut file = std::fs::File::create(&tmp_path).map_err(|err| format!("임시 모델 파일을 만들지 못했어요: {err}"))?;
  let mut downloaded_bytes = 0u64;
  let mut buffer = vec![0u8; 256 * 1024];
  let mut last_percent = 0u8;
  let mut last_reported_bytes = 0u64;
  on_progress(0, total_bytes, 0);
  loop {
    let read = response
      .read(&mut buffer)
      .map_err(|err| format!("모델 파일을 내려받는 중 읽기 오류가 발생했어요: {err}"))?;
    if read == 0 {
      break;
    }
    file
      .write_all(&buffer[..read])
      .map_err(|err| format!("모델 파일을 저장하지 못했어요: {err}"))?;
    downloaded_bytes += read as u64;
    let percent = if total_bytes > 0 {
      (((downloaded_bytes as f64 / total_bytes as f64) * 100.0).round() as i64).clamp(0, 100) as u8
    } else {
      (((downloaded_bytes / (1024 * 1024)) % 90) as u8).clamp(1, 90)
    };
    let advanced_enough = downloaded_bytes >= last_reported_bytes.saturating_add(512 * 1024);
    if total_bytes == 0 || advanced_enough || percent >= last_percent.saturating_add(1) || downloaded_bytes == total_bytes {
      last_percent = percent;
      last_reported_bytes = downloaded_bytes;
      on_progress(downloaded_bytes, total_bytes, percent);
    }
  }
  on_progress(downloaded_bytes, total_bytes, 100);
  file.flush().map_err(|err| format!("모델 파일 저장을 마무리하지 못했어요: {err}"))?;
  std::fs::rename(&tmp_path, target).map_err(|err| format!("모델 파일 저장을 완료하지 못했어요: {err}"))?;
  Ok(())
}

pub fn start_strategy_model_download(app: &AppHandle) -> Result<StrategyModelStatus, String> {
  #[cfg(target_os = "windows")]
  {
    if let Some(root) = strategy_program_data_root() {
      let _ = fs::create_dir_all(root.join("models"));
      let _ = fs::create_dir_all(root.join("sidecar"));
      let _ = fs::create_dir_all(root.join("resources"));
    }
  }
  let current_status = strategy_model_status_inner(Some(app));
  if current_status.all_ready {
    return Ok(current_status);
  }

  let running = STRATEGY_MODEL_DOWNLOAD_RUNNING.get_or_init(|| Mutex::new(false));
  {
    let mut guard = running
      .lock()
      .map_err(|_| "모델 다운로드 상태를 확인하지 못했어요.".to_string())?;
    if *guard {
      return Ok(current_status);
    }
    *guard = true;
  }

  emit_strategy_model_download_progress(
    app,
    "starting",
    "all",
    "AI 모델",
    "최초 1회 모델 다운로드를 준비하고 있어요.",
    0,
    2,
    0,
    0,
    0,
    true,
  );

  let app_handle = app.clone();
  thread::spawn(move || {
    let result = download_strategy_models(&app_handle);
    match result {
      Ok(status) => {
        emit_strategy_model_download_progress(
          &app_handle,
          "done",
          "all",
          "AI 모델",
          "모델 다운로드가 끝났어요. 이제 바로 채팅할 수 있어요.",
          status.models.iter().filter(|model| model.available).count(),
          status.models.len(),
          0,
          0,
          100,
          false,
        );
      }
      Err(error) => {
        emit_strategy_model_download_progress(
          &app_handle,
          "error",
          "all",
          "AI 모델",
          error,
          0,
          2,
          0,
          0,
          0,
          true,
        );
      }
    }

    if let Ok(mut guard) = STRATEGY_MODEL_DOWNLOAD_RUNNING
      .get_or_init(|| Mutex::new(false))
      .lock()
    {
      *guard = false;
    }
  });

  Ok(current_status)
}

pub fn download_strategy_models(app: &AppHandle) -> Result<StrategyModelStatus, String> {
  #[cfg(not(target_os = "windows"))]
  {
    return Ok(strategy_model_status_inner(Some(app)));
  }

  #[cfg(target_os = "windows")]
  {
    let _guard = STRATEGY_MODEL_DOWNLOAD_LOCK
      .get_or_init(|| Mutex::new(()))
      .lock()
      .map_err(|_| "모델 다운로드 잠금을 잡지 못했어요.".to_string())?;
    let storage_dir = strategy_model_storage_dir(Some(app))
      .ok_or_else(|| "모델 저장 폴더를 찾지 못했어요.".to_string())?;
    std::fs::create_dir_all(&storage_dir).map_err(|err| format!("모델 저장 폴더를 준비하지 못했어요: {err}"))?;

    let specs = strategy_model_download_specs();
    let total = specs.len();
    let mut completed = 0usize;
    let mut handles = Vec::new();

    for spec in specs.iter() {
      let target = storage_dir.join(spec.filename);
      if target.exists() {
        if strategy_model_integrity_error(&target, spec.model_id).is_none() {
          completed += 1;
          emit_strategy_model_download_progress(
            app,
            "skip",
            spec.model_id,
            spec.label,
            format!("{} 모델이 이미 준비되어 있어요.", spec.label),
            completed,
            total,
            0,
            0,
            100,
            false,
          );
          continue;
        }

        let reason = strategy_model_runtime_hint(&target, spec.model_id);
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_file(target.with_extension("part"));
        emit_strategy_model_download_progress(
          app,
          "repair",
          spec.model_id,
          spec.label,
          format!("{} 모델 파일이 불완전해서 다시 내려받을게요. {}", spec.label, reason),
          completed,
          total,
          0,
          0,
          0,
          true,
        );
      }

      let app_handle = app.clone();
      let model_id = spec.model_id.to_string();
      let label = spec.label.to_string();
      let url = spec.default_url.to_string();
      handles.push(thread::spawn(move || -> Result<(String, String), String> {
        emit_strategy_model_download_progress(
          &app_handle,
          "start",
          &model_id,
          &label,
          format!("{} 모델을 내려받는 중이에요.", label),
          0,
          total,
          0,
          0,
          0,
          true,
        );
        download_strategy_model_file(&url, &target, |downloaded_bytes, total_bytes, percent| {
          let detail = if total_bytes > 0 {
            format!(
              "{} 모델 다운로드 중 · {}% · {:.1}MB / {:.1}MB",
              label,
              percent,
              downloaded_bytes as f64 / (1024.0 * 1024.0),
              total_bytes as f64 / (1024.0 * 1024.0)
            )
          } else {
            format!(
              "{} 모델 다운로드 중 · {:.1}MB 수신",
              label,
              downloaded_bytes as f64 / (1024.0 * 1024.0)
            )
          };
          emit_strategy_model_download_progress(
            &app_handle,
            "progress",
            &model_id,
            &label,
            detail,
            0,
            total,
            downloaded_bytes,
            total_bytes,
            percent,
            total_bytes == 0,
          );
        })?;
        Ok((model_id, label))
      }));
    }

    for handle in handles {
      let (model_id, label) = handle
        .join()
        .map_err(|_| "모델 다운로드 스레드가 비정상 종료됐어요.".to_string())??;
      completed += 1;
      emit_strategy_model_download_progress(
        app,
        "done",
        &model_id,
        &label,
        format!("{} 모델 다운로드가 끝났어요.", label),
        completed,
        total,
        0,
        0,
        100,
        false,
      );
    }

    let status = strategy_model_status_inner(Some(app));
    emit_strategy_model_download_progress(
      app,
      "complete",
      STRATEGY_MODEL_HYBRID_ID,
      "ROOSY-Hybrid",
      "두 모델 다운로드가 모두 끝났어요.",
      total,
      total,
      0,
      0,
      100,
      false,
    );
    Ok(status)
  }
}

fn strategy_model_candidates(app: Option<&AppHandle>, model_id: &str) -> Vec<PathBuf> {
  let mut out = Vec::<PathBuf>::new();
  let resource_path = strategy_model_resource_path_for_id(model_id);
  let filename = strategy_model_filename_for_id(model_id);

  if let Some(path) = strategy_downloaded_model_path(app, model_id) {
    push_unique_path(&mut out, path);
  }
  if let Some(dir) = strategy_model_legacy_storage_dir(app) {
    push_unique_path(&mut out, dir.join(strategy_model_filename_for_id(model_id)));
  }

  if let Some(app) = app {
    if let Ok(path) = app.path().resolve(resource_path, BaseDirectory::Resource) {
      push_unique_path(&mut out, path);
    }
  }

  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      if let Some(contents) = dir.parent() {
        push_unique_path(&mut out, contents.join("Resources").join("models").join(filename));
      }
      push_unique_path(&mut out, dir.join("RoosyCozy").join("resources").join("models").join(filename));
      push_unique_path(&mut out, dir.join("resources").join("models").join(filename));
    }
  }

  #[cfg(debug_assertions)]
  {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_unique_path(&mut out, manifest.join("resources").join("models").join(filename));
    push_unique_path(&mut out, manifest.join("src").join("engine").join(filename));
    push_unique_path(&mut out, manifest.join(filename));
    if let Some(parent) = manifest.parent() {
      push_unique_path(&mut out, parent.join("src-tauri").join("resources").join("models").join(filename));
    }
  }

  out
}

fn strategy_model_storage_dir(app: Option<&AppHandle>) -> Option<PathBuf> {
  #[cfg(target_os = "windows")]
  {
    if let Some(public_dir) = std::env::var_os("PUBLIC") {
      let candidate = PathBuf::from(public_dir).join("RoosyCozy").join("models");
      if fs::create_dir_all(&candidate).is_ok() {
        return Some(candidate);
      }
    }
  }
  if let Some(app) = app {
    if let Ok(path) = app.path().resolve("models", BaseDirectory::AppData) {
      return Some(path);
    }
  }
  None
}

fn strategy_model_legacy_storage_dir(app: Option<&AppHandle>) -> Option<PathBuf> {
  if let Some(app) = app {
    if let Ok(path) = app.path().resolve("models", BaseDirectory::AppData) {
      return Some(path);
    }
  }
  None
}

fn strategy_downloaded_model_path(app: Option<&AppHandle>, model_id: &str) -> Option<PathBuf> {
  strategy_model_storage_dir(app).map(|dir| dir.join(strategy_model_filename_for_id(model_id)))
}

fn strategy_existing_model_path(app: Option<&AppHandle>, model_id: &str) -> Option<PathBuf> {
  for candidate in strategy_model_candidates(app, model_id) {
    if candidate.exists() && strategy_model_integrity_error(&candidate, model_id).is_none() {
      #[cfg(target_os = "windows")]
      {
        if candidate.to_string_lossy().chars().any(|ch| !ch.is_ascii()) {
          if let Some(public_dir) = strategy_model_storage_dir(app) {
            let migrated = public_dir.join(strategy_model_filename_for_id(model_id));
            if migrated != candidate {
              if fs::create_dir_all(&public_dir).is_ok() && fs::copy(&candidate, &migrated).is_ok() {
                return Some(migrated);
              }
            }
          }
        }
      }
      return Some(candidate);
    }
  }
  None
}

fn resolve_strategy_model_path(app: Option<&AppHandle>, model_id: &str) -> Result<PathBuf, String> {
  let filename = strategy_model_filename_for_id(model_id);
  if let Some(path) = strategy_existing_model_path(app, model_id) {
    return Ok(path);
  }
  if let Some(path) = strategy_downloaded_model_path(app, model_id) {
    if path.exists() {
      let reason = strategy_model_runtime_hint(&path, model_id);
      return Err(format!(
        "{} 모델 파일이 손상됐거나 현재 PC에서 정상 로딩되지 않는 상태예요. 채팅 화면에서 AI 모델 다운로드를 다시 실행해주세요. 경로: {} / {}",
        strategy_model_label_for_id(model_id),
        path.display(),
        reason
      ));
    }
  }
  #[cfg(target_os = "windows")]
  let message = format!(
    "{} 모델 파일을 찾지 못했어요. 채팅 화면에서 먼저 AI 모델 다운로드를 실행한 뒤 다시 시도해주세요. 필요한 파일: {}",
    strategy_model_label_for_id(model_id),
    filename
  );
  #[cfg(not(target_os = "windows"))]
  let message = format!(
    "{} 모델 파일을 찾지 못했어요. App 번들의 Resources/models 안에 {} 파일을 포함해주세요.",
    strategy_model_label_for_id(model_id),
    filename
  );
  Err(message)
}

fn format_actor_short(actor: &ActorRef) -> String {
  let kind = actor.r#type.trim();
  let name = actor.name.trim();
  if kind.is_empty() {
    return name.to_string();
  }
  if name.is_empty() {
    return kind.to_string();
  }
  format!("{} {}", kind, name)
}

fn strategy_store_label(record: &RecordItem) -> String {
  let store = record.store_type.trim();
  let other = record.store_other.trim();
  if store.is_empty() || store == "기타" {
    if other.is_empty() {
      "기록유형 미상".to_string()
    } else {
      other.to_string()
    }
  } else {
    store.to_string()
  }
}

fn strategy_place_label(record: &RecordItem) -> String {
  let place = record.place.trim();
  let other = record.place_other.trim();
  if place.is_empty() || place == "기타" {
    if other.is_empty() {
      "장소 미상".to_string()
    } else {
      other.to_string()
    }
  } else {
    place.to_string()
  }
}

fn strategy_main_actor_label(record: &RecordItem) -> String {
  let actor_names = record_main_actor_names(record);
  actor_names
    .get(0)
    .cloned()
    .filter(|x| !x.trim().is_empty())
    .unwrap_or_else(|| {
      let label = format_actor_short(&record.actor);
      if label.trim().is_empty() {
        "당사자 미상".to_string()
      } else {
        label
      }
    })
}

fn strategy_effective_risk(record: &RecordItem) -> RiskPrediction {
  record.risk.clone().unwrap_or_else(|| predict_risk(record))
}

fn summarize_case_context(case_item: Option<&CaseItem>) -> String {
  if let Some(case_item) = case_item {
    let title = case_item.title.trim();
    let actors = case_item
      .actors
      .iter()
      .take(4)
      .map(format_actor_short)
      .collect::<Vec<_>>()
      .join(", ");
    let query = strategy_trim(case_item.query.trim(), 280);
    let mut lines = vec![format!("- 사건 제목: {}", if title.is_empty() { "제목 없음" } else { title })];
    if !actors.is_empty() {
      lines.push(format!("- 핵심 인물: {}", actors));
    }
    if !query.is_empty() {
      lines.push(format!("- 사건 설명: {}", query));
    }
    if !case_item.time_from.trim().is_empty() || !case_item.time_to.trim().is_empty() {
      lines.push(format!("- 기간 필터: {} ~ {}", case_item.time_from.trim(), case_item.time_to.trim()));
    }
    return lines.join("\n");
  }
  "- 사건 연결 없이 증거만으로 분석 중".to_string()
}

fn strategy_legal_dataset() -> &'static StrategyLegalDataset {
  STRATEGY_LEGAL_DATASET.get_or_init(|| {
    serde_json::from_str::<StrategyLegalDataset>(STRATEGY_LEGAL_RAG_JSON)
      .unwrap_or_else(|err| panic!("failed to load legal rag dataset: {err}"))
  })
}

fn strategy_legal_flat_chunks() -> &'static Vec<StrategyLegalFlatChunk> {
  STRATEGY_LEGAL_FLAT_CHUNKS.get_or_init(|| {
    STRATEGY_LEGAL_RAG_JSONL
      .lines()
      .filter_map(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() {
          return None;
        }
        serde_json::from_str::<StrategyLegalFlatChunk>(trimmed).ok()
      })
      .collect::<Vec<_>>()
  })
}

fn strategy_push_unique_term(out: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return;
  }
  let normalized = norm(trimmed);
  if normalized.chars().count() < 2 {
    return;
  }
  if seen.insert(normalized) {
    out.push(trimmed.to_string());
  }
}

fn strategy_push_unique_reason(out: &mut Vec<String>, reason: String) {
  let trimmed = reason.trim();
  if trimmed.is_empty() {
    return;
  }
  if !out.iter().any(|item| item == trimmed) {
    out.push(trimmed.to_string());
  }
}

fn strategy_collect_legal_source_text(
  case_item: Option<&CaseItem>,
  selected_records: &[&RecordItem],
  retrieval_query: &str,
  message: &str,
  strategy_note: Option<&str>,
) -> String {
  let mut parts = Vec::<String>::new();
  if let Some(case_item) = case_item {
    if !case_item.title.trim().is_empty() {
      parts.push(case_item.title.trim().to_string());
    }
    if !case_item.query.trim().is_empty() {
      parts.push(case_item.query.trim().to_string());
    }
    for actor in case_item.actors.iter().take(6) {
      let label = format_actor_short(actor);
      if !label.trim().is_empty() {
        parts.push(label);
      }
    }
  }
  if !retrieval_query.trim().is_empty() {
    parts.push(retrieval_query.trim().to_string());
  }
  if !message.trim().is_empty() {
    parts.push(message.trim().to_string());
  }
  if let Some(note) = strategy_note.map(str::trim).filter(|note| !note.is_empty()) {
    parts.push(note.to_string());
  }
  for record in selected_records {
    if !record.summary.trim().is_empty() {
      parts.push(record.summary.trim().to_string());
    }
    let actor = strategy_main_actor_label(record);
    if !actor.trim().is_empty() {
      parts.push(actor);
    }
    let place = strategy_place_label(record);
    if !place.trim().is_empty() && place != "장소 미상" {
      parts.push(place);
    }
    if let Some(parts_summary) = record.summary_parts.as_ref() {
      for field in [
        parts_summary.background.trim(),
        parts_summary.teacher_actions.trim(),
        parts_summary.issues.trim(),
        parts_summary.evidence_list.trim(),
        parts_summary.other.trim(),
      ] {
        if !field.is_empty() {
          parts.push(field.to_string());
        }
      }
    }
    for related in &record.related {
      let label = format_actor_short(related);
      if !label.trim().is_empty() {
        parts.push(label);
      }
    }
  }
  strategy_trim(&parts.join(" "), 2400)
}

fn strategy_build_legal_query_terms(source_text: &str, concept_map: &HashMap<String, Vec<String>>) -> Vec<String> {
  let source_norm = norm(source_text);
  let mut out = Vec::<String>::new();
  let mut seen = HashSet::<String>::new();

  for token in tokenize(&source_norm) {
    strategy_push_unique_term(&mut out, &mut seen, &token);
  }

  for (concept, expansions) in concept_map {
    let concept_norm = norm(concept);
    if concept_norm.is_empty() || !source_norm.contains(&concept_norm) {
      continue;
    }
    strategy_push_unique_term(&mut out, &mut seen, concept);
    for expansion in expansions {
      strategy_push_unique_term(&mut out, &mut seen, expansion);
    }
  }

  out.truncate(80);
  out
}

fn strategy_phrase_score(
  source_norm: &str,
  phrases: &[String],
  weight: f32,
  reason_prefix: &str,
  reasons: &mut Vec<String>,
) -> f32 {
  let mut score = 0.0;
  for phrase in phrases {
    let trimmed = phrase.trim();
    let normalized = norm(trimmed);
    if normalized.chars().count() < 2 || !source_norm.contains(&normalized) {
      continue;
    }
    score += weight;
    strategy_push_unique_reason(reasons, format!("{} {}", reason_prefix, trimmed));
  }
  score
}

fn strategy_overlap_score(source_norm: &str, query_terms: &[String], reasons: &mut Vec<String>) -> f32 {
  let mut matched = Vec::<String>::new();
  for term in query_terms {
    let normalized = norm(term);
    if normalized.chars().count() < 2 || !source_norm.contains(&normalized) {
      continue;
    }
    if !matched.iter().any(|item| item == term) {
      matched.push(term.clone());
    }
  }
  for term in matched.iter().take(4) {
    strategy_push_unique_reason(reasons, format!("질의 일치 {}", term));
  }
  (matched.len().min(6) as f32) * 0.22
}

fn build_strategy_legal_line_for_prompt(reference: &StrategyLegalReference) -> String {
  let law_name = if reference.short_name.trim().is_empty() {
    reference.law_name.trim().to_string()
  } else {
    format!("{} ({})", reference.short_name.trim(), reference.law_name.trim())
  };
  let mut line = format!(
    "[{}] {} {} {}",
    reference.ref_id,
    strategy_trim(&law_name, 52),
    strategy_trim(reference.article_ref.trim(), 18),
    strategy_trim(reference.article_title.trim(), 44)
  );
  if !reference.legal_point.trim().is_empty() {
    line.push_str(&format!(" | 취지: {}", strategy_trim(reference.legal_point.trim(), 120)));
  }
  if !reference.teacher_use_case.trim().is_empty() {
    line.push_str(&format!(" | 현장 적용: {}", strategy_trim(reference.teacher_use_case.trim(), 110)));
  }
  if !reference.relevance_reasons.is_empty() {
    line.push_str(&format!(" | 연결 이유: {}", strategy_trim(&reference.relevance_reasons.join(", "), 96)));
  }
  line
}

fn build_strategy_legal_references(
  case_item: Option<&CaseItem>,
  selected_records: &[&RecordItem],
  retrieval_query: &str,
  message: &str,
  strategy_note: Option<&str>,
) -> Vec<StrategyLegalReference> {
  #[derive(Clone)]
  struct Candidate<'a> {
    score: f32,
    reasons: Vec<String>,
    chunk: &'a StrategyLegalFlatChunk,
    law: Option<&'a StrategyLegalLawRecord>,
  }

  let dataset = strategy_legal_dataset();
  let flat_chunks = strategy_legal_flat_chunks();
  if dataset.records.is_empty() && flat_chunks.is_empty() {
    return Vec::new();
  }

  let source_text = strategy_collect_legal_source_text(case_item, selected_records, retrieval_query, message, strategy_note);
  let source_norm = norm(&source_text);
  let query_terms = strategy_build_legal_query_terms(&source_text, &dataset.retrieval_boosters.concept_map);
  let law_by_id = dataset
    .records
    .iter()
    .filter_map(|law| {
      let id = law.record_id.trim().to_string();
      if id.is_empty() { None } else { Some((id, law)) }
    })
    .collect::<HashMap<_, _>>();
  let mut candidates = Vec::<Candidate>::new();

  for chunk in flat_chunks.iter() {
    if !chunk.chunk_type.trim().is_empty() && !chunk.chunk_type.trim().eq_ignore_ascii_case("article") {
      continue;
    }
    let law = law_by_id.get(chunk.record_id.trim()).copied();

    let mut law_names = Vec::<String>::new();
    let mut law_names_seen = HashSet::<String>::new();
    for raw in [
      chunk.official_name.as_str(),
      chunk.short_name.as_str(),
      law.map(|item| item.official_name.as_str()).unwrap_or(""),
      law.map(|item| item.short_name.as_str()).unwrap_or(""),
    ] {
      strategy_push_unique_term(&mut law_names, &mut law_names_seen, raw);
    }

    let mut aliases = Vec::<String>::new();
    let mut aliases_seen = HashSet::<String>::new();
    for raw in &chunk.aliases {
      strategy_push_unique_term(&mut aliases, &mut aliases_seen, raw);
    }
    if let Some(law_item) = law {
      for raw in &law_item.rag.aliases {
        strategy_push_unique_term(&mut aliases, &mut aliases_seen, raw);
      }
    }

    let mut topical_tags = Vec::<String>::new();
    let mut topical_seen = HashSet::<String>::new();
    for raw in &chunk.topical_tags {
      strategy_push_unique_term(&mut topical_tags, &mut topical_seen, raw);
    }
    if let Some(law_item) = law {
      for raw in &law_item.rag.topical_tags {
        strategy_push_unique_term(&mut topical_tags, &mut topical_seen, raw);
      }
    }

    let article_titles = vec![
      chunk.article_title.clone(),
      format!("{} {}", chunk.article_no.trim(), chunk.article_title.trim()).trim().to_string(),
    ];
    let article_keywords = chunk.keywords.clone();
    let article_text = norm(&format!(
      "{} {} {} {} {} {} {} {} {}",
      chunk.official_name,
      chunk.short_name,
      chunk.school_relevance,
      topical_tags.join(" "),
      chunk.article_no,
      chunk.article_title,
      chunk.legal_point,
      chunk.teacher_use_case,
      chunk.retrieval_text
    ));

    let mut reasons = Vec::<String>::new();
    let mut score = 0.0;
    score += strategy_phrase_score(&source_norm, &law_names, 3.1, "법령명 일치", &mut reasons);
    score += strategy_phrase_score(&source_norm, &aliases, 2.7, "법령 별칭 일치", &mut reasons);
    score += strategy_phrase_score(&source_norm, &topical_tags, 2.3, "주제 일치", &mut reasons);
    score += strategy_phrase_score(&source_norm, &article_titles, 1.8, "조문 주제 일치", &mut reasons);
    score += strategy_phrase_score(&source_norm, &article_keywords, 1.6, "키워드 일치", &mut reasons);
    score += strategy_overlap_score(&article_text, &query_terms, &mut reasons);

    if !chunk.school_relevance.trim().is_empty() {
      score += strategy_overlap_score(&norm(chunk.school_relevance.trim()), &query_terms, &mut reasons) * 0.7;
    }
    if source_norm.contains(&norm(chunk.article_no.trim())) && !chunk.article_no.trim().is_empty() {
      score += 1.0;
      strategy_push_unique_reason(&mut reasons, format!("조문 번호 일치 {}", chunk.article_no.trim()));
    }
    if !chunk.retrieval_text.trim().is_empty() {
      score += strategy_overlap_score(&norm(chunk.retrieval_text.trim()), &query_terms, &mut reasons) * 1.15;
    }

    if score >= 2.2 || reasons.len() >= 2 {
      candidates.push(Candidate { score, reasons, chunk, law });
    }
  }

  candidates.sort_by(|a, b| {
    b.score
      .partial_cmp(&a.score)
      .unwrap_or(Ordering::Equal)
      .then_with(|| a.chunk.official_name.cmp(&b.chunk.official_name))
      .then_with(|| a.chunk.article_no.cmp(&b.chunk.article_no))
  });

  let mut per_law = HashMap::<String, usize>::new();
  let mut out = Vec::<StrategyLegalReference>::new();
  for candidate in candidates {
    let law_id = candidate.chunk.record_id.trim().to_string();
    if law_id.is_empty() {
      continue;
    }
    let used = per_law.entry(law_id.clone()).or_insert(0);
    if *used >= 2 {
      continue;
    }
    *used += 1;
    let index = out.len() + 1;
    out.push(StrategyLegalReference {
      ref_id: format!("L{}", index),
      law_id,
      law_name: candidate
        .law
        .map(|item| item.official_name.trim().to_string())
        .unwrap_or_else(|| candidate.chunk.official_name.trim().to_string()),
      short_name: candidate
        .law
        .map(|item| item.short_name.trim().to_string())
        .unwrap_or_else(|| candidate.chunk.short_name.trim().to_string()),
      article_ref: candidate.chunk.article_no.trim().to_string(),
      article_title: candidate.chunk.article_title.trim().to_string(),
      legal_point: candidate.chunk.legal_point.trim().to_string(),
      teacher_use_case: candidate.chunk.teacher_use_case.trim().to_string(),
      source_url: candidate
        .law
        .map(|item| item.source_url.trim().to_string())
        .unwrap_or_else(|| candidate.chunk.source_url.trim().to_string()),
      status_label: candidate
        .law
        .map(|item| item.current_status_label.trim().to_string())
        .unwrap_or_else(|| candidate.chunk.current_status_label.trim().to_string()),
      relevance_reasons: candidate.reasons.into_iter().take(4).collect(),
    });
    if out.len() >= 4 {
      break;
    }
  }

  out
}

fn build_strategy_retrieval_query(
  case_item: Option<&CaseItem>,
  message: &str,
  strategy_note: Option<&str>,
) -> String {
  let mut parts = Vec::<String>::new();
  let question = message.trim();
  if !question.is_empty() {
    parts.push(question.to_string());
  }
  if let Some(case_item) = case_item {
    let title = case_item.title.trim();
    if !title.is_empty() {
      parts.push(title.to_string());
    }
    let query = case_item.query.trim();
    if !query.is_empty() {
      parts.push(query.to_string());
    }
    let actor_block = case_item
      .actors
      .iter()
      .take(4)
      .map(format_actor_short)
      .filter(|x| !x.trim().is_empty())
      .collect::<Vec<_>>()
      .join(" ");
    if !actor_block.is_empty() {
      parts.push(actor_block);
    }
  }
  let note = strategy_trim(strategy_note.unwrap_or("").trim(), 180);
  if !note.is_empty() && note != "없음" {
    parts.push(note);
  }
  strategy_trim(&parts.join(" "), 340)
}

fn build_strategy_retrieval_case(
  case_item: Option<&CaseItem>,
  retrieval_query: &str,
  max_results: usize,
) -> CaseItem {
  let mut built = case_item.cloned().unwrap_or(CaseItem {
    id: "strategy".to_string(),
    title: "직접 분석".to_string(),
    query: String::new(),
    time_from: String::new(),
    time_to: String::new(),
    max_results: Some(max_results as u32),
    actors: Vec::new(),
  });
  built.query = retrieval_query.to_string();
  built.max_results = Some(max_results as u32);
  built
}

fn summarize_strategy_record_parts(record: &RecordItem) -> String {
  let mut extras = Vec::<String>::new();
  if let Some(parts) = record.summary_parts.as_ref() {
    let issues = parts.issues.trim();
    let evidence = parts.evidence_list.trim();
    let actions = parts.teacher_actions.trim();
    if !issues.is_empty() {
      extras.push(format!("핵심포인트: {}", strategy_trim(issues, 90)));
    }
    if !evidence.is_empty() {
      extras.push(format!("자료: {}", strategy_trim(evidence, 72)));
    }
    if !actions.is_empty() {
      extras.push(format!("내대응: {}", strategy_trim(actions, 72)));
    }
  }
  extras.join(" | ")
}

fn build_strategy_record_line_for_prompt(evidence: &StrategyEvidenceRecord) -> String {
  let mut line = format!(
    "[{}] {} | {} | {} | {} | {}",
    evidence.ref_id,
    strategy_trim(evidence.ts.trim(), 32),
    strategy_trim(evidence.actor.trim(), 28),
    strategy_trim(evidence.store.trim(), 18),
    strategy_trim(evidence.place.trim(), 18),
    strategy_trim(evidence.summary.trim(), 180)
  );
  if !evidence.risk_label.trim().is_empty() {
    line.push_str(&format!(" | 위험: {}", strategy_trim(evidence.risk_label.trim(), 18)));
  }
  if !evidence.reasons.is_empty() {
    line.push_str(&format!(" | 선택 이유: {}", strategy_trim(&evidence.reasons.join(", "), 96)));
  }
  line
}

fn build_strategy_actor_summary(records: &[&RecordItem]) -> Vec<String> {
  let mut counts = HashMap::<String, usize>::new();
  for record in records {
    let main = strategy_main_actor_label(record);
    if !main.trim().is_empty() {
      *counts.entry(main).or_insert(0) += 1;
    }
    for related in &record.related {
      let label = format!("관련 {}", format_actor_short(related));
      if !label.trim().is_empty() {
        *counts.entry(label).or_insert(0) += 1;
      }
    }
  }
  let mut ranked = counts.into_iter().collect::<Vec<_>>();
  ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
  ranked
    .into_iter()
    .take(6)
    .map(|(label, count)| format!("{} · {}건", label, count))
    .collect()
}

fn build_strategy_gaps(case_item: Option<&CaseItem>, records: &[&RecordItem], total_records: usize) -> Vec<String> {
  let mut gaps = Vec::<String>::new();
  if case_item.is_none() {
    gaps.push("기준 컬렉션 없이 직접 분석 중이라 사건 범위가 넓을 수 있어요.".to_string());
  }
  if records.len() <= 2 {
    gaps.push("현재 연결된 핵심 기록 수가 적어서 흐름 판단이 제한적일 수 있어요.".to_string());
  }
  if total_records > records.len() {
    gaps.push(format!("전체 기록 {}건 중 핵심 근거 {}건만 추려 분석했어요.", total_records, records.len()));
  }
  let missing_actions = records
    .iter()
    .filter(|record| {
      record
        .summary_parts
        .as_ref()
        .map(|parts| parts.teacher_actions.trim().is_empty())
        .unwrap_or(true)
    })
    .count();
  if missing_actions >= records.len().max(1) / 2 && !records.is_empty() {
    gaps.push("내가 실제로 취한 대응 메모가 비어 있는 기록이 많아요.".to_string());
  }
  let missing_evidence = records
    .iter()
    .filter(|record| {
      record
        .summary_parts
        .as_ref()
        .map(|parts| parts.evidence_list.trim().is_empty())
        .unwrap_or(true)
    })
    .count();
  if missing_evidence >= records.len().max(1) / 2 && !records.is_empty() {
    gaps.push("관련 자료·증빙 정리 칸이 비어 있는 기록이 많아요.".to_string());
  }
  gaps.truncate(4);
  gaps
}

fn push_strategy_evidence_candidate(
  out: &mut Vec<(String, Vec<String>, f32)>,
  seen: &mut HashSet<String>,
  id: String,
  reasons: Vec<String>,
  score: f32,
) {
  if !id.trim().is_empty() && seen.insert(id.clone()) {
    out.push((id, reasons, score));
  }
}

fn select_strategy_evidence_records(
  records: &[RecordItem],
  ranked_hits: &[RankedHit],
  risk_by_id: &HashMap<String, RiskPrediction>,
) -> Vec<(String, Vec<String>, f32)> {
  let mut out = Vec::<(String, Vec<String>, f32)>::new();
  let mut seen = HashSet::<String>::new();

  for hit in ranked_hits.iter().take(5) {
    push_strategy_evidence_candidate(&mut out, &mut seen, hit.id.clone(), hit.reasons.iter().take(3).cloned().collect(), hit.score);
  }

  let mut risk_ranked = records
    .iter()
    .map(|record| {
      let risk = risk_by_id
        .get(&record.id)
        .cloned()
        .unwrap_or_else(|| strategy_effective_risk(record));
      (record.id.clone(), risk.label, risk.confidence, risk.reasons)
    })
    .collect::<Vec<_>>();
  risk_ranked.sort_by(|a, b| {
    b.1.cmp(&a.1)
      .then_with(|| b.2.partial_cmp(&a.2).unwrap_or(Ordering::Equal))
      .then_with(|| a.0.cmp(&b.0))
  });
  for (id, label, _confidence, reasons) in risk_ranked.into_iter().take(3) {
    if label >= 1 {
      let mut why = vec![if label == 2 { "고위험 신호".to_string() } else { "경고 신호".to_string() }];
      why.extend(reasons.into_iter().take(2));
      push_strategy_evidence_candidate(&mut out, &mut seen, id, why, 0.0);
    }
  }

  let mut recent = records.iter().collect::<Vec<_>>();
  recent.sort_by(|a, b| b.ts.cmp(&a.ts));
  for record in recent.into_iter().take(3) {
    push_strategy_evidence_candidate(&mut out, &mut seen, record.id.clone(), vec!["최근 흐름".to_string()], 0.0);
  }

  let should_fill_default = out.is_empty();
  if should_fill_default {
    for record in records.iter().rev().take(4) {
      push_strategy_evidence_candidate(&mut out, &mut seen, record.id.clone(), vec!["기본 선택".to_string()], 0.0);
    }
  }

  out
}

fn build_strategy_evidence_packet(
  case_item: Option<&CaseItem>,
  records: &[RecordItem],
  message: &str,
  strategy_note: Option<&str>,
) -> (StrategyEvidencePacket, String) {
  let retrieval_query = build_strategy_retrieval_query(case_item, message, strategy_note);
  let retrieval_case = build_strategy_retrieval_case(case_item, &retrieval_query, records.len().clamp(4, 8));
  let ranked_hits = rank_records_for_case(
    records,
    &retrieval_case,
    Some(RankOpts {
      max_results: Some(records.len().clamp(4, 8) as u32),
      weights: Some(RankWeights {
        actor: Some(2.8),
        related: Some(1.2),
        text: Some(2.4),
      }),
      min_score: Some(0.0),
      min_text_sim: Some(0.15),
    }),
  );
  let risk_by_id = records
    .iter()
    .map(|record| (record.id.clone(), strategy_effective_risk(record)))
    .collect::<HashMap<_, _>>();
  let selected = select_strategy_evidence_records(records, &ranked_hits, &risk_by_id);
  let by_id = records
    .iter()
    .map(|record| (record.id.clone(), record))
    .collect::<HashMap<_, _>>();

  let mut selected_records = selected
    .iter()
    .filter_map(|(id, _, _)| by_id.get(id).copied())
    .collect::<Vec<_>>();
  selected_records.sort_by(|a, b| a.ts.cmp(&b.ts));

  let earliest = selected_records.first().map(|record| record.ts.trim()).unwrap_or("");
  let latest = selected_records.last().map(|record| record.ts.trim()).unwrap_or("");
  let actor_summary = build_strategy_actor_summary(&selected_records);
  let gaps = build_strategy_gaps(case_item, &selected_records, records.len());
  let legal_references = build_strategy_legal_references(case_item, &selected_records, &retrieval_query, message, strategy_note);

  let mut risk_counts = [0usize; 3];
  let mut risk_reasons = Vec::<String>::new();
  for record in &selected_records {
    let risk = risk_by_id
      .get(&record.id)
      .cloned()
      .unwrap_or_else(|| strategy_effective_risk(record));
    risk_counts[risk.label as usize] += 1;
    for reason in risk.reasons.iter().take(2) {
      if !risk_reasons.iter().any(|item| item == reason) {
        risk_reasons.push(reason.clone());
      }
    }
  }

  let case_title = case_item
    .map(|item| item.title.trim().to_string())
    .filter(|title| !title.is_empty())
    .unwrap_or_else(|| "직접 분석".to_string());
  let actor_line = actor_summary
    .iter()
    .take(3)
    .cloned()
    .collect::<Vec<_>>()
    .join(", ");
  let focus_summary = if earliest.is_empty() && latest.is_empty() {
    format!("{} 기준으로 핵심 근거 {}건을 묶었어요.", case_title, selected_records.len())
  } else {
    format!(
      "{} 기준. {} ~ {} 흐름에서 핵심 근거 {}건을 골랐고, 주요 인물은 {}예요.",
      case_title,
      if earliest.is_empty() { "시점 미상" } else { earliest },
      if latest.is_empty() { "시점 미상" } else { latest },
      selected_records.len(),
      if actor_line.is_empty() { "정리 중" } else { actor_line.as_str() }
    )
  };

  let overview = if selected_records.is_empty() {
    "핵심 근거를 아직 고르지 못했어요.".to_string()
  } else {
    let lead = selected_records
      .iter()
      .take(3)
      .map(|record| {
        format!(
          "{} / {} / {}",
          strategy_main_actor_label(record),
          strategy_store_label(record),
          strategy_trim(record.summary.trim(), 58)
        )
      })
      .collect::<Vec<_>>()
      .join(" -> ");
    format!(
      "질문과 사건 맥락을 기준으로 기록을 다시 뽑아보니, 흐름의 중심은 {} 입니다.",
      strategy_trim(&lead, 220)
    )
  };

  let timeline_summary = selected
    .iter()
    .filter_map(|(id, reasons, score)| {
      let record = by_id.get(id)?;
      let risk = risk_by_id.get(id).cloned().unwrap_or_else(|| strategy_effective_risk(record));
      let extra = summarize_strategy_record_parts(record);
      let mut line = format!(
        "{} · {} · {} · {}",
        record.ts.trim(),
        strategy_main_actor_label(record),
        strategy_trim(record.summary.trim(), 72),
        if extra.is_empty() { format!("위험 {}", risk.label_text) } else { extra }
      );
      if !reasons.is_empty() {
        line.push_str(&format!(" · 선택 이유 {}", strategy_trim(&reasons.join(", "), 80)));
      }
      if *score > 0.0 {
        line.push_str(&format!(" · score {:.2}", score));
      }
      Some(strategy_trim(&line, 280))
    })
    .take(6)
    .collect::<Vec<_>>();

  let mut risk_summary = Vec::<String>::new();
  if risk_counts[2] > 0 {
    risk_summary.push(format!("고위험 신호 {}건", risk_counts[2]));
  }
  if risk_counts[1] > 0 {
    risk_summary.push(format!("경고 신호 {}건", risk_counts[1]));
  }
  if risk_summary.is_empty() {
    risk_summary.push("대부분 일반 공유 수준 기록".to_string());
  }
  for reason in risk_reasons.into_iter().take(4) {
    risk_summary.push(reason);
  }

  let evidence_records = selected_records
    .iter()
    .enumerate()
    .map(|(idx, record)| {
      let ref_id = format!("E{}", idx + 1);
      let lookup = selected
        .iter()
        .find(|(id, _, _)| id == &record.id)
        .cloned()
        .unwrap_or_else(|| (record.id.clone(), vec!["핵심 근거".to_string()], 0.0));
      let risk = risk_by_id
        .get(&record.id)
        .cloned()
        .unwrap_or_else(|| strategy_effective_risk(record));
      let extra = summarize_strategy_record_parts(record);
      let summary = if extra.is_empty() {
        strategy_trim(record.summary.trim(), 220)
      } else {
        strategy_trim(&format!("{} | {}", record.summary.trim(), extra), 220)
      };
      StrategyEvidenceRecord {
        ref_id,
        record_id: record.id.clone(),
        ts: record.ts.trim().to_string(),
        actor: strategy_main_actor_label(record),
        place: strategy_place_label(record),
        store: strategy_store_label(record),
        summary,
        score: lookup.2,
        risk_label: risk.label_text,
        reasons: lookup.1,
      }
    })
    .collect::<Vec<_>>();

  (
    StrategyEvidencePacket {
      mode: if case_item.is_some() { "case-linked".to_string() } else { "direct".to_string() },
      case_title,
      focus_summary,
      overview,
      actor_summary,
      timeline_summary,
      risk_summary,
      gaps,
      evidence_records,
      legal_references,
    },
    retrieval_query,
  )
}

fn summarize_conversation(history: &[StrategyChatTurn]) -> String {
  if history.is_empty() {
    return "- 이전 대화 없음".to_string();
  }
  history
    .iter()
    .rev()
    .take(4)
    .collect::<Vec<_>>()
    .into_iter()
    .rev()
    .map(|turn| {
      let role = if turn.role.trim() == "user" { "사용자" } else { "어시스턴트" };
      format!("- {}: {}", role, strategy_trim(&strategy_sanitize_text(turn.content.trim()), 160))
    })
    .collect::<Vec<_>>()
    .join("\n")
}

fn build_strategy_system_prompt() -> String {
  [
    "- AI 언어모델의 이름은 \"CLOVA X\" 이며 네이버에서 만들었다.",
    "- 반드시 한국어로만 답하라.",
    "- 영어, 중국어, 일본어, 한자 사용 금지.",
    "- 역할: 학교 현장 분쟁·민원 대응을 돕는 증거 기반 전략자문 에이전트.",
    "- 반드시 제공된 사건 맥락과 증거 참조표만 근거로 답하라.",
    "- 관련 법령 참조표가 함께 주어지면 사건 증거와 연결되는 범위 안에서만 조심스럽게 활용하라.",
    "- 입력으로 주어진 사건 맥락, 증거 참조표, 법령 참조표 문구를 그대로 길게 다시 베끼지 말라.",
    "- 사건에 없는 사실을 추가하지 말고, 확실하지 않으면 모른다고 적어라.",
    "- 첫 문장에서 사용자의 질문에 직접 답하라.",
    "- 근거는 별도 '근거 묶음' 섹션으로 떼어내지 말고, 답변 문장 안에 자연스럽게 녹여라.",
    "- 핵심 판단이나 제안마다 가능하면 [E1], [E2] 형식의 근거 표기를 문장 안에 붙여라.",
    "- 법령을 언급할 때는 가능하면 [L1], [L2]처럼 표시하고, 조문 취지와 현장 적용 포인트만 짧게 연결하라.",
    "- 답변은 교사가 바로 복사해 쓸 수 있게 실무적으로 작성하라.",
    "- 과도한 법률 단정이나 최종 법률판단은 피하고, 기록·증거·말의 톤·다음 행동 중심으로 답하라.",
    "- 응답은 대화형으로 자연스럽게 이어가되, 필요하면 짧은 bullet만 사용하라.",
    "- 응답은 가능하면 1) 상황판단 2) 지금 먼저 할 말 3) 바로 남길 기록 4) 다음 행동 순서를 자연스럽게 따른다.",
  ].join("\n")
}

fn build_strategy_hybrid_system_prompt() -> String {
  [
    "- AI 언어모델의 이름은 \"CLOVA X\" 이며 네이버에서 만들었다.",
    "- 반드시 한국어로만 답하라.",
    "- 역할: 두 개의 전략자문 초안을 하나의 최종 답변으로 합치는 편집 에이전트.",
    "- 최종 문장과 답변 흐름은 Roosy-X 초안을 기본으로 삼고, HyperCLOVA-X 초안은 사실 과장 방지와 근거 정렬용으로 활용하라.",
    "- HyperCLOVA-X 초안의 근거성·균형감은 안전장치로 쓰고, Roosy-X 초안의 직관성·실무 문장은 전면에 세워라.",
    "- 입력 초안을 비교평가하지 말고, 사용자에게 바로 보여줄 최종 답변만 작성하라.",
    "- 사건·증거·법령은 입력에 포함된 범위만 사용하라.",
    "- 사실 단정은 조심하고, 확실하지 않은 부분은 확인 필요로 표현하라.",
    "- 첫 문장에서 사용자의 질문에 직접 답하라.",
    "- 근거는 문장 안에 자연스럽게 [E1], [L1]처럼 녹여라.",
    "- 답변은 가능하면 1) 상황판단 2) 지금 먼저 할 말 3) 바로 남길 기록 4) 다음 행동 순서를 자연스럽게 따른다.",
    "- 초안 문장을 그대로 길게 이어붙이지 말고, 하나의 매끈한 최종 한국어 답변으로 정리하라.",
    "- 증거 목록을 길게 다시 나열하지 말고, 결론을 뒷받침하는 핵심 근거만 짧게 묶어 설명하라.",
  ].join("\n")
}

fn build_strategy_user_prompt(
  evidence_packet: &StrategyEvidencePacket,
  case_item: Option<&CaseItem>,
  message: &str,
  strategy_note: Option<&str>,
  conversation: &[StrategyChatTurn],
) -> String {
  let case_block = summarize_case_context(case_item);
  let records_block = if evidence_packet.evidence_records.is_empty() {
    "- 연결된 증거 없음".to_string()
  } else {
    evidence_packet
      .evidence_records
      .iter()
      .map(build_strategy_record_line_for_prompt)
      .collect::<Vec<_>>()
      .join("\n")
  };
  let note_block = strategy_trim(&strategy_sanitize_text(strategy_note.unwrap_or("없음")), 320);
  let history_block = summarize_conversation(conversation);
  let question_block = strategy_trim(&strategy_sanitize_text(message.trim()), 360);
  let question_focus_block = strategy_question_focus_hint(message)
    .unwrap_or_else(|| "- 이번 질문의 핵심 의도를 첫 문장에서 직접 답하라.".to_string());
  let actor_block = if evidence_packet.actor_summary.is_empty() {
    "- 정리된 인물 없음".to_string()
  } else {
    evidence_packet
      .actor_summary
      .iter()
      .map(|line| format!("- {}", line))
      .collect::<Vec<_>>()
      .join("\n")
  };
  let risk_block = if evidence_packet.risk_summary.is_empty() {
    "- 두드러진 위험 신호 없음".to_string()
  } else {
    evidence_packet
      .risk_summary
      .iter()
      .map(|line| format!("- {}", line))
      .collect::<Vec<_>>()
      .join("\n")
  };
  let gap_block = if evidence_packet.gaps.is_empty() {
    "- 특별히 비어 있는 정보 없음".to_string()
  } else {
    evidence_packet
      .gaps
      .iter()
      .map(|line| format!("- {}", line))
      .collect::<Vec<_>>()
      .join("\n")
  };
  let timeline_block = if evidence_packet.timeline_summary.is_empty() {
    "- 시간 흐름 요약 없음".to_string()
  } else {
    evidence_packet
      .timeline_summary
      .iter()
      .map(|line| format!("- {}", line))
      .collect::<Vec<_>>()
      .join("\n")
  };
  let legal_block = if evidence_packet.legal_references.is_empty() {
    "- 바로 연결된 법령 없음".to_string()
  } else {
    evidence_packet
      .legal_references
      .iter()
      .map(build_strategy_legal_line_for_prompt)
      .map(|line| format!("- {}", line))
      .collect::<Vec<_>>()
      .join("\n")
  };

  strategy_sanitize_text(&format!(
    "[현재 사건 맥락]\n{}\n\n[증거 패킷 요약]\n- {}\n- {}\n\n[핵심 인물]\n{}\n\n[시간 흐름]\n{}\n\n[위험 신호]\n{}\n\n[비어 있는 정보]\n{}\n\n[증거 참조표]\n{}\n\n[관련 법령 참조표]\n{}\n\n[전략 메모]\n{}\n\n[직전 대화]\n{}\n\n[이번 요청]\n{}\n\n[질문 초점]\n{}\n\n[응답 조건]\n- 한국어만 사용\n- 학교 현장에서 바로 쓰는 표현\n- 첫 문장에서 질문에 직접 답할 것\n- 너무 긴 설명보다 핵심 위주\n- 필요한 경우 bullet 사용 가능\n- 사건에 없는 사실은 추정하지 말 것\n- '현재 근거 묶음 보기' 같은 별도 섹션 제목은 만들지 말 것\n- 근거는 답변 문장 안에 [E1]처럼 자연스럽게 섞어 쓸 것\n- 법령을 쓸 때는 [L1]처럼 자연스럽게 섞되, 최종 법률판단처럼 단정하지 말 것\n- 비어 있는 정보나 확인 필요 사항도 별도 큰 섹션보다 문장 말미에 자연스럽게 덧붙일 것\n- 근거가 약한 내용은 '확실하지 않음'이라고 쓸 것",
    case_block,
    evidence_packet.focus_summary,
    evidence_packet.overview,
    actor_block,
    timeline_block,
    risk_block,
    gap_block,
    records_block,
    legal_block,
    note_block,
    history_block,
    question_block,
    question_focus_block
  ))
}

fn build_strategy_user_prompt_for_draft(
  evidence_packet: &StrategyEvidencePacket,
  case_item: Option<&CaseItem>,
  message: &str,
  strategy_note: Option<&str>,
) -> String {
  let case_block = summarize_case_context(case_item);
  let note_block = strategy_trim(&strategy_sanitize_text(strategy_note.unwrap_or("없음")), 180);
  let question_block = strategy_trim(&strategy_sanitize_text(message.trim()), 220);
  let question_focus_block = strategy_question_focus_hint(message)
    .unwrap_or_else(|| "- 첫 문장에서 질문에 직접 답하고, 바로 실무 판단으로 이어가라.".to_string());
  let evidence_block = if evidence_packet.evidence_records.is_empty() {
    "- 연결된 핵심 근거 없음".to_string()
  } else {
    evidence_packet
      .evidence_records
      .iter()
      .take(3)
      .map(build_strategy_record_line_for_prompt)
      .map(|line| format!("- {}", line))
      .collect::<Vec<_>>()
      .join("\n")
  };
  let legal_block = if !strategy_question_needs_legal_refs(message) || evidence_packet.legal_references.is_empty() {
    "- 이번 질문에서 법령 직접 인용은 우선순위가 낮음".to_string()
  } else {
    evidence_packet
      .legal_references
      .iter()
      .take(2)
      .map(build_strategy_legal_line_for_prompt)
      .map(|line| format!("- {}", line))
      .collect::<Vec<_>>()
      .join("\n")
  };

  strategy_sanitize_text(&format!(
    "[현재 사건 맥락]\n{}\n\n[핵심 근거]\n{}\n\n[관련 법령]\n{}\n\n[전략 메모]\n{}\n\n[질문]\n{}\n\n[질문 초점]\n{}\n\n[응답 조건]\n- 첫 문장에서 질문에 직접 답할 것\n- 증거 목록을 길게 다시 늘어놓지 말 것\n- 학교 현장에서 바로 쓸 수 있는 한국어 문장으로 답할 것\n- 너무 긴 설명보다 결론과 행동 제안을 먼저 줄 것",
    case_block,
    evidence_block,
    legal_block,
    note_block,
    question_block,
    question_focus_block
  ))
}

fn build_strategy_hybrid_user_prompt(
  evidence_packet: &StrategyEvidencePacket,
  case_item: Option<&CaseItem>,
  message: &str,
  strategy_note: Option<&str>,
  hyper_answer: &str,
  roosy_answer: &str,
) -> String {
  let case_block = summarize_case_context(case_item);
  let note_block = strategy_trim(&strategy_sanitize_text(strategy_note.unwrap_or("없음")), 220);
  let question_block = strategy_trim(&strategy_sanitize_text(message.trim()), 240);
  let question_focus_block = strategy_question_focus_hint(message)
    .unwrap_or_else(|| "- 이번 질문에 먼저 직접 답하고, 그다음 이유와 행동 제안을 붙여라.".to_string());
  let evidence_block = if evidence_packet.evidence_records.is_empty() {
    "- 연결된 핵심 근거 없음".to_string()
  } else {
    evidence_packet
      .evidence_records
      .iter()
      .take(4)
      .map(build_strategy_record_line_for_prompt)
      .map(|line| format!("- {}", line))
      .collect::<Vec<_>>()
      .join("\n")
  };
  let legal_block = if evidence_packet.legal_references.is_empty() {
    "- 관련 법령 없음".to_string()
  } else {
    evidence_packet
      .legal_references
      .iter()
      .take(3)
      .map(build_strategy_legal_line_for_prompt)
      .map(|line| format!("- {}", line))
      .collect::<Vec<_>>()
      .join("\n")
  };

  strategy_sanitize_text(&format!(
    "[현재 사건 맥락]\n{}\n\n[질문]\n{}\n\n[질문 초점]\n{}\n\n[전략 메모]\n{}\n\n[핵심 근거]\n{}\n\n[관련 법령]\n{}\n\n[HyperCLOVA-X 초안]\n{}\n\n[Roosy-X 초안]\n{}\n\n[합성 지침]\n- 최종 답변의 문장 흐름과 말투는 Roosy-X 초안을 기본으로 삼는다.\n- HyperCLOVA-X 초안은 과한 단정, 근거 누락, 법령 연결 오류를 바로잡는 안전 검토용으로 쓴다.\n- 첫 문장에서 사용자의 질문에 바로 답한다.\n- 둘을 비교하거나 '첫 번째 초안/두 번째 초안'이라고 설명하지 않는다.\n- 사용자에게 바로 전달할 하나의 최종 답변만 쓴다.\n- 대답 속에 [합성 지침], [추가 정보], [관련 법령] 같은 입력 헤더를 절대 다시 출력하지 않는다.\n- 증거 목록을 길게 다시 늘어놓지 말고, 결론을 뒷받침하는 핵심 근거만 짧게 묶어 설명한다.\n- 너무 짧게 줄이지 말고, 두 초안의 좋은 내용을 자연스럽게 충분히 녹여 길이감 있게 정리한다.\n- 답변은 상황판단, 지금 먼저 할 말, 바로 남길 기록, 다음 행동이 모두 드러나도록 3~6문단 정도의 완성형 답변으로 쓴다.\n- 답변은 자연스러운 문단형으로 쓰되, 꼭 필요할 때만 짧은 bullet을 사용한다.",
    case_block,
    question_block,
    question_focus_block,
    note_block,
    evidence_block,
    legal_block,
    strategy_trim(hyper_answer.trim(), 2200),
    strategy_trim(roosy_answer.trim(), 2200)
  ))
}

fn cleanup_strategy_output(raw: &str) -> String {
  let mut cleaned = String::with_capacity(raw.len());
  let mut chars = raw.chars().peekable();
  while let Some(ch) = chars.next() {
    if ch == '\u{1b}' {
      if matches!(chars.peek(), Some('[')) {
        chars.next();
        while let Some(next) = chars.next() {
          if ('@'..='~').contains(&next) {
            break;
          }
        }
        continue;
      }
      continue;
    }
    cleaned.push(ch);
  }

  let mut out = cleaned.replace('\r', "");
  if let Some(idx) = out.rfind("<|im_start|>assistant") {
    out = out[(idx + "<|im_start|>assistant".len())..].to_string();
  }
  out = out.replace("<|im_end|>", "");
  out = out.replace("<|endofturn|>", "");
  out = out.replace("<|stop|>", "");
  let mut filtered = Vec::<String>::new();
  let mut skipping_user_echo = false;
  for line in out.lines() {
    let trimmed = line.trim();
    let is_block_art = !trimmed.is_empty() && trimmed.chars().all(|ch| matches!(ch, '▄' | '█' | '▀' | ' '));
    if trimmed.contains('\u{fffd}') {
      continue;
    }
    if skipping_user_echo {
      if trimmed.is_empty() {
        skipping_user_echo = false;
      }
      continue;
    }
    if trimmed.starts_with('>') {
      skipping_user_echo = true;
      continue;
    }
    if trimmed.is_empty() {
      if filtered.last().is_some_and(|last| !last.is_empty()) {
        filtered.push(String::new());
      }
      continue;
    }
    if is_block_art
      || trimmed == ">>>"
      || trimmed == "..."
      || is_strategy_runtime_noise(trimmed)
      || trimmed.contains("(truncated)")
      || trimmed.starts_with("common params")
      || trimmed.starts_with("example-specific params")
      || trimmed.starts_with("Loading model...")
      || trimmed.starts_with("build")
      || trimmed.starts_with("model")
      || trimmed.starts_with("modalities")
      || trimmed.starts_with("available commands:")
      || trimmed.starts_with("/exit")
      || trimmed.starts_with("/regen")
      || trimmed.starts_with("/clear")
      || trimmed.starts_with("/read ")
      || trimmed.starts_with("/glob ")
      || trimmed.starts_with("[ Prompt:")
      || trimmed.starts_with("Exiting...")
      || trimmed.starts_with("llama_memory_breakdown_print:")
      || trimmed.starts_with("<|im_start|>")
      || trimmed.starts_with("<|im_end|>")
      || trimmed.starts_with("[현재 사건 맥락]")
      || trimmed.starts_with("[증거 패킷 요약]")
      || trimmed.starts_with("[핵심 인물]")
      || trimmed.starts_with("[시간 흐름]")
      || trimmed.starts_with("[위험 신호]")
      || trimmed.starts_with("[비어 있는 정보]")
      || trimmed.starts_with("[증거 참조표]")
      || trimmed.starts_with("[전략 메모]")
      || trimmed.starts_with("[직전 대화]")
      || trimmed.starts_with("[이번 요청]")
      || trimmed.starts_with("[응답 조건]")
      || trimmed.starts_with("[질문]")
      || trimmed.starts_with("[핵심 근거]")
      || trimmed.starts_with("[관련 법령]")
      || trimmed.starts_with("[HyperCLOVA-X 초안]")
      || trimmed.starts_with("[Roosy-X 초안]")
      || trimmed.starts_with("[합성 지침]")
      || trimmed.starts_with("[추가 정보]")
      || trimmed.starts_with("현재 목표:")
      || trimmed.starts_with("전략 프리셋:")
      || trimmed.starts_with("AI에게 반영할 메모:")
      || trimmed.starts_with("기준 사건:")
      || trimmed.starts_with("로컬 브리핑 지표:")
      || trimmed.starts_with("추천 톤:")
      || trimmed.starts_with("추천 행동:")
      || trimmed.starts_with("- AI 언어모델의 이름은")
      || trimmed.starts_with("- 반드시 한국어로만")
      || trimmed.starts_with("- 영어, 중국어, 일본어")
      || trimmed.starts_with("- 역할:")
      || trimmed.starts_with("- 반드시 제공된 사건 맥락과 증거 참조표만")
      || trimmed.starts_with("- 사건에 없는 사실을 추가하지 말고")
      || trimmed.starts_with("- 핵심 판단이나 제안마다 가능하면")
      || trimmed.starts_with("- 답변은 교사가 바로")
      || trimmed.starts_with("- 과도한 법률 단정은")
      || trimmed.starts_with("- 응답은 가능하면 1) 상황판단")
      || trimmed.starts_with("- HyperCLOVA-X 초안의")
      || trimmed.starts_with("- Roosy-X 초안의")
      || trimmed.starts_with("- 둘을 비교하거나")
      || trimmed.starts_with("- 사용자에게 바로 전달할")
      || trimmed.starts_with("- 대답 속에 [합성 지침]")
      || trimmed.starts_with("- 너무 짧게 줄이지 말고")
    {
      continue;
    }
    let normalized = trimmed.replace('\u{fffd}', "").trim().to_string();
    if normalized.is_empty() {
      continue;
    }
    filtered.push(normalized);
  }
  let out = filtered.join("\n");
  let out = strategy_strip_prompt_echo(out.trim());
  let out = out.trim();
  strategy_trim(out, 4200)
}

fn strategy_answer_has_evidence_ref(answer: &str) -> bool {
  answer.contains("[E1]") || answer.contains("[E2]") || answer.contains("[E3]") || answer.contains("[E")
}

fn finalize_strategy_answer(answer: &str, evidence_packet: &StrategyEvidencePacket, user_message: &str) -> String {
  let mut out = answer.trim().to_string();
  if out.is_empty() {
    return out;
  }

  if !strategy_answer_has_evidence_ref(&out) && !evidence_packet.evidence_records.is_empty() {
    let lines = evidence_packet
      .evidence_records
      .iter()
      .take(2)
      .map(|item| {
        format!(
          "[{}] {} / {} / {}",
          item.ref_id,
          strategy_trim(item.ts.trim(), 22),
          strategy_trim(item.actor.trim(), 22),
          strategy_trim(item.summary.trim(), 54)
        )
      })
      .collect::<Vec<_>>()
      .join(", ");
    out.push_str("\n\n참고로 지금 판단의 중심 근거는 ");
    out.push_str(&lines);
    out.push_str(" 정도예요.");
  }

  if !out.contains("[L")
    && !evidence_packet.legal_references.is_empty()
    && strategy_question_needs_legal_refs(user_message)
  {
    let refs = evidence_packet
      .legal_references
      .iter()
      .take(2)
      .map(|item| {
        let law_label = if item.short_name.trim().is_empty() {
          item.law_name.trim().to_string()
        } else {
          item.short_name.trim().to_string()
        };
        let article = if item.article_ref.trim().is_empty() {
          item.article_title.trim().to_string()
        } else {
          format!("{} {}", item.article_ref.trim(), item.article_title.trim()).trim().to_string()
        };
        format!("[{}] {} {}", item.ref_id, strategy_trim(&law_label, 18), strategy_trim(&article, 28))
      })
      .collect::<Vec<_>>()
      .join(", ");
    if !refs.trim().is_empty() {
      out.push_str("\n\n관련 법령으로는 ");
      out.push_str(&refs);
      out.push_str(" 정도가 함께 연결돼요.");
    }
  }

  let normalized = out.replace(' ', "");
  if !evidence_packet.gaps.is_empty()
    && !normalized.contains("확인필요")
    && !normalized.contains("비어있는정보")
    && !normalized.contains("추가필요")
  {
    let lines = evidence_packet
      .gaps
      .iter()
      .take(2)
      .map(|item| item.to_string())
      .collect::<Vec<_>>()
      .join(", ");
    out.push_str("\n\n추가로 ");
    out.push_str(&lines);
    out.push_str(" 부분은 아직 확실하지 않아 확인이 더 필요해요.");
  }

  strategy_trim(out.trim(), 5600)
}

fn execute_strategy_model(
  app: Option<&AppHandle>,
  requested_model_id: &str,
  system_prompt_raw: &str,
  user_prompt_raw: &str,
  evidence_packet: &StrategyEvidencePacket,
  n_ctx: u32,
  max_tokens: u32,
  threads: u32,
  stage_label: &str,
) -> Result<StrategyModelExecution, String> {
  let model_id = normalize_strategy_model_id(Some(requested_model_id));
  if model_id == STRATEGY_MODEL_HYBRID_ID {
    return Err("하이브리드 모델은 직접 실행할 수 없어요.".to_string());
  }
  let runtime = strategy_runtime_config(Some(n_ctx), Some(threads));

  let model_path = resolve_strategy_model_path(app, model_id)?;
  let runner = resolve_strategy_runner_path(app)?;
  let system_prompt = strategy_sanitize_text(system_prompt_raw.trim());
  let user_prompt = strategy_fit_prompt_to_budget(
    &strategy_sanitize_text(user_prompt_raw.trim()),
    runtime.n_ctx,
    max_tokens,
  );
  let stage = stage_label.trim();
  let model_label = strategy_model_label_for_id(model_id);
  let runner_name = runner.file_name().and_then(|x| x.to_str()).unwrap_or("llama-sidecar");
  let model_name = model_path.file_name().and_then(|x| x.to_str()).unwrap_or(strategy_model_filename_for_id(model_id));

  emit_strategy_progress(
    app,
    stage,
    format!("{} 단계에서 {}({})를 준비했어요.", if stage.is_empty() { "실행" } else { stage }, model_label, model_name),
  );
  emit_strategy_progress(
    app,
    stage,
    format!(
      "{} · 실행기 {} · 프롬프트 {}자 · 컨텍스트 {} · 최대 토큰 {} · 스레드 {} · 장치 {}",
      model_label,
      runner_name,
      system_prompt.chars().count() + user_prompt.chars().count(),
      runtime.n_ctx,
      max_tokens,
      runtime.threads,
      if runtime.n_gpu_layers > 0 { "metal" } else { "cpu" }
    ),
  );

  let system_prompt_file = write_strategy_prompt_file("system_prompt", &system_prompt)?;
  let user_prompt_file = match write_strategy_prompt_file("user_prompt", &user_prompt) {
    Ok(path) => path,
    Err(err) => {
      cleanup_strategy_prompt_file(&system_prompt_file);
      return Err(err);
    }
  };

  let mut command = Command::new(&runner);
  command
    .arg("-m")
    .arg(&model_path)
    .arg("-c")
    .arg(runtime.n_ctx.to_string())
    .arg("-n")
    .arg(max_tokens.to_string())
    .arg("-t")
    .arg(runtime.threads.to_string())
    .arg("--threads-batch")
    .arg(runtime.threads.to_string())
    .arg("--temp")
    .arg("0.15")
    .arg("--top-p")
    .arg("0.85")
    .arg("--repeat-penalty")
    .arg("1.12")
    .arg("--parallel")
    .arg("1")
    .arg("--simple-io")
    .arg("--no-display-prompt")
    .arg("--no-show-timings")
    .arg("--single-turn")
    .arg("--no-warmup")
    .arg("--device")
    .arg(runtime.device)
    .arg("--n-gpu-layers")
    .arg(runtime.n_gpu_layers.to_string())
    .arg("--color")
    .arg("off")
    .arg("--log-colors")
    .arg("off")
    .arg("--system-prompt-file")
    .arg(&system_prompt_file)
    .arg("--file")
    .arg(&user_prompt_file)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  configure_strategy_child_process(&mut command);

  let mut child = command.spawn().map_err(|e| {
    cleanup_strategy_prompt_file(&system_prompt_file);
    cleanup_strategy_prompt_file(&user_prompt_file);
    format!(
      "{} 실행에 실패했어요. sidecar 포함 여부와 실행 권한을 확인해주세요. runner={} / 상세: {}",
      model_label,
      runner.display(),
      e
    )
  })?;
  emit_strategy_progress(app, stage, format!("{}로 응답을 생성하고 있어요.", model_label));

  let stdout = child.stdout.take().ok_or_else(|| format!("{} 표준출력을 연결하지 못했어요.", model_label))?;
  let stderr = child.stderr.take().ok_or_else(|| format!("{} 표준에러를 연결하지 못했어요.", model_label))?;

  let stdout_handle = thread::spawn(move || {
    let mut reader = BufReader::new(stdout);
    let mut bytes = Vec::<u8>::new();
    let _ = reader.read_to_end(&mut bytes);
    bytes
  });

  let app_for_stderr = app.cloned();
  let stderr_handle = thread::spawn(move || {
    let mut reader = BufReader::new(stderr);
    let mut collected = String::new();
    loop {
      let mut line = String::new();
      match reader.read_line(&mut line) {
        Ok(0) => break,
        Ok(_) => {
          collected.push_str(&line);
          let trimmed = line.trim();
          if !trimmed.is_empty() && should_emit_strategy_runtime_log(trimmed) {
            emit_strategy_progress(app_for_stderr.as_ref(), "모델로그", strategy_trim(trimmed, 260));
          }
        }
        Err(err) => {
          let msg = format!("표준에러 읽기 실패: {err}");
          collected.push_str(&msg);
          emit_strategy_progress(app_for_stderr.as_ref(), "모델로그", &msg);
          break;
        }
      }
    }
    collected
  });

  let started = Instant::now();
  let mut timed_out = false;
  let mut last_heartbeat = 0_u64;
  let status = loop {
    if let Some(status) = child.try_wait().map_err(|e| format!("{} 상태 확인에 실패했어요: {e}", model_label))? {
      break status;
    }

    let elapsed = started.elapsed().as_secs();
    if elapsed >= STRATEGY_CHAT_TIMEOUT_SECS {
      timed_out = true;
      emit_strategy_progress(app, stage, format!("{}가 {}초 동안 끝나지 않아 실행을 중단할게요.", model_label, STRATEGY_CHAT_TIMEOUT_SECS));
      let _ = child.kill();
      let status = child.wait().map_err(|e| format!("중단된 {} 프로세스를 정리하지 못했어요: {e}", model_label))?;
      break status;
    }
    if elapsed >= last_heartbeat + 5 {
      last_heartbeat = elapsed;
      emit_strategy_progress(app, stage, format!("{} 응답을 기다리는 중이에요. {}초 경과했어요.", model_label, elapsed));
    }
    thread::sleep(Duration::from_millis(200));
  };

  let stdout = String::from_utf8_lossy(&stdout_handle.join().unwrap_or_default()).to_string();
  let stderr = stderr_handle.join().unwrap_or_else(|_| "stderr 수집 스레드가 비정상 종료되었어요.".to_string());
  cleanup_strategy_prompt_file(&system_prompt_file);
  cleanup_strategy_prompt_file(&user_prompt_file);
  let answer = finalize_strategy_answer(&cleanup_strategy_output(&stdout), evidence_packet, user_prompt_raw);

  if timed_out {
    return Err(format!(
      "{} 응답이 {}초 안에 끝나지 않아 중단했어요. 마지막 로그: {}",
      model_label,
      STRATEGY_CHAT_TIMEOUT_SECS,
      strategy_trim(stderr.trim(), 280)
    ));
  }
  if !status.success() && answer.is_empty() {
    if stderr.to_ascii_lowercase().contains("failed to load the model") {
      return Err(format!(
        "{} 모델을 불러오지 못했어요. 경로: {} / {} / runner={} / stderr: {}",
        model_label,
        model_path.display(),
        strategy_model_runtime_hint(&model_path, model_id),
        runner.display(),
        strategy_trim(stderr.trim(), 600)
      ));
    }
    return Err(format!(
      "{} 실행이 완료되지 않았어요. runner={} / stderr: {}",
      model_label,
      runner.display(),
      strategy_trim(stderr.trim(), 600)
    ));
  }
  if answer.is_empty() {
    return Err(format!("{}가 빈 응답을 반환했어요.", model_label));
  }

  emit_strategy_progress(app, stage, format!("{} 단계 응답을 {}자로 정리했어요.", model_label, answer.chars().count()));
  Ok(StrategyModelExecution {
    answer,
    model_path: model_path.display().to_string(),
    runner: runner.display().to_string(),
    prompt_chars: system_prompt.chars().count() + user_prompt.chars().count(),
  })
}

pub fn run_strategy_chat(
  app: Option<&AppHandle>,
  case_item: Option<&CaseItem>,
  records: &[RecordItem],
  message: &str,
  strategy_note: Option<&str>,
  conversation: &[StrategyChatTurn],
  opts: Option<StrategyChatOptions>,
) -> Result<StrategyChatRunResult, String> {
  let safe_message_owned = strategy_sanitize_text(message.trim());
  let safe_message = safe_message_owned.trim();
  if safe_message.is_empty() {
    return Err("질문 내용이 비어 있어요.".to_string());
  }
  if records.is_empty() {
    return Err("전략자문에 연결된 증거가 없어요.".to_string());
  }
  emit_strategy_progress(app, "준비", format!("전략자문 요청을 받았어요. 연결된 증거 {}개를 확인 중이에요.", records.len()));
  let (evidence_packet, retrieval_query) = build_strategy_evidence_packet(case_item, records, safe_message, strategy_note);
  emit_strategy_progress(
    app,
    "근거정리",
    format!(
      "질문 기준으로 핵심 근거 {}건을 골랐어요. 검색 질의는 '{}'예요.",
      evidence_packet.evidence_records.len(),
      strategy_trim(retrieval_query.trim(), 120)
    ),
  );
  if !evidence_packet.legal_references.is_empty() {
    emit_strategy_progress(
      app,
      "법령정리",
      format!(
        "사건과 연결되는 법령·조문 {}건도 함께 골랐어요.",
        evidence_packet.legal_references.len()
      ),
    );
  }

  let requested_model_id = normalize_strategy_model_id(opts.as_ref().and_then(|x| x.model.as_deref()));
  let max_tokens = opts
    .as_ref()
    .and_then(|x| x.max_tokens)
    .unwrap_or(if requested_model_id == STRATEGY_MODEL_HYBRID_ID { 720 } else { 320 })
    .clamp(64, 768);
  let runtime = strategy_runtime_config(
    opts.as_ref().and_then(|x| x.n_ctx),
    opts.as_ref().and_then(|x| x.threads),
  );
  let n_ctx = runtime.n_ctx;
  let threads = runtime.threads;
  let system_prompt = build_strategy_system_prompt();
  let user_prompt = build_strategy_user_prompt(&evidence_packet, case_item, safe_message, strategy_note, conversation);
  let draft_user_prompt = build_strategy_user_prompt_for_draft(&evidence_packet, case_item, safe_message, strategy_note);
  let question_route = strategy_question_route(safe_message);

  if requested_model_id == STRATEGY_MODEL_HYBRID_ID {
    if question_route == StrategyQuestionRoute::FastRoosy {
      emit_strategy_progress(app, "라우팅", "이번 질문은 짧은 확인성 대화라 Roosy-X 단일 경로로 빠르게 정리할게요.");
      let fast_result = execute_strategy_model(
        app,
        STRATEGY_MODEL_ROOSY_ID,
        &system_prompt,
        &user_prompt,
        &evidence_packet,
        strategy_hybrid_draft_n_ctx(n_ctx),
        max_tokens.min(640).max(280),
        threads,
        "빠른실행",
      )?;
      emit_strategy_progress(app, "완료", format!("빠른 경로 응답 생성을 마쳤어요. 본문 길이 {}자예요.", fast_result.answer.chars().count()));
      return Ok(StrategyChatRunResult {
        answer: fast_result.answer,
        model_path: "ROOSY-Hybrid (Roosy fast path)".to_string(),
        runner: fast_result.runner,
        prompt_chars: fast_result.prompt_chars,
        records_used: evidence_packet.evidence_records.len(),
        retrieval_query,
        evidence_packet,
      });
    }

    emit_strategy_progress(app, "라우팅", "이번 질문은 비교·민원문구·법령 연결 성격이 있어 하이브리드 전체를 돌릴게요.");
    emit_strategy_progress(app, "준비", "Roosy-X 1차 초안에 사건 맥락을 충분히 먹이고, HyperCLOVA-X가 균형 검토한 뒤 최종 정리를 붙일게요.");
    let draft_n_ctx = strategy_hybrid_draft_n_ctx(n_ctx);

    let roosy_draft = match execute_strategy_model(
      app,
      STRATEGY_MODEL_ROOSY_ID,
      &system_prompt,
      &user_prompt,
      &evidence_packet,
      draft_n_ctx,
      max_tokens.min(640).max(420),
      threads,
      "초안1",
    ) {
      Ok(result) => Some(result),
      Err(err) => {
        emit_strategy_progress(app, "초안1", format!("Roosy-X 초안이 잠시 흔들렸어요. {}", strategy_trim(&err, 220)));
        None
      }
    };
    if let Some(roosy) = roosy_draft.as_ref() {
      emit_strategy_progress(
        app,
        "초안공유",
        format!("1차 초안 포인트: {}", strategy_trim(&roosy.answer.replace('\n', " "), 150)),
      );
    }

    let hyper_draft = match execute_strategy_model(
      app,
      STRATEGY_MODEL_DEFAULT_ID,
      &system_prompt,
      &draft_user_prompt,
      &evidence_packet,
      draft_n_ctx,
      max_tokens.min(520).max(320),
      threads,
      "초안2",
    ) {
      Ok(result) => Some(result),
      Err(err) => {
        emit_strategy_progress(app, "초안2", format!("HyperCLOVA-X 검토 초안이 잠시 흔들렸어요. {}", strategy_trim(&err, 220)));
        None
      }
    };

    match (roosy_draft, hyper_draft) {
      (Some(roosy), Some(hyper)) => {
        emit_strategy_progress(app, "합성", "Roosy-X 초안을 바탕으로 가되, HyperCLOVA-X의 근거·균형 검토를 반영해 최종 답변으로 묶을게요.");
        let hybrid_prompt = build_strategy_hybrid_user_prompt(
          &evidence_packet,
          case_item,
          safe_message,
          strategy_note,
          &hyper.answer,
          &roosy.answer,
        );
        let synthesis = match execute_strategy_model(
          app,
          STRATEGY_MODEL_ROOSY_ID,
          &build_strategy_hybrid_system_prompt(),
          &hybrid_prompt,
          &evidence_packet,
          n_ctx,
          (max_tokens + 120).clamp(620, 768),
          threads,
          "합성",
        ) {
          Ok(result) => result,
          Err(err) => {
            emit_strategy_progress(app, "합성", format!("최종 합성 단계가 흔들려서 Roosy-X 초안을 우선 보여드릴게요. {}", strategy_trim(&err, 220)));
            roosy
          }
        };

        emit_strategy_progress(app, "완료", format!("ROOSY-Hybrid 응답 생성을 마쳤어요. 본문 길이 {}자예요.", synthesis.answer.chars().count()));
        return Ok(StrategyChatRunResult {
          answer: synthesis.answer,
          model_path: "ROOSY-Hybrid (Roosy-X + HyperCLOVA-X)".to_string(),
          runner: synthesis.runner,
          prompt_chars: synthesis.prompt_chars,
          records_used: evidence_packet.evidence_records.len(),
          retrieval_query,
          evidence_packet,
        });
      }
      (Some(roosy), None) => {
        emit_strategy_progress(app, "완료", "HyperCLOVA-X 검토 초안이 비어 있어 Roosy-X 기반으로 먼저 정리했어요.");
        return Ok(StrategyChatRunResult {
          answer: roosy.answer,
          model_path: "ROOSY-Hybrid (Roosy-X fallback)".to_string(),
          runner: roosy.runner,
          prompt_chars: roosy.prompt_chars,
          records_used: evidence_packet.evidence_records.len(),
          retrieval_query,
          evidence_packet,
        });
      }
      (None, Some(hyper)) => {
        emit_strategy_progress(app, "완료", "Roosy-X 초안이 비어 있어 HyperCLOVA-X 기반으로 먼저 정리했어요.");
        return Ok(StrategyChatRunResult {
          answer: hyper.answer,
          model_path: "ROOSY-Hybrid (HyperCLOVA-X fallback)".to_string(),
          runner: hyper.runner,
          prompt_chars: hyper.prompt_chars,
          records_used: evidence_packet.evidence_records.len(),
          retrieval_query,
          evidence_packet,
        });
      }
      (None, None) => {
        #[cfg(target_os = "windows")]
        return Err("ROOSY-Hybrid 초안 두 개를 모두 만들지 못했어요. 먼저 AI 모델 다운로드가 완료됐는지, 그리고 sidecar가 정상인지 함께 확인해주세요.".to_string());
        #[cfg(not(target_os = "windows"))]
        return Err("ROOSY-Hybrid 초안 두 개를 모두 만들지 못했어요. 번들된 모델 파일과 sidecar 상태를 함께 확인해주세요.".to_string());
      }
    }
  }

  let result = execute_strategy_model(
    app,
    requested_model_id,
    &system_prompt,
    &user_prompt,
    &evidence_packet,
    n_ctx,
    max_tokens,
    threads,
    "실행",
  )?;
  emit_strategy_progress(app, "완료", format!("응답 생성을 마쳤어요. 본문 길이 {}자예요.", result.answer.chars().count()));

  Ok(StrategyChatRunResult {
    answer: result.answer,
    model_path: result.model_path,
    runner: result.runner,
    prompt_chars: result.prompt_chars,
    records_used: evidence_packet.evidence_records.len(),
    retrieval_query,
    evidence_packet,
  })
}
