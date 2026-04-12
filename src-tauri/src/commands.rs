// src-tauri/src/commands.rs
use crate::engine;
use engine::{AdvisorItem, CaseItem, RankOpts, RankedHit, RecordItem, RiskPrediction};

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

// genpdf의 .styled()/.padded()/.framed() 등을 쓰려면 Element 트레이트가 스코프에 있어야 함
use genpdf::Element;

#[tauri::command]
pub fn engine_rank(
  records: Vec<RecordItem>,
  case_item: CaseItem,
  opts: Option<RankOpts>,
) -> Result<Vec<RankedHit>, String> {
  Ok(engine::rank_records_for_case(&records, &case_item, opts))
}

#[tauri::command]
pub fn engine_advise(records: Vec<RecordItem>, case_item: CaseItem) -> Result<Vec<AdvisorItem>, String> {
  Ok(engine::generate_advisors_for_case(&case_item, &records))
}

#[tauri::command]
pub fn engine_classify_risk(records: Vec<RecordItem>) -> Result<Vec<RiskPrediction>, String> {
  Ok(engine::classify_records_risk(&records))
}

fn bytes_to_hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>()
}

fn payload_sha256_hex(payload: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(payload.as_bytes());
  bytes_to_hex(&hasher.finalize())
}

fn signer_fingerprint_hex(public_key: &VerifyingKey) -> String {
  let mut hasher = Sha256::new();
  hasher.update(public_key.as_bytes());
  bytes_to_hex(&hasher.finalize())
}

fn signer_store_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("app data dir unavailable: {e}"))?
    .join("security");
  fs::create_dir_all(&dir).map_err(|e| format!("cannot create security dir: {e}"))?;
  Ok(dir)
}

fn signer_key_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(signer_store_dir(app)?.join("device_ed25519.key"))
}

