#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod engine;
mod commands;

use std::fs;
#[cfg(target_os = "windows")]
use std::fs::File;
#[cfg(target_os = "windows")]
use std::io;
#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::process::Command;
#[cfg(target_os = "windows")]
use tauri::Manager;
use tauri::{command, AppHandle};

#[cfg(target_os = "windows")]
const UPDATE_REPO_OWNER: &str = "myongsung";
#[cfg(target_os = "windows")]
const UPDATE_REPO_NAME: &str = "roosycozy";
#[cfg(target_os = "windows")]
const UPDATE_ASSET_NAME: &str = "roosycozy-x86_64-pc-windows-msvc.zip";
#[cfg(target_os = "windows")]
const WINDOWS_BUNDLE_SUPPORT_DIR_NAME: &str = "RoosyCozy";
#[cfg(target_os = "windows")]
const WINDOWS_RUNTIME_URL: &str =
    "https://github.com/myongsung/roosycozy/releases/latest/download/roosycozy-windows-runtime.zip";
#[cfg(target_os = "windows")]
const WINDOWS_RUNTIME_MARKER_FILENAME: &str = ".runtime-ready";

#[cfg(target_os = "windows")]
#[derive(Debug, serde::Deserialize)]
struct GithubReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[cfg(target_os = "windows")]
#[derive(Debug, serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubReleaseAsset>,
}

#[cfg(target_os = "windows")]
fn normalize_release_version(value: &str) -> String {
    value.trim().trim_start_matches('v').to_string()
}

#[cfg(target_os = "windows")]
fn parse_version_triplet(value: &str) -> [u32; 3] {
    let mut out = [0u32; 3];
    for (idx, part) in normalize_release_version(value).split('.').take(3).enumerate() {
        out[idx] = part.parse::<u32>().unwrap_or(0);
    }
    out
}

#[cfg(target_os = "windows")]
fn latest_github_release() -> Result<GithubRelease, String> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        UPDATE_REPO_OWNER, UPDATE_REPO_NAME
    );
    reqwest::blocking::Client::builder()
        .user_agent("roosycozy-updater/1.0")
        .build()
        .map_err(|e| format!("업데이트 클라이언트를 준비하지 못했어요: {}", e))?
        .get(url)
        .send()
        .map_err(|e| format!("최신 릴리즈를 확인하지 못했어요: {}", e))?
        .error_for_status()
        .map_err(|e| format!("최신 릴리즈 응답이 올바르지 않아요: {}", e))?
        .json::<GithubRelease>()
        .map_err(|e| format!("최신 릴리즈 정보를 읽지 못했어요: {}", e))
}

