import { describe, expect, it } from "vitest";
import { atlasStem, lintAtlas, parseAtlasFile, rectForIndex, spriteAt } from "./atlasfile";

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
    expect(atlas!.sprites[0]).toEqual({
      name: "eve",
      tags: ["portrait", "named"],
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
