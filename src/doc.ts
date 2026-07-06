// Document model — the single owner of edit state, following the SceneDoc
// (Leitmotif) / AudioDoc (soundgarden) convention: every mutation goes through
// `apply()`, which is also the one place undo history is recorded. The UI
// never mutates document values directly.
//
// `HistoryDoc<T>` is the generic engine; `MenageDoc` (the spritesheets.toml
// instruction file) and `AtlasDoc` (one atlas/grid descriptor file) are the
// two concrete documents.

import {
  parseInstructions,
  serializeInstructions,
  type Instructions,
} from "./instructions";
import { refreshRects, serializeAtlasFile, type AtlasFile } from "./atlasfile";

const HISTORY_CAP = 100;

export class HistoryDoc<T> {
  value: T;
  dirty = false;

  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private listeners: Array<() => void> = [];

  constructor(initial: T) {
    this.value = initial;
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  protected notify(): void {
    for (const listener of this.listeners) listener();
  }

  private snapshot(): T {
    return structuredClone(this.value);
  }

  /** Replace the whole value and clear history (load / reload). */
  reset(value: T): void {
    this.value = value;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.notify();
  }

  /** Run one mutation. Records history, marks dirty, notifies subscribers. */
  apply(mutate: (value: T) => void): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift();
    this.redoStack = [];
    mutate(this.value);
    this.dirty = true;
    this.notify();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.snapshot());
    this.value = previous;
    this.dirty = true;
    this.notify();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.value = next;
    this.dirty = true;
    this.notify();
  }

  /** Mark the current state as saved (after a successful write). */
  markSaved(): void {
    this.dirty = false;
    this.notify();
  }
}

/** The spritesheets.toml instruction document. */
export class MenageDoc extends HistoryDoc<Instructions> {
  constructor() {
    super({ sheets: [], tilesets: [] });
  }

  get instructions(): Instructions {
    return this.value;
  }

  /** Replace the whole document from file text (Reload / first load). */
  load(text: string): void {
    this.reset(parseInstructions(text));
  }

  serialize(): string {
    return serializeInstructions(this.value);
  }
}

/** One editable atlas/grid descriptor file. Derived sprite rects refresh
 *  after every mutation so the stage always draws the edited truth. */
export class AtlasDoc extends HistoryDoc<AtlasFile> {
  get atlas(): AtlasFile {
    return this.value;
  }

  override apply(mutate: (atlas: AtlasFile) => void): void {
    super.apply((atlas) => {
      mutate(atlas);
      refreshRects(atlas);
    });
  }

  serialize(): string {
    return serializeAtlasFile(this.value);
  }
}
