// src-tauri/src/commands.rs
use crate::engine;
use engine::{AdvisorItem, CaseItem, RankOpts, RankedHit, RecordItem};

use serde::Deserialize;
use std::path::{Path, PathBuf};

// genpdf의 .styled()를 쓰려면 Element 트레이트가 스코프에 있어야 함
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
  #[serde(default, alias = "fileName", alias = "filePath", alias = "path", alias = "savePath", alias = "outputPath")]
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
      // (명조계가 있다면 여기에 추가해도 되지만, 지금은 기능 영향 최소화를 위해 유지)
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

#[tauri::command]
pub fn export_case_pdf(args: ExportPdfArgs) -> Result<String, String> {
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

  // ✅ “문서” 느낌: 여백 살짝만 확대 (기능 영향 없음)
  let mut decorator = genpdf::SimplePageDecorator::new();
  decorator.set_margins(24);
  doc.set_page_decorator(decorator);

  use genpdf::{elements, style};

  // --------------------
  // ✅ 법률/공문 톤 스타일(텍스트만 조정: 기능 영향 0)
  // --------------------
  let t_main = style::Style::new().bold().with_font_size(18);
  let t_sub = style::Style::new().bold().with_font_size(12);
  let h = style::Style::new().bold().with_font_size(12);
  let b = style::Style::new().with_font_size(10);
  let m = style::Style::new().with_font_size(9);

  // 너무 길면 줄바꿈될 수 있어 적당 길이로
  let hr = "────────────────────────────────────────────────────────";

  // 표제
  doc.push(elements::Paragraph::new("사  건  보  고  서").styled(t_main.clone()));
  doc.push(elements::Paragraph::new(paper.title.clone()).styled(t_sub.clone()));
  doc.push(elements::Paragraph::new(hr).styled(m.clone()));

  // 메타 블록 (법률 문서 맛)
  doc.push(elements::Paragraph::new(format!("사건번호: {}", paper.case_id)).styled(m.clone()));
  doc.push(elements::Paragraph::new(format!("작성/출력: {}", paper.generated_at)).styled(m.clone()));
  doc.push(elements::Paragraph::new("배포등급: 내부검토용(업무상 필요자 한정)").styled(m.clone()));
  doc.push(elements::Paragraph::new(format!("무결성 해시(SHA-256): {}", paper.hash_sha256)).styled(m.clone()));
  doc.push(elements::Paragraph::new(hr).styled(m.clone()));
  doc.push(elements::Break::new(1));

  // Ⅰ. 사건 개요
  doc.push(elements::Paragraph::new("Ⅰ. 사건 개요").styled(h.clone()));
  doc.push(elements::Paragraph::new(hr).styled(m.clone()));
  {
    let mut n = 1usize;
    for line in paper.overview_lines.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
      doc.push(elements::Paragraph::new(format!("  {}. {}", n, line)).styled(b.clone()));
      n += 1;
    }
    if n == 1 {
      doc.push(elements::Paragraph::new("  1. -").styled(b.clone()));
    }
  }
  doc.push(elements::Break::new(1));

  // Ⅱ. 핵심 권고(어드바이저)
  doc.push(elements::Paragraph::new("Ⅱ. 핵심 권고(어드바이저)").styled(h.clone()));
  doc.push(elements::Paragraph::new(hr).styled(m.clone()));
  {
    let mut n = 1usize;
    for a in paper.advisors.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
      doc.push(elements::Paragraph::new(format!("  {}. {}", n, a)).styled(b.clone()));
      n += 1;
    }
    if n == 1 {
      doc.push(elements::Paragraph::new("  1. -").styled(b.clone()));
    }
  }
  doc.push(elements::Break::new(1));

  // Ⅲ. 주요 사실(타임라인 요약)
  doc.push(elements::Paragraph::new("Ⅲ. 주요 사실(타임라인 요약)").styled(h.clone()));
  doc.push(elements::Paragraph::new(hr).styled(m.clone()));
  {
    let mut n = 1usize;
    for f in paper.facts.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
      doc.push(elements::Paragraph::new(format!("  {}. {}", n, f)).styled(b.clone()));
      n += 1;
    }
    if n == 1 {
      doc.push(elements::Paragraph::new("  1. -").styled(b.clone()));
    }
  }
  doc.push(elements::Break::new(1));

  // Ⅳ. 증빙 및 조치(목록)  — “증빙 제n호” 서식형
  doc.push(elements::Paragraph::new("Ⅳ. 증빙 및 조치(목록)").styled(h.clone()));
  doc.push(elements::Paragraph::new(hr).styled(m.clone()));

  if paper.records.is_empty() {
    doc.push(elements::Paragraph::new("  ※ 등록된 증빙 항목 없음").styled(b.clone()));
  } else {
    for (idx, r) in paper.records.iter().enumerate() {
      let no = idx + 1;

      let kind = if r.kind.trim().is_empty() { "-" } else { r.kind.trim() };
      let when = if r.when.trim().is_empty() { "-" } else { r.when.trim() };
      let lv = if r.lv.trim().is_empty() { "-" } else { r.lv.trim() };
      let actor = if r.actor.trim().is_empty() { "-" } else { r.actor.trim() };
      let place = if r.place.trim().is_empty() { "-" } else { r.place.trim() };
      let summary = if r.summary.trim().is_empty() { "-" } else { r.summary.trim() };

      // 헤더(굵게)
      doc.push(
        elements::Paragraph::new(format!("【증빙 제{}호】 {}", no, summary))
          .styled(style::Style::new().bold().with_font_size(10)),
      );

      // 서식형 필드
      doc.push(elements::Paragraph::new(format!("  1) 유형: {}", kind.to_uppercase())).styled(b.clone()));
      doc.push(elements::Paragraph::new(format!("  2) 일시: {}", when)).styled(b.clone()));
      doc.push(elements::Paragraph::new(format!("  3) 등급: {}", lv)).styled(b.clone()));
      doc.push(elements::Paragraph::new(format!("  4) 주체: {}", actor)).styled(b.clone()));
      doc.push(elements::Paragraph::new(format!("  5) 장소: {}", place)).styled(b.clone()));

      // 메타(작게)
      doc.push(elements::Paragraph::new(format!("  6) 식별자(ID): {}", r.id)).styled(m.clone()));
      if let Some(reason) = &r.reason {
        let rr = reason.trim();
        if !rr.is_empty() {
          doc.push(elements::Paragraph::new(format!("  7) 포함근거: {}", rr)).styled(m.clone()));
        }
      }

      doc.push(elements::Paragraph::new(hr).styled(m.clone()));
      doc.push(elements::Break::new(1));
    }
  }

  // Ⅴ. 확인/서명 (결재라인 맛)
  doc.push(elements::Paragraph::new("Ⅴ. 확인 및 서명").styled(h.clone()));
  doc.push(elements::Paragraph::new(hr).styled(m.clone()));
  doc.push(elements::Paragraph::new("  작성자(담당): __________________________   (서명) __________").styled(b.clone()));
  doc.push(elements::Paragraph::new("  검토(관리/법률): _______________________   (서명) __________").styled(b.clone()));
  doc.push(elements::Paragraph::new("  승인자: _________________________________   (서명) __________").styled(b.clone()));

  // 출력
  doc.render_to_file(&out_path)
    .map_err(|e| format!("pdf render failed: {e}"))?;

  Ok(out_path.to_string_lossy().to_string())
}
