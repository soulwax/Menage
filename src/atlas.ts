// The end-product planner: computes exactly what `sprite_cutter` will write
// for a sheet — crop rectangles, flips, output filenames, and the
// animation.toml manifest text — without touching the disk. The math here
// mirrors src/bin/sprite_cutter.rs in the game repo frame for frame; if the
// cutter changes, this file is the one that must follow.

import type { AnimationDef, SheetDef } from "./instructions";

export interface FramePlan {
  /** Source crop in sheet pixels. */
  sx: number;
  sy: number;
  w: number;
  h: number;
  flipX: boolean;
  /** Output file name, e.g. `idle_down_003.png`. */
  filename: string;
}

export interface AnimationPlan {
  name: string;
  fps: number;
  /** Output directory relative to the game root, e.g.
   *  `Generated/Sprites/characters/player/idle_down`. */
  dir: string;
  frames: FramePlan[];
  /** The exact animation.toml the cutter writes next to the frames. */
  manifestToml: string;
}

function pad3(index: number): string {
  return String(index).padStart(3, "0");
}

/** The cutter's fallback when a sheet declares no animations: one full-grid
 *  pass named `grid`. Mirrors cut_sheet() in sprite_cutter.rs. */
function effectiveAnimations(sheet: SheetDef): AnimationDef[] {
  if (sheet.animations.length > 0) return sheet.animations;
  return [
    {
      name: "grid",
      row: 0,
      start_column: 0,
      frame_count: sheet.columns * sheet.rows,
      fps: 1,
      flip_x: false,
    },
  ];
}

/** Mirrors animation_manifest() in sprite_cutter.rs, byte for byte. */
export function manifestToml(sheet: SheetDef, animation: AnimationDef): string {
  const frames = Array.from(
    { length: animation.frame_count },
    (_, index) => `"${animation.name}_${pad3(index)}.png"`,
  ).join(", ");
  return (
    `sheet_id = "${sheet.id}"\n` +
    `animation = "${animation.name}"\n` +
    `fps = ${animation.fps}\n` +
    `frame_width = ${sheet.frame_width}\n` +
    `frame_height = ${sheet.frame_height}\n` +
    `flip_x = ${animation.flip_x}\n` +
    `frames = [${frames}]\n`
  );
}

/** Everything the cutter will produce for this sheet, in cut order. */
export function planSheet(sheet: SheetDef): AnimationPlan[] {
  const plans: AnimationPlan[] = [];
  for (const animation of effectiveAnimations(sheet)) {
    const frames: FramePlan[] = [];
    for (let index = 0; index < animation.frame_count; index++) {
      // The cutter walks frame_index across the row and wraps to later rows.
      const frameIndex = animation.start_column + index;
      const column = frameIndex % sheet.columns;
      const row = animation.row + Math.floor(frameIndex / sheet.columns);
      frames.push({
        sx: column * sheet.frame_width,
        sy: row * sheet.frame_height,
        w: sheet.frame_width,
        h: sheet.frame_height,
        flipX: animation.flip_x,
        filename: `${animation.name}_${pad3(index)}.png`,
      });
    }
    plans.push({
      name: animation.name,
      fps: animation.fps,
      dir: `${sheet.output_dir}/${animation.name}`,
      frames,
      manifestToml: manifestToml(sheet, {
        ...animation,
        frame_count: animation.frame_count,
      }),
    });
  }
  return plans;
}

export function totalFrames(plans: AnimationPlan[]): number {
  return plans.reduce((sum, plan) => sum + plan.frames.length, 0);
}

// ---------------------------------------------------------------------------
// contact-sheet layout (pure math so it is testable; drawing lives in main)

export interface AtlasCell {
  plan: AnimationPlan;
  frame: FramePlan;
  /** Destination position on the contact sheet, in unscaled pixels. */
  dx: number;
  dy: number;
}

export interface AtlasLayout {
  width: number;
  height: number;
  /** Y of each animation's label row, keyed by animation name order. */
  labelYs: number[];
  cells: AtlasCell[];
}

export const ATLAS_PAD = 8;
export const ATLAS_LABEL_H = 18;

/** One labelled strip per animation, frames left→right in cut order. */
export function layoutContactSheet(plans: AnimationPlan[]): AtlasLayout {
  const cells: AtlasCell[] = [];
  const labelYs: number[] = [];
  let y = ATLAS_PAD;
  let width = 0;

  for (const plan of plans) {
    labelYs.push(y);
    y += ATLAS_LABEL_H;
    let x = ATLAS_PAD;
    let stripH = 0;
    for (const frame of plan.frames) {
      cells.push({ plan, frame, dx: x, dy: y });
      x += frame.w + 2;
      stripH = Math.max(stripH, frame.h);
    }
    width = Math.max(width, x + ATLAS_PAD);
    y += stripH + ATLAS_PAD;
  }

  return { width: Math.max(width, 160), height: y, labelYs, cells };
}
