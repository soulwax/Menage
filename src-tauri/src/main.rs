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
///
/// Spawn retries: Menage points at a LIVE repo — a `cargo build` racing in the
/// game workspace unlinks `sprite_cutter.exe` for a moment, and a click landing
/// in that window would fail with "file not found" even though nothing is
/// wrong. A NotFound spawn is retried briefly before it is reported.
fn run_cli(bin: &str, game_root: &str, args: &[&str]) -> Result<String, String> {
    let mut last_err = None;
    let mut output = None;
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
        match Command::new(bin).args(args).current_dir(game_root).output() {
            Ok(out) => {
                output = Some(out);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => last_err = Some(e),
            Err(e) => {
                return Err(format!(
                    "could not run `{bin}` (set MENAGE_*_BIN or add it to PATH): {e}"
                ))
            }
        }
    }
    let Some(output) = output else {
        let e = last_err.expect("NotFound recorded on every failed attempt");
        return Err(format!(
            "could not run `{bin}` after 3 tries (set MENAGE_*_BIN or add it to PATH; \
             if the game repo is mid-build, wait for cargo to finish): {e}"
        ));
    };

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

// The command fns above are plain functions; these tests exercise them the
// way the webview does — including the real `sprite_cutter` binary when the
// game repo has one built (tests skip gracefully when it is absent, matching
// the family's graceful-degradation rule).
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// tools/menage/src-tauri → the EchoWarrior repo root.
    fn game_root() -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .expect("game root exists")
            .to_string_lossy()
            .into_owned()
    }

    fn cutter_exe(root: &str) -> Option<String> {
        let path = Path::new(root).join("target/debug/sprite_cutter.exe");
        let unix = Path::new(root).join("target/debug/sprite_cutter");
        if path.exists() {
            Some(path.to_string_lossy().into_owned())
        } else if unix.exists() {
            Some(unix.to_string_lossy().into_owned())
        } else {
            None
        }
    }

    const VALID_METADATA: &str = r#"
[[sheets]]
id = "player_test"
path = "Assets/Graphics/sprites/characters/player.png"
kind = "character"
frame_width = 48
frame_height = 48
columns = 6
rows = 10
output_dir = "Generated/Sprites/characters/player_test"

[[sheets.animations]]
name = "idle_down"
row = 0
start_column = 0
frame_count = 6
fps = 8
flip_x = false
"#;

    #[test]
    fn resolve_refuses_empty_root() {
        assert!(resolve("", "Assets/x.toml").is_err());
        assert!(resolve("   ", "Assets/x.toml").is_err());
    }

    #[test]
    fn read_write_and_base64_roundtrip() {
        let dir = std::env::temp_dir().join("menage-shell-test");
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_string_lossy().into_owned();

        write_text_file(root.clone(), "roundtrip.txt".into(), "grüße 🗡".into()).unwrap();
        let text = read_text_file(root.clone(), "roundtrip.txt".into()).unwrap();
        assert_eq!(text, "grüße 🗡");

        let b64 = read_file_base64(root.clone(), "roundtrip.txt".into()).unwrap();
        assert!(!b64.is_empty() && !b64.contains(' '));
        assert!(read_text_file(root, "missing.txt".into()).is_err());
    }

    #[test]
    fn list_files_returns_sorted_json_of_matching_ext() {
        let root = game_root();
        let json = list_files(root, "Assets/Metadata".into(), "toml".into()).unwrap();
        assert!(json.starts_with('[') && json.ends_with(']'));
        assert!(json.contains("Assets/Metadata/portraits_6.toml"));
        assert!(json.contains("Assets/Metadata/spritesheets.toml"));
        assert!(!json.contains(".md")); // reference notes filtered out
    }

    #[test]
    fn dry_run_validates_temp_metadata_without_touching_the_repo() {
        let root = game_root();
        let Some(cutter) = cutter_exe(&root) else {
            eprintln!("skipping: build sprite_cutter in the game repo first");
            return;
        };
        std::env::set_var("MENAGE_SPRITE_CUTTER_BIN", &cutter);

        let report =
            cutter_dry_run(root.clone(), None, Some(VALID_METADATA.into())).expect("valid metadata passes");
        assert!(report.contains("would cut"), "unexpected report: {report}");

        // The cutter's own validation is the authority: a grid that disagrees
        // with the real image must be rejected.
        let bad = VALID_METADATA.replace("columns = 6", "columns = 7");
        let err = cutter_dry_run(root, None, Some(bad)).expect_err("bad metadata fails");
        assert!(err.contains("expected"), "unexpected error: {err}");
    }
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
