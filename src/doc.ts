// MenageDoc — the single owner of edit state, following the SceneDoc
// (Leitmotif) / AudioDoc (soundgarden) convention: every mutation goes through
// `apply()`, which is also the one place undo history is recorded. The UI
// never mutates `instructions` directly.

import {
  parseInstructions,
  serializeInstructions,
  type Instructions,
} from "./instructions";

const HISTORY_CAP = 100;

export class MenageDoc {
  instructions: Instructions = { sheets: [], tilesets: [] };
  dirty = false;

  private undoStack: Instructions[] = [];
  private redoStack: Instructions[] = [];
  private listeners: Array<() => void> = [];

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private snapshot(): Instructions {
    return structuredClone(this.instructions);
  }

  /** Replace the whole document from file text (Reload / first load). */
  load(text: string): void {
    this.instructions = parseInstructions(text);
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.notify();
  }

  serialize(): string {
    return serializeInstructions(this.instructions);
  }

  /** Run one named mutation against the instructions. Records history,
   *  marks the doc dirty, and notifies subscribers. */
  apply(mutate: (instructions: Instructions) => void): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift();
    this.redoStack = [];
    mutate(this.instructions);
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
    this.instructions = previous;
    this.dirty = true;
    this.notify();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.instructions = next;
    this.dirty = true;
    this.notify();
  }

  /** Mark the current state as saved (after a successful write). */
  markSaved(): void {
    this.dirty = false;
    this.notify();
  }
}