#[cfg(target_os = "windows")]
fn download_release_zip(url: &str, target_zip: &Path) -> Result<(), String> {
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("roosycozy-updater/1.0")
        .build()
        .map_err(|e| format!("업데이트 다운로드 클라이언트를 준비하지 못했어요: {}", e))?
        .get(url)
        .send()
        .map_err(|e| format!("업데이트 파일을 받지 못했어요: {}", e))?
        .error_for_status()
        .map_err(|e| format!("업데이트 파일 응답이 올바르지 않아요: {}", e))?;

    if let Some(parent) = target_zip.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("임시 업데이트 폴더를 만들지 못했어요: {}", e))?;
    }

    let mut file = File::create(target_zip).map_err(|e| format!("업데이트 zip을 만들지 못했어요: {}", e))?;
    io::copy(&mut response, &mut file).map_err(|e| format!("업데이트 zip 저장에 실패했어요: {}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn extract_release_zip(zip_path: &Path, target_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(target_dir).map_err(|e| format!("업데이트 압축 해제 폴더를 만들지 못했어요: {}", e))?;
    let file = File::open(zip_path).map_err(|e| format!("업데이트 zip을 열지 못했어요: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("업데이트 zip 형식이 올바르지 않아요: {}", e))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("업데이트 zip 항목을 읽지 못했어요: {}", e))?;
        let out_path = target_dir.join(entry.mangled_name());

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("업데이트 폴더를 만들지 못했어요: {}", e))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("업데이트 파일 폴더를 만들지 못했어요: {}", e))?;
        }

        let mut out_file = File::create(&out_path).map_err(|e| format!("업데이트 파일을 만들지 못했어요: {}", e))?;
        io::copy(&mut entry, &mut out_file).map_err(|e| format!("업데이트 파일 저장에 실패했어요: {}", e))?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(target).map_err(|e| format!("업데이트 대상 폴더를 만들지 못했어요: {}", e))?;
    for entry in fs::read_dir(source).map_err(|e| format!("업데이트 폴더를 읽지 못했어요: {}", e))? {
        let entry = entry.map_err(|e| format!("업데이트 폴더 항목을 읽지 못했어요: {}", e))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("업데이트 파일 폴더를 만들지 못했어요: {}", e))?;
            }
            fs::copy(&source_path, &target_path).map_err(|e| format!("업데이트 파일 복사에 실패했어요: {}", e))?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn schedule_windows_exe_swap(current_exe: &Path, staged_exe: &Path) -> Result<(), String> {
    let current_dir = current_exe
        .parent()
        .ok_or_else(|| "현재 실행 파일 폴더를 찾지 못했어요.".to_string())?;
    let current_name = current_exe
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "현재 실행 파일 이름을 읽지 못했어요.".to_string())?;
    let staged_name = staged_exe
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "새 실행 파일 이름을 읽지 못했어요.".to_string())?;
    let script_path = current_dir.join("roosycozy-update.cmd");
    let pid = std::process::id();
    let script = format!(
        "@echo off\r\n\
setlocal\r\n\
set \"TARGET_DIR={target_dir}\"\r\n\
set \"CURRENT_EXE={current_name}\"\r\n\
set \"STAGED_EXE={staged_name}\"\r\n\
set \"PID={pid}\"\r\n\
:waitloop\r\n\
tasklist /FI \"PID eq %PID%\" | findstr /R /C:\"\\<%PID%\\>\" >nul\r\n\
if %ERRORLEVEL%==0 (\r\n\
  timeout /t 1 /nobreak >nul\r\n\
  goto waitloop\r\n\
)\r\n\
if exist \"%TARGET_DIR%\\%CURRENT_EXE%.old\" del /f /q \"%TARGET_DIR%\\%CURRENT_EXE%.old\"\r\n\
if exist \"%TARGET_DIR%\\%CURRENT_EXE%\" move /Y \"%TARGET_DIR%\\%CURRENT_EXE%\" \"%TARGET_DIR%\\%CURRENT_EXE%.old\" >nul\r\n\
if exist \"%TARGET_DIR%\\%STAGED_EXE%\" move /Y \"%TARGET_DIR%\\%STAGED_EXE%\" \"%TARGET_DIR%\\%CURRENT_EXE%\" >nul\r\n\
del /f /q \"%~f0\"\r\n\
endlocal\r\n",
        target_dir = current_dir.display(),
        current_name = current_name,
        staged_name = staged_name,
        pid = pid
    );
    fs::write(&script_path, script).map_err(|e| format!("업데이트 교체 스크립트를 만들지 못했어요: {}", e))?;
    Command::new("cmd")
        .args(["/C", "start", "", "/MIN", script_path.to_string_lossy().as_ref()])
        .spawn()
        .map_err(|e| format!("업데이트 적용 스크립트를 실행하지 못했어요: {}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_sidecar_storage_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("sidecar", tauri::path::BaseDirectory::AppData)
        .map_err(|e| format!("AI 런타임 폴더를 찾지 못했어요: {}", e))
}

#[cfg(target_os = "windows")]
fn windows_resources_storage_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("resources", tauri::path::BaseDirectory::AppData)
        .map_err(|e| format!("AI 리소스 폴더를 찾지 못했어요: {}", e))
}

#[cfg(target_os = "windows")]
fn windows_sidecar_required_files() -> [&'static str; 3] {
    [
        "llama-sidecar-x86_64-pc-windows-msvc.exe",
        "llama.dll",
        "mtmd.dll",
    ]
}

#[cfg(target_os = "windows")]
fn windows_msvc_runtime_files() -> [&'static str; 4] {
    [
        "msvcp140.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
        "concrt140.dll",
    ]
}

#[cfg(target_os = "windows")]
fn windows_runtime_marker_path(sidecar_dir: &Path) -> PathBuf {
    sidecar_dir.join(WINDOWS_RUNTIME_MARKER_FILENAME)
}

#[cfg(target_os = "windows")]
fn windows_install_needs_repair(app: &AppHandle) -> bool {
    let Ok(sidecar_dir) = windows_sidecar_storage_dir(app) else {
        return true;
    };

    if !sidecar_dir.exists() {
        return true;
    }

    windows_sidecar_required_files()
        .iter()
        .chain(windows_msvc_runtime_files().iter())
        .any(|name| !sidecar_dir.join(name).exists())
        || !windows_runtime_marker_path(&sidecar_dir).exists()
}

