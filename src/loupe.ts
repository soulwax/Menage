// The playback loupe: a small canvas that plays one animation at its authored
// fps, using the same frame plan the cutter uses — so what loops here is what
// the game will get.

import type { AnimationPlan } from "./atlas";

export class Loupe {
  private image: HTMLImageElement | null = null;
  private plan: AnimationPlan | null = null;
  private frame = 0;
  private playing = false;
  private lastTick = 0;
  private raf = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private label: HTMLElement,
    private playButton: HTMLButtonElement,
  ) {
    playButton.addEventListener("click", () => this.toggle());
  }

  setAnimation(image: HTMLImageElement | null, plan: AnimationPlan | null): void {
    this.image = image;
    this.plan = plan;
    this.frame = 0;
    this.label.textContent = plan
      ? `${plan.name} · ${plan.frames.length}f @ ${plan.fps}fps`
      : "no animation";
    if (!plan) this.stop();
    this.draw();
  }

  toggle(): void {
    if (this.playing) this.stop();
    else this.play();
  }

  private play(): void {
    if (!this.plan || this.plan.frames.length === 0) return;
    this.playing = true;
    this.playButton.textContent = "⏸";
    this.lastTick = performance.now();
    const step = (now: number) => {
      if (!this.playing || !this.plan) return;
      const frameDuration = 1000 / Math.max(this.plan.fps, 0.001);
      if (now - this.lastTick >= frameDuration) {
        this.frame = (this.frame + 1) % this.plan.frames.length;
        this.lastTick += frameDuration;
        // If we fell far behind (tab hidden), resync instead of fast-forwarding.
        if (now - this.lastTick > 1000) this.lastTick = now;
        this.draw();
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  stop(): void {
    this.playing = false;
    this.playButton.textContent = "▶";
    cancelAnimationFrame(this.raf);
  }

  private draw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    // Checker backdrop so transparent pixels read as transparency.
    const tile = 8;
    for (let y = 0; y < this.canvas.height; y += tile) {
      for (let x = 0; x < this.canvas.width; x += tile) {
        ctx.fillStyle = (x / tile + y / tile) % 2 === 0 ? "#1b1724" : "#151119";
        ctx.fillRect(x, y, tile, tile);
      }
    }
    if (!this.image || !this.plan || this.plan.frames.length === 0) return;
    const frame = this.plan.frames[Math.min(this.frame, this.plan.frames.length - 1)];
    const scale = Math.max(
      1,
      Math.floor(Math.min(this.canvas.width / frame.w, this.canvas.height / frame.h)),
    );
    const dw = frame.w * scale;
    const dh = frame.h * scale;
    const dx = Math.floor((this.canvas.width - dw) / 2);
    const dy = Math.floor((this.canvas.height - dh) / 2);
    ctx.save();
    if (frame.flipX) {
      ctx.translate(dx + dw, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(this.image, frame.sx, frame.sy, frame.w, frame.h, 0, 0, dw, dh);
    } else {
      ctx.drawImage(this.image, frame.sx, frame.sy, frame.w, frame.h, dx, dy, dw, dh);
    }
    ctx.restore();

    if (this.plan.frames.length > 1) {
      const text = `${this.frame + 1}/${this.plan.frames.length}`;
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.textBaseline = "bottom";
      const width = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(10, 8, 14, 0.75)";
      ctx.fillRect(this.canvas.width - width - 8, this.canvas.height - 15, width + 8, 15);
      ctx.fillStyle = "#d8b268";
      ctx.fillText(text, this.canvas.width - width - 4, this.canvas.height - 3);
    }
  }
}
