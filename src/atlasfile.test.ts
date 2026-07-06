import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  atlasStem,
  createDescriptor,
  lintAtlas,
  parseAtlasFile,
  rectForIndex,
  serializeAtlasFile,
  spriteAt,
} from "./atlasfile";

const ATLAS_SAMPLE = `
image = "Assets/Graphics/sprites/characters/portraits_6.png"
type = "atlas"
tile_width = 250
tile_height = 250
columns = 5
rows = 5
origin_x = 0
origin_y = 0
padding_x = 1
padding_y = 1

[[sprites]]
name = "eve"
x = 753
y = 502
w = 250
h = 250
tags = ["portrait", "named"]

[[sprites]]
name = "portrait_r0_c4"
x = 1004
y = 0
w = 250
h = 250
tags = ["portrait", "unnamed"]
`;

const GRID_SAMPLE = `
image = "Assets/Graphics/sprites/characters/player.png"
type = "grid"
tile_width = 48
tile_height = 48
columns = 6
rows = 10
origin_x = 0
origin_y = 0
padding_x = 0
padding_y = 0

[[sprites]]
name = "player_idle_down_0"
index = 0

[[sprites]]
name = "player_move_down_2"
index = 20
`;

describe("parseAtlasFile", () => {
  it("reads the atlas variant with free rects and tags", () => {
    const atlas = parseAtlasFile("Assets/Metadata/portraits_6.toml", ATLAS_SAMPLE);
    expect(atlas).not.toBeNull();
    expect(atlas!.kind).toBe("atlas");
    expect(atlas!.paddingX).toBe(1);
    expect(atlas!.sprites[0]).toMatchObject({
      name: "eve",
      tags: ["portrait", "named"],
      index: null,
      rect: { x: 753, y: 502, w: 250, h: 250 },
    });
  });

  it("derives grid-variant rects from index, tile size, and padding", () => {
    const atlas = parseAtlasFile("Assets/Metadata/player_spritesheet.toml", GRID_SAMPLE);
    expect(atlas).not.toBeNull();
    expect(atlas!.kind).toBe("grid");
    // index 20 in a 6-wide grid → column 2, row 3.
    expect(atlas!.sprites[1].rect).toEqual({ x: 2 * 48, y: 3 * 48, w: 48, h: 48 });
  });

  it("honors padding in derived rects (the portraits gutter case)", () => {
    const atlas = parseAtlasFile("x.toml", ATLAS_SAMPLE)!;
    // Cell (4,0) with 1px gutters starts at 4*(250+1) = 1004 — matches the file.
    expect(rectForIndex(atlas, 4)).toEqual({ x: 1004, y: 0, w: 250, h: 250 });
  });

  it("returns null for TOML that is not a descriptor", () => {
    expect(parseAtlasFile("spritesheets.toml", `[[sheets]]\nid = "player"\n`)).toBeNull();
    expect(parseAtlasFile("weather.toml", `schema = 1\n[storm]\nrain = true\n`)).toBeNull();
  });
});

describe("spriteAt", () => {
  it("hit-tests rects, topmost (last declared) winning", () => {
    const atlas = parseAtlasFile("x.toml", ATLAS_SAMPLE)!;
    expect(spriteAt(atlas, 800, 600)?.name).toBe("eve");
    expect(spriteAt(atlas, 1010, 10)?.name).toBe("portrait_r0_c4");
    expect(spriteAt(atlas, 300, 300)).toBeNull(); // gutter/no sprite declared there
  });
});

describe("lintAtlas", () => {
  it("is clean for the sample with the real image size", () => {
    const atlas = parseAtlasFile("x.toml", ATLAS_SAMPLE)!;
    expect(lintAtlas(atlas, { width: 1254, height: 1254 })).toEqual([]);
  });

  it("flags duplicate names and rects that leave the image", () => {
    const atlas = parseAtlasFile("x.toml", ATLAS_SAMPLE)!;
    atlas.sprites[1].name = "eve";
    atlas.sprites[0].rect.x = 1100;
    const findings = lintAtlas(atlas, { width: 1254, height: 1254 });
    expect(findings.some((f) => f.message.includes("used 2 times"))).toBe(true);
    expect(findings.some((f) => f.message.includes("leaves the 1254×1254 image"))).toBe(true);
  });
});

