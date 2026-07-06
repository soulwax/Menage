// Atlas descriptors: the second metadata family under Assets/Metadata —
// `type = "atlas"` (free rects: portraits_6.toml, symbols_spritesheet.toml)
// and `type = "grid"` (indexed cells: player_spritesheet.toml and friends).
//
// The model is FULL fidelity: every field the game's SpriteSheetDescriptor
// reads (index/rect placement, pivots, trimmed, tags, [[animations]]) is
// parsed, kept, and serialized back — editing a descriptor in Menage must
// never quietly drop data a file already had. `sheets validate` (the game's
// own CLI) gates every save; `lintAtlas` is the live advisory layer.

import { parse as parseToml } from "smol-toml";
import type { Finding } from "./instructions";

export interface SpriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasSprite {
  name: string;
  tags: string[];
  /** Grid placement (grid descriptors); null when placed by rect. */
  index: number | null;
  /** Free-rect placement (atlas descriptors); null when placed by index. */
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  pivotX: number | null;
  pivotY: number | null;
  trimmed: boolean;
  /** Resolved pixel rect for drawing/hit-testing — call refreshRects after
   *  mutating placement fields. */
  rect: SpriteRect;
}

export interface AtlasAnimation {
  name: string;
  frames: string[];
  fps: number | null;
  frameDurationMs: number | null;
}

