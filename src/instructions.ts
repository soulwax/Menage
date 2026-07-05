// The cut-instruction model: a faithful TypeScript mirror of
// Assets/Metadata/spritesheets.toml (the game's SpriteMetadata serde structs).
//
// This is the ONE place Menage understands that file's shape. Parsing is
// tolerant (graceful degradation: missing fields get defaults), serialization
// is deterministic (stable field order, sheets then tilesets), and `lint()`
// is advisory — `sprite_cutter --dry-run` remains the authoritative validator.

import { parse as parseToml } from "smol-toml";

export interface AnimationDef {
  name: string;
  row: number;
  start_column: number;
  frame_count: number;
  fps: number;
  flip_x: boolean;
}

export interface SheetDef {
  id: string;
  path: string;
  kind: string;
  frame_width: number;
  frame_height: number;
  columns: number;
  rows: number;
  output_dir: string;
  animations: AnimationDef[];
}

export interface TilesetDef {
  id: string;
  path: string;
  tile_width: number;
  tile_height: number;
  columns: number;
  rows: number;
}

export interface Instructions {
  sheets: SheetDef[];
  tilesets: TilesetDef[];
}

export interface Finding {
  level: "error" | "warn";
  where: string;
  message: string;
}

/** Pixel size of an image on disk, when known. Keys are instruction `path`s. */
export type ImageSizes = Map<string, { width: number; height: number }>;

// ---------------------------------------------------------------------------
// parse

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function toAnimation(raw: Record<string, unknown>): AnimationDef {
  return {
    name: str(raw.name, ""),
    row: num(raw.row, 0),
    start_column: num(raw.start_column, 0),
    frame_count: num(raw.frame_count, 0),
    fps: num(raw.fps, 8),
    flip_x: bool(raw.flip_x, false),
  };
}

function toSheet(raw: Record<string, unknown>): SheetDef {
  const animations = Array.isArray(raw.animations)
    ? raw.animations.map((a) => toAnimation(a as Record<string, unknown>))
    : [];
  return {
    id: str(raw.id, ""),
    path: str(raw.path, ""),
    kind: str(raw.kind, "character"),
    frame_width: num(raw.frame_width, 16),
    frame_height: num(raw.frame_height, 16),
    columns: num(raw.columns, 1),
    rows: num(raw.rows, 1),
    output_dir: str(raw.output_dir, ""),
    animations,
  };
}

function toTileset(raw: Record<string, unknown>): TilesetDef {
  return {
    id: str(raw.id, ""),
    path: str(raw.path, ""),
    tile_width: num(raw.tile_width, 16),
    tile_height: num(raw.tile_height, 16),
    columns: num(raw.columns, 1),
    rows: num(raw.rows, 1),
  };
}

/** Parse spritesheets.toml text. Throws with the TOML error on malformed input;
 *  missing/mistyped fields degrade to defaults instead of failing. */
export function parseInstructions(text: string): Instructions {
  const doc = parseToml(text) as Record<string, unknown>;
  const sheets = Array.isArray(doc.sheets)
    ? doc.sheets.map((s) => toSheet(s as Record<string, unknown>))
    : [];
  const tilesets = Array.isArray(doc.tilesets)
    ? doc.tilesets.map((t) => toTileset(t as Record<string, unknown>))
    : [];
  return { sheets, tilesets };
}

// ---------------------------------------------------------------------------
// serialize

const HEADER = [
  "# File: Assets/Metadata/spritesheets.toml",
  "# EchoWarrior spritesheet metadata — maintained with Menage (tools/menage).",
  "# Coordinates are grid based and frame indexes are zero-based, left-to-right, top-to-bottom.",
  "",
].join("\n");

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Deterministic writer: header comment, every sheet with its animations, then
 *  every tileset. Field order matches the hand-written original so diffs stay
 *  readable. (Free-form comments in the source file are not preserved.) */
