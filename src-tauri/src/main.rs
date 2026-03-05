#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod commands;

use self_update::backends::github::Update;
use tauri::{command, AppHandle}; // ✅ AppHandle을 추가로 가져옵니다.
use std::fs;

// ✅ 1. 업데이트 확인 및 실행 커맨드 (app: AppHandle 매개변수 추가)
#[command]
fn check_and_update(app: AppHandle) -> Result<String, String> {
    // 🚨 핵심 수정: 고정된 Cargo.toml 버전 대신, 깃허브 액션이 주입한 '진짜 현재 버전'을 가져옵니다.
    let app_version = app.package_info().version.to_string();

    let status = Update::configure()
        .repo_owner("myongsung") // 깃허브 아이디
        .repo_name("roosycozy") // 레포지토리 이름
        .bin_name("roosycozy.exe") // 다운로드 받아 압축을 풀었을 때 나오는 실제 실행 파일 이름
        .show_download_progress(true)
        .current_version(&app_version) // ✅ 동적으로 가져온 버전을 여기에 넣습니다!
        .build()
        .map_err(|e| format!("업데이트 설정 오류: {}", e))?
        .update()
        .map_err(|e| format!("업데이트 실행 오류: {}", e))?;

    if status.updated() {
        Ok(format!("업데이트 완료: 버전 {}", status.version()))
    } else {
        Ok("최신 버전입니다.".to_string())
    }
}

// ✅ 2. 이전 버전(.old) 찌꺼기 파일 삭제 로직
fn cleanup_old_versions() {
    if let Ok(current_exe) = std::env::current_exe() {
        let old_exe = current_exe.with_extension("exe.old");
        if old_exe.exists() {
            // 구버전 파일이 남아있으면 조용히 삭제합니다.
            let _ = fs::remove_file(old_exe);
        }
    }
}

fn main() {
    // 앱 시작 시 이전 업데이트 잔여물 청소
    cleanup_old_versions();

    tauri::Builder::default()
        // save()/open() 파일 다이얼로그 플러그인
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::engine_rank,
            commands::engine_advise,
            commands::export_case_pdf,
            commands::export_backup_json,
            check_and_update // ✅ 3. 생성한 업데이트 커맨드 등록
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}