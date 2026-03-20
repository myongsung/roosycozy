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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperPayload {
  pub title: String,
  pub case_id: String,
  pub generated_at: String,
  pub hash_sha256: String,

  pub overview_lines: Vec<String>,
  pub advisors: Vec<String>,
  pub facts: Vec<String>,
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
    if dst.exists() {
      return Ok(());
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

#[tauri::command]
pub fn export_case_pdf(args: ExportPdfArgs) -> Result<String, String> {
  use genpdf::{elements, style, Alignment};

  let paper = args.paper;

  // ✅ 기존 동작 유지: fileName은 필수
  let file_name = args
    .file_name
    .as_ref()
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "fileName(전체 경로)가 필요해요. 프론트에서 saveDialog 결과를 넘겨주세요.".to_string())?;

  let out_path = ensure_pdf_ext(PathBuf::from(file_name));
  ensure_parent_dir(&out_path)?;

  // 1) font source
  let src_font = find_korean_font_source()
    .ok_or_else(|| "Korean font not found (AppleGothic/Malgun/Nanum/Noto).".to_string())?;

  // 2) temp 4종 생성
  let (font_dir, family) = prepare_genpdf_font_family(&src_font)?;

  // 3) load family
  let font_family = genpdf::fonts::from_files(&font_dir, &family, None)
    .map_err(|e| format!("font load failed: {e}"))?;

  // 4) render
  let mut doc = genpdf::Document::new(font_family);
  doc.set_title(&paper.title);
  doc.set_font_size(10);
  doc.set_line_spacing(1.25);

  // ✅ 문서 여백(균일)
  let mut decorator = genpdf::SimplePageDecorator::new();
  decorator.set_margins(18);
  doc.set_page_decorator(decorator);

  // --------------------
  // 스타일 세트 (공문/법률 톤)
  // --------------------
  let s_cover_title = style::Style::new().bold().with_font_size(22);
  let s_cover_sub = style::Style::new().bold().with_font_size(12);

  let s_h1 = style::Style::new().bold().with_font_size(13);
  let s_h2 = style::Style::new().bold().with_font_size(11);
  let s_body = style::Style::new().with_font_size(10);
  let s_meta = style::Style::new().with_font_size(9);

  let s_table_head = style::Style::new().bold().with_font_size(9);
  let s_table = style::Style::new().with_font_size(9);

  let hr = "────────────────────────────────────────────────────────";

  // 유틸
    fn clean<'a>(s: &'a str) -> &'a str {
      let t = s.trim();
      if t.is_empty() { "-" } else { t }
    }

  let kind_ko = |k: &str| -> &'static str {
    match k.trim().to_ascii_lowercase().as_str() {
      "record" => "기록",
      "step" => "조치",
      "advisor" => "권고",
      _ => "기타",
    }
  };

  // =========================
  // 표지(cover)
  // =========================
  doc.push(
    elements::Paragraph::new("사 건 보 고 서")
      .aligned(Alignment::Center)      // ✅ aligned 먼저!
      .styled(s_cover_title.clone())
  );

  doc.push(
    elements::Paragraph::new("제출용(법률 검토/대리인 제출 가능본)")
      .aligned(Alignment::Center)      // ✅ aligned 먼저!
      .styled(s_cover_sub.clone())
      .padded((3.0, 0.0, 0.0, 0.0))
  );

  doc.push(
    elements::Paragraph::new(hr)
      .styled(s_meta.clone())
      .padded((4.0, 0.0, 2.0, 0.0))
  );

  // 사건 정보 블록(키-값)
  {
    let mut meta = elements::TableLayout::new(vec![2, 6]);
    meta.set_cell_decorator(elements::FrameCellDecorator::new(true, true, false));

    let mut row = meta.row();
    row.push_element(elements::Paragraph::new("사건명").styled(s_table_head.clone()).padded(1.0));
    row.push_element(elements::Paragraph::new(paper.title.clone()).styled(s_table.clone()).padded(1.0));
    row.push().map_err(|e| format!("meta table row invalid: {e}"))?;

    let mut row = meta.row();
    row.push_element(elements::Paragraph::new("사건번호").styled(s_table_head.clone()).padded(1.0));
    row.push_element(elements::Paragraph::new(paper.case_id.clone()).styled(s_table.clone()).padded(1.0));
    row.push().map_err(|e| format!("meta table row invalid: {e}"))?;

    let mut row = meta.row();
    row.push_element(elements::Paragraph::new("작성/출력").styled(s_table_head.clone()).padded(1.0));
    row.push_element(elements::Paragraph::new(paper.generated_at.clone()).styled(s_table.clone()).padded(1.0));
    row.push().map_err(|e| format!("meta table row invalid: {e}"))?;

    let mut row = meta.row();
    row.push_element(elements::Paragraph::new("배포등급").styled(s_table_head.clone()).padded(1.0));
    row.push_element(
      elements::Paragraph::new("내부검토용(업무상 필요자 한정) / 외부 제출 시 문구 검토 권장")
        .styled(s_table.clone())
        .padded(1.0)
    );
    row.push().map_err(|e| format!("meta table row invalid: {e}"))?;

    let mut row = meta.row();
    row.push_element(elements::Paragraph::new("무결성 해시").styled(s_table_head.clone()).padded(1.0));
    // 해시는 길어서 끊어쓰기(줄바꿈 도움)
    let hash_pretty = wrap_every(paper.hash_sha256.trim(), 32);
    row.push_element(
      elements::Paragraph::new(format!("SHA-256: {}", hash_pretty))
        .styled(s_table.clone())
        .padded(1.0)
    );
    row.push().map_err(|e| format!("meta table row invalid: {e}"))?;

    doc.push(meta.padded((2.0, 0.0, 0.0, 0.0)));
  }

  doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()).padded((3.0, 0.0, 0.0, 0.0)));
  doc.push(
    elements::Paragraph::new(
      "※ 본 문서는 시스템 출력물로서, 사실관계 및 표현은 최종 제출 전 담당자/대리인이 확인·수정하여 사용하시기 바랍니다."
    )
    .styled(s_meta.clone())
    .padded((2.0, 0.0, 0.0, 0.0))
  );

  doc.push(elements::PageBreak::new());

  // =========================
  // 목차
  // =========================
  doc.push(elements::Paragraph::new("목차").styled(s_h1.clone()));
  doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));

  // ✅ genpdf 0.2.0 호환: element 체인 대신 push 사용
  {
    let mut toc = elements::OrderedList::new();
    toc.push(elements::Paragraph::new("Ⅰ. 사건 개요").styled(s_body.clone()));
    toc.push(elements::Paragraph::new("Ⅱ. 대응 권고(핵심 권고)").styled(s_body.clone()));
    toc.push(elements::Paragraph::new("Ⅲ. 주요 사실관계(요약) 및 연표").styled(s_body.clone()));
    toc.push(elements::Paragraph::new("Ⅳ. 증빙/첨부 목록표").styled(s_body.clone()));
    toc.push(elements::Paragraph::new("Ⅴ. 첨부(증빙) 상세").styled(s_body.clone()));
    toc.push(elements::Paragraph::new("Ⅵ. 확인 및 서명").styled(s_body.clone()));
    doc.push(toc.padded((2.0, 0.0, 0.0, 0.0)));
  }

  doc.push(elements::PageBreak::new());

  // =========================
  // Ⅰ. 사건 개요
  // =========================
  doc.push(elements::Paragraph::new("Ⅰ. 사건 개요").styled(s_h1.clone()));
  doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));

  if paper.overview_lines.iter().all(|s| s.trim().is_empty()) {
    doc.push(elements::Paragraph::new("  1. -").styled(s_body.clone()));
  } else {
    let mut list = elements::OrderedList::new();
    for line in paper.overview_lines.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
      list.push(elements::Paragraph::new(line.to_string()).styled(s_body.clone()));
    }
    doc.push(list.padded((1.5, 0.0, 0.0, 0.0)));
  }

  doc.push(elements::Break::new(1));

  // =========================
  // Ⅱ. 대응 권고
  // =========================
  doc.push(elements::Paragraph::new("Ⅱ. 대응 권고(핵심 권고)").styled(s_h1.clone()));
  doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));

  if paper.advisors.iter().all(|s| s.trim().is_empty()) {
    doc.push(elements::Paragraph::new("  1. -").styled(s_body.clone()));
  } else {
    let mut list = elements::OrderedList::new();
    for a in paper.advisors.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
      list.push(elements::Paragraph::new(a.to_string()).styled(s_body.clone()));
    }
    doc.push(list.padded((1.5, 0.0, 0.0, 0.0)));
  }

  doc.push(elements::Break::new(1));

  // =========================
  // Ⅲ. 주요 사실관계 + 연표
  // =========================
  doc.push(elements::Paragraph::new("Ⅲ. 주요 사실관계(요약) 및 연표").styled(s_h1.clone()));
  doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));

  doc.push(
    elements::Paragraph::new("1. 요약(핵심 사실)")
      .styled(s_h2.clone())
      .padded((1.5, 0.0, 0.0, 0.0))
  );

  if paper.facts.iter().all(|s| s.trim().is_empty()) {
    doc.push(
      elements::Paragraph::new("  1) -")
        .styled(s_body.clone())
        .padded((1.0, 0.0, 0.0, 0.0))
    );
  } else {
    let mut list = elements::OrderedList::new();
    for f in paper.facts.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
      list.push(elements::Paragraph::new(f.to_string()).styled(s_body.clone()));
    }
    doc.push(list.padded((1.0, 0.0, 0.0, 0.0)));
  }

  doc.push(elements::Break::new(1));

  doc.push(
    elements::Paragraph::new("2. 연표(기록/조치/권고 목록)")
      .styled(s_h2.clone())
      .padded((1.5, 0.0, 0.0, 0.0))
  );

  if paper.records.is_empty() {
    doc.push(
      elements::Paragraph::new("  ※ 등록된 항목 없음")
        .styled(s_body.clone())
        .padded((1.0, 0.0, 0.0, 0.0))
    );
  } else {
    // 표: No / 일시 / 구분 / 요약 / 주체·장소 / 등급
    let mut table = elements::TableLayout::new(vec![1, 2, 1, 4, 2, 1]);
    table.set_cell_decorator(elements::FrameCellDecorator::new(true, true, false));

    // header
    {
      let mut row = table.row();
      row.push_element(elements::Paragraph::new("No").styled(s_table_head.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new("일시").styled(s_table_head.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new("구분").styled(s_table_head.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new("요약").styled(s_table_head.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new("주체·장소").styled(s_table_head.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new("등급").styled(s_table_head.clone()).padded(1.0));
      row.push().map_err(|e| format!("timeline table header invalid: {e}"))?;
    }

    for (idx, r) in paper.records.iter().enumerate() {
      let no = idx + 1;

      let when = clean(&r.when);
      let kind = kind_ko(&r.kind);
      let summary = clean(&r.summary);
      let actor = clean(&r.actor);
      let place = clean(&r.place);
      let lv = clean(&r.lv);

      let actor_place = if actor == "-" && place == "-" {
        "-".to_string()
      } else if place == "-" {
        actor.to_string()
      } else if actor == "-" {
        place.to_string()
      } else {
        format!("{actor} / {place}")
      };

      let rev_count = r.revision_count.unwrap_or(0);
      let amend_count = rev_count.saturating_sub(1);
      let original_sealed_at = r.original_sealed_at.as_deref().map(clean).unwrap_or("-");
      let last_sealed_at = r.last_sealed_at.as_deref().map(clean).unwrap_or("-");
      let integrity_hash = r.integrity_hash.as_deref().map(clean).unwrap_or("-");
      let mut summary_block = summary.to_string();
      if rev_count > 0 || original_sealed_at != "-" || last_sealed_at != "-" {
        summary_block.push_str(&format!("\n입력/봉인: {original_sealed_at} / 최종 수정봉인: {last_sealed_at}"));
        if amend_count > 0 {
          summary_block.push_str(&format!("\n수정이력: 정정 {amend_count}회 / REV {rev_count} / {integrity_hash}"));
        } else {
          summary_block.push_str(&format!("\n수정이력: 원본 / REV {rev_count} / {integrity_hash}"));
        }
      }

      let mut row = table.row();
      row.push_element(elements::Paragraph::new(format!("{no}")).styled(s_table.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new(when.to_string()).styled(s_table.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new(kind).styled(s_table.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new(summary_block).styled(s_table.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new(actor_place).styled(s_table.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new(lv.to_string()).styled(s_table.clone()).padded(1.0));
      row.push().map_err(|e| format!("timeline table row invalid: {e}"))?;
    }

    doc.push(table.padded((1.0, 0.0, 0.0, 0.0)));
    doc.push(
      elements::Paragraph::new("※ 표의 상세(포함근거/식별자 등)는 ‘Ⅴ. 첨부(증빙) 상세’에 기재함.")
        .styled(s_meta.clone())
        .padded((1.0, 0.0, 0.0, 0.0))
    );
  }

  doc.push(elements::PageBreak::new());

  // =========================
  // Ⅳ. 증빙/첨부 목록표
  // =========================
  doc.push(elements::Paragraph::new("Ⅳ. 증빙/첨부 목록표").styled(s_h1.clone()));
  doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));

  if paper.records.is_empty() {
    doc.push(elements::Paragraph::new("  ※ 등록된 증빙 항목 없음").styled(s_body.clone()));
  } else {
    let mut table = elements::TableLayout::new(vec![1, 2, 5, 2]);
    table.set_cell_decorator(elements::FrameCellDecorator::new(true, true, false));

    // header
    {
      let mut row = table.row();
      row.push_element(elements::Paragraph::new("첨부").styled(s_table_head.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new("일시").styled(s_table_head.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new("제목/요지").styled(s_table_head.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new("구분").styled(s_table_head.clone()).padded(1.0));
      row.push().map_err(|e| format!("evidence table header invalid: {e}"))?;
    }

    for (idx, r) in paper.records.iter().enumerate() {
      let no = idx + 1;
      let when = clean(&r.when);
      let summary = clean(&r.summary);
      let kind = kind_ko(&r.kind);

      let mut row = table.row();
      row.push_element(elements::Paragraph::new(format!("제{no}호")).styled(s_table.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new(when.to_string()).styled(s_table.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new(summary.to_string()).styled(s_table.clone()).padded(1.0));
      row.push_element(elements::Paragraph::new(kind).styled(s_table.clone()).padded(1.0));
      row.push().map_err(|e| format!("evidence table row invalid: {e}"))?;
    }

    doc.push(table.padded((1.0, 0.0, 0.0, 0.0)));
  }

  doc.push(elements::PageBreak::new());

  // =========================
  // Ⅴ. 첨부(증빙) 상세
  // =========================
  doc.push(elements::Paragraph::new("Ⅴ. 첨부(증빙) 상세").styled(s_h1.clone()));
  doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));

  if paper.records.is_empty() {
    doc.push(elements::Paragraph::new("  ※ 등록된 증빙 항목 없음").styled(s_body.clone()));
  } else {
    for (idx, r) in paper.records.iter().enumerate() {
      let no = idx + 1;

      let kind = kind_ko(&r.kind);
      let when = clean(&r.when);
      let lv = clean(&r.lv);
      let actor = clean(&r.actor);
      let place = clean(&r.place);
      let summary = clean(&r.summary);

      // ID는 길면 끊어쓰기(줄바꿈 도움)
      let id_pretty = wrap_every(clean(&r.id), 24);

      // 블록 헤더
      doc.push(
        elements::Paragraph::new(format!("【첨부 제{no}호】 {summary}"))
          .styled(style::Style::new().bold().with_font_size(11))
          .padded((2.0, 0.0, 0.0, 0.0))
      );

      // 필드(공문/법률 서식)  ✅ 괄호/체인 전부 정상화
      doc.push(elements::Paragraph::new(format!("  1) 구분: {kind}")).styled(s_body.clone()));
      doc.push(elements::Paragraph::new(format!("  2) 일시: {when}")).styled(s_body.clone()));
      doc.push(elements::Paragraph::new(format!("  3) 등급: {lv}")).styled(s_body.clone()));
      doc.push(elements::Paragraph::new(format!("  4) 주체: {actor}")).styled(s_body.clone()));
      doc.push(elements::Paragraph::new(format!("  5) 장소: {place}")).styled(s_body.clone()));
      doc.push(
        elements::Paragraph::new(format!("  6) 식별자(ID): {id_pretty}"))
          .styled(s_meta.clone())
      );

      let rev_count = r.revision_count.unwrap_or(0);
      let amend_count = rev_count.saturating_sub(1);
      let has_integrity_meta = rev_count > 0
        || r.original_sealed_at.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false)
        || r.last_sealed_at.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false)
        || r.integrity_hash.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);

      if has_integrity_meta {
        doc.push(elements::Paragraph::new("  7) 봉인/수정 메타").styled(s_meta.clone()));
        if let Some(original) = &r.original_sealed_at {
          let v = original.trim();
          if !v.is_empty() {
            doc.push(elements::Paragraph::new(format!("      - 최초 입력봉인: {}", clean(v))).styled(s_meta.clone()));
          }
        }
        if let Some(last) = &r.last_sealed_at {
          let v = last.trim();
          if !v.is_empty() {
            doc.push(elements::Paragraph::new(format!("      - 최종 수정봉인: {}", clean(v))).styled(s_meta.clone()));
          }
        }
        if rev_count > 0 {
          let rev_line = if amend_count > 0 {
            format!("      - 수정이력: 정정 {amend_count}회 / REV {rev_count}")
          } else {
            format!("      - 수정이력: 원본 / REV {rev_count}")
          };
          doc.push(elements::Paragraph::new(rev_line).styled(s_meta.clone()));
        }
        if let Some(hash) = &r.integrity_hash {
          let v = hash.trim();
          if !v.is_empty() {
            let pretty = wrap_every(v, 24);
            doc.push(elements::Paragraph::new(format!("      - 현재 해시: {pretty}")).styled(s_meta.clone()));
          }
        }
        if let Some(trail) = &r.revision_trail {
          for line in trail.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).take(6) {
            doc.push(elements::Paragraph::new(format!("      - {line}")).styled(s_meta.clone()));
          }
        }
      }

      if let Some(reason) = &r.reason {
        let rr = reason.trim();
        if !rr.is_empty() {
          doc.push(
            elements::Paragraph::new(format!("  8) 포함근거: {rr}"))
              .styled(s_meta.clone())
          );
        }
      }

      doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()).padded((1.5, 0.0, 0.0, 0.0)));
    }
  }

  doc.push(elements::Break::new(1));

  // =========================
  // Ⅵ. 확인 및 서명
  // =========================
  doc.push(elements::Paragraph::new("Ⅵ. 확인 및 서명").styled(s_h1.clone()));
  doc.push(elements::Paragraph::new(hr).styled(s_meta.clone()));
  doc.push(elements::Paragraph::new("  작성자(담당): __________________________   (서명) __________").styled(s_body.clone()));
  doc.push(elements::Paragraph::new("  검토(관리/법률): _______________________   (서명) __________").styled(s_body.clone()));
  doc.push(elements::Paragraph::new("  승인자: _________________________________   (서명) __________").styled(s_body.clone()));

  // 출력
  doc.render_to_file(&out_path)
    .map_err(|e| format!("pdf render failed: {e}"))?;

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