export function serializeInstructions(instructions: Instructions): string {
  const parts: string[] = [HEADER];

  for (const sheet of instructions.sheets) {
    parts.push(
      [
        "[[sheets]]",
        `id = ${tomlString(sheet.id)}`,
        `path = ${tomlString(sheet.path)}`,
        `kind = ${tomlString(sheet.kind)}`,
        `frame_width = ${sheet.frame_width}`,
        `frame_height = ${sheet.frame_height}`,
        `columns = ${sheet.columns}`,
        `rows = ${sheet.rows}`,
        `output_dir = ${tomlString(sheet.output_dir)}`,
        "",
      ].join("\n"),
    );
    for (const animation of sheet.animations) {
      parts.push(
        [
          "[[sheets.animations]]",
          `name = ${tomlString(animation.name)}`,
          `row = ${animation.row}`,
          `start_column = ${animation.start_column}`,
          `frame_count = ${animation.frame_count}`,
          `fps = ${animation.fps}`,
          `flip_x = ${animation.flip_x}`,
          "",
        ].join("\n"),
      );
    }
  }

  for (const tileset of instructions.tilesets) {
    parts.push(
      [
        "[[tilesets]]",
        `id = ${tomlString(tileset.id)}`,
        `path = ${tomlString(tileset.path)}`,
        `tile_width = ${tileset.tile_width}`,
        `tile_height = ${tileset.tile_height}`,
        `columns = ${tileset.columns}`,
        `rows = ${tileset.rows}`,
        "",
      ].join("\n"),
    );
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// lint

/** Advisory findings. `sprite_cutter --dry-run` is the authority; this exists
 *  so mistakes surface while typing, not at cut time. When `sizes` has an
 *  entry for a sheet's path, the exact-dimension rule the cutter enforces is
 *  checked too (the cutter refuses any mismatch, larger or smaller).
 *  `missing` lists paths that are KNOWN absent — images that merely have not
 *  been loaded yet are not flagged. */
export function lint(
  instructions: Instructions,
  sizes?: ImageSizes,
  missing?: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  const err = (where: string, message: string) => findings.push({ level: "error", where, message });
  const warn = (where: string, message: string) => findings.push({ level: "warn", where, message });

  const ids = new Map<string, number>();
  for (const sheet of instructions.sheets) ids.set(sheet.id, (ids.get(sheet.id) ?? 0) + 1);
  for (const tileset of instructions.tilesets) ids.set(tileset.id, (ids.get(tileset.id) ?? 0) + 1);
  for (const [id, count] of ids) {
    if (id === "") err("(library)", "an entry has an empty id");
    else if (count > 1) err(id, `id used ${count} times — ids must be unique`);
  }

  for (const sheet of instructions.sheets) {
    const where = sheet.id || "(unnamed sheet)";
    if (sheet.path === "") err(where, "path is empty");
    else if (!sheet.path.startsWith("Assets/"))
      warn(where, `path '${sheet.path}' is outside Assets/ — it will not ship in data.pak`);
    if (sheet.frame_width < 1 || sheet.frame_height < 1)
      err(where, "frame_width/frame_height must be at least 1");
    if (sheet.columns < 1 || sheet.rows < 1) err(where, "columns/rows must be at least 1");
    if (sheet.output_dir === "") err(where, "output_dir is empty");
    if (sheet.animations.length === 0)
      warn(where, "no animations — the cutter falls back to one full-grid 'grid' animation");

    const seen = new Set<string>();
    for (const animation of sheet.animations) {
      const anWhere = `${where}.${animation.name || "(unnamed)"}`;
      if (animation.name === "") err(anWhere, "animation name is empty");
      else if (seen.has(animation.name)) err(anWhere, "duplicate animation name in this sheet");
      seen.add(animation.name);
      if (animation.frame_count < 1) err(anWhere, "frame_count must be at least 1");
      if (animation.fps <= 0) err(anWhere, "fps must be positive");
      if (animation.row < 0 || animation.start_column < 0)
        err(anWhere, "row/start_column must not be negative");

      // Mirror the cutter's frame walk: frames may wrap past the end of a row.
      if (sheet.columns >= 1 && animation.frame_count >= 1) {
        const lastIndex = animation.start_column + animation.frame_count - 1;
        const lastRow = animation.row + Math.floor(lastIndex / sheet.columns);
        if (lastRow >= sheet.rows)
          err(
            anWhere,
            `frames run past the grid (last frame lands on row ${lastRow}, sheet has rows 0–${sheet.rows - 1})`,
          );
      }
    }

    const size = sizes?.get(sheet.path);
    if (size) {
      const expectedW = sheet.columns * sheet.frame_width;
      const expectedH = sheet.rows * sheet.frame_height;
      if (size.width !== expectedW || size.height !== expectedH)
        err(
          where,
          `image is ${size.width}x${size.height} but the grid says ${expectedW}x${expectedH} — sprite_cutter requires an exact match`,
        );
    } else if (missing?.has(sheet.path)) {
      warn(where, `image '${sheet.path}' not found`);
    }
  }

  for (const tileset of instructions.tilesets) {
    const where = tileset.id || "(unnamed tileset)";
    if (tileset.path === "") err(where, "path is empty");
    else if (!tileset.path.startsWith("Assets/"))
      warn(where, `path '${tileset.path}' is outside Assets/ — it will not ship in data.pak`);
    if (tileset.tile_width < 1 || tileset.tile_height < 1)
      err(where, "tile_width/tile_height must be at least 1");
    if (tileset.columns < 1 || tileset.rows < 1) err(where, "columns/rows must be at least 1");
  }

  return findings;
}

/** True when nothing error-level is present (warnings do not block saving). */
export function isSaveable(findings: Finding[]): boolean {
  return findings.every((f) => f.level !== "error");
}
