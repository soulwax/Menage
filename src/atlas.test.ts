import { describe, expect, it } from "vitest";
import { layoutContactSheet, manifestToml, planSheet, totalFrames } from "./atlas";
import type { SheetDef } from "./instructions";

function sheet(overrides: Partial<SheetDef> = {}): SheetDef {
  return {
    id: "player",
    path: "Assets/Graphics/sprites/characters/player.png",
    kind: "character",
    frame_width: 48,
    frame_height: 48,
    columns: 6,
    rows: 10,
    output_dir: "Generated/Sprites/characters/player",
    animations: [
      { name: "idle_down", row: 0, start_column: 0, frame_count: 6, fps: 8, flip_x: false },
    ],
    ...overrides,
  };
}

describe("planSheet", () => {
  it("computes the cutter's crop rects and filenames", () => {
    const plans = planSheet(sheet());
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    expect(plan.dir).toBe("Generated/Sprites/characters/player/idle_down");
    expect(plan.frames[0]).toMatchObject({ sx: 0, sy: 0, w: 48, h: 48, filename: "idle_down_000.png" });
    expect(plan.frames[5]).toMatchObject({ sx: 240, sy: 0, filename: "idle_down_005.png" });
  });

  it("wraps past the end of a row exactly like the cutter", () => {
    // 6 columns: start_column 4, 4 frames → indexes 4,5,6,7 → row wraps at 6.
    const plans = planSheet(
      sheet({
        animations: [{ name: "wrap", row: 2, start_column: 4, frame_count: 4, fps: 8, flip_x: false }],
      }),
    );
    const [f0, f1, f2, f3] = plans[0].frames;
    expect([f0.sx, f0.sy]).toEqual([4 * 48, 2 * 48]);
    expect([f1.sx, f1.sy]).toEqual([5 * 48, 2 * 48]);
    expect([f2.sx, f2.sy]).toEqual([0, 3 * 48]); // wrapped to the next row
    expect([f3.sx, f3.sy]).toEqual([48, 3 * 48]);
  });

  it("falls back to one full-grid 'grid' animation when none are declared", () => {
    const plans = planSheet(sheet({ animations: [], columns: 3, rows: 2 }));
    expect(plans).toHaveLength(1);
    expect(plans[0].name).toBe("grid");
    expect(plans[0].frames).toHaveLength(6);
    expect(totalFrames(plans)).toBe(6);
  });

  it("carries flip_x onto every frame", () => {
    const plans = planSheet(
      sheet({
        animations: [{ name: "left", row: 1, start_column: 0, frame_count: 2, fps: 10, flip_x: true }],
      }),
    );
    expect(plans[0].frames.every((f) => f.flipX)).toBe(true);
  });
});

describe("manifestToml", () => {
  it("matches sprite_cutter's animation_manifest byte for byte", () => {
    const s = sheet();
    const text = manifestToml(s, s.animations[0]);
    expect(text).toBe(
      'sheet_id = "player"\n' +
        'animation = "idle_down"\n' +
        "fps = 8\n" +
        "frame_width = 48\n" +
        "frame_height = 48\n" +
        "flip_x = false\n" +
        'frames = ["idle_down_000.png", "idle_down_001.png", "idle_down_002.png", "idle_down_003.png", "idle_down_004.png", "idle_down_005.png"]\n',
    );
  });
});

describe("layoutContactSheet", () => {
  it("stacks one labelled strip per animation without overlap", () => {
    const plans = planSheet(
      sheet({
        animations: [
          { name: "a", row: 0, start_column: 0, frame_count: 3, fps: 8, flip_x: false },
          { name: "b", row: 1, start_column: 0, frame_count: 6, fps: 8, flip_x: false },
        ],
      }),
    );
    const layout = layoutContactSheet(plans);
    expect(layout.labelYs).toHaveLength(2);
    expect(layout.labelYs[1]).toBeGreaterThan(layout.labelYs[0]);
    const stripA = layout.cells.filter((c) => c.plan.name === "a");
    const stripB = layout.cells.filter((c) => c.plan.name === "b");
    expect(Math.max(...stripA.map((c) => c.dy + c.frame.h))).toBeLessThanOrEqual(
      Math.min(...stripB.map((c) => c.dy)),
    );
    expect(layout.width).toBeGreaterThanOrEqual(6 * 48);
    expect(layout.height).toBeGreaterThan(2 * 48);
  });
});
