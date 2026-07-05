// The inspector: plain-DOM forms for one sheet or tileset. Every commit goes
// through doc.apply() (one undo step per changed field); main re-renders on
// doc change, so this file only builds DOM and forwards edits.

import type { MenageDoc } from "./doc";
import type { AnimationDef, SheetDef, TilesetDef } from "./instructions";
import type { AtlasFile } from "./atlasfile";

export type Selection =
  | { type: "sheet"; id: string }
  | { type: "tileset"; id: string }
  | { type: "atlasfile"; path: string }
  | null;

export interface InspectorHooks {
  onSelectAnimation: (name: string | null) => void;
  onSelectSprite: (name: string | null) => void;
  onDeleteEntry: () => void;
}

const SHEET_KINDS = ["character", "tile_animation", "object_animation", "particle"];

function field(
  label: string,
  input: HTMLElement,
  title?: string,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "field";
  const l = document.createElement("label");
  l.textContent = label;
  if (title) l.title = title;
  row.append(l, input);
  return row;
}

function textInput(value: string, commit: (v: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.addEventListener("change", () => commit(input.value.trim()));
  return input;
}

function numberInput(value: number, commit: (v: number) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.addEventListener("change", () => {
    const parsed = Number(input.value);
    commit(Number.isFinite(parsed) ? parsed : value);
  });
  return input;
}

function checkbox(value: boolean, commit: (v: boolean) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = value;
  input.addEventListener("change", () => commit(input.checked));
  return input;
}

function kindSelect(value: string, commit: (v: string) => void): HTMLSelectElement {
  const select = document.createElement("select");
  const kinds = SHEET_KINDS.includes(value) ? SHEET_KINDS : [value, ...SHEET_KINDS];
  for (const kind of kinds) {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = kind;
    option.selected = kind === value;
    select.append(option);
  }
  select.addEventListener("change", () => commit(select.value));
  return select;
}

function findSheet(doc: MenageDoc, id: string): SheetDef | undefined {
  return doc.instructions.sheets.find((s) => s.id === id);
}
function findTileset(doc: MenageDoc, id: string): TilesetDef | undefined {
  return doc.instructions.tilesets.find((t) => t.id === id);
}

export function renderInspector(
  host: HTMLElement,
  doc: MenageDoc,
  selection: Selection,
  selectedAnimation: string | null,
  atlas: AtlasFile | null,
  selectedSprite: string | null,
  hooks: InspectorHooks,
): void {
  host.textContent = "";
  if (!selection) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Select a sheet or tileset to edit its cutting instructions.";
    host.append(p);
    return;
  }

  if (selection.type === "atlasfile") {
    if (atlas) host.append(atlasPanel(atlas, selectedSprite, hooks));
    return;
  }

  if (selection.type === "tileset") {
    const tileset = findTileset(doc, selection.id);
    if (!tileset) return;
    host.append(tilesetForm(doc, tileset, hooks));
    return;
  }

  const sheet = findSheet(doc, selection.id);
  if (!sheet) return;
  host.append(sheetForm(doc, sheet, selectedAnimation, hooks));
}

/** Read-only descriptor panel: the header facts plus the named sprites as a
 *  clickable roster (placeholder-named cells stay discoverable via hover on
 *  the stage instead of flooding the list). */
