use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH}; // 시간 처리를 위한 표준 라이브러리 추가

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