// Menage — app shell. Owns startup, selection, the image cache, and the
// toolbar actions; everything else lives in its module: instructions (model),
// doc (edit state), bridge (Tauri/CLI), stage (canvases), form (inspector),
// atlas (end-product math), inventory (audit).

import { MenageDoc } from "./doc";
import { lint, isSaveable, type Finding, type ImageSizes } from "./instructions";
import { planSheet, type AnimationPlan } from "./atlas";
import { atlasStem, lintAtlas, parseAtlasFile, type AtlasFile } from "./atlasfile";
import { Stage, sheetGrid, drawContactSheet, contactSheetHit, type Zoom } from "./stage";
import { Loupe } from "./loupe";
import { renderInspector, type Selection } from "./form";
import { crossReference, formatAudit, parsePackList } from "./inventory";
import * as bridge from "./bridge";

const METADATA_REL = "Assets/Metadata/spritesheets.toml";
const SCAN_ROOT = "Assets/Graphics/sprites";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

const doc = new MenageDoc();
let gameRoot = "";
let selection: Selection = null;
let selectedAnimation: string | null = null;
let selectedSprite: string | null = null;
let activeTab: "stage" | "atlas" = "stage";
let zoom: Zoom = "fit";
let unregistered: string[] = [];
let atlases: AtlasFile[] = [];
/** Findings from the game's `sheets validate --json` (✓ Check). Cleared on
 *  every edit or selection change — they describe a moment, not live state. */
let checkFindings: Finding[] | null = null;
let busy = false;

const CLI_BUTTON_IDS = ["btn-dry-run", "btn-cut-sheet", "btn-cut-all", "btn-audit", "btn-save", "btn-check"];
const ZOOM_STEPS: number[] = [0.5, 1, 2, 3, 4, 6, 8];

const images = new Map<string, HTMLImageElement | "missing">();
const imageSizes: ImageSizes = new Map();

const stage = new Stage(el<HTMLCanvasElement>("stage"), el("stage-wrap"));
const atlasCanvas = el<HTMLCanvasElement>("atlas");
const loupe = new Loupe(el<HTMLCanvasElement>("loupe"), el("loupe-label"), el<HTMLButtonElement>("btn-play"));
const report = el<HTMLPreElement>("report");
const statusCell = el("status-cell");

// ---------------------------------------------------------------------------
// image cache

async function ensureImage(path: string): Promise<HTMLImageElement | null> {
  const cached = images.get(path);
  if (cached === "missing") return null;
  if (cached) return cached;
  const url = await bridge.gameImageUrl(gameRoot, path);
  if (!url) {
    images.set(path, "missing");
    return null;
  }
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      images.set(path, image);
      imageSizes.set(path, { width: image.naturalWidth, height: image.naturalHeight });
      renderAll();
      resolve(image);
    };
    image.onerror = () => {
      images.set(path, "missing");
      renderAll();
      resolve(null);
    };
    image.src = url;
  });
}

function cachedImage(path: string): HTMLImageElement | null {
  const cached = images.get(path);
  if (cached && cached !== "missing") return cached;
  if (!cached) void ensureImage(path);
  return null;
}

// ---------------------------------------------------------------------------
// selection helpers

function selectedSheet() {
  if (selection?.type !== "sheet") return null;
  const current = selection;
  return doc.instructions.sheets.find((s) => s.id === current.id) ?? null;
}

function selectedTileset() {
  if (selection?.type !== "tileset") return null;
  const current = selection;
  return doc.instructions.tilesets.find((t) => t.id === current.id) ?? null;
}

function selectedAtlas(): AtlasFile | null {
  if (selection?.type !== "atlasfile") return null;
  const current = selection;
  return atlases.find((a) => a.path === current.path) ?? null;
}

function selectedPlans(): AnimationPlan[] {
  const sheet = selectedSheet();
  return sheet ? planSheet(sheet) : [];
}

function selectAnimation(name: string | null): void {
  selectedAnimation = name;
  stage.selectedAnimation = name;
  const sheet = selectedSheet();
  const plan = name ? selectedPlans().find((p) => p.name === name) ?? null : null;
  loupe.setAnimation(sheet ? cachedImage(sheet.path) : null, plan);
  renderAll();
}

