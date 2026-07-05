import { describe, expect, it } from "vitest";
import { crossReference, formatAudit, normalizePath, parsePackList } from "./inventory";
import { parseInstructions } from "./instructions";

const INSTRUCTIONS = parseInstructions(`
[[sheets]]
id = "player"
path = "Assets/Graphics/sprites/characters/player.png"
kind = "character"
frame_width = 48
frame_height = 48
columns = 6
rows = 10
output_dir = "Generated/Sprites/characters/player"

[[tilesets]]
id = "plains"
path = "Assets/Graphics/sprites/tilesets/plains.png"
tile_width = 16
tile_height = 16
columns = 6
rows = 12
`);

describe("parsePackList", () => {
  it("keeps paths and drops summary lines and blanks", () => {
    const output = [
      "Assets/Graphics/sprites/characters/player.png",
      "shaders/warp.frag",
      "",
      "asset_pack: discovered 190 runtime asset(s), 20.85 MiB plain payload",
      "asset_pack: dry run, not writing data.pak",
    ].join("\n");
    expect(parsePackList(output)).toEqual([
      "Assets/Graphics/sprites/characters/player.png",
      "shaders/warp.frag",
    ]);
  });
});

describe("normalizePath", () => {
  it("forces forward slashes and strips leading ./", () => {
    expect(normalizePath("Assets\\Graphics\\a.png")).toBe("Assets/Graphics/a.png");
    expect(normalizePath("./Assets/a.png")).toBe("Assets/a.png");
  });
});

describe("crossReference", () => {
  const disk = [
    "Assets/Graphics/sprites/characters/player.png",
    "Assets/Graphics/sprites/tilesets/plains.png",
    "Assets/Graphics/sprites/objects/lost_barrel.png",
  ];
  const pack = ["Assets/Graphics/sprites/characters/player.png"];

  it("marks registered images with their owners and ship status", () => {
    const audit = crossReference(INSTRUCTIONS, disk, pack);
    const player = audit.rows.find((r) => r.path.endsWith("player.png"));
    expect(player).toMatchObject({ registeredBy: ["player"], ships: true });
    const plains = audit.rows.find((r) => r.path.endsWith("plains.png"));
    expect(plains).toMatchObject({ registeredBy: ["plains"], ships: false });
  });

  it("lists disk PNGs no instruction references as unregistered", () => {
    const audit = crossReference(INSTRUCTIONS, disk, pack);
    expect(audit.unregistered).toEqual(["Assets/Graphics/sprites/objects/lost_barrel.png"]);
  });

  it("degrades gracefully with empty sources", () => {
    const audit = crossReference(INSTRUCTIONS, [], []);
    expect(audit.rows).toHaveLength(2);
    expect(audit.unregistered).toEqual([]);
  });

  it("formats a readable report", () => {
    const audit = crossReference(INSTRUCTIONS, disk, pack);
    const text = formatAudit(audit, true);
    expect(text).toContain("[ships] Assets/Graphics/sprites/characters/player.png");
    expect(text).toContain("[NOT IN PACK] Assets/Graphics/sprites/tilesets/plains.png");
    expect(text).toContain("[orphan] Assets/Graphics/sprites/objects/lost_barrel.png");
  });
});