fn load_or_create_signing_key(app: &AppHandle) -> Result<SigningKey, String> {
  let path = signer_key_path(app)?;
  if path.exists() {
    let raw = fs::read_to_string(&path).map_err(|e| format!("cannot read signing key: {e}"))?;
    let key_bytes = B64
      .decode(raw.trim())
      .map_err(|e| format!("stored signing key decode failed: {e}"))?;
    let arr: [u8; 32] = key_bytes
      .try_into()
      .map_err(|_| "stored signing key length is invalid".to_string())?;
    return Ok(SigningKey::from_bytes(&arr));
  }

  let signing_key = SigningKey::generate(&mut OsRng);
  let encoded = B64.encode(signing_key.to_bytes());
  fs::write(&path, encoded).map_err(|e| format!("cannot write signing key: {e}"))?;
  #[cfg(unix)]
  {
    let perms = fs::Permissions::from_mode(0o600);
    let _ = fs::set_permissions(&path, perms);
  }
  Ok(signing_key)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSignerInfo {
  pub algorithm: String,
  pub signer_fingerprint: String,
  pub signer_public_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignIntegrityPayloadArgs {
  pub payload: String,
  #[serde(default)]
  pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignIntegrityPayloadResult {
  pub algorithm: String,
  pub payload_sha256: String,
  pub signature: String,
  pub signer_fingerprint: String,
  pub signer_public_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyIntegrityPayloadArgs {
  pub payload: String,
  pub signature: String,
  pub signer_public_key: String,
  #[serde(default)]
  pub signer_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyIntegrityPayloadResult {
  pub valid: bool,
  pub code: String,
  pub message: String,
  pub algorithm: String,
  pub payload_sha256: String,
  pub signer_fingerprint: String,
}

#[tauri::command]
pub fn get_device_signer_info(app: AppHandle) -> Result<DeviceSignerInfo, String> {
  let signing_key = load_or_create_signing_key(&app)?;
  let verifying_key = signing_key.verifying_key();
  Ok(DeviceSignerInfo {
    algorithm: "rust-ed25519-v1".to_string(),
    signer_fingerprint: signer_fingerprint_hex(&verifying_key),
    signer_public_key: B64.encode(verifying_key.to_bytes()),
  })
}

#[tauri::command]
pub fn sign_integrity_payload(app: AppHandle, args: SignIntegrityPayloadArgs) -> Result<SignIntegrityPayloadResult, String> {
  let _ = args.label.as_deref();
  let signing_key = load_or_create_signing_key(&app)?;
  let verifying_key = signing_key.verifying_key();
  let signature = signing_key.sign(args.payload.as_bytes());
  Ok(SignIntegrityPayloadResult {
    algorithm: "rust-ed25519-v1".to_string(),
    payload_sha256: payload_sha256_hex(&args.payload),
    signature: B64.encode(signature.to_bytes()),
    signer_fingerprint: signer_fingerprint_hex(&verifying_key),
    signer_public_key: B64.encode(verifying_key.to_bytes()),
  })
}

#[tauri::command]
pub fn verify_integrity_payload(args: VerifyIntegrityPayloadArgs) -> Result<VerifyIntegrityPayloadResult, String> {
  let payload_sha256 = payload_sha256_hex(&args.payload);
  let public_key_bytes = B64
    .decode(args.signer_public_key.trim())
    .map_err(|e| format!("public key decode failed: {e}"))?;
  let public_key_arr: [u8; 32] = public_key_bytes
    .try_into()
    .map_err(|_| "public key length is invalid".to_string())?;
  let verifying_key = VerifyingKey::from_bytes(&public_key_arr)
    .map_err(|e| format!("public key parse failed: {e}"))?;

  let signature_bytes = B64
    .decode(args.signature.trim())
    .map_err(|e| format!("signature decode failed: {e}"))?;
  let signature = Signature::from_slice(&signature_bytes)
    .map_err(|e| format!("signature parse failed: {e}"))?;

  let computed_fingerprint = signer_fingerprint_hex(&verifying_key);
  if let Some(expected) = args.signer_fingerprint.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
    if expected != computed_fingerprint {
      return Ok(VerifyIntegrityPayloadResult {
        valid: false,
        code: "fingerprint-mismatch".to_string(),
        message: "서명 공개키의 지문이 저장된 지문과 일치하지 않아요.".to_string(),
        algorithm: "rust-ed25519-v1".to_string(),
        payload_sha256,
        signer_fingerprint: computed_fingerprint,
      });
    }
  }

  match verifying_key.verify(args.payload.as_bytes(), &signature) {
    Ok(_) => Ok(VerifyIntegrityPayloadResult {
      valid: true,
      code: "ok".to_string(),
      message: "Rust Ed25519 서명이 확인됐어요.".to_string(),
      algorithm: "rust-ed25519-v1".to_string(),
      payload_sha256,
      signer_fingerprint: computed_fingerprint,
    }),
    Err(_) => Ok(VerifyIntegrityPayloadResult {
      valid: false,
      code: "signature-invalid".to_string(),
      message: "서명값이 현재 payload와 맞지 않아요.".to_string(),
      algorithm: "rust-ed25519-v1".to_string(),
      payload_sha256,
      signer_fingerprint: computed_fingerprint,
    }),
  }
}

/* -------------------- PDF export (case paper) -------------------- */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperRecordRow {
  pub when: String,
  pub kind: String, // record | step | advisor
  pub lv: String,
  pub actor: String,
  pub place: String,
  pub summary: String,
  pub id: String,
  pub reason: Option<String>,
  pub original_sealed_at: Option<String>,
  pub last_sealed_at: Option<String>,
  pub revision_count: Option<u32>,
  pub integrity_hash: Option<String>,
  pub revision_trail: Option<Vec<String>>,
  pub verification_status: Option<String>,
  pub verification_message: Option<String>,
  pub signature_algorithm: Option<String>,
  pub signer_fingerprint: Option<String>,
  pub trusted: Option<bool>,
  pub signed_on_this_device: Option<bool>,
  pub integrity_verdict: Option<String>,
  pub integrity_evidence: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperPayload {
  pub title: String,
  pub case_id: String,
  pub generated_at: String,
  pub hash_sha256: String,
  pub sender_name: String,
  pub sender_address: String,
  pub recipient_name: String,
  pub recipient_address: String,
  pub subject: String,
  pub statement_lines: Vec<String>,
  pub action_lines: Vec<String>,
  pub integrity_lines: Vec<String>,
  pub records: Vec<PaperRecordRow>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPdfArgs {
  pub paper: PaperPayload,

  // ✅ 프론트에서 { fileName: path }로 주는 걸 유지
  // (추가 alias는 기능 영향 없고 호환성만 올려줌)
  #[serde(
    default,
    alias = "fileName",
    alias = "filePath",
    alias = "path",
    alias = "savePath",
    alias = "outputPath"
  )]
  pub file_name: Option<String>, // saveDialog로 받은 전체 경로
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllRecordsPayload {
  pub title: String,
  pub generated_at: String,
  pub hash_sha256: String,
  pub overview_lines: Vec<String>,
  pub integrity_lines: Vec<String>,
  pub records: Vec<PaperRecordRow>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAllRecordsPdfArgs {
  pub report: AllRecordsPayload,

  #[serde(
    default,
    alias = "fileName",
    alias = "filePath",
    alias = "path",
    alias = "savePath",
    alias = "outputPath"
  )]
  pub file_name: Option<String>,
}

fn ensure_pdf_ext(mut p: PathBuf) -> PathBuf {
  let has_pdf = p
    .extension()
    .and_then(|e| e.to_str())
    .map(|e| e.eq_ignore_ascii_case("pdf"))
    .unwrap_or(false);
  if !has_pdf {
    p.set_extension("pdf");
  }
  p
}

fn ensure_json_ext(mut p: PathBuf) -> PathBuf {
  let has_json = p
    .extension()
    .and_then(|e| e.to_str())
    .map(|e| e.eq_ignore_ascii_case("json"))
    .unwrap_or(false);
  if !has_json {
    p.set_extension("json");
  }
  p
}

fn ensure_parent_dir(p: &Path) -> Result<(), String> {
  if let Some(parent) = p.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("cannot create output directory: {e}"))?;
  }
  Ok(())
}

// ✅ OS별 "최소 후보" (기존 로직 유지)
fn find_korean_font_source() -> Option<PathBuf> {
  let candidates: &[&str] = if cfg!(target_os = "macos") {
    &[
      "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
      "/Library/Fonts/AppleGothic.ttf",
    ]
  } else if cfg!(target_os = "windows") {
    &[
      "C:\\Windows\\Fonts\\malgun.ttf", // 맑은 고딕
      "C:\\Windows\\Fonts\\Malgun.ttf",
    ]
  } else {
    &[
      "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
      "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
      "/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf",
      "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf",
    ]
  };

  for p in candidates {
    let pb = PathBuf::from(p);
    if pb.exists() {
      return Some(pb);
    }
  }
  None
}

// ✅ genpdf는 Regular/Bold/Italic/BoldItalic 4종을 찾는 케이스가 있어서 temp에 복제
fn prepare_genpdf_font_family(src: &Path) -> Result<(PathBuf, String), String> {
  let family = "KoreanFont".to_string();

  let work_dir = std::env::temp_dir().join("roosycozy_fonts");
  std::fs::create_dir_all(&work_dir).map_err(|e| format!("cannot create temp font dir: {e}"))?;

  fn copy_force(src: &Path, dst: &Path) -> Result<(), String> {
    let src_len = std::fs::metadata(src)
      .map_err(|e| format!("font source metadata read failed: {e}"))?
      .len();

    if dst.exists() {
      let should_refresh = std::fs::metadata(dst)
        .map(|m| m.len() != src_len || m.len() == 0)
        .unwrap_or(true);
      if should_refresh {
        let _ = std::fs::remove_file(dst);
      } else {
        return Ok(());
      }
    }

    std::fs::copy(src, dst).map_err(|e| format!("font copy failed: cannot copy to {dst:?}: {e}"))?;
    Ok(())
  }

  let regular = work_dir.join(format!("{family}-Regular.ttf"));
  let bold = work_dir.join(format!("{family}-Bold.ttf"));
  let italic = work_dir.join(format!("{family}-Italic.ttf"));
  let bold_italic = work_dir.join(format!("{family}-BoldItalic.ttf"));

  copy_force(src, &regular)?;
  copy_force(src, &bold)?;
  copy_force(src, &italic)?;
  copy_force(src, &bold_italic)?;

  for p in [&regular, &bold, &italic, &bold_italic] {
    if !p.exists() {
      return Err(format!("font load failed: expected font file missing: {p:?}"));
    }
  }

  Ok((work_dir, family))
}

/// 긴 토큰(해시/ID) 줄바꿈 유도용: n글자마다 공백 삽입
fn wrap_every(s: &str, n: usize) -> String {
  if n == 0 {
    return s.to_string();
  }
  let mut out = String::new();
  let mut i = 0usize;
  for ch in s.chars() {
    if i > 0 && i % n == 0 {
      out.push(' ');
    }
    out.push(ch);
    i += 1;
  }
  out
}

/// PDF 본문용 텍스트 정리:
/// - 줄바꿈/탭/제어문자를 공백으로 바꿔 네모(□) 깨짐을 막음
/// - 연속 공백을 하나로 줄임
fn normalize_pdf_inline_text(s: &str) -> String {
  let normalized = s.replace("\r\n", "\n").replace('\r', "\n");
  let mut out = String::with_capacity(normalized.len());
  let mut prev_space = false;

  for ch in normalized.chars() {
    let mapped = match ch {
      '\n' | '\t' | '\u{2028}' | '\u{2029}' => ' ',
      c if c.is_control() => ' ',
      c => c,
    };
    if mapped.is_whitespace() {
      if !prev_space {
        out.push(' ');
        prev_space = true;
      }
    } else {
      out.push(mapped);
      prev_space = false;
    }
  }

  let trimmed = out.trim();
  if trimmed.is_empty() { "-".to_string() } else { trimmed.to_string() }
}

fn normalize_pdf_lines(s: &str) -> Vec<String> {
  let normalized = s.replace("\r\n", "\n").replace('\r', "\n");
  let mut out: Vec<String> = Vec::new();
  for raw in normalized.lines() {
    let line = normalize_pdf_inline_text(raw);
    if line != "-" {
      out.push(line);
    }
  }
  if out.is_empty() {
    out.push("-".to_string());
  }
  out
}

fn normalize_pdf_blocks(s: &str) -> Vec<String> {
  let normalized = s.replace("\r\n", "\n").replace('\r', "\n");
  let mut blocks: Vec<String> = Vec::new();
  let mut current: Vec<String> = Vec::new();

  for raw in normalized.lines() {
    let line = normalize_pdf_inline_text(raw);
    if line == "-" {
      if !current.is_empty() {
        blocks.push(current.join(" "));
        current.clear();
      }
      continue;
    }
    current.push(line);
  }

  if !current.is_empty() {
    blocks.push(current.join(" "));
  }
  if blocks.is_empty() {
    blocks.push("-".to_string());
  }
  blocks
}


fn panic_message(err: Box<dyn std::any::Any + Send>) -> String {
  if let Some(msg) = err.downcast_ref::<&str>() {
    return (*msg).to_string();
  }
  if let Some(msg) = err.downcast_ref::<String>() {
    return msg.clone();
  }
  "unexpected panic while generating pdf".to_string()
}

fn temp_pdf_output_path(out_path: &Path) -> PathBuf {
  let file_name = out_path
    .file_name()
    .and_then(|s| s.to_str())
    .filter(|s| !s.is_empty())
    .unwrap_or("document.pdf");
  let parent = out_path.parent().unwrap_or_else(|| Path::new("."));
  parent.join(format!(".{file_name}.part"))
}

fn compact_hash(s: &str, head: usize, tail: usize) -> String {
  let trimmed = s.trim();
  if trimmed.is_empty() {
    return "-".to_string();
  }
  let chars: Vec<char> = trimmed.chars().collect();
  if chars.len() <= head + tail + 1 {
    return trimmed.to_string();
  }
  let start: String = chars.iter().take(head).collect();
  let end: String = chars.iter().rev().take(tail).collect::<Vec<_>>().into_iter().rev().collect();
  format!("{start}…{end}")
}

fn clamp_chars(s: &str, max_chars: usize) -> String {
  let trimmed = s.trim();
  if trimmed.is_empty() {
    return "-".to_string();
  }
  let count = trimmed.chars().count();
  if count <= max_chars {
    return trimmed.to_string();
  }
  let mut out = String::new();
  for (idx, ch) in trimmed.chars().enumerate() {
    if idx >= max_chars {
      break;
    }
    out.push(ch);
  }
  out.push('…');
  out
}

fn compact_record_id(id: &str) -> String {
  let trimmed = id.trim();
  if trimmed.is_empty() {
    return "-".to_string();
  }
  let chars: Vec<char> = trimmed.chars().collect();
  if chars.len() <= 18 {
    return trimmed.to_string();
  }
  let start: String = chars.iter().take(8).collect();
  let end: String = chars.iter().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
  format!("{start}…{end}")
}


#[tauri::command]
pub fn export_case_pdf(args: ExportPdfArgs) -> Result<String, String> {
  use genpdf::{elements, style, Alignment};

  let paper = args.paper;
  let file_name = args
    .file_name
    .as_ref()
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "fileName(전체 경로)가 필요해요. 프론트에서 saveDialog 결과를 넘겨주세요.".to_string())?;

  let out_path = ensure_pdf_ext(PathBuf::from(file_name));
  ensure_parent_dir(&out_path)?;

  let tmp_path = temp_pdf_output_path(&out_path);
  if tmp_path.exists() {
    let _ = std::fs::remove_file(&tmp_path);
  }

  let render_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
    let src_font = find_korean_font_source()
      .ok_or_else(|| "Korean font not found (AppleGothic/Malgun/Nanum/Noto).".to_string())?;
    let (font_dir, family) = prepare_genpdf_font_family(&src_font)?;
    let font_family = genpdf::fonts::from_files(&font_dir, &family, None)
      .map_err(|e| format!("font load failed: {e}"))?;

    let mut doc = genpdf::Document::new(font_family);
    doc.set_title(&paper.title);
    doc.set_font_size(9);
    doc.set_line_spacing(1.14);

    let mut decorator = genpdf::SimplePageDecorator::new();
    decorator.set_margins(16);
    doc.set_page_decorator(decorator);

    let s_title = style::Style::new().bold().with_font_size(17);
    let s_h1 = style::Style::new().bold().with_font_size(12);
    let s_h2 = style::Style::new().bold().with_font_size(10);
    let s_body = style::Style::new().with_font_size(9);
    let s_meta = style::Style::new().with_font_size(8);
    let hr = "────────────────────────────────────────────────────────";

    fn clean<'a>(s: &'a str) -> &'a str {
      let t = s.trim();
      if t.is_empty() { "-" } else { t }
    }

    fn verdict_ko(row: &PaperRecordRow) -> String {
      if !row.kind.trim().eq_ignore_ascii_case("record") {
        return row.integrity_verdict.clone().unwrap_or_else(|| "사건 대응 조치 로그".to_string());
      }
      if let Some(v) = row.integrity_verdict.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return v.to_string();
      }
      match row.verification_status.as_deref().unwrap_or("").trim() {
        "verified" => {
          if row.signed_on_this_device.unwrap_or(false) {
            "기기서명·해시체인 검증완료".to_string()
          } else {
            "기기서명 검증완료".to_string()
          }
        }
        "foreign" => "해시체인 일치 · 타기기 서명".to_string(),
        "legacy" => "SHA-256 리비전 체인 보존".to_string(),
        "pending" => "해시체인 일치 · 서명검증 대기".to_string(),
        "missing" => "해시체인 점검 가능 · 메타 보강 필요".to_string(),
        _ => "추가 포렌식 검토 필요".to_string(),
      }
    }

    fn evidence_ko(row: &PaperRecordRow) -> String {
      if !row.kind.trim().eq_ignore_ascii_case("record") {
        return row.integrity_evidence.clone().unwrap_or_else(|| clean(row.verification_message.as_deref().unwrap_or("사건 대응 경과 로그입니다.")).to_string());
      }
      if let Some(v) = row.integrity_evidence.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return v.to_string();
      }
      let mut parts: Vec<String> = vec![format!("REV {}", row.revision_count.unwrap_or(0))];
      if let Some(sealed) = row.last_sealed_at.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("최종 봉인 {}", sealed));
      }
      if let Some(hash) = row.integrity_hash.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("SHA-256 {}", hash.chars().take(14).collect::<String>()));
      }
      parts.push(if row.signature_algorithm.as_deref().unwrap_or("") == "rust-ed25519-v1" {
        "Ed25519 전자서명".to_string()
      } else {
        "해시 체인 봉인".to_string()
      });
      if let Some(fp) = row.signer_fingerprint.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("지문 {}", fp.chars().take(12).collect::<String>()));
      }
      let tail = clean(row.verification_message.as_deref().unwrap_or(""));
      if tail != "-" {
        parts.push(normalize_pdf_inline_text(tail));
      }
      parts.join(" / ")
    }

    let kind_ko = |k: &str| -> &'static str {
      match k.trim().to_ascii_lowercase().as_str() {
        "record" => "기록",
        "step" => "조치",
        "advisor" => "권고",
        _ => "기타",
      }
    };

    doc.push(elements::Paragraph::new("내 용 증 명 서").aligned(Alignment::Center).styled(s_title.clone()));
    doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()).padded((2.0, 0.0, 1.0, 0.0)));

    doc.push(elements::Paragraph::new("발신인").styled(s_h2.clone()));
    doc.push(elements::Paragraph::new(format!("성명 : {}", normalize_pdf_inline_text(clean(&paper.sender_name)))).styled(s_body.clone()).padded((0.5, 0.0, 0.0, 0.0)));
    for (line_idx, line) in normalize_pdf_lines(clean(&paper.sender_address)).iter().enumerate() {
      let prefix = if line_idx == 0 { "주소 : " } else { "       " };
      doc.push(elements::Paragraph::new(format!("{prefix}{line}")).styled(s_body.clone()).padded((0.3, 0.0, 0.0, 0.0)));
    }
    doc.push(elements::Break::new(1));

    doc.push(elements::Paragraph::new("수신인").styled(s_h2.clone()));
    doc.push(elements::Paragraph::new(format!("성명 : {}", normalize_pdf_inline_text(clean(&paper.recipient_name)))).styled(s_body.clone()).padded((0.5, 0.0, 0.0, 0.0)));
    for (line_idx, line) in normalize_pdf_lines(clean(&paper.recipient_address)).iter().enumerate() {
      let prefix = if line_idx == 0 { "주소 : " } else { "       " };
      doc.push(elements::Paragraph::new(format!("{prefix}{line}")).styled(s_body.clone()).padded((0.3, 0.0, 0.0, 0.0)));
    }
    doc.push(elements::Break::new(1));

    doc.push(elements::Paragraph::new(format!("제목 : {}", normalize_pdf_inline_text(clean(&paper.subject)))).styled(s_h1.clone()));
    doc.push(elements::Paragraph::new(format!("문서 생성일시 : {}", normalize_pdf_inline_text(clean(&paper.generated_at)))).styled(s_meta.clone()).padded((0.5, 0.0, 0.0, 0.0)));
    doc.push(elements::Paragraph::new(format!("사건 식별값 : {}", compact_record_id(&normalize_pdf_inline_text(clean(&paper.case_id))))).styled(s_meta.clone()));
    if !paper.hash_sha256.trim().is_empty() {
      doc.push(elements::Paragraph::new(format!("문서 전체 SHA-256 : {}", compact_hash(&normalize_pdf_inline_text(paper.hash_sha256.trim()), 14, 10))).styled(s_meta.clone()));
    }

    doc.push(elements::Break::new(1));
    doc.push(elements::Paragraph::new("1. 통지 내용").styled(s_h1.clone()));
    for (idx, line) in paper.statement_lines.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).take(5).enumerate() {
      doc.push(elements::Paragraph::new(format!("{}. {}", idx + 1, clamp_chars(&normalize_pdf_inline_text(line), 220))).styled(s_body.clone()).padded((0.5, 0.0, 0.0, 0.0)));
    }

    doc.push(elements::Break::new(1));
    doc.push(elements::Paragraph::new("2. 요구 및 향후 조치").styled(s_h1.clone()));
    for (idx, line) in paper.action_lines.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).take(3).enumerate() {
      doc.push(elements::Paragraph::new(format!("{}. {}", idx + 1, clamp_chars(&normalize_pdf_inline_text(line), 200))).styled(s_body.clone()).padded((0.5, 0.0, 0.0, 0.0)));
    }

    doc.push(elements::Break::new(1));
    doc.push(elements::Paragraph::new("3. 증빙자료 요약").styled(s_h1.clone()));
    doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));

    if paper.records.is_empty() {
      doc.push(elements::Paragraph::new("※ 등록된 증빙 항목이 없습니다.").styled(s_body.clone()).padded((0.5, 0.0, 0.0, 0.0)));
    } else {
      for (idx, r) in paper.records.iter().enumerate() {
        doc.push(elements::Paragraph::new(format!("[{}] {} / {}", idx + 1, normalize_pdf_inline_text(kind_ko(&r.kind)), normalize_pdf_inline_text(clean(&r.when)))).styled(s_h2.clone()).padded((0.6, 0.0, 0.0, 0.0)));
        doc.push(elements::Paragraph::new(format!("요지 : {}", normalize_pdf_inline_text(clean(&r.summary)))).styled(s_body.clone()).padded((0.2, 0.0, 0.0, 0.0)));
        doc.push(elements::Paragraph::new(format!("주체 / 장소 : {} / {}", normalize_pdf_inline_text(clean(&r.actor)), normalize_pdf_inline_text(clean(&r.place)))).styled(s_meta.clone()).padded((0.2, 0.0, 0.0, 0.0)));
        doc.push(elements::Paragraph::new(format!("무결성 결론 : {}", normalize_pdf_inline_text(&verdict_ko(r)))).styled(s_meta.clone()).padded((0.2, 0.0, 0.0, 0.0)));
        let evidence = normalize_pdf_inline_text(&evidence_ko(r));
        if r.kind.trim().eq_ignore_ascii_case("record") {
          let rev = r.revision_count.unwrap_or(0);
          let sealed = compact_hash(&normalize_pdf_inline_text(clean(r.last_sealed_at.as_deref().unwrap_or("-"))), 10, 8);
          let hash = compact_hash(&normalize_pdf_inline_text(clean(r.integrity_hash.as_deref().unwrap_or("-"))), 10, 8);
          doc.push(elements::Paragraph::new(format!("검증 근거 : {}", evidence)).styled(s_meta.clone()).padded((0.2, 0.0, 0.0, 0.0)));
          doc.push(elements::Paragraph::new(format!("REV / 봉인 / 해시 / ID : {} / {} / {} / {}", rev, sealed, hash, compact_record_id(&normalize_pdf_inline_text(clean(&r.id))))).styled(s_meta.clone()).padded((0.2, 0.0, 0.0, 0.0)));
        } else {
          doc.push(elements::Paragraph::new(format!("보조 정보 : {}", evidence)).styled(s_meta.clone()).padded((0.2, 0.0, 0.0, 0.0)));
        }
        doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()).padded((0.5, 0.0, 0.0, 0.0)));
      }
    }

    doc.push(elements::Break::new(1));
    doc.push(elements::Paragraph::new("4. 무결성 검증 요약").styled(s_h1.clone()));
    doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));
    for (idx, line) in paper.integrity_lines.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).take(3).enumerate() {
      doc.push(elements::Paragraph::new(format!("{}. {}", idx + 1, clamp_chars(&normalize_pdf_inline_text(line), 220))).styled(s_body.clone()).padded((0.5, 0.0, 0.0, 0.0)));
    }

    doc.push(elements::Break::new(1));
    doc.push(elements::Paragraph::new(normalize_pdf_inline_text(clean(&paper.generated_at))).aligned(Alignment::Center).styled(s_body.clone()));
    doc.push(elements::Paragraph::new(format!("발신인 성명 : {}", normalize_pdf_inline_text(clean(&paper.sender_name)))).aligned(Alignment::Center).styled(s_body.clone()).padded((1.5, 0.0, 0.0, 0.0)));
    for (line_idx, line) in normalize_pdf_lines(clean(&paper.sender_address)).iter().enumerate() {
      let prefix = if line_idx == 0 { "발신인 주소 : " } else { "             " };
      doc.push(elements::Paragraph::new(format!("{prefix}{line}")).aligned(Alignment::Center).styled(s_meta.clone()));
    }

    doc.render_to_file(&tmp_path)
      .map_err(|e| format!("pdf render failed: {e}"))?;
    Ok(())
  })).map_err(panic_message)?;

  render_result?;

  let tmp_meta = std::fs::metadata(&tmp_path)
    .map_err(|e| format!("pdf file check failed: {e}"))?;
  if tmp_meta.len() < 512 {
    let _ = std::fs::remove_file(&tmp_path);
    return Err("PDF 파일이 정상적으로 생성되지 않았어요. 내용을 단순화해 다시 저장하거나 앱을 다시 실행한 뒤 시도해주세요.".to_string());
  }

  if out_path.exists() {
    let _ = std::fs::remove_file(&out_path);
  }

  std::fs::rename(&tmp_path, &out_path).or_else(|_| {
    std::fs::copy(&tmp_path, &out_path)
      .map_err(|e| format!("pdf finalize copy failed: {e}"))?;
    let _ = std::fs::remove_file(&tmp_path);
    Ok::<(), String>(())
  })?;

  Ok(out_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn export_all_records_pdf(args: ExportAllRecordsPdfArgs) -> Result<String, String> {
  use genpdf::{elements, style, Alignment};

  let report = args.report;
  let file_name = args
    .file_name
    .as_ref()
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "fileName(전체 경로)가 필요해요. 프론트에서 saveDialog 결과를 넘겨주세요.".to_string())?;

  let out_path = ensure_pdf_ext(PathBuf::from(file_name));
  ensure_parent_dir(&out_path)?;

  let tmp_path = temp_pdf_output_path(&out_path);
  if tmp_path.exists() {
    let _ = std::fs::remove_file(&tmp_path);
  }

  let render_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
    let src_font = find_korean_font_source()
      .ok_or_else(|| "Korean font not found (AppleGothic/Malgun/Nanum/Noto).".to_string())?;
    let (font_dir, family) = prepare_genpdf_font_family(&src_font)?;
    let font_family = genpdf::fonts::from_files(&font_dir, &family, None)
      .map_err(|e| format!("font load failed: {e}"))?;

    let mut doc = genpdf::Document::new(font_family);
    doc.set_title(&report.title);
    doc.set_font_size(9);
    doc.set_line_spacing(1.14);

    let mut decorator = genpdf::SimplePageDecorator::new();
    decorator.set_margins(16);
    doc.set_page_decorator(decorator);

    let s_title = style::Style::new().bold().with_font_size(17);
    let s_h1 = style::Style::new().bold().with_font_size(12);
    let s_h2 = style::Style::new().bold().with_font_size(10);
    let s_body = style::Style::new().with_font_size(9);
    let s_meta = style::Style::new().with_font_size(8);
    let hr = "────────────────────────────────────────────────────────";

    fn clean<'a>(s: &'a str) -> &'a str {
      let t = s.trim();
      if t.is_empty() { "-" } else { t }
    }

    fn verdict_ko(row: &PaperRecordRow) -> String {
      if !row.kind.trim().eq_ignore_ascii_case("record") {
        return row.integrity_verdict.clone().unwrap_or_else(|| "사건 대응 조치 로그".to_string());
      }
      if let Some(v) = row.integrity_verdict.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return v.to_string();
      }
      match row.verification_status.as_deref().unwrap_or("").trim() {
        "verified" => {
          if row.signed_on_this_device.unwrap_or(false) {
            "기기서명·해시체인 검증완료".to_string()
          } else {
            "기기서명 검증완료".to_string()
          }
        }
        "foreign" => "해시체인 일치 · 타기기 서명".to_string(),
        "legacy" => "SHA-256 리비전 체인 보존".to_string(),
        "pending" => "해시체인 일치 · 서명검증 대기".to_string(),
        "missing" => "해시체인 점검 가능 · 메타 보강 필요".to_string(),
        _ => "추가 포렌식 검토 필요".to_string(),
      }
    }

    fn evidence_ko(row: &PaperRecordRow) -> String {
      if !row.kind.trim().eq_ignore_ascii_case("record") {
        return row.integrity_evidence.clone().unwrap_or_else(|| clean(row.verification_message.as_deref().unwrap_or("사건 대응 경과 로그입니다.")).to_string());
      }
      if let Some(v) = row.integrity_evidence.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return v.to_string();
      }
      let mut parts: Vec<String> = vec![format!("REV {}", row.revision_count.unwrap_or(0))];
      if let Some(sealed) = row.last_sealed_at.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("최종 봉인 {}", sealed));
      }
      if let Some(hash) = row.integrity_hash.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("SHA-256 {}", hash.chars().take(14).collect::<String>()));
      }
      parts.push(if row.signature_algorithm.as_deref().unwrap_or("") == "rust-ed25519-v1" {
        "Ed25519 전자서명".to_string()
      } else {
        "해시 체인 봉인".to_string()
      });
      if let Some(fp) = row.signer_fingerprint.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("지문 {}", fp.chars().take(12).collect::<String>()));
      }
      let tail = clean(row.verification_message.as_deref().unwrap_or(""));
      if tail != "-" {
        parts.push(normalize_pdf_inline_text(tail));
      }
      parts.join(" / ")
    }

    let kind_ko = |k: &str| -> &'static str {
      match k.trim().to_ascii_lowercase().as_str() {
        "record" => "기록",
        "step" => "조치",
        "advisor" => "권고",
        _ => "기타",
      }
    };

    doc.push(elements::Paragraph::new("전 체 증 거 기 록").aligned(Alignment::Center).styled(s_title.clone()));
    doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()).padded((2.0, 0.0, 1.0, 0.0)));
    doc.push(elements::Paragraph::new(format!("문서 생성일시 : {}", normalize_pdf_inline_text(clean(&report.generated_at)))).styled(s_meta.clone()));
    if !report.hash_sha256.trim().is_empty() {
      doc.push(elements::Paragraph::new(format!("문서 전체 SHA-256 : {}", compact_hash(&normalize_pdf_inline_text(report.hash_sha256.trim()), 14, 10))).styled(s_meta.clone()));
    }

    doc.push(elements::Break::new(1));
    doc.push(elements::Paragraph::new("1. 전체 기록 개요").styled(s_h1.clone()));
    for (idx, line) in report.overview_lines.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).enumerate() {
      doc.push(elements::Paragraph::new(format!("{}. {}", idx + 1, normalize_pdf_inline_text(line))).styled(s_body.clone()).padded((0.5, 0.0, 0.0, 0.0)));
    }

    doc.push(elements::Break::new(1));
    doc.push(elements::Paragraph::new("2. 전체 증거기록").styled(s_h1.clone()));
    doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));

    if report.records.is_empty() {
      doc.push(elements::Paragraph::new("※ 저장된 증거기록이 없습니다.").styled(s_body.clone()).padded((0.5, 0.0, 0.0, 0.0)));
    } else {
      for (idx, r) in report.records.iter().enumerate() {
        doc.push(elements::Paragraph::new(format!("[{}] {} / {}", idx + 1, normalize_pdf_inline_text(kind_ko(&r.kind)), normalize_pdf_inline_text(clean(&r.when)))).styled(s_h2.clone()).padded((0.6, 0.0, 0.0, 0.0)));
        doc.push(elements::Paragraph::new(format!("요지 : {}", normalize_pdf_inline_text(clean(&r.summary)))).styled(s_body.clone()).padded((0.2, 0.0, 0.0, 0.0)));
        doc.push(elements::Paragraph::new(format!("주체 / 장소 : {} / {}", normalize_pdf_inline_text(clean(&r.actor)), normalize_pdf_inline_text(clean(&r.place)))).styled(s_meta.clone()).padded((0.2, 0.0, 0.0, 0.0)));
        doc.push(elements::Paragraph::new(format!("무결성 결론 : {}", normalize_pdf_inline_text(&verdict_ko(r)))).styled(s_meta.clone()).padded((0.2, 0.0, 0.0, 0.0)));
        doc.push(elements::Paragraph::new(format!("검증 근거 : {}", normalize_pdf_inline_text(&evidence_ko(r)))).styled(s_meta.clone()).padded((0.2, 0.0, 0.0, 0.0)));
        if r.kind.trim().eq_ignore_ascii_case("record") {
          let rev = r.revision_count.unwrap_or(0);
          let sealed = compact_hash(&normalize_pdf_inline_text(clean(r.last_sealed_at.as_deref().unwrap_or("-"))), 10, 8);
          let hash = compact_hash(&normalize_pdf_inline_text(clean(r.integrity_hash.as_deref().unwrap_or("-"))), 10, 8);
          doc.push(elements::Paragraph::new(format!("REV / 봉인 / 해시 / ID : {} / {} / {} / {}", rev, sealed, hash, compact_record_id(&normalize_pdf_inline_text(clean(&r.id))))).styled(s_meta.clone()).padded((0.2, 0.0, 0.0, 0.0)));
        }
        doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()).padded((0.5, 0.0, 0.0, 0.0)));
      }
    }

    doc.push(elements::Break::new(1));
    doc.push(elements::Paragraph::new("3. 무결성 검증 요약").styled(s_h1.clone()));
    doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));
    for (idx, line) in report.integrity_lines.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).enumerate() {
      doc.push(elements::Paragraph::new(format!("{}. {}", idx + 1, normalize_pdf_inline_text(line))).styled(s_body.clone()).padded((0.5, 0.0, 0.0, 0.0)));
    }

    doc.push(elements::Break::new(1));
    doc.push(elements::Paragraph::new(normalize_pdf_inline_text(clean(&report.generated_at))).aligned(Alignment::Center).styled(s_body.clone()));

    doc.render_to_file(&tmp_path)
      .map_err(|e| format!("pdf render failed: {e}"))?;
    Ok(())
  })).map_err(panic_message)?;

  render_result?;

  let tmp_meta = std::fs::metadata(&tmp_path)
    .map_err(|e| format!("pdf file check failed: {e}"))?;
  if tmp_meta.len() < 512 {
    let _ = std::fs::remove_file(&tmp_path);
    return Err("PDF 파일이 정상적으로 생성되지 않았어요. 내용을 단순화해 다시 저장하거나 앱을 다시 실행한 뒤 시도해주세요.".to_string());
  }

  if out_path.exists() {
    let _ = std::fs::remove_file(&out_path);
  }

  std::fs::rename(&tmp_path, &out_path).or_else(|_| {
    std::fs::copy(&tmp_path, &out_path)
      .map_err(|e| format!("pdf finalize copy failed: {e}"))?;
    let _ = std::fs::remove_file(&tmp_path);
    Ok::<(), String>(())
  })?;

  Ok(out_path.to_string_lossy().to_string())
}

/* -------------------- Backup export (JSON) -------------------- */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBackupArgs {
  /// saveDialog로 받은 전체 경로
  #[serde(default, alias = "fileName", alias = "filePath", alias = "path", alias = "savePath", alias = "outputPath")]
  pub file_name: Option<String>,
  pub json: String,
}

#[tauri::command]
pub fn export_backup_json(args: ExportBackupArgs) -> Result<String, String> {
  let file_name = args
    .file_name
    .as_ref()
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "fileName(전체 경로)가 필요해요. 프론트에서 saveDialog 결과를 넘겨주세요.".to_string())?;

  let out_path = ensure_json_ext(PathBuf::from(file_name));
  ensure_parent_dir(&out_path)?;

  std::fs::write(&out_path, args.json)
    .map_err(|e| format!("backup write failed: {e}"))?;

  Ok(out_path.to_string_lossy().to_string())
}