/** Selecting an atlas sprite highlights its rect and shows a still crop in
 *  the loupe (a one-frame "animation" — same plumbing, no special case). */
function selectSprite(name: string | null): void {
  selectedSprite = name;
  stage.selectedSprite = name;
  const atlas = selectedAtlas();
  const sprite = atlas?.sprites.find((s) => s.name === name) ?? null;
  loupe.setAnimation(
    atlas && sprite ? cachedImage(atlas.image) : null,
    atlas && sprite
      ? {
          name: sprite.name,
          fps: 1,
          dir: atlas.path,
          frames: [
            {
              sx: sprite.rect.x,
              sy: sprite.rect.y,
              w: sprite.rect.w,
              h: sprite.rect.h,
              flipX: false,
              filename: sprite.name,
            },
          ],
          manifestToml: "",
        }
      : null,
  );
  renderAll();
}

function select(next: Selection): void {
  selection = next;
  selectedAnimation = null;
  selectedSprite = null;
  checkFindings = null;
  stage.selectedAnimation = null;
  stage.selectedSprite = null;
  loupe.setAnimation(null, null);
  renderAll();
}

// ---------------------------------------------------------------------------
// rendering

function renderLibrary(): void {
  const sheetList = el("sheet-list");
  const tilesetList = el("tileset-list");
  const unregList = el("unregistered-list");
  sheetList.textContent = "";
  tilesetList.textContent = "";
  unregList.textContent = "";

  for (const sheet of doc.instructions.sheets) {
    const li = document.createElement("li");
    li.textContent = sheet.id;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${sheet.columns}×${sheet.rows} @ ${sheet.frame_width}px`;
    li.append(meta);
    if (selection?.type === "sheet" && selection.id === sheet.id) li.classList.add("selected");
    li.addEventListener("click", () => select({ type: "sheet", id: sheet.id }));
    sheetList.append(li);
  }
  for (const tileset of doc.instructions.tilesets) {
    const li = document.createElement("li");
    li.textContent = tileset.id;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${tileset.columns}×${tileset.rows} @ ${tileset.tile_width}px`;
    li.append(meta);
    if (selection?.type === "tileset" && selection.id === tileset.id) li.classList.add("selected");
    li.addEventListener("click", () => select({ type: "tileset", id: tileset.id }));
    tilesetList.append(li);
  }
  const atlasList = el("atlas-list");
  atlasList.textContent = "";
  for (const atlas of atlases) {
    const li = document.createElement("li");
    li.textContent = atlasStem(atlas.path);
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${atlas.kind} · ${atlas.sprites.length}`;
    li.append(meta);
    if (selection?.type === "atlasfile" && selection.path === atlas.path) li.classList.add("selected");
    li.addEventListener("click", () => select({ type: "atlasfile", path: atlas.path }));
    atlasList.append(li);
  }
  el("atlas-count").textContent = String(atlases.length);

  for (const path of unregistered) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "unreg-path";
    name.textContent = path.replace(`${SCAN_ROOT}/`, "");
    name.title = path;
    const registerButton = document.createElement("button");
    registerButton.className = "mini ghost";
    registerButton.textContent = "+ register";
    registerButton.addEventListener("click", () => void registerPng(path));
    li.append(name, registerButton);
    unregList.append(li);
  }

  el("lib-count").textContent =
    `${doc.instructions.sheets.length} sheets · ${doc.instructions.tilesets.length} tilesets`;
}

function renderCenter(): void {
  const sheet = selectedSheet();
  const tileset = selectedTileset();
  const atlas = selectedAtlas();
  el("stage-wrap").classList.toggle("atlas-mode", activeTab === "atlas" && !atlas);
  stage.zoom = zoom;

  // Descriptors have no "end product" (nothing gets cut) — the stage IS the view.
  el<HTMLButtonElement>("tab-atlas").toggleAttribute("disabled", atlas !== null);
  if (atlas) {
    el<HTMLCanvasElement>("stage").classList.remove("hidden");
    atlasCanvas.classList.add("hidden");
    stage.setAtlas(cachedImage(atlas.image), atlas);
    return;
  }

  if (activeTab === "atlas") {
    el<HTMLCanvasElement>("stage").classList.add("hidden");
    atlasCanvas.classList.remove("hidden");
    const plans = selectedPlans();
    const scale = zoom === "fit" ? 2 : zoom;
    drawContactSheet(atlasCanvas, sheet ? cachedImage(sheet.path) : null, plans, scale);
    return;
  }

  el<HTMLCanvasElement>("stage").classList.remove("hidden");
  atlasCanvas.classList.add("hidden");
  if (sheet) {
    stage.setSheet(cachedImage(sheet.path), sheetGrid(sheet));
  } else if (tileset) {
    stage.setSheet(cachedImage(tileset.path), {
      frameW: tileset.tile_width,
      frameH: tileset.tile_height,
      columns: tileset.columns,
      rows: tileset.rows,
      animations: [],
    });
  } else {
    stage.setSheet(null, null);
  }
}

function currentFindings(): Finding[] {
  const missing = new Set(
    [...images.entries()].filter(([, v]) => v === "missing").map(([path]) => path),
  );
  return lint(doc.instructions, imageSizes.size > 0 ? imageSizes : undefined, missing);
}

/** Jump to the entry a finding points at (and its animation, when named). */
function jumpToFinding(target: NonNullable<Finding["target"]>): void {
  const exists =
    target.type === "sheet"
      ? doc.instructions.sheets.some((s) => s.id === target.id)
      : doc.instructions.tilesets.some((t) => t.id === target.id);
  if (!exists) return;
  const keep = checkFindings;
  select({ type: target.type, id: target.id });
  checkFindings = keep; // jumping around findings must not dismiss them
  if (target.animation) selectAnimation(target.animation);
  else renderAll();
}

function renderFindingsList(findings: Finding[], emptyText: string): void {
  const host = el("findings");
  host.textContent = "";
  if (findings.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = emptyText;
    host.append(p);
    return;
  }
  for (const finding of findings) {
    const row = document.createElement("button");
    row.className = `finding ${finding.level}`;
    const where = document.createElement("span");
    where.className = "finding-where";
    where.textContent = finding.where;
    const message = document.createElement("span");
    message.className = "finding-message";
    message.textContent = finding.message;
    row.append(where, message);
    if (finding.target) {
      const target = finding.target;
      row.title = "Jump to it";
      row.addEventListener("click", () => jumpToFinding(target));
    } else {
      row.disabled = true;
    }
    host.append(row);
  }
}

function renderRibbon(): void {
  const atlas = selectedAtlas();
  const findings = atlas
    ? checkFindings ?? lintAtlas(atlas, imageSizes.get(atlas.image))
    : checkFindings ?? currentFindings();
  const chip = el("ribbon-chip");
  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.length - errors;
  chip.className = "chip " + (errors > 0 ? "bad" : warns > 0 ? "warn" : "ok");
  chip.textContent = errors > 0 ? `${errors} error(s)` : warns > 0 ? `${warns} warning(s)` : "clean";
  el("ribbon-source").textContent = checkFindings ? "game validator" : "live lint";
  renderFindingsList(
    findings,
    checkFindings
      ? "The game's validator found nothing. Ship it."
      : "No findings. ✓ Check runs the game's own validator.",
  );
}

function renderToolbar(): void {
  el<HTMLButtonElement>("btn-undo").disabled = busy || !doc.canUndo;
  el<HTMLButtonElement>("btn-redo").disabled = busy || !doc.canRedo;
  el<HTMLButtonElement>("btn-cut-sheet").disabled = busy || selection?.type !== "sheet";
  el<HTMLButtonElement>("btn-save").disabled = busy || !doc.dirty;
  el("doc-name").textContent = (doc.dirty ? "● " : "") + "spritesheets.toml";
  el("game-root").textContent = gameRoot === "" ? "pick game repo…" : gameRoot;
}

/** Rebuilding the inspector must not steal the keyboard: remember which input
 *  held focus (and the caret) and give it back after the render. */
function captureFocus(): { key: string; caret: number | null } | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.dataset.focusKey) return null;
  let caret: number | null = null;
  if (active instanceof HTMLInputElement && active.type === "text") {
    caret = active.selectionStart;
  }
  return { key: active.dataset.focusKey, caret };
}

function restoreFocus(saved: { key: string; caret: number | null } | null): void {
  if (!saved) return;
  const input = document.querySelector<HTMLElement>(`[data-focus-key="${saved.key}"]`);
  if (!input) return;
  input.focus();
  if (saved.caret !== null && input instanceof HTMLInputElement) {
    try {
      input.setSelectionRange(saved.caret, saved.caret);
    } catch {
      // number inputs reject selection ranges in some engines — focus suffices
    }
  }
}

function renderAll(): void {
  const focus = captureFocus();
  renderLibrary();
  renderInspector(el("inspector"), doc, selection, selectedAnimation, selectedAtlas(), selectedSprite, {
    onSelectAnimation: (name) => selectAnimation(name),
    onSelectSprite: (name) => selectSprite(name),
    onRename: (newId) => {
      if (selection?.type !== "sheet" && selection?.type !== "tileset") return;
      const current = selection;
      if (newId === "" || newId === current.id) return;
      // Selection first, mutation second: the doc's change notification then
      // re-renders once, already pointing at the renamed entry.
      selection = { type: current.type, id: newId };
      doc.apply((instructions) => {
        if (current.type === "sheet") {
          const sheet = instructions.sheets.find((s) => s.id === current.id);
          if (sheet) sheet.id = newId;
        } else {
          const tileset = instructions.tilesets.find((t) => t.id === current.id);
          if (tileset) tileset.id = newId;
        }
      });
    },
    onDeleteEntry: () => {
      if (selection?.type !== "sheet" && selection?.type !== "tileset") return;
      const current = selection;
      doc.apply((instructions) => {
        if (current.type === "sheet")
          instructions.sheets = instructions.sheets.filter((s) => s.id !== current.id);
        else instructions.tilesets = instructions.tilesets.filter((t) => t.id !== current.id);
      });
      select(null);
    },
  });
  renderCenter();
  renderRibbon();
  renderToolbar();
  restoreFocus(focus);
}

// ---------------------------------------------------------------------------
// actions

/** Report panel text with a tone: "run" (in flight), "ok", "fail", or plain. */
function say(text: string, tone: "run" | "ok" | "fail" | "" = ""): void {
  report.textContent = text;
  report.dataset.tone = tone;
}

/** One CLI action at a time: buttons disable, the report shows the run, and
 *  the outcome tints the panel. Prevents double-cuts from impatient clicks. */
async function runExclusive(startMessage: string, action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  for (const id of CLI_BUTTON_IDS) el<HTMLButtonElement>(id).disabled = true;
  say(startMessage, "run");
  try {
    await action();
  } finally {
    busy = false;
    for (const id of CLI_BUTTON_IDS) el<HTMLButtonElement>(id).disabled = false;
    renderToolbar();
  }
}

async function loadDoc(): Promise<void> {
  const result = await bridge.readGameText(gameRoot, METADATA_REL);
  if (!result.ok) {
    say(`Could not read ${METADATA_REL}:\n${result.output}`);
    return;
  }
  try {
    doc.load(result.output);
  } catch (e) {
    say(`Malformed TOML in ${METADATA_REL}:\n${String(e)}`);
    return;
  }
  // Selection may be stale after a reload (or point at a renamed id).
  if (
    (selection?.type === "sheet" || selection?.type === "tileset") &&
    !selectedSheet() &&
    !selectedTileset()
  )
    select(null);
  say(`Loaded ${METADATA_REL} — ${doc.instructions.sheets.length} sheets, ${doc.instructions.tilesets.length} tilesets.`);
}

async function scanUnregistered(): Promise<void> {
  const pngs = await bridge.listGameFiles(gameRoot, SCAN_ROOT, "png");
  unregistered = crossReference(doc.instructions, pngs, []).unregistered;
  renderAll();
}

/** Discover atlas/grid descriptors: every TOML under Assets/Metadata that
 *  parses as one. Non-descriptor TOMLs (spritesheets.toml itself, weather
 *  files, …) simply don't match the schema and are skipped. */
async function scanAtlases(): Promise<void> {
  const paths = await bridge.listGameFiles(gameRoot, "Assets/Metadata", "toml");
  const found = await Promise.all(
    paths.map(async (path) => {
      const text = await bridge.readGameText(gameRoot, path);
      if (!text.ok) return null;
      try {
        return parseAtlasFile(path, text.output);
      } catch {
        return null;
      }
    }),
  );
  atlases = found.filter((a): a is AtlasFile => a !== null);
  renderAll();
}

async function registerPng(path: string): Promise<void> {
  const image = await ensureImage(path);
  const size = imageSizes.get(path) ?? { width: 16, height: 16 };
  const stem = path.split("/").pop()?.replace(/\.png$/i, "") ?? "new_sheet";
  let id = stem.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  while (doc.instructions.sheets.some((s) => s.id === id)) id = `${id}_2`;
  doc.apply((instructions) => {
    instructions.sheets.push({
      id,
      path,
      kind: "object_animation",
      frame_width: size.width,
      frame_height: size.height,
      columns: 1,
      rows: 1,
      output_dir: `Generated/Sprites/objects/${id}`,
      animations: [],
    });
  });
  void image;
  await scanUnregistered();
  select({ type: "sheet", id });
}

async function saveToGame(): Promise<void> {
  const findings = currentFindings();
  if (!isSaveable(findings)) {
    say(
      "Refusing to save — fix the error-level findings first:\n" +
        findings
          .filter((f) => f.level === "error")
          .map((f) => `[error] ${f.where}: ${f.message}`)
          .join("\n"),
      "fail",
    );
    return;
  }
  const serialized = doc.serialize();
  if (await bridge.inTauri()) {
    const dryRun = await bridge.cutterDryRun(gameRoot, null, serialized);
    if (!dryRun.ok) {
      say(
        `sprite_cutter --dry-run rejected the instructions — nothing written.\n\n${dryRun.output}`,
        "fail",
      );
      return;
    }
  }
  const written = await bridge.writeGameText(gameRoot, METADATA_REL, serialized);
  if (!written.ok) {
    say(`Save failed:\n${written.output}`, "fail");
    return;
  }
  doc.markSaved();
  say(`Saved ${METADATA_REL}.`, "ok");
}

async function runDryRun(): Promise<void> {
  const result = await bridge.cutterDryRun(gameRoot, null, doc.serialize());
  say(result.output, result.ok ? "ok" : "fail");
}

async function runCut(sheetId: string | null): Promise<void> {
  const result = await bridge.cutterCut(gameRoot, sheetId);
  say(result.output, result.ok ? "ok" : "fail");
}

async function runAudit(): Promise<void> {
  const pngs = await bridge.listGameFiles(gameRoot, SCAN_ROOT, "png");
  const pack = await bridge.assetPackList(gameRoot);
  const packList = pack.ok ? parsePackList(pack.output) : [];
  const audit = crossReference(doc.instructions, pngs, packList);
  unregistered = audit.unregistered;
  renderAll();
  const header = pack.ok ? "" : `asset_pack unavailable — ship status unknown.\n${pack.output}\n\n`;
  say(header + formatAudit(audit, pack.ok), pack.ok ? "ok" : "fail");
}

/** ✓ Check — the game's own validator (`sheets validate --json --images`) on
 *  the current state: the unsaved instruction doc, or the selected descriptor
 *  file. Results land in the ribbon as clickable findings. */
async function runCheck(): Promise<void> {
  const atlas = selectedAtlas();
  let metadata: string;
  if (atlas) {
    const text = await bridge.readGameText(gameRoot, atlas.path);
    if (!text.ok) {
      say(`Cannot read '${atlas.path}':\n${text.output}`, "fail");
      return;
    }
    metadata = text.output;
  } else {
    metadata = doc.serialize();
  }
  const results = await bridge.sheetsValidateJson(gameRoot, metadata, true);
  if (results === null) {
    say(
      "The game validator needs the desktop shell and the `sheets` CLI.\n" +
        "Build it in the game repo (cargo build --bin sheets), then run inside\n" +
        "Tauri with MENAGE_SHEETS_BIN set or `sheets` on PATH.",
      "fail",
    );
    return;
  }
  checkFindings = results.map((f) => {
    // "player" / "player.idle_down" → a clickable target when the id exists.
    const [id, animation] = f.where.split(".", 2);
    const type = doc.instructions.sheets.some((s) => s.id === id)
      ? ("sheet" as const)
      : doc.instructions.tilesets.some((t) => t.id === id)
        ? ("tileset" as const)
        : null;
    return {
      level: f.level === "error" ? ("error" as const) : ("warn" as const),
      where: f.where,
      message: f.message,
      target: !atlas && type ? { type, id, animation } : undefined,
    };
  });
  renderAll();
  const errors = checkFindings.filter((f) => f.level === "error").length;
  say(
    errors > 0
      ? `The game validator found ${errors} error(s) — see the ribbon.`
      : "The game validator found nothing wrong.",
    errors > 0 ? "fail" : "ok",
  );
}

// ---------------------------------------------------------------------------
// wiring

function addEntry(type: "sheet" | "tileset"): void {
  const base = type === "sheet" ? "new_sheet" : "new_tileset";
  let id = base;
  let n = 2;
  const taken = (candidate: string) =>
    doc.instructions.sheets.some((s) => s.id === candidate) ||
    doc.instructions.tilesets.some((t) => t.id === candidate);
  while (taken(id)) id = `${base}_${n++}`;
  doc.apply((instructions) => {
    if (type === "sheet")
      instructions.sheets.push({
        id,
        path: "",
        kind: "character",
        frame_width: 48,
        frame_height: 48,
        columns: 6,
        rows: 10,
        output_dir: `Generated/Sprites/characters/${id}`,
        animations: [],
      });
    else
      instructions.tilesets.push({ id, path: "", tile_width: 16, tile_height: 16, columns: 1, rows: 1 });
  });
  select({ type, id });
}

/** Wheel zoom steps through ZOOM_STEPS around the current effective scale,
 *  keeping the pixel under the cursor put. */
function wheelZoom(direction: 1 | -1, e: WheelEvent): void {
  const visible = atlasCanvas.classList.contains("hidden")
    ? el<HTMLCanvasElement>("stage")
    : atlasCanvas;
  const oldWidth = visible.width;
  const current =
    zoom !== "fit" ? zoom : visible === atlasCanvas ? 2 : stage.currentScale;
  let nearest = 0;
  ZOOM_STEPS.forEach((step, index) => {
    if (Math.abs(step - current) < Math.abs(ZOOM_STEPS[nearest] - current)) nearest = index;
  });
  const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, nearest + direction))];
  if (next === current) return;
  zoom = next;
  syncZoomButtons();
  renderCenter();
  const factor = visible.width / Math.max(1, oldWidth);
  const wrap = el("stage-wrap");
  const rect = wrap.getBoundingClientRect();
  wrap.scrollLeft = (wrap.scrollLeft + (e.clientX - rect.left)) * factor - (e.clientX - rect.left);
  wrap.scrollTop = (wrap.scrollTop + (e.clientY - rect.top)) * factor - (e.clientY - rect.top);
}

function syncZoomButtons(): void {
  for (const button of el("zoom-controls").querySelectorAll("button")) {
    const value = button.dataset.zoom ?? "fit";
    button.classList.toggle(
      "active",
      zoom === "fit" ? value === "fit" : value === String(zoom),
    );
  }
}

function wire(): void {
  doc.onChange(() => {
    checkFindings = null; // an edit outdates the last ✓ Check snapshot
    // Undo/redo can orphan the selection (e.g. undoing a rename): clear it
    // instead of leaving a blank inspector pointed at a ghost id.
    if (
      (selection?.type === "sheet" && !selectedSheet()) ||
      (selection?.type === "tileset" && !selectedTileset())
    ) {
      selection = null;
      selectedAnimation = null;
      selectedSprite = null;
      stage.selectedAnimation = null;
      stage.selectedSprite = null;
      loupe.setAnimation(null, null);
    }
    renderAll();
  });

  stage.onHover = (info) => {
    if (!info) {
      statusCell.textContent = "";
      return;
    }
    const rect = `px ${info.frameRect.x},${info.frameRect.y} ${info.frameRect.w}×${info.frameRect.h}`;
    statusCell.textContent =
      info.kind === "sprite"
        ? `${info.name} · ${rect}${info.tags.length ? ` · [${info.tags.join(", ")}]` : ""}`
        : `cell ${info.column},${info.row} · ${rect}` + (info.animation ? ` · ${info.animation}` : "");
  };
  stage.onPickAnimation = (name) => selectAnimation(name);
  stage.onPickSprite = (name) => selectSprite(name);
  stage.onWheelZoom = (direction, e) => wheelZoom(direction, e);

  atlasCanvas.addEventListener("mousemove", (e) => {
    const sheet = selectedSheet();
    if (!sheet) return;
    const rect = atlasCanvas.getBoundingClientRect();
    const scale = zoom === "fit" ? 2 : zoom;
    const hit = contactSheetHit(selectedPlans(), scale, e.clientX - rect.left, e.clientY - rect.top);
    statusCell.textContent = hit ? `${hit.dir}/${hit.filename}` : "";
  });

  el("tab-stage").addEventListener("click", () => {
    activeTab = "stage";
    el("tab-stage").classList.add("active");
    el("tab-atlas").classList.remove("active");
    renderCenter();
  });
  el("tab-atlas").addEventListener("click", () => {
    activeTab = "atlas";
    el("tab-atlas").classList.add("active");
    el("tab-stage").classList.remove("active");
    renderCenter();
  });

  el("zoom-controls").addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest("button");
    if (!button) return;
    const value = button.dataset.zoom ?? "fit";
    zoom = value === "fit" ? "fit" : Number(value);
    syncZoomButtons();
    renderCenter();
  });

  el("btn-reload").addEventListener("click", () =>
    void loadDoc().then(scanUnregistered).then(scanAtlases),
  );
  el("btn-undo").addEventListener("click", () => doc.undo());
  el("btn-redo").addEventListener("click", () => doc.redo());
  el("btn-save").addEventListener("click", () =>
    void runExclusive("Validating and saving…", saveToGame),
  );
  el("btn-dry-run").addEventListener("click", () =>
    void runExclusive(
      "Running sprite_cutter --dry-run on the current (unsaved) instructions…",
      runDryRun,
    ),
  );
  el("btn-cut-sheet").addEventListener("click", () => {
    if (selection?.type !== "sheet") return;
    if (doc.dirty) {
      say("Unsaved changes — the cutter reads the saved file. Save to game first.", "fail");
      return;
    }
    const id = selection.id;
    void runExclusive(`Cutting sheet '${id}'…`, () => runCut(id));
  });
  el("btn-cut-all").addEventListener("click", () => {
    if (doc.dirty) {
      say("Unsaved changes — the cutter reads the saved file. Save to game first.", "fail");
      return;
    }
    void runExclusive("Cutting every sheet…", () => runCut(null));
  });
  el("btn-audit").addEventListener("click", () =>
    void runExclusive("Auditing: scanning PNGs and asking asset_pack what ships…", runAudit),
  );
  el("btn-check").addEventListener("click", () =>
    void runExclusive("Asking the game's validator (sheets validate --json --images)…", runCheck),
  );
  el("btn-add-sheet").addEventListener("click", () => addEntry("sheet"));
  el("btn-add-tileset").addEventListener("click", () => addEntry("tileset"));
  el("btn-rescan").addEventListener("click", () => void scanUnregistered());

  el("game-root").addEventListener("click", async () => {
    const picked = await bridge.pickGameRoot();
    if (picked) {
      gameRoot = picked;
      images.clear();
      imageSizes.clear();
      await loadDoc();
      await scanUnregistered();
      await scanAtlases();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      doc.undo();
    } else if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      doc.redo();
    } else if (key === "s") {
      e.preventDefault();
      void saveToGame();
    }
  });

  window.addEventListener("resize", () => renderCenter());
}

async function start(): Promise<void> {
  wire();
  gameRoot = await bridge.defaultGameRoot();
  if ((await bridge.inTauri()) && gameRoot === "") {
    say(
      "No game repo configured.\nClick the path in the toolbar to pick your EchoWarrior root,\nor set MENAGE_GAME_ROOT before launching.",
    );
    renderAll();
    return;
  }
  await loadDoc();
  await scanUnregistered();
  await scanAtlases();
}

void start();
