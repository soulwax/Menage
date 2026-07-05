// Canvas renderers: the Stage (source sheet + cutting grid + animation bands)
// and the Atlas contact sheet (the end product). Pixel-art rules apply
// throughout: nearest-neighbor scaling, whole-pixel positions.

import type { SheetDef } from "./instructions";
import { ATLAS_LABEL_H, layoutContactSheet, type AnimationPlan } from "./atlas";

export type Zoom = "fit" | number;

export interface GridModel {
  frameW: number;
  frameH: number;
  columns: number;
  rows: number;
  /** Animations for band tinting; empty for tilesets. */
  animations: Array<{ name: string; row: number; start_column: number; frame_count: number }>;
}

export interface HoverInfo {
  column: number;
  row: number;
  frameRect: { x: number; y: number; w: number; h: number };
  animation: string | null;
}

export function sheetGrid(sheet: SheetDef): GridModel {
  return {
    frameW: sheet.frame_width,
    frameH: sheet.frame_height,
    columns: sheet.columns,
    rows: sheet.rows,
    animations: sheet.animations,
  };
}

const BAND_HUES = [42, 168, 285, 12, 210, 330, 96, 250, 60, 140];

/** Which animation (index) covers each cell, walking the same wrap the cutter
 *  does. First writer wins so overlaps are visible as the earlier animation. */
function coverage(grid: GridModel): Map<string, number> {
  const covered = new Map<string, number>();
  grid.animations.forEach((animation, index) => {
    for (let i = 0; i < animation.frame_count; i++) {
      const frameIndex = animation.start_column + i;
      const column = frameIndex % grid.columns;
      const row = animation.row + Math.floor(frameIndex / grid.columns);
      const key = `${column},${row}`;
      if (!covered.has(key)) covered.set(key, index);
    }
  });
  return covered;
}

export class Stage {
  private image: HTMLImageElement | null = null;
  private grid: GridModel | null = null;
  private scale = 1;
  zoom: Zoom = "fit";
  selectedAnimation: string | null = null;
  onHover: (info: HoverInfo | null) => void = () => {};
  onPickAnimation: (name: string | null) => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement,
    private wrap: HTMLElement,
  ) {
    canvas.addEventListener("mousemove", (e) => this.onHover(this.hitTest(e)));
    canvas.addEventListener("mouseleave", () => this.onHover(null));
    canvas.addEventListener("click", (e) => {
      const hit = this.hitTest(e);
      this.onPickAnimation(hit?.animation ?? null);
    });
  }

  setSheet(image: HTMLImageElement | null, grid: GridModel | null): void {
    this.image = image;
    this.grid = grid;
    this.draw();
  }

  setZoom(zoom: Zoom): void {
    this.zoom = zoom;
    this.draw();
  }

  private contentSize(): { w: number; h: number } {
    if (this.image) return { w: this.image.naturalWidth, h: this.image.naturalHeight };
    if (this.grid)
      return { w: this.grid.columns * this.grid.frameW, h: this.grid.rows * this.grid.frameH };
    return { w: 320, h: 180 };
  }

  private computeScale(): number {
    if (this.zoom !== "fit") return this.zoom;
    const { w, h } = this.contentSize();
    const fit = Math.min((this.wrap.clientWidth - 24) / w, (this.wrap.clientHeight - 24) / h);
    // Integer scales keep the pixel grid honest; only shrink below 1 when the
    // sheet genuinely does not fit.
    return fit >= 1 ? Math.max(1, Math.floor(fit)) : Math.max(0.125, fit);
  }

  private hitTest(e: MouseEvent): HoverInfo | null {
    if (!this.grid) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / this.scale;
    const y = (e.clientY - rect.top) / this.scale;
    const column = Math.floor(x / this.grid.frameW);
    const row = Math.floor(y / this.grid.frameH);
    if (column < 0 || row < 0 || column >= this.grid.columns || row >= this.grid.rows) return null;
    const animationIndex = coverage(this.grid).get(`${column},${row}`);
    return {
      column,
      row,
      frameRect: {
        x: column * this.grid.frameW,
        y: row * this.grid.frameH,
        w: this.grid.frameW,
        h: this.grid.frameH,
      },
      animation: animationIndex === undefined ? null : this.grid.animations[animationIndex].name,
    };
  }

  draw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const { w, h } = this.contentSize();
    this.scale = this.computeScale();
    this.canvas.width = Math.max(1, Math.round(w * this.scale));
    this.canvas.height = Math.max(1, Math.round(h * this.scale));
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.image) {
      ctx.drawImage(this.image, 0, 0, this.canvas.width, this.canvas.height);
    } else {
      drawMissingPlaceholder(ctx, this.canvas.width, this.canvas.height);
    }

    if (!this.grid) return;
    const grid = this.grid;
    const cellW = grid.frameW * this.scale;
    const cellH = grid.frameH * this.scale;

    // Animation bands (under the grid lines).
    const covered = coverage(grid);
    for (const [key, index] of covered) {
      const [column, row] = key.split(",").map(Number);
      const name = grid.animations[index].name;
      const hue = BAND_HUES[index % BAND_HUES.length];
      const selected = this.selectedAnimation !== null && name === this.selectedAnimation;
      ctx.fillStyle = `hsla(${hue}, 70%, 60%, ${selected ? 0.34 : 0.14})`;
      ctx.fillRect(column * cellW, row * cellH, cellW, cellH);
    }

    // Grid lines.
    ctx.strokeStyle = "rgba(216, 178, 104, 0.35)";
    ctx.lineWidth = 1;
    for (let c = 0; c <= grid.columns; c++) {
      const x = Math.round(c * cellW) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, grid.rows * cellH);
      ctx.stroke();
    }
    for (let r = 0; r <= grid.rows; r++) {
      const y = Math.round(r * cellH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(grid.columns * cellW, y);
      ctx.stroke();
    }

    // Animation labels at each animation's first frame.
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textBaseline = "top";
    grid.animations.forEach((animation, index) => {
      const column = animation.start_column % grid.columns;
      const row = animation.row;
      const hue = BAND_HUES[index % BAND_HUES.length];
      const x = column * cellW + 3;
      const y = row * cellH + 3;
      ctx.fillStyle = "rgba(10, 8, 14, 0.75)";
      const width = ctx.measureText(animation.name).width;
      ctx.fillRect(x - 2, y - 2, width + 6, 15);
      ctx.fillStyle = `hsl(${hue}, 75%, 72%)`;
      ctx.fillText(animation.name, x, y);
    });
  }
}

function drawMissingPlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const tile = 16;
  for (let y = 0; y < h; y += tile) {
    for (let x = 0; x < w; x += tile) {
      ctx.fillStyle = ((x + y) / tile) % 2 === 0 ? "#241f30" : "#1a1622";
      ctx.fillRect(x, y, tile, tile);
    }
  }
  ctx.fillStyle = "#8a8397";
  ctx.font = "13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("image not found — grid preview only", w / 2, Math.min(h / 2, 40));
  ctx.textAlign = "left";
}

/** Draw the end-product contact sheet: one labelled strip per animation, each
 *  frame cropped (and flipped) exactly as the cutter will write it. */
export function drawContactSheet(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement | null,
  plans: AnimationPlan[],
  scale: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const layout = layoutContactSheet(plans);
  canvas.width = Math.max(1, Math.round(layout.width * scale));
  canvas.height = Math.max(1, Math.round(layout.height * scale));
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#141019";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.font = `600 ${Math.max(11, Math.round(11 * Math.min(scale, 1.4)))}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  plans.forEach((plan, index) => {
    ctx.fillStyle = "#d8b268";
    ctx.fillText(
      `${plan.name}  ·  ${plan.frames.length} frame(s) @ ${plan.fps} fps  →  ${plan.dir}/`,
      8 * scale,
      layout.labelYs[index] * scale + 2,
    );
  });

  for (const cell of layout.cells) {
    const dx = Math.round(cell.dx * scale);
    const dy = Math.round(cell.dy * scale);
    const dw = Math.round(cell.frame.w * scale);
    const dh = Math.round(cell.frame.h * scale);
    ctx.fillStyle = "#0e0b13";
    ctx.fillRect(dx, dy, dw, dh);
    if (image) {
      ctx.save();
      if (cell.frame.flipX) {
        ctx.translate(dx + dw, dy);
        ctx.scale(-1, 1);
        ctx.drawImage(image, cell.frame.sx, cell.frame.sy, cell.frame.w, cell.frame.h, 0, 0, dw, dh);
      } else {
        ctx.drawImage(image, cell.frame.sx, cell.frame.sy, cell.frame.w, cell.frame.h, dx, dy, dw, dh);
      }
      ctx.restore();
    }
    ctx.strokeStyle = "rgba(216, 178, 104, 0.25)";
    ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
  }
}

/** Hit-test the contact sheet for the status bar: which output file is under
 *  the cursor. */
export function contactSheetHit(
  plans: AnimationPlan[],
  scale: number,
  x: number,
  y: number,
): { dir: string; filename: string } | null {
  const layout = layoutContactSheet(plans);
  const ux = x / scale;
  const uy = y / scale;
  for (const cell of layout.cells) {
    if (
      ux >= cell.dx &&
      ux < cell.dx + cell.frame.w &&
      uy >= cell.dy + ATLAS_LABEL_H * 0 && // frames sit below their label row
      uy >= cell.dy &&
      uy < cell.dy + cell.frame.h
    ) {
      return { dir: cell.plan.dir, filename: cell.frame.filename };
    }
  }
  return null;
}
