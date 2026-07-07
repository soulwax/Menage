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
  swapAnimationFrames,
  type AtlasAnimation,
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

describe("swapAnimationFrames", () => {
  function animation(frames: string[]): AtlasAnimation {
    return { name: "walk", frames, fps: 8, frameDurationMs: null };
  }

  it("swaps two frames by index (the up/down reorder buttons)", () => {
    const a = animation(["a", "b", "c"]);
    swapAnimationFrames(a, 0, 1);
    expect(a.frames).toEqual(["b", "a", "c"]);
    swapAnimationFrames(a, 1, 2);
    expect(a.frames).toEqual(["b", "c", "a"]);
  });

  it("is a no-op for equal, negative, or out-of-range indices", () => {
    const a = animation(["a", "b"]);
    swapAnimationFrames(a, 0, 0);
    expect(a.frames).toEqual(["a", "b"]);
    swapAnimationFrames(a, -1, 0);
    expect(a.frames).toEqual(["a", "b"]);
    swapAnimationFrames(a, 0, 5);
    expect(a.frames).toEqual(["a", "b"]);
  });

  it("guards the first/last frame against the disabled up/down buttons firing anyway", () => {
    const a = animation(["only"]);
    swapAnimationFrames(a, 0, -1); // "up" from index 0
    swapAnimationFrames(a, 0, 1); // "down" from the last index
    expect(a.frames).toEqual(["only"]);
  });
});

describe("animation editing round-trips through serialize/parse", () => {
  const image = "Assets/Graphics/sprites/objects/barrel.png";

  it("a hand-built animation with add/reorder/remove serializes and reparses losslessly", () => {
    const atlas = createDescriptor("x.toml", image, { width: 96, height: 32 });
    atlas.animations.push({ name: "spin", frames: [], fps: 12, frameDurationMs: null });
    const spin = atlas.animations[0];
    spin.frames.push(atlas.sprites[0].name, atlas.sprites[1].name, atlas.sprites[2].name);
    swapAnimationFrames(spin, 0, 2); // reorder: [2, 1, 0]
    spin.frames.splice(1, 1); // remove the middle frame: [2, 0]

    expect(spin.frames).toEqual([atlas.sprites[2].name, atlas.sprites[0].name]);
    expect(lintAtlas(atlas).filter((f) => f.level === "error")).toEqual([]);

    const reparsed = parseAtlasFile(atlas.path, serializeAtlasFile(atlas))!;
    expect(reparsed.animations).toEqual(atlas.animations);
  });

  it("frame_duration_ms survives when fps is cleared, and vice versa", () => {
    const atlas = createDescriptor("x.toml", image, { width: 96, height: 32 });
    atlas.animations.push({
      name: "slow",
      frames: [atlas.sprites[0].name],
      fps: null,
      frameDurationMs: 250,
    });
    const reparsed = parseAtlasFile(atlas.path, serializeAtlasFile(atlas))!;
    expect(reparsed.animations[0]).toEqual({
      name: "slow",
      frames: [atlas.sprites[0].name],
      fps: null,
      frameDurationMs: 250,
    });
  });

  it("an animation with zero frames is preserved (lint flags it; serialize never drops it)", () => {
    const atlas = createDescriptor("x.toml", image, { width: 96, height: 32 });
    atlas.animations.push({ name: "empty", frames: [], fps: 8, frameDurationMs: null });
    const reparsed = parseAtlasFile(atlas.path, serializeAtlasFile(atlas))!;
    expect(reparsed.animations).toEqual(atlas.animations);
    expect(lintAtlas(atlas).some((f) => f.message.includes("declares no frames"))).toBe(true);
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
