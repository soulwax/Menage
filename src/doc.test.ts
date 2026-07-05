import { describe, expect, it } from "vitest";
import { MenageDoc } from "./doc";

const MINIMAL = `
[[sheets]]
id = "a"
path = "Assets/a.png"
kind = "character"
frame_width = 16
frame_height = 16
columns = 1
rows = 1
output_dir = "Generated/a"
`;

describe("MenageDoc", () => {
  it("load resets history and dirty state", () => {
    const doc = new MenageDoc();
    doc.load(MINIMAL);
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo).toBe(false);
    expect(doc.instructions.sheets[0].id).toBe("a");
  });

  it("apply mutates, marks dirty, and records one undo step", () => {
    const doc = new MenageDoc();
    doc.load(MINIMAL);
    doc.apply((i) => (i.sheets[0].columns = 6));
    expect(doc.instructions.sheets[0].columns).toBe(6);
    expect(doc.dirty).toBe(true);
    expect(doc.canUndo).toBe(true);

    doc.undo();
    expect(doc.instructions.sheets[0].columns).toBe(1);
    expect(doc.canRedo).toBe(true);

    doc.redo();
    expect(doc.instructions.sheets[0].columns).toBe(6);
  });

  it("a new apply clears the redo stack", () => {
    const doc = new MenageDoc();
    doc.load(MINIMAL);
    doc.apply((i) => (i.sheets[0].columns = 6));
    doc.undo();
    doc.apply((i) => (i.sheets[0].rows = 3));
    expect(doc.canRedo).toBe(false);
    expect(doc.instructions.sheets[0].rows).toBe(3);
    expect(doc.instructions.sheets[0].columns).toBe(1);
  });

  it("notifies subscribers on every state change", () => {
    const doc = new MenageDoc();
    let calls = 0;
    doc.onChange(() => calls++);
    doc.load(MINIMAL);
    doc.apply((i) => (i.sheets[0].columns = 2));
    doc.undo();
    doc.redo();
    doc.markSaved();
    expect(calls).toBe(5);
    expect(doc.dirty).toBe(false);
  });
});
