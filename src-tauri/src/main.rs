#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod commands;

fn main() {
  tauri::Builder::default()
    // ✅ save()/open() 파일 다이얼로그 플러그인
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      commands::engine_rank,
      commands::engine_advise,
      commands::export_case_pdf,
      commands::export_backup_json,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
