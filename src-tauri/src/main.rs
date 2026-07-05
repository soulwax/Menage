// Menage — the thin Tauri shell.
//
// The app's only coupling to the game is `spritesheets.toml` plus two CLIs:
// `sprite_cutter` (validate + cut) and `asset_pack` (ship audit). These
// commands are the single place they are reached; the web UI calls them via
// `invoke` and never spawns processes or knows the CLIs' argument shapes.
//
// Finding the binaries: `MENAGE_SPRITE_CUTTER_BIN` / `MENAGE_ASSET_PACK_BIN`
// env vars if set, else `sprite_cutter` / `asset_pack` on PATH. Every run uses
// the game repo root as its working directory, because the instruction file
// refers to images by repo-relative paths.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use base64::Engine;
use std::path::{Path, PathBuf};
use std::process::Command;

fn cutter_bin() -> String {
    std::env::var("MENAGE_SPRITE_CUTTER_BIN").unwrap_or_else(|_| "sprite_cutter".to_string())
}

fn asset_pack_bin() -> String {
    std::env::var("MENAGE_ASSET_PACK_BIN").unwrap_or_else(|_| "asset_pack".to_string())
}

/// Run a CLI in the game root; return stdout on success (stderr as fallback),
/// or a combined error string so the UI can show the findings verbatim.
fn run_cli(bin: &str, game_root: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(bin)
        .args(args)
        .current_dir(game_root)
        .output()
        .map_err(|e| format!("could not run `{bin}` (set MENAGE_*_BIN or add it to PATH): {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if output.status.success() {
        if stdout.trim().is_empty() {
            Ok(stderr)
        } else {
            Ok(stdout)
        }
    } else {
        let mut msg = stderr;
        if !stdout.trim().is_empty() {
            msg.push_str(&stdout);
        }
        if msg.trim().is_empty() {
            msg = format!("`{bin}` exited with {}", output.status);
        }
        Err(msg)
    }
}

/// A unique temp path for validating unsaved metadata without touching the repo.
fn temp_metadata_path() -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("menage-metadata-{nanos}.toml"))
}

fn resolve(game_root: &str, rel: &str) -> Result<PathBuf, String> {
    if game_root.trim().is_empty() {
        return Err("no game repo configured (set MENAGE_GAME_ROOT or pick a folder)".to_string());
    }
    Ok(Path::new(game_root).join(rel))
}

#[tauri::command]
fn default_game_root() -> String {
    std::env::var("MENAGE_GAME_ROOT").unwrap_or_default()
}

#[tauri::command]
fn read_text_file(game_root: String, rel: String) -> Result<String, String> {
    let path = resolve(&game_root, &rel)?;
    std::fs::read_to_string(&path).map_err(|e| format!("cannot read '{}': {e}", path.display()))
}

#[tauri::command]
fn write_text_file(game_root: String, rel: String, contents: String) -> Result<String, String> {
    let path = resolve(&game_root, &rel)?;
    std::fs::write(&path, contents).map_err(|e| format!("cannot write '{}': {e}", path.display()))?;
    Ok(format!("wrote {}", path.display()))
}

#[tauri::command]
fn read_file_base64(game_root: String, rel: String) -> Result<String, String> {
    let path = resolve(&game_root, &rel)?;
    let bytes =
        std::fs::read(&path).map_err(|e| format!("cannot read '{}': {e}", path.display()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// JSON array of repo-relative paths with extension `ext` under `rel_dir`,
/// recursive, sorted. Hand-rolled JSON to keep the shell serde-free (the
/// family convention).
#[tauri::command]
fn list_files(game_root: String, rel_dir: String, ext: String) -> Result<String, String> {
    fn walk(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, ext, out);
            } else if path
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case(ext))
            {
                out.push(path);
            }
        }
    }

    let root = Path::new(&game_root);
    let mut found = Vec::new();
    walk(
        &resolve(&game_root, &rel_dir)?,
        ext.trim_start_matches('.'),
        &mut found,
    );
    let mut rels: Vec<String> = found
        .iter()
        .filter_map(|p| p.strip_prefix(root).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect();
    rels.sort();
    let items: Vec<String> = rels
        .iter()
        .map(|p| format!("\"{}\"", p.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    Ok(format!("[{}]", items.join(",")))
}

/// `sprite_cutter --dry-run`. When `metadata` text is given, it is written to a
/// temp file and validated via `--metadata`, so unsaved instructions can be
/// checked before they ever touch the repo.
#[tauri::command]
fn cutter_dry_run(
    game_root: String,
    sheet: Option<String>,
    metadata: Option<String>,
) -> Result<String, String> {
    let mut args: Vec<String> = vec!["--dry-run".into()];
    match &sheet {
        Some(id) => {
            args.push("--sheet".into());
            args.push(id.clone());
        }
        None => args.push("--all".into()),
    }

    let temp = metadata.map(|contents| {
        let path = temp_metadata_path();
        std::fs::write(&path, contents).map(|()| path)
    });
    if let Some(temp) = &temp {
        match temp {
            Ok(path) => {
                args.push("--metadata".into());
                args.push(path.to_string_lossy().into_owned());
            }
            Err(e) => return Err(format!("cannot stage temp metadata: {e}")),
        }
    }

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = run_cli(&cutter_bin(), &game_root, &arg_refs);
    if let Some(Ok(path)) = temp {
        let _ = std::fs::remove_file(path);
    }
    result
}

/// The real cut. Always reads the SAVED metadata so what you cut is what the
/// repo holds — the UI blocks this while the document is dirty.
#[tauri::command]
fn cutter_cut(game_root: String, sheet: Option<String>) -> Result<String, String> {
    let args: Vec<String> = match &sheet {
        Some(id) => vec!["--sheet".into(), id.clone()],
        None => vec!["--all".into()],
    };
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_cli(&cutter_bin(), &game_root, &arg_refs)
}

#[tauri::command]
fn asset_pack_list(game_root: String) -> Result<String, String> {
    run_cli(&asset_pack_bin(), &game_root, &["--dry-run", "--list"])
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            default_game_root,
            read_text_file,
            write_text_file,
            read_file_base64,
            list_files,
            cutter_dry_run,
            cutter_cut,
            asset_pack_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running menage");
}