describe("atlasStem", () => {
  it("shortens the descriptor path for the library", () => {
    expect(atlasStem("Assets/Metadata/portraits_6.toml")).toBe("portraits_6");
  });
});

describe("serializeAtlasFile — full fidelity against the real game files", () => {
  const game = (rel: string) => readFileSync(`../../${rel}`, "utf8");

  it("round-trips the real portraits descriptor losslessly", () => {
    const original = parseAtlasFile(
      "Assets/Metadata/portraits_6.toml",
      game("Assets/Metadata/portraits_6.toml"),
    )!;
    const again = parseAtlasFile(original.path, serializeAtlasFile(original));
    expect(again).toEqual(original);
  });

  it("preserves [[animations]] through the round-trip (player has 10)", () => {
    const original = parseAtlasFile(
      "Assets/Metadata/player_spritesheet.toml",
      game("Assets/Metadata/player_spritesheet.toml"),
    )!;
    expect(original.animations.length).toBeGreaterThanOrEqual(10);
    expect(original.sprites[0].index).not.toBeNull();
    const again = parseAtlasFile(original.path, serializeAtlasFile(original));
    expect(again).toEqual(original);
    expect(again!.animations).toEqual(original.animations);
  });

  it("a rename that flows into animation frames still lints clean", () => {
    const atlas = parseAtlasFile(
      "Assets/Metadata/player_spritesheet.toml",
      game("Assets/Metadata/player_spritesheet.toml"),
    )!;
    const oldName = atlas.sprites[0].name;
    atlas.sprites[0].name = "renamed_cell";
    for (const animation of atlas.animations) {
      animation.frames = animation.frames.map((f) => (f === oldName ? "renamed_cell" : f));
    }
    expect(lintAtlas(atlas).filter((f) => f.level === "error")).toEqual([]);
  });

  it("lint catches an animation frame orphaned by a rename", () => {
    const atlas = parseAtlasFile(
      "Assets/Metadata/player_spritesheet.toml",
      game("Assets/Metadata/player_spritesheet.toml"),
    )!;
    atlas.sprites[0].name = "renamed_without_frames";
    const findings = lintAtlas(atlas);
    expect(findings.some((f) => f.message.includes("names no declared sprite"))).toBe(true);
  });
});

describe("createDescriptor", () => {
  it("derives a 16px grid when the image divides evenly", () => {
    const atlas = createDescriptor(
      "Assets/Metadata/barrel_spritesheet.toml",
      "Assets/Graphics/sprites/objects/barrel.png",
      { width: 96, height: 32 },
    );
    expect(atlas.kind).toBe("grid");
    expect([atlas.tileWidth, atlas.tileHeight]).toEqual([16, 16]);
    expect([atlas.columns, atlas.rows]).toEqual([6, 2]);
    expect(atlas.sprites).toHaveLength(12);
    expect(atlas.sprites[7]).toMatchObject({
      name: "barrel_spritesheet_7",
      index: 7,
      rect: { x: 16, y: 16, w: 16, h: 16 },
    });
    expect(lintAtlas(atlas, { width: 96, height: 32 })).toEqual([]);
  });

  it("falls back to one full-image cell for odd sizes", () => {
    const atlas = createDescriptor("x.toml", "img.png", { width: 100, height: 30 });
    expect([atlas.columns, atlas.rows]).toEqual([1, 1]);
    expect([atlas.tileWidth, atlas.tileHeight]).toEqual([100, 30]);
    expect(atlas.sprites).toHaveLength(1);
  });
});
