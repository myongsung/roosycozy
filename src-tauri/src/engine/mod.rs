// src-tauri/src/engine/mod.rs
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::{SystemTime, UNIX_EPOCH};

static UID_SEQ: AtomicU64 = AtomicU64::new(1);

fn uid(prefix: &str) -> String {
  let t = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  let n = UID_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
  format!("{prefix}_{t}_{n}")
}

fn is_word_char(ch: char) -> bool {
  ch.is_ascii_alphanumeric()
    || ('가' <= ch && ch <= '힣')
    || ('ㄱ' <= ch && ch <= 'ㅎ')
    || ('ㅏ' <= ch && ch <= 'ㅣ')
}

fn tokenize(s: &str) -> Vec<String> {
  let mut out: Vec<String> = Vec::new();
  let mut cur = String::new();
  for ch in s.chars() {
    let c = ch.to_ascii_lowercase();
    if is_word_char(c) {
      cur.push(c);
    } else if !cur.is_empty() {
      if cur.len() >= 2 {
        out.push(cur.clone());
      }
      cur.clear();
    }
  }
  if !cur.is_empty() && cur.len() >= 2 {
    out.push(cur);
  }
  out
}

fn within_range(ts: &str, from: &str, to: &str) -> bool {
  // ts/from/to가 ISO-8601이면 문자열 비교로 범위 체크가 안전합니다.
  if !from.is_empty() && ts < from {
    return false;
  }
  if !to.is_empty() && ts > to {
    return false;
  }
  true
}

fn norm(s: &str) -> String {
  s.trim().to_lowercase()
}