#[cfg(target_os = "windows")]
fn find_runtime_sidecar_candidate(root: &Path) -> Option<PathBuf> {
    for candidate in [
        "llama-sidecar-x86_64-pc-windows-msvc.exe",
        "llama-sidecar.exe",
        "llama-cli.exe",
    ] {
        if let Some(path) = find_path_recursively(root, &|path| {
            path.is_file() && path.file_name().and_then(|x| x.to_str()) == Some(candidate)
        }) {
            return Some(path);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn collect_runtime_dlls(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !root.exists() {
        return out;
    }
    if root.is_file() {
        if root.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("dll")) == Some(true) {
            out.push(root.to_path_buf());
        }
        return out;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(collect_runtime_dlls(&path));
        } else if path.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("dll")) == Some(true) {
            out.push(path);
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn download_windows_runtime_to_appdata(sidecar_dir: &Path) -> Result<(), String> {
    let temp_root = std::env::temp_dir().join(format!("roosycozy-runtime-{}", std::process::id()));
    if temp_root.exists() {
        let _ = fs::remove_dir_all(&temp_root);
    }
    fs::create_dir_all(&temp_root).map_err(|e| format!("임시 AI 런타임 폴더를 만들지 못했어요: {}", e))?;
    let zip_path = temp_root.join("runtime.zip");
    let extract_dir = temp_root.join("runtime");

    download_release_zip(WINDOWS_RUNTIME_URL, &zip_path)?;
    extract_release_zip(&zip_path, &extract_dir)?;

    let runtime_exe = find_runtime_sidecar_candidate(&extract_dir)
        .ok_or_else(|| "다운로드한 AI 런타임 안에서 실행 파일을 찾지 못했어요.".to_string())?;
    let runtime_dlls = collect_runtime_dlls(&extract_dir);

    for required in windows_sidecar_required_files()
        .iter()
        .skip(1)
        .chain(windows_msvc_runtime_files().iter())
    {
        if !runtime_dlls.iter().any(|path| path.file_name().and_then(|x| x.to_str()) == Some(required)) {
            return Err(format!(
                "다운로드한 AI 런타임 안에 필요한 DLL이 빠져 있어요: {}",
                required
            ));
        }
    }

    fs::create_dir_all(sidecar_dir).map_err(|e| format!("AppData sidecar 폴더를 만들지 못했어요: {}", e))?;
    let target_exe = sidecar_dir.join("llama-sidecar-x86_64-pc-windows-msvc.exe");
    fs::copy(&runtime_exe, &target_exe).map_err(|e| format!("AI 실행 파일을 AppData로 복사하지 못했어요: {}", e))?;
    for dll in runtime_dlls {
        let Some(name) = dll.file_name() else {
            continue;
        };
        let target = sidecar_dir.join(name);
        let _ = fs::copy(&dll, &target);
    }
    fs::write(
        windows_runtime_marker_path(sidecar_dir),
        format!("runtime-ready\nsource={}\n", WINDOWS_RUNTIME_URL),
    )
    .map_err(|e| format!("AI 런타임 준비 표시를 저장하지 못했어요: {}", e))?;

    let _ = fs::remove_dir_all(&temp_root);
    Ok(())
}

#[cfg(target_os = "windows")]
fn ensure_windows_runtime_cache(app: &AppHandle) -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("현재 실행 파일 경로를 읽지 못했어요: {}", e))?;
    let install_dir = current_exe
        .parent()
        .ok_or_else(|| "현재 실행 파일 폴더를 찾지 못했어요.".to_string())?;

    let sidecar_dir = windows_sidecar_storage_dir(app)?;
    let resources_dir = windows_resources_storage_dir(app)?;
    fs::create_dir_all(&sidecar_dir).map_err(|e| format!("AppData sidecar 폴더를 만들지 못했어요: {}", e))?;
    fs::create_dir_all(&resources_dir).map_err(|e| format!("AppData resources 폴더를 만들지 못했어요: {}", e))?;

    if windows_install_needs_repair(app) {
        let bootstrap_candidates = [
            install_dir.join(WINDOWS_BUNDLE_SUPPORT_DIR_NAME).join("sidecar"),
            install_dir.join("sidecar"),
        ];
        for source in bootstrap_candidates {
            if source.exists() {
                copy_dir_recursive(&source, &sidecar_dir)?;
                break;
            }
        }
    }

    if windows_install_needs_repair(app) {
        download_windows_runtime_to_appdata(&sidecar_dir)?;
    }

    let resource_candidates = [
        install_dir.join(WINDOWS_BUNDLE_SUPPORT_DIR_NAME).join("resources"),
        install_dir.join("resources"),
    ];
    for source in resource_candidates {
        if source.exists() {
            copy_dir_recursive(&source, &resources_dir)?;
            break;
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn find_path_recursively(root: &Path, predicate: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    if predicate(root) {
        return Some(root.to_path_buf());
    }
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if predicate(&path) {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(found) = find_path_recursively(&path, predicate) {
                return Some(found);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn validate_extracted_release(extract_dir: &Path) -> Result<(PathBuf, Option<PathBuf>, Option<PathBuf>, Option<PathBuf>), String> {
    let extracted_exe = find_path_recursively(extract_dir, &|path| {
        path.is_file() && path.file_name().and_then(|x| x.to_str()) == Some("roosycozy.exe")
    })
    .ok_or_else(|| "업데이트 압축 파일 안에 roosycozy.exe가 없어요.".to_string())?;

    let extracted_support_dir = find_path_recursively(extract_dir, &|path| {
        path.is_dir() && path.file_name().and_then(|x| x.to_str()) == Some(WINDOWS_BUNDLE_SUPPORT_DIR_NAME)
    })
    .or_else(|| {
        find_path_recursively(extract_dir, &|path| {
            path.is_dir() && path.file_name().and_then(|x| x.to_str()) == Some("sidecar")
        })
        .and_then(|sidecar| sidecar.parent().map(|parent| parent.to_path_buf()))
    });

    let Some(extracted_support_dir) = extracted_support_dir else {
        return Ok((extracted_exe, None, None, None));
    };

    let extracted_sidecar = extracted_support_dir.join("sidecar");
    let extracted_sidecar = if extracted_sidecar.exists() {
        for required in windows_sidecar_required_files() {
            if !extracted_sidecar.join(required).exists() {
                return Err(format!(
                    "업데이트 압축 파일 안에 필요한 sidecar 파일이 빠져 있어요: {}",
                    required
                ));
            }
        }
        Some(extracted_sidecar)
    } else {
        None
    };

    let extracted_resources = extracted_support_dir.join("resources");
    let extracted_resources = if extracted_resources.exists() {
        Some(extracted_resources)
    } else {
        None
    };

    Ok((extracted_exe, extracted_sidecar, extracted_resources, Some(extracted_support_dir)))
}

#[cfg(target_os = "windows")]
fn apply_portable_release_update(
    app: &AppHandle,
    asset_url: &str,
    current_exe: &Path,
    replace_exe: bool,
) -> Result<(), String> {
    let temp_root = std::env::temp_dir().join(format!("roosycozy-update-{}", std::process::id()));
    if temp_root.exists() {
        let _ = fs::remove_dir_all(&temp_root);
    }
    fs::create_dir_all(&temp_root).map_err(|e| format!("임시 업데이트 폴더를 만들지 못했어요: {}", e))?;
    let zip_path = temp_root.join("release.zip");
    let extract_dir = temp_root.join("release");

    download_release_zip(asset_url, &zip_path)?;
    extract_release_zip(&zip_path, &extract_dir)?;

    let sidecar_dir = windows_sidecar_storage_dir(app)?;
    let resources_dir = windows_resources_storage_dir(app)?;
    fs::create_dir_all(&sidecar_dir).map_err(|e| format!("AppData sidecar 폴더를 만들지 못했어요: {}", e))?;
    fs::create_dir_all(&resources_dir).map_err(|e| format!("AppData resources 폴더를 만들지 못했어요: {}", e))?;

    let (extracted_exe, extracted_sidecar, extracted_resources, _) = validate_extracted_release(&extract_dir)?;

    if let Some(extracted_sidecar) = extracted_sidecar.as_ref() {
        copy_dir_recursive(extracted_sidecar, &sidecar_dir)?;
    }

    if let Some(extracted_resources) = extracted_resources.as_ref() {
        copy_dir_recursive(extracted_resources, &resources_dir)?;
    }

    if replace_exe {
        let install_dir = current_exe
            .parent()
            .ok_or_else(|| "현재 실행 파일 폴더를 찾지 못했어요.".to_string())?;
        let staged_exe = install_dir.join("roosycozy.exe.new");
        if staged_exe.exists() {
            let _ = fs::remove_file(&staged_exe);
        }
        fs::copy(&extracted_exe, &staged_exe).map_err(|e| format!("새 실행 파일을 준비하지 못했어요: {}", e))?;
        let _ = fs::remove_dir_all(&temp_root);
        schedule_windows_exe_swap(current_exe, &staged_exe)?;
    } else {
        let _ = fs::remove_dir_all(&temp_root);
    }

    Ok(())
}

#[command]
fn check_and_update(app: AppHandle) -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Ok("윈도우에서만 자동 업데이트를 지원합니다.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
  ensure_windows_runtime_cache(&app)?;

        let app_version = app.package_info().version.to_string();
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("현재 실행 파일 경로를 읽지 못했어요: {}", e))?;
        let needs_repair = windows_install_needs_repair(&app);

        let latest = latest_github_release()?;
        let latest_version = normalize_release_version(&latest.tag_name);
        let asset = latest
            .assets
            .iter()
            .find(|item| item.name == UPDATE_ASSET_NAME)
            .ok_or_else(|| format!("릴리즈 자산에서 {} 파일을 찾지 못했어요.", UPDATE_ASSET_NAME))?;

        if parse_version_triplet(&app_version) >= parse_version_triplet(&latest_version) && !needs_repair {
            Ok("최신 버전입니다.".to_string())
        } else {
            let replace_exe = parse_version_triplet(&app_version) < parse_version_triplet(&latest_version);
            apply_portable_release_update(
                &app,
                &asset.browser_download_url,
                &current_exe,
                replace_exe,
            )?;
            ensure_windows_runtime_cache(&app)?;

            if replace_exe {
                Ok(format!(
                    "업데이트 완료: 버전 {}. 앱을 종료하면 새 버전과 sidecar가 함께 적용됩니다.",
                    latest_version
                ))
            } else {
                Ok("프로그램 파일을 복구했어요. sidecar를 다시 채워 넣었으니 지금 바로 AI 채팅을 다시 시도해보세요.".to_string())
            }
        }
    }
}

fn cleanup_old_versions() {
    if let Ok(current_exe) = std::env::current_exe() {
        let old_exe = current_exe.with_extension("exe.old");
        if old_exe.exists() {
            let _ = fs::remove_file(old_exe);
        }
    }
}

#[cfg(target_os = "windows")]
fn roosycozy_program_data_root() -> Result<std::path::PathBuf, String> {
  let base = std::env::var_os("PROGRAMDATA")
    .map(std::path::PathBuf::from)
    .or_else(|| dirs::data_dir())
    .ok_or_else(|| "ProgramData 경로를 찾지 못했어요.".to_string())?;
  Ok(base.join("co.roosycozy.app"))
}

#[cfg(target_os = "windows")]
fn roosycozy_program_data_path(child: &str) -> Result<std::path::PathBuf, String> {
  Ok(roosycozy_program_data_root()?.join(child))
}

#[cfg(target_os = "windows")]
fn configure_windows_program_data_env() {
  if let Ok(root) = roosycozy_program_data_root() {
    let _ = std::fs::create_dir_all(&root);
    let updates_root = root.join("updates");
    let temp_root = updates_root.join("temp");
    let _ = std::fs::create_dir_all(&updates_root);
    let _ = std::fs::create_dir_all(&temp_root);
    std::env::set_var("ROOSYCOZY_SHARED_ROOT", &root);
    std::env::set_var("ROOSYCOZY_UPDATES_ROOT", &updates_root);
    std::env::set_var("TMP", &temp_root);
    std::env::set_var("TEMP", &temp_root);
    std::env::set_var("TMPDIR", &temp_root);
    if let Some(parent) = root.parent() {
      std::env::set_var("APPDATA", parent);
      std::env::set_var("LOCALAPPDATA", parent);
    }
  }
}

fn main() {
  #[cfg(target_os = "windows")]
  configure_windows_program_data_env();
    cleanup_old_versions();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = _app.get_webview_window("main") {
                let _ = window.set_decorations(false);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::engine_rank,
            commands::engine_advise,
            commands::engine_classify_risk,
            commands::strategy_agent_chat,
            commands::strategy_model_status,
      commands::start_strategy_model_download,
      commands::download_strategy_models,
            commands::get_device_signer_info,
            commands::sign_integrity_payload,
            commands::verify_integrity_payload,
            commands::export_case_pdf,
            commands::export_backup_json,
            commands::import_backup_json,
            check_and_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