function atlasPanel(
  atlas: AtlasFile,
  selectedSprite: string | null,
  hooks: InspectorHooks,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const head = document.createElement("h3");
  head.textContent = `Atlas — ${atlas.path.split("/").pop()}`;
  frag.append(head);

  const facts = document.createElement("pre");
  facts.className = "atlas-facts";
  facts.textContent = [
    `image    ${atlas.image}`,
    `type     ${atlas.kind}`,
    `tile     ${atlas.tileWidth}×${atlas.tileHeight}`,
    `grid     ${atlas.columns}×${atlas.rows}` +
      (atlas.paddingX || atlas.paddingY ? `  gutter ${atlas.paddingX},${atlas.paddingY}` : ""),
    `sprites  ${atlas.sprites.length}`,
    "",
    "read-only — descriptors have no CLI validator to gate a save with yet",
  ].join("\n");
  frag.append(facts);

  const named = atlas.sprites.filter((s) => !/^(portrait|sprite|tile)_r?\d/i.test(s.name));
  const listHead = document.createElement("div");
  listHead.className = "lib-group-head";
  const h = document.createElement("h3");
  h.textContent = `Named sprites (${named.length})`;
  listHead.append(h);
  frag.append(listHead);

  const list = document.createElement("ul");
  list.className = "lib-list";
  for (const sprite of named) {
    const li = document.createElement("li");
    li.textContent = sprite.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${sprite.rect.x},${sprite.rect.y}`;
    li.append(meta);
    if (sprite.name === selectedSprite) li.classList.add("selected");
    li.addEventListener("click", () => hooks.onSelectSprite(sprite.name));
    list.append(li);
  }
  frag.append(list);
  return frag;
}

function sheetForm(
  doc: MenageDoc,
  sheet: SheetDef,
  selectedAnimation: string | null,
  hooks: InspectorHooks,
): DocumentFragment {
  const id = sheet.id;
  const edit = (mutate: (s: SheetDef) => void) =>
    doc.apply((instructions) => {
      const target = instructions.sheets.find((s) => s.id === id);
      if (target) mutate(target);
    });

  const frag = document.createDocumentFragment();
  const head = document.createElement("h3");
  head.textContent = `Sheet — ${sheet.id}`;
  frag.append(head);

  frag.append(
    field("id", textInput(sheet.id, (v) => edit((s) => (s.id = v)))),
    field("path", textInput(sheet.path, (v) => edit((s) => (s.path = v))), "PNG path, relative to the game repo root"),
    field("kind", kindSelect(sheet.kind, (v) => edit((s) => (s.kind = v)))),
    field("frame w", numberInput(sheet.frame_width, (v) => edit((s) => (s.frame_width = v)))),
    field("frame h", numberInput(sheet.frame_height, (v) => edit((s) => (s.frame_height = v)))),
    field("columns", numberInput(sheet.columns, (v) => edit((s) => (s.columns = v)))),
    field("rows", numberInput(sheet.rows, (v) => edit((s) => (s.rows = v)))),
    field("output", textInput(sheet.output_dir, (v) => edit((s) => (s.output_dir = v))), "Cut frames land here (Generated/Sprites/…)"),
  );

  const animationsHead = document.createElement("div");
  animationsHead.className = "lib-group-head";
  const h = document.createElement("h3");
  h.textContent = `Animations (${sheet.animations.length})`;
  const addButton = document.createElement("button");
  addButton.className = "mini ghost";
  addButton.textContent = "+ add";
  addButton.addEventListener("click", () => {
    edit((s) => {
      let n = s.animations.length;
      let name = `animation_${n}`;
      while (s.animations.some((a) => a.name === name)) name = `animation_${++n}`;
      s.animations.push({ name, row: 0, start_column: 0, frame_count: 1, fps: 8, flip_x: false });
    });
  });
  animationsHead.append(h, addButton);
  frag.append(animationsHead);

  sheet.animations.forEach((animation, index) => {
    frag.append(animationForm(animation, index, selectedAnimation, edit, hooks));
  });

  frag.append(deleteButton(`Delete sheet '${sheet.id}'`, hooks));
  return frag;
}

function animationForm(
  animation: AnimationDef,
  index: number,
  selectedAnimation: string | null,
  edit: (mutate: (s: SheetDef) => void) => void,
  hooks: InspectorHooks,
): HTMLFieldSetElement {
  const set = document.createElement("fieldset");
  set.className = "animation";
  if (animation.name === selectedAnimation) set.classList.add("selected");

  const legend = document.createElement("legend");
  legend.textContent = animation.name || "(unnamed)";
  legend.title = "Click to preview this animation in the loupe";
  legend.addEventListener("click", () => hooks.onSelectAnimation(animation.name));
  set.append(legend);

  set.append(
    field("name", textInput(animation.name, (v) => edit((s) => (s.animations[index].name = v)))),
    field("row", numberInput(animation.row, (v) => edit((s) => (s.animations[index].row = v)))),
    field("start col", numberInput(animation.start_column, (v) => edit((s) => (s.animations[index].start_column = v)))),
    field("frames", numberInput(animation.frame_count, (v) => edit((s) => (s.animations[index].frame_count = v)))),
    field("fps", numberInput(animation.fps, (v) => edit((s) => (s.animations[index].fps = v)))),
    field("flip x", checkbox(animation.flip_x, (v) => edit((s) => (s.animations[index].flip_x = v)))),
  );

  const remove = document.createElement("button");
  remove.className = "mini danger";
  remove.textContent = "remove";
  remove.addEventListener("click", () => {
    if (animation.name === selectedAnimation) hooks.onSelectAnimation(null);
    edit((s) => s.animations.splice(index, 1));
  });
  set.append(remove);
  return set;
}

function tilesetForm(doc: MenageDoc, tileset: TilesetDef, hooks: InspectorHooks): DocumentFragment {
  const id = tileset.id;
  const edit = (mutate: (t: TilesetDef) => void) =>
    doc.apply((instructions) => {
      const target = instructions.tilesets.find((t) => t.id === id);
      if (target) mutate(target);
    });

  const frag = document.createDocumentFragment();
  const head = document.createElement("h3");
  head.textContent = `Tileset — ${tileset.id}`;
  frag.append(head);
  frag.append(
    field("id", textInput(tileset.id, (v) => edit((t) => (t.id = v)))),
    field("path", textInput(tileset.path, (v) => edit((t) => (t.path = v)))),
    field("tile w", numberInput(tileset.tile_width, (v) => edit((t) => (t.tile_width = v)))),
    field("tile h", numberInput(tileset.tile_height, (v) => edit((t) => (t.tile_height = v)))),
    field("columns", numberInput(tileset.columns, (v) => edit((t) => (t.columns = v)))),
    field("rows", numberInput(tileset.rows, (v) => edit((t) => (t.rows = v)))),
  );
  frag.append(deleteButton(`Delete tileset '${tileset.id}'`, hooks));
  return frag;
}

function deleteButton(label: string, hooks: InspectorHooks): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "small danger delete-entry";
  button.textContent = label;
  button.addEventListener("click", () => hooks.onDeleteEntry());
  return button;
}
