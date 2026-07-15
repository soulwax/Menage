// Typed wrappers over the Tauri bridge commands (src-tauri/src/main.rs).
//
// The app talks to the game ONLY through spritesheets.toml, the sprite_cutter
// CLI, and the asset_pack CLI. This file is the single place those are
// reached; the rest of the app never spawns processes or fetches files.
//
// Two runtimes, one interface:
//  - Inside Tauri: full read/write plus CLI runs.
//  - Plain `vite dev` (web mode): read-only via the dev-server /@game routes;
//    writes and CLI runs report that they need the desktop shell.

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let cachedInvoke: Invoke | null | undefined;

async function getInvoke(): Promise<Invoke | null> {
  if (cachedInvoke !== undefined) return cachedInvoke;
  // Tauri v2 exposes the API as an installed module; import lazily so a pure
  // web `vite dev` still loads the UI. The global marker tells the runtimes apart.
  if (!("__TAURI_INTERNALS__" in window)) {
    cachedInvoke = null;
    return null;
  }
  try {
    const mod = await import("@tauri-apps/api/core");
    cachedInvoke = mod.invoke as Invoke;
  } catch {
    cachedInvoke = null;
  }
  return cachedInvoke;
}

export interface BridgeResult {
  ok: boolean;
  output: string;
}

const NEEDS_TAURI =
  "Not running inside Tauri — this action needs the desktop shell.\n" +
  "Run `npm run tauri:dev` (with sprite_cutter/asset_pack built in the game repo,\n" +
  "or MENAGE_SPRITE_CUTTER_BIN / MENAGE_ASSET_PACK_BIN pointing at them).";

async function call(cmd: string, args: Record<string, unknown>): Promise<BridgeResult> {
  const invoke = await getInvoke();
  if (!invoke) return { ok: false, output: NEEDS_TAURI };
  try {
    return { ok: true, output: await invoke<string>(cmd, args) };
  } catch (e) {
    return { ok: false, output: String(e) };
  }
}

export async function inTauri(): Promise<boolean> {
  return (await getInvoke()) !== null;
}

/** The game repo root this session manages. In Tauri it comes from
 *  MENAGE_GAME_ROOT (falling back to a prompt in the UI); in web mode the dev
 *  server owns the root and this returns the marker "(dev server)". */
export async function defaultGameRoot(): Promise<string> {
  const invoke = await getInvoke();
  if (!invoke) return "(dev server)";
  try {
    return await invoke<string>("default_game_root", {});
  } catch {
    return "";
  }
}

/** Default `universal.key` path for an encrypted `data.pak`, from
 *  MENAGE_ASSET_KEY_PATH. Empty means unset — the audit runs `asset_pack`
 *  without `--key`, exactly as it does today, so unencrypted packs are
 *  unaffected. Menage never reads the key itself; it only tells
 *  `asset_pack` where to look. */
export async function defaultKeyPath(): Promise<string> {
  const invoke = await getInvoke();
  if (!invoke) return "";
  try {
    return await invoke<string>("default_key_path", {});
  } catch {
    return "";
  }
}

/** Read a repo-relative text file. */
export async function readGameText(gameRoot: string, rel: string): Promise<BridgeResult> {
  const invoke = await getInvoke();
  if (!invoke) {
    try {
      const res = await fetch(`/@game/${rel}`);
      if (!res.ok) return { ok: false, output: `HTTP ${res.status} for ${rel}` };
      return { ok: true, output: await res.text() };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  }
  return call("read_text_file", { gameRoot, rel });
}

/** Write a repo-relative text file (Tauri only). */
export function writeGameText(gameRoot: string, rel: string, contents: string): Promise<BridgeResult> {
  return call("write_text_file", { gameRoot, rel, contents });
}

/** A URL suitable for an <img> src for a repo-relative image:
 *  a data: URL inside Tauri, the dev-server route in web mode. */
export async function gameImageUrl(gameRoot: string, rel: string): Promise<string | null> {
  const invoke = await getInvoke();
  if (!invoke) return `/@game/${encodeURI(rel)}`;
  try {
    const b64 = await invoke<string>("read_file_base64", { gameRoot, rel });
    return `data:image/png;base64,${b64}`;
  } catch {
    return null;
  }
}

/** Repo-relative paths of every `.ext` file under `relDir`, recursively. */
export async function listGameFiles(
  gameRoot: string,
  relDir: string,
  ext: string,
): Promise<string[]> {
  const invoke = await getInvoke();
  if (!invoke) {
    try {
      const res = await fetch(
        `/@game-ls?dir=${encodeURIComponent(relDir)}&ext=${encodeURIComponent(ext)}`,
      );
      if (!res.ok) return [];
      const parsed: unknown = await res.json();
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  const r = await call("list_files", { gameRoot, relDir, ext });
  if (!r.ok) return [];
  try {
    const parsed: unknown = JSON.parse(r.output);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** `sprite_cutter --dry-run` — the authoritative check. When `metadata` is
 *  given, the shell validates THAT text (via a temp file) instead of the saved
 *  file, so unsaved instructions can be checked before they ever touch disk. */
export function cutterDryRun(
  gameRoot: string,
  sheetId: string | null,
  metadata: string | null = null,
): Promise<BridgeResult> {
  return call("cutter_dry_run", { gameRoot, sheet: sheetId, metadata });
}

/** The real cut: writes Generated/Sprites/ in the game repo. */
export function cutterCut(gameRoot: string, sheetId: string | null): Promise<BridgeResult> {
  return call("cutter_cut", { gameRoot, sheet: sheetId });
}

/** `asset_pack --dry-run --list` — the ship audit's ground truth. `keyPath`
 *  is the `universal.key` file for an encrypted pack; omit or pass an empty
 *  string for an unencrypted one (the default). */
export function assetPackList(gameRoot: string, keyPath?: string): Promise<BridgeResult> {
  return call("asset_pack_list", { gameRoot, keyPath: keyPath ?? null });
}

/** The game's own validator (`sheets validate --json`) on UNSAVED metadata
 *  text. Returns the parsed findings array, or null when unavailable (web
 *  mode, missing binary) — callers fall back to the client lint. */
export async function sheetsValidateJson(
  gameRoot: string,
  metadata: string,
  images: boolean,
): Promise<Array<{ level: string; where: string; message: string }> | null> {
  const r = await call("sheets_validate_json", { gameRoot, metadata, images });
  if (!r.ok) return null;
  try {
    const parsed: unknown = JSON.parse(r.output);
    return Array.isArray(parsed)
      ? (parsed as Array<{ level: string; where: string; message: string }>)
      : null;
  } catch {
    return null;
  }
}

/** Folder picker (Tauri only); null when unavailable or cancelled. */
export async function pickGameRoot(): Promise<string | null> {
  if (!(await inTauri())) return null;
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const picked = await dialog.open({ directory: true, title: "Pick the EchoWarrior repo root" });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

/** File picker for `data.pak`'s `universal.key` (Tauri only); null when
 *  unavailable or cancelled. */
export async function pickKeyPath(): Promise<string | null> {
  if (!(await inTauri())) return null;
  try {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const picked = await dialog.open({
      directory: false,
      multiple: false,
      title: "Pick data.pak's universal.key (leave unset for an unencrypted pack)",
    });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}
