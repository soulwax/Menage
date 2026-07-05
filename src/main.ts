// Menage — app shell. Owns startup, selection, the image cache, and the
// toolbar actions; everything else lives in its module: instructions (model),
// doc (edit state), bridge (Tauri/CLI), stage (canvases), form (inspector),
// atlas (end-product math), inventory (audit).

import { MenageDoc } from "./doc";
import { lint, isSaveable, type Finding, type ImageSizes } from "./instructions";
import { planSheet, type AnimationPlan } from "./atlas";
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
let activeTab: "stage" | "atlas" = "stage";
let zoom: Zoom = "fit";
let unregistered: string[] = [];

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
  return doc.instructions.sheets.find((s) => s.id === selection!.id) ?? null;
}

function selectedTileset() {
  if (selection?.type !== "tileset") return null;
  return doc.instructions.tilesets.find((t) => t.id === selection!.id) ?? null;
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

function select(next: Selection): void {
  selection = next;
  selectedAnimation = null;
  stage.selectedAnimation = null;
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
  el("stage-wrap").classList.toggle("atlas-mode", activeTab === "atlas");
  stage.zoom = zoom;

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

function renderRibbon(): void {
  const findings = currentFindings();
  const chip = el("ribbon-chip");
  const errors = findings.filter((f) => f.level === "error").length;
  const warns = findings.length - errors;
  chip.className = "chip " + (errors > 0 ? "bad" : warns > 0 ? "warn" : "ok");
  chip.textContent = errors > 0 ? `${errors} error(s)` : warns > 0 ? `${warns} warning(s)` : "clean";
  el<HTMLPreElement>("findings").textContent =
    findings.length === 0
      ? "No findings. sprite_cutter --dry-run stays the authority."
      : findings.map((f) => `[${f.level}] ${f.where}: ${f.message}`).join("\n");
}

function renderToolbar(): void {
  el<HTMLButtonElement>("btn-undo").disabled = !doc.canUndo;
  el<HTMLButtonElement>("btn-redo").disabled = !doc.canRedo;
  el<HTMLButtonElement>("btn-cut-sheet").disabled = selection?.type !== "sheet";
  el("doc-name").textContent = (doc.dirty ? "● " : "") + "spritesheets.toml";
  el("game-root").textContent = gameRoot === "" ? "pick game repo…" : gameRoot;
}

function renderAll(): void {
  renderLibrary();
  renderInspector(el("inspector"), doc, selection, selectedAnimation, {
    onSelectAnimation: (name) => selectAnimation(name),
    onDeleteEntry: () => {
      if (!selection) return;
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
}

// ---------------------------------------------------------------------------
// actions

function say(text: string): void {
  report.textContent = text;
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
  if (selection && !selectedSheet() && !selectedTileset()) select(null);
  say(`Loaded ${METADATA_REL} — ${doc.instructions.sheets.length} sheets, ${doc.instructions.tilesets.length} tilesets.`);
}

async function scanUnregistered(): Promise<void> {
  const pngs = await bridge.listGamePngs(gameRoot, SCAN_ROOT);
  unregistered = crossReference(doc.instructions, pngs, []).unregistered;
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
    );
    return;
  }
  const serialized = doc.serialize();
  if (await bridge.inTauri()) {
    const dryRun = await bridge.cutterDryRun(gameRoot, null, serialized);
    if (!dryRun.ok) {
      say(`sprite_cutter --dry-run rejected the instructions — nothing written.\n\n${dryRun.output}`);
      return;
    }
  }
  const written = await bridge.writeGameText(gameRoot, METADATA_REL, serialized);
  if (!written.ok) {
    say(`Save failed:\n${written.output}`);
    return;
  }
  doc.markSaved();
  say(`Saved ${METADATA_REL}.`);
}

async function runDryRun(): Promise<void> {
  say("Running sprite_cutter --dry-run on the current (unsaved) instructions…");
  const result = await bridge.cutterDryRun(gameRoot, null, doc.serialize());
  say(result.output);
}

async function runCut(sheetId: string | null): Promise<void> {
  if (doc.dirty) {
    say("Unsaved changes — the cutter reads the saved file. Save to game first.");
    return;
  }
  say(sheetId ? `Cutting sheet '${sheetId}'…` : "Cutting every sheet…");
  const result = await bridge.cutterCut(gameRoot, sheetId);
  say(result.output);
}

async function runAudit(): Promise<void> {
  say("Auditing: scanning PNGs and asking asset_pack what ships…");
  const pngs = await bridge.listGamePngs(gameRoot, SCAN_ROOT);
  const pack = await bridge.assetPackList(gameRoot);
  const packList = pack.ok ? parsePackList(pack.output) : [];
  const audit = crossReference(doc.instructions, pngs, packList);
  unregistered = audit.unregistered;
  renderAll();
  const header = pack.ok ? "" : `asset_pack unavailable — ship status unknown.\n${pack.output}\n\n`;
  say(header + formatAudit(audit, pack.ok));
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

function wire(): void {
  doc.onChange(renderAll);

  stage.onHover = (info) => {
    statusCell.textContent = info
      ? `cell ${info.column},${info.row} · px ${info.frameRect.x},${info.frameRect.y} ${info.frameRect.w}×${info.frameRect.h}` +
        (info.animation ? ` · ${info.animation}` : "")
      : "";
  };
  stage.onPickAnimation = (name) => selectAnimation(name);

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
    for (const b of el("zoom-controls").querySelectorAll("button")) b.classList.remove("active");
    button.classList.add("active");
    const value = button.dataset.zoom ?? "fit";
    zoom = value === "fit" ? "fit" : Number(value);
    renderCenter();
  });

  el("btn-reload").addEventListener("click", () => void loadDoc().then(scanUnregistered));
  el("btn-undo").addEventListener("click", () => doc.undo());
  el("btn-redo").addEventListener("click", () => doc.redo());
  el("btn-save").addEventListener("click", () => void saveToGame());
  el("btn-dry-run").addEventListener("click", () => void runDryRun());
  el("btn-cut-sheet").addEventListener("click", () => {
    if (selection?.type === "sheet") void runCut(selection.id);
  });
  el("btn-cut-all").addEventListener("click", () => void runCut(null));
  el("btn-audit").addEventListener("click", () => void runAudit());
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
}

void start();
