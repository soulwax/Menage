import { describe, expect, it } from "vitest";
import {
  isSaveable,
  lint,
  parseInstructions,
  serializeInstructions,
  type ImageSizes,
} from "./instructions";

const SAMPLE = `
# File: Assets/Metadata/spritesheets.toml

[[sheets]]
id = "player"
path = "Assets/Graphics/sprites/characters/player.png"
kind = "character"
frame_width = 48
frame_height = 48
columns = 6
rows = 10
output_dir = "Generated/Sprites/characters/player"

[[sheets.animations]]
name = "idle_down"
row = 0
start_column = 0
frame_count = 6
fps = 8
flip_x = false

[[tilesets]]
id = "plains"
path = "Assets/Graphics/sprites/tilesets/plains.png"
tile_width = 16
tile_height = 16
columns = 6
rows = 12
`;

describe("parseInstructions", () => {
  it("reads sheets, animations, and tilesets", () => {
    const parsed = parseInstructions(SAMPLE);
    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0].id).toBe("player");
    expect(parsed.sheets[0].animations[0]).toEqual({
      name: "idle_down",
      row: 0,
      start_column: 0,
      frame_count: 6,
      fps: 8,
      flip_x: false,
    });
    expect(parsed.tilesets[0]).toEqual({
      id: "plains",
      path: "Assets/Graphics/sprites/tilesets/plains.png",
      tile_width: 16,
      tile_height: 16,
      columns: 6,
      rows: 12,
    });
  });

  it("degrades missing fields to defaults instead of failing", () => {
    const parsed = parseInstructions(`[[sheets]]\nid = "bare"\n`);
    expect(parsed.sheets[0].frame_width).toBe(16);
    expect(parsed.sheets[0].animations).toEqual([]);
  });

  it("throws on malformed TOML (caller shows the error)", () => {
    expect(() => parseInstructions("[[sheets]\nnope")).toThrow();
  });
});

describe("serializeInstructions", () => {
  it("round-trips: parse(serialize(parse(x))) === parse(x)", () => {
    const first = parseInstructions(SAMPLE);
    const second = parseInstructions(serializeInstructions(first));
    expect(second).toEqual(first);
  });

  it("emits the header and stable field order", () => {
    const text = serializeInstructions(parseInstructions(SAMPLE));
    expect(text.startsWith("# File: Assets/Metadata/spritesheets.toml")).toBe(true);
    expect(text.indexOf("[[sheets]]")).toBeLessThan(text.indexOf("[[sheets.animations]]"));
    expect(text.indexOf("[[sheets.animations]]")).toBeLessThan(text.indexOf("[[tilesets]]"));
  });

  it("escapes quotes and backslashes in strings", () => {
    const instructions = parseInstructions(SAMPLE);
    instructions.sheets[0].path = 'weird"\\path.png';
    const round = parseInstructions(serializeInstructions(instructions));
    expect(round.sheets[0].path).toBe('weird"\\path.png');
  });
});

describe("lint", () => {
  it("is clean for the sample", () => {
    const findings = lint(parseInstructions(SAMPLE));
    expect(findings.filter((f) => f.level === "error")).toEqual([]);
  });

  it("flags duplicate ids across sheets and tilesets", () => {
    const instructions = parseInstructions(SAMPLE);
    instructions.tilesets[0].id = "player";
    const findings = lint(instructions);
    expect(findings.some((f) => f.level === "error" && f.message.includes("unique"))).toBe(true);
  });

  it("rejects row wrap exactly like the game validator (sheets CLI agrees)", () => {
    const instructions = parseInstructions(SAMPLE);
    // 6 columns: starting at 4 with 3 frames would wrap onto the next row —
    // the game's SpritesheetMetadata::validate() forbids that.
    instructions.sheets[0].animations[0] = {
      name: "wrap",
      row: 0,
      start_column: 4,
      frame_count: 3,
      fps: 8,
      flip_x: false,
    };
    const findings = lint(instructions);
    const wrap = findings.find((f) => f.message.includes("forbids row wrap"));
    expect(wrap?.level).toBe("error");
    expect(wrap?.target).toEqual({ type: "sheet", id: "player", animation: "wrap" });
  });

  it("flags a row outside the sheet, with a clickable target", () => {
    const instructions = parseInstructions(SAMPLE);
    instructions.sheets[0].animations[0].row = 12;
    const findings = lint(instructions);
    const outside = findings.find((f) => f.message.includes("outside the sheet"));
    expect(outside?.level).toBe("error");
    expect(outside?.target?.animation).toBe("idle_down");
  });

  it("enforces the cutter's exact-dimension rule when sizes are known", () => {
    const instructions = parseInstructions(SAMPLE);
    const sizes: ImageSizes = new Map([
      ["Assets/Graphics/sprites/characters/player.png", { width: 288, height: 480 }],
      ["Assets/Graphics/sprites/tilesets/plains.png", { width: 96, height: 192 }],
    ]);
    expect(lint(instructions, sizes).filter((f) => f.level === "error")).toEqual([]);

    sizes.set("Assets/Graphics/sprites/characters/player.png", { width: 288, height: 528 });
    const findings = lint(instructions, sizes);
    expect(findings.some((f) => f.level === "error" && f.message.includes("exact match"))).toBe(true);
  });

  it("warns for known-missing images only — unloaded images stay quiet", () => {
    const instructions = parseInstructions(SAMPLE);
    const sizes: ImageSizes = new Map(); // nothing loaded yet
    expect(lint(instructions, sizes).some((f) => f.message.includes("not found"))).toBe(false);

    const missing = new Set(["Assets/Graphics/sprites/characters/player.png"]);
    const findings = lint(instructions, sizes, missing);
    expect(findings.some((f) => f.level === "warn" && f.message.includes("not found"))).toBe(true);
  });

  it("fps zero and empty animation names are errors; no animations is a warning", () => {
    const instructions = parseInstructions(SAMPLE);
    instructions.sheets[0].animations[0].fps = 0;
    instructions.sheets[0].animations[0].name = "";
    let findings = lint(instructions);
    expect(findings.filter((f) => f.level === "error").length).toBeGreaterThanOrEqual(2);

    instructions.sheets[0].animations = [];
    findings = lint(instructions);
    expect(findings.some((f) => f.level === "warn" && f.message.includes("full-grid"))).toBe(true);
    expect(isSaveable(findings)).toBe(true);
  });
});
