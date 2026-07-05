// Atlas descriptors: the second metadata family under Assets/Metadata —
// `type = "atlas"` (free rects: portraits_6.toml, symbols_spritesheet.toml)
// and `type = "grid"` (indexed cells: player_spritesheet.toml and friends).
// Both resolve to one shape: named sprites with pixel rects over one image.
//
// Read-only in this phase: Menage views, labels, and hit-tests these files;
// it does not write them yet (there is no CLI authority to gate a save with).

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
  rect: SpriteRect;
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
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
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
  };

  const rawSprites = Array.isArray(doc.sprites) ? doc.sprites : [];
  for (const raw of rawSprites) {
    const sprite = raw as Record<string, unknown>;
    const tags = Array.isArray(sprite.tags)
      ? sprite.tags.filter((t): t is string => typeof t === "string")
      : [];
    const rect =
      kind === "grid"
        ? rectForIndex(atlas, num(sprite.index, 0))
        : {
            x: num(sprite.x, 0),
            y: num(sprite.y, 0),
            w: num(sprite.w, atlas.tileWidth),
            h: num(sprite.h, atlas.tileHeight),
          };
    atlas.sprites.push({ name: str(sprite.name, ""), tags, rect });
  }
  return atlas;
}

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

/** Advisory findings for a descriptor (there is no CLI authority for these
 *  files, so this is the only net — which is also why Menage does not write
 *  them yet). */
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
  for (const sprite of atlas.sprites) {
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
  return findings;
}

/** A short display label: "portraits_6" from "Assets/Metadata/portraits_6.toml". */
export function atlasStem(path: string): string {
  return path.split("/").pop()?.replace(/\.toml$/i, "") ?? path;
}