export interface AtlasFile {
  /** Repo-relative path of the descriptor TOML. */
  path: string;
  /** Repo-relative path of the image it describes. */
  image: string;
  kind: "atlas" | "grid";
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  originX: number;
  originY: number;
  paddingX: number;
  paddingY: number;
  sprites: AtlasSprite[];
  animations: AtlasAnimation[];
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function optNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

/** Grid descriptors place sprites by cell index; the rect is derived from the
 *  tile grid, origin, and per-cell padding (gutter pixels). */
export function rectForIndex(atlas: AtlasFile, index: number): SpriteRect {
  const columns = Math.max(1, atlas.columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: atlas.originX + column * (atlas.tileWidth + atlas.paddingX),
    y: atlas.originY + row * (atlas.tileHeight + atlas.paddingY),
    w: atlas.tileWidth,
    h: atlas.tileHeight,
  };
}

function resolveRect(atlas: AtlasFile, sprite: AtlasSprite): SpriteRect {
  if (sprite.index !== null) return rectForIndex(atlas, sprite.index);
  return {
    x: sprite.x ?? 0,
    y: sprite.y ?? 0,
    w: sprite.w ?? atlas.tileWidth,
    h: sprite.h ?? atlas.tileHeight,
  };
}

/** Recompute every sprite's derived rect — call after editing grid geometry
 *  or a sprite's placement fields. */
export function refreshRects(atlas: AtlasFile): void {
  for (const sprite of atlas.sprites) sprite.rect = resolveRect(atlas, sprite);
}

/** Parse a descriptor TOML. Returns null when the text is not this schema
 *  (no `type`/`image`) — discovery feeds every Assets/Metadata TOML here and
 *  simply skips the ones that are something else. Throws on malformed TOML. */
export function parseAtlasFile(path: string, text: string): AtlasFile | null {
  const doc = parseToml(text) as Record<string, unknown>;
  const kind = str(doc.type, "");
  const image = str(doc.image, "");
  if ((kind !== "atlas" && kind !== "grid") || image === "") return null;

  const atlas: AtlasFile = {
    path,
    image,
    kind,
    tileWidth: num(doc.tile_width, 16),
    tileHeight: num(doc.tile_height, 16),
    columns: num(doc.columns, 1),
    rows: num(doc.rows, 1),
    originX: num(doc.origin_x, 0),
    originY: num(doc.origin_y, 0),
    paddingX: num(doc.padding_x, 0),
    paddingY: num(doc.padding_y, 0),
    sprites: [],
    animations: [],
  };

  const rawSprites = Array.isArray(doc.sprites) ? doc.sprites : [];
  for (const raw of rawSprites) {
    const sprite = raw as Record<string, unknown>;
    const tags = Array.isArray(sprite.tags)
      ? sprite.tags.filter((t): t is string => typeof t === "string")
      : [];
    const entry: AtlasSprite = {
      name: str(sprite.name, ""),
      tags,
      index: optNum(sprite.index),
      x: optNum(sprite.x),
      y: optNum(sprite.y),
      w: optNum(sprite.w),
      h: optNum(sprite.h),
      pivotX: optNum(sprite.pivot_x),
      pivotY: optNum(sprite.pivot_y),
      trimmed: sprite.trimmed === true,
      rect: { x: 0, y: 0, w: 0, h: 0 },
    };
    entry.rect = resolveRect(atlas, entry);
    atlas.sprites.push(entry);
  }

  const rawAnimations = Array.isArray(doc.animations) ? doc.animations : [];
  for (const raw of rawAnimations) {
    const animation = raw as Record<string, unknown>;
    atlas.animations.push({
      name: str(animation.name, ""),
      frames: Array.isArray(animation.frames)
        ? animation.frames.filter((f): f is string => typeof f === "string")
        : [],
      fps: optNum(animation.fps),
      frameDurationMs: optNum(animation.frame_duration_ms),
    });
  }

  return atlas;
}

// ---------------------------------------------------------------------------
// serialize

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Deterministic writer: header comment, the grid facts, every sprite, every
 *  animation — the exact field set the game's SpriteSheetDescriptor reads.
 *  (Free-form comments in the source file are not preserved.) */
export function serializeAtlasFile(atlas: AtlasFile): string {
  const parts: string[] = [
    [
      `# File: ${atlas.path}`,
      "# Sprite-sheet descriptor — maintained with Menage (tools/menage);",
      "# validated by the game's `sheets` CLI before every save.",
      "",
      `image = ${tomlString(atlas.image)}`,
      `type = ${tomlString(atlas.kind)}`,
      `tile_width = ${atlas.tileWidth}`,
      `tile_height = ${atlas.tileHeight}`,
      `columns = ${atlas.columns}`,
      `rows = ${atlas.rows}`,
      `origin_x = ${atlas.originX}`,
      `origin_y = ${atlas.originY}`,
      `padding_x = ${atlas.paddingX}`,
      `padding_y = ${atlas.paddingY}`,
      "",
    ].join("\n"),
  ];

  for (const sprite of atlas.sprites) {
    const lines = ["[[sprites]]", `name = ${tomlString(sprite.name)}`];
    if (sprite.index !== null) lines.push(`index = ${sprite.index}`);
    if (sprite.x !== null) lines.push(`x = ${sprite.x}`);
    if (sprite.y !== null) lines.push(`y = ${sprite.y}`);
    if (sprite.w !== null) lines.push(`w = ${sprite.w}`);
    if (sprite.h !== null) lines.push(`h = ${sprite.h}`);
    if (sprite.pivotX !== null) lines.push(`pivot_x = ${sprite.pivotX}`);
    if (sprite.pivotY !== null) lines.push(`pivot_y = ${sprite.pivotY}`);
    if (sprite.trimmed) lines.push("trimmed = true");
    if (sprite.tags.length > 0)
      lines.push(`tags = [${sprite.tags.map(tomlString).join(", ")}]`);
    lines.push("");
    parts.push(lines.join("\n"));
  }

  for (const animation of atlas.animations) {
    const lines = [
      "[[animations]]",
      `name = ${tomlString(animation.name)}`,
      `frames = [${animation.frames.map(tomlString).join(", ")}]`,
    ];
    if (animation.fps !== null) lines.push(`fps = ${animation.fps}`);
    if (animation.frameDurationMs !== null)
      lines.push(`frame_duration_ms = ${animation.frameDurationMs}`);
    lines.push("");
    parts.push(lines.join("\n"));
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// creation

/** A fresh grid descriptor for an image: tiles default to 16px when the image
 *  divides evenly, else one full-image cell. Sprites enumerate the grid with
 *  stable `<stem>_<n>` names — the shape the per-sheet descriptors use. */
export function createDescriptor(
  path: string,
  image: string,
  size: { width: number; height: number } | null,
): AtlasFile {
  const stem = atlasStem(path);
  const tile =
    size && size.width % 16 === 0 && size.height % 16 === 0 ? 16 : null;
  const tileWidth = tile ?? size?.width ?? 16;
  const tileHeight = tile ?? size?.height ?? 16;
  const columns = size ? Math.max(1, Math.floor(size.width / tileWidth)) : 1;
  const rows = size ? Math.max(1, Math.floor(size.height / tileHeight)) : 1;

  const atlas: AtlasFile = {
    path,
    image,
    kind: "grid",
    tileWidth,
    tileHeight,
    columns,
    rows,
    originX: 0,
    originY: 0,
    paddingX: 0,
    paddingY: 0,
    sprites: [],
    animations: [],
  };
  const cells = Math.min(columns * rows, 4096);
  for (let index = 0; index < cells; index++) {
    atlas.sprites.push({
      name: `${stem}_${index}`,
      tags: [],
      index,
      x: null,
      y: null,
      w: null,
      h: null,
      pivotX: null,
      pivotY: null,
      trimmed: false,
      rect: rectForIndex(atlas, index),
    });
  }
  return atlas;
}

// ---------------------------------------------------------------------------
// queries + lint

/** The sprite under a pixel position, topmost (last declared) first. */
export function spriteAt(atlas: AtlasFile, x: number, y: number): AtlasSprite | null {
  for (let i = atlas.sprites.length - 1; i >= 0; i--) {
    const { rect } = atlas.sprites[i];
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) {
      return atlas.sprites[i];
    }
  }
  return null;
}

/** Advisory findings; `sheets validate` (the game CLI) is the save gate. */
export function lintAtlas(
  atlas: AtlasFile,
  imageSize?: { width: number; height: number },
): Finding[] {
  const findings: Finding[] = [];
  const where = atlas.path;
  const names = new Map<string, number>();
  for (const sprite of atlas.sprites) names.set(sprite.name, (names.get(sprite.name) ?? 0) + 1);
  for (const [name, count] of names) {
    if (name === "") findings.push({ level: "error", where, message: "a sprite has an empty name" });
    else if (count > 1)
      findings.push({ level: "error", where, message: `sprite name '${name}' used ${count} times` });
  }
  if (atlas.sprites.length === 0 && atlas.animations.length === 0)
    findings.push({
      level: "error",
      where,
      message: "descriptor declares no sprites and no animations — the game rejects it",
    });
  for (const sprite of atlas.sprites) {
    if (sprite.index !== null && atlas.kind !== "grid")
      findings.push({
        level: "error",
        where,
        message: `'${sprite.name}' uses index placement but type is '${atlas.kind}'`,
      });
    if (sprite.index === null && (sprite.x === null || sprite.y === null || sprite.w === null || sprite.h === null))
      findings.push({
        level: "error",
        where,
        message: `'${sprite.name}' needs either an index (grid) or all of x/y/w/h (atlas)`,
      });
    if (sprite.index !== null && sprite.index >= atlas.columns * atlas.rows)
      findings.push({
        level: "error",
        where,
        message: `'${sprite.name}' index ${sprite.index} is outside the ${atlas.columns}×${atlas.rows} grid`,
      });
    if (sprite.rect.w < 1 || sprite.rect.h < 1)
      findings.push({ level: "error", where, message: `'${sprite.name}' has a degenerate rect` });
    if (imageSize) {
      const { rect } = sprite;
      if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > imageSize.width || rect.y + rect.h > imageSize.height)
        findings.push({
          level: "error",
          where,
          message: `'${sprite.name}' rect ${rect.x},${rect.y} ${rect.w}×${rect.h} leaves the ${imageSize.width}×${imageSize.height} image`,
        });
    }
  }
  for (const animation of atlas.animations) {
    if (animation.frames.length === 0)
      findings.push({ level: "error", where, message: `animation '${animation.name}' declares no frames` });
    for (const frame of animation.frames) {
      if (!atlas.sprites.some((s) => s.name === frame))
        findings.push({
          level: "error",
          where,
          message: `animation '${animation.name}' frame '${frame}' names no declared sprite`,
        });
    }
  }
  return findings;
}

/** A short display label: "portraits_6" from "Assets/Metadata/portraits_6.toml". */
export function atlasStem(path: string): string {
  return path.split("/").pop()?.replace(/\.toml$/i, "") ?? path;
}