// query 토큰이 summary 문자열에 "부분 포함"되면 hit로 인정 (한국어/활용형에 훨씬 강함)
fn text_similarity_ratio(q_tokens: &[String], summary: &str) -> f32 {
  if q_tokens.is_empty() {
    return 0.0;
  }
  let s = norm(summary);
  let mut hit = 0usize;
  for qt in q_tokens {
    if qt.len() >= 2 && s.contains(qt) {
      hit += 1;
    }
  }
  hit as f32 / q_tokens.len() as f32
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

  // extra fields from UI may come in — serde will ignore them if not declared
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankWeights {
  #[serde(default)]
  pub actor: Option<f32>,   // record.actor 가 case.actor 중 하나면 가산
  #[serde(default)]
  pub related: Option<f32>, // record.related 에 case.actor 가 포함되면 가산
  #[serde(default)]
  pub text: Option<f32>,    // 키워드 유사도(0~1)에 곱해지는 가중치
  #[serde(default)]
  pub time: Option<f32>,    // (프로토) 미사용
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankOpts {
  // TS에서 {limit: n} 으로 보내는 경우가 많아서 alias로 수용
  #[serde(default, alias = "limit", alias = "maxResults")]
  pub max_results: Option<u32>,

  #[serde(default)]
  pub weights: Option<RankWeights>,

  #[serde(default, alias = "minScore")]
  pub min_score: Option<f32>,

  // query가 있을 때 "이 정도 유사도면 포함" (0~1)
  #[serde(default, alias = "minTextSim")]
  pub min_text_sim: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedHit {
  pub id: String,
  pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisorItem {
  pub id: String,
  pub ts: String,
  pub title: String,
  pub body: String,
  pub level: String, // "info" | "warn" | "critical"
  #[serde(default)]
  pub tags: Vec<String>,
  pub state: String, // "active" | "done" | "dismissed"
  #[serde(skip_serializing_if = "Option::is_none")]
  pub rule_id: Option<String>,
}

/* -------------------- core: rank -------------------- */

// 요구사항 반영:
// 1) 메인 Actor(= case_item.actors[0]) record는 반드시 포함 (단, max_results를 넘기면 최신순 k개)
// 2) 관련자 포함(record.related) 여부는 가중치 랭킹에 반영
// 3) 키워드 유사도(부분 포함 기반)가 일정 이상이면 포함
pub fn rank_records_for_case(
  records: &[RecordItem],
  case_item: &CaseItem,
  opts: Option<RankOpts>,
) -> Vec<RankedHit> {
  // ----- 옵션/기본값 -----
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

  // case actor 이름 집합(타입은 흔들릴 수 있어서 name 위주)
  let case_actor_names: HashSet<String> = case_item
    .actors
    .iter()
    .map(|a| norm(&a.name))
    .filter(|s| !s.is_empty())
    .collect();

  // 메인 actor = actors[0]
  let main_actor_name = case_item
    .actors
    .get(0)
    .map(|a| norm(&a.name))
    .filter(|s| !s.is_empty());

  // (id, score, ts) 보관
  let mut main_hits: Vec<(String, f32, String)> = Vec::new();
  let mut candidates: Vec<(String, f32, String)> = Vec::new();

  for r in records {
    // time range 필터
    if (!case_item.time_from.is_empty() || !case_item.time_to.is_empty())
      && !within_range(&r.ts, &case_item.time_from, &case_item.time_to)
    {
      continue;
    }

    let r_actor_name = norm(&r.actor.name);
    let actor_match_any = !r_actor_name.is_empty() && case_actor_names.contains(&r_actor_name);

    let is_main_actor = main_actor_name
      .as_ref()
      .map(|m| &r_actor_name == m)
      .unwrap_or(false);

    // 2) related hit
    let mut related_hits = 0usize;
    for ra in &r.related {
      let rn = norm(&ra.name);
      if !rn.is_empty() && case_actor_names.contains(&rn) {
        related_hits += 1;
      }
    }

    // 3) text similarity (0~1)
    let sim = text_similarity_ratio(&q_tokens, &r.summary);

    // 점수 계산(랭킹용)
    let mut score: f32 = 0.0;
    if actor_match_any {
      score += w_actor;
    }
    score += (related_hits as f32) * w_related;
    score += sim * w_text;

    // ----- 포함 규칙 -----
    if is_main_actor {
      // 1순위: 메인 actor는 무조건 포함
      main_hits.push((r.id.clone(), score, r.ts.clone()));
      continue;
    }

    // 메인 actor 아닌 경우:
    // - actor가 case에 포함되어 있거나
    // - related에 case actor가 있거나
    // - query가 있을 때 키워드 유사도가 기준 이상이면
    let passes_logic = actor_match_any
      || related_hits > 0
      || (!q_tokens.is_empty() && sim >= min_text_sim);

    if passes_logic && score >= min_score {
      candidates.push((r.id.clone(), score, r.ts.clone()));
    }
  }

  // ----- 정렬 -----
  // 메인 actor: 최신순 우선 (동점이면 score desc)
  main_hits.sort_by(|a, b| match b.2.cmp(&a.2) {
    Ordering::Equal => match b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal) {
      Ordering::Equal => a.0.cmp(&b.0),
      other => other,
    },
    other => other,
  });

  // 후보: score desc → 최신순 → id
  candidates.sort_by(|a, b| match b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal) {
    Ordering::Equal => match b.2.cmp(&a.2) {
      Ordering::Equal => a.0.cmp(&b.0),
      other => other,
    },
    other => other,
  });

  // ----- 합치기 -----
  // UI 성능을 위해 "반드시 포함"이라도 max_results를 넘기면 최신순 k개까지만
  let mut out: Vec<RankedHit> = Vec::new();

  // 1) 메인 actor 먼저
  for (id, score, _) in main_hits.into_iter().take(k) {
    out.push(RankedHit { id, score });
  }

  // 2) 남은 슬롯에 후보 채우기
  if out.len() < k {
    let remain = k - out.len();
    for (id, score, _) in candidates.into_iter().take(remain) {
      // 중복 방지
      if out.iter().any(|h| h.id == id) {
        continue;
      }
      out.push(RankedHit { id, score });
    }
  }

  out
}

/* -------------------- core: advise -------------------- */

pub fn generate_advisors_for_case(case_item: &CaseItem, _records: &[RecordItem]) -> Vec<AdvisorItem> {
  let ts = chrono_like_now_iso();
  let mut out: Vec<AdvisorItem> = Vec::new();

  // 아주 단순한 3줄 가이드(프로토용)
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
    title: "커뮤니케이션".into(),
    body: "추가 소통은 가능한 한 공식 채널/문서로 남기고, 감정 표현은 줄이세요.".into(),
    level: "warn".into(),
    tags: vec!["소통".into()],
    state: "active".into(),
    rule_id: Some("proto:comm".into()),
  });

  let title_hint = if case_item.title.trim().is_empty() {
    "케이스"
  } else {
    case_item.title.trim()
  };
  out.push(AdvisorItem {
    id: uid("ADV"),
    ts,
    title: format!("다음 액션 ({title_hint})"),
    body: "필요 시 관리자/담당자에게 '요약 3줄 + 타임라인 + 증빙 목록' 형태로 공유할 준비를 하세요.".into(),
    level: "info".into(),
    tags: vec!["액션".into()],
    state: "active".into(),
    rule_id: Some("proto:next".into()),
  });

  out
}

// chrono 없이 ISO 비슷하게: "YYYY-MM-DDTHH:MM:SSZ" (정확한 tz는 프로토에서 충분)
fn chrono_like_now_iso() -> String {
  // 매우 가벼운 now ISO (UTC)
  use std::time::{SystemTime, UNIX_EPOCH};
  let ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  format!("1970-01-01T00:00:{:02}Z", (ms / 1000) % 60)
}
