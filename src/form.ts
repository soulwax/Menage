// The inspector: plain-DOM forms for one sheet or tileset. Every commit goes
// through doc.apply() (one undo step per changed field); main re-renders on
// doc change, so this file only builds DOM and forwards edits.

import type { AtlasDoc, MenageDoc } from "./doc";
import type { AnimationDef, SheetDef, TilesetDef } from "./instructions";
import type { AtlasFile, AtlasSprite } from "./atlasfile";

export type Selection =
  | { type: "sheet"; id: string }
  | { type: "tileset"; id: string }
  | { type: "atlasfile"; path: string }
  | null;

export interface InspectorHooks {
  onSelectAnimation: (name: string | null) => void;
  onSelectSprite: (name: string | null) => void;
  onDeleteEntry: () => void;
  /** Rename the selected entry: updates the selection BEFORE the doc mutation
   *  so the single re-render lands on the renamed entry (no lost selection). */
  onRename: (newId: string) => void;
  /** Same convention for the selected atlas sprite. */
  onRenameSprite: (newName: string) => void;
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

function textInput(value: string, focusKey: string, commit: (v: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.dataset.focusKey = focusKey;
  input.addEventListener("change", () => commit(input.value.trim()));
  return input;
}

function numberInput(value: number, focusKey: string, commit: (v: number) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.dataset.focusKey = focusKey;
  input.addEventListener("change", () => {
    const parsed = Number(input.value);
    commit(Number.isFinite(parsed) ? parsed : value);
  });
  return input;
}

function checkbox(value: boolean, focusKey: string, commit: (v: boolean) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = value;
  input.dataset.focusKey = focusKey;
  input.addEventListener("change", () => commit(input.checked));
  return input;
}

function kindSelect(value: string, focusKey: string, commit: (v: string) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.dataset.focusKey = focusKey;
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
  atlasDoc: AtlasDoc | null,
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
    if (atlasDoc) host.append(atlasForm(atlasDoc, selectedSprite, hooks));
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

/** Editable descriptor form: the grid header, one focused sprite editor (the
 *  565-cell symbols atlas must not become 565 forms), and the named roster.
 *  Every commit goes through the AtlasDoc; `sheets validate` gates the save. */
function atlasForm(
  atlasDoc: AtlasDoc,
  selectedSprite: string | null,
  hooks: InspectorHooks,
): DocumentFragment {
  const atlas = atlasDoc.atlas;
  const edit = (mutate: (a: AtlasFile) => void) => atlasDoc.apply(mutate);

  const frag = document.createDocumentFragment();
  const head = document.createElement("h3");
  head.textContent = `Atlas — ${atlas.path.split("/").pop()}`;
  frag.append(head);

  const kindSel = document.createElement("select");
  kindSel.dataset.focusKey = "atlas.kind";
  for (const kind of ["grid", "atlas"]) {
    const option = document.createElement("option");
    option.value = kind;
    option.textContent = kind;
    option.selected = kind === atlas.kind;
    kindSel.append(option);
  }
  kindSel.addEventListener("change", () =>
    edit((a) => (a.kind = kindSel.value as AtlasFile["kind"])),
  );

  frag.append(
    field("image", textInput(atlas.image, "atlas.image", (v) => edit((a) => (a.image = v))), "PNG path, relative to the game repo root"),
    field("type", kindSel),
    field("tile w", numberInput(atlas.tileWidth, "atlas.tile_width", (v) => edit((a) => (a.tileWidth = v)))),
    field("tile h", numberInput(atlas.tileHeight, "atlas.tile_height", (v) => edit((a) => (a.tileHeight = v)))),
    field("columns", numberInput(atlas.columns, "atlas.columns", (v) => edit((a) => (a.columns = v)))),
    field("rows", numberInput(atlas.rows, "atlas.rows", (v) => edit((a) => (a.rows = v)))),
    field("origin", numberPair(atlas.originX, atlas.originY, "atlas.origin", (x, y) => edit((a) => { a.originX = x; a.originY = y; }))),
    field("gutter", numberPair(atlas.paddingX, atlas.paddingY, "atlas.padding", (x, y) => edit((a) => { a.paddingX = x; a.paddingY = y; })), "padding_x / padding_y between cells"),
  );

  if (atlas.animations.length > 0) {
    const facts = document.createElement("pre");
    facts.className = "atlas-facts";
    facts.textContent =
      `animations  ${atlas.animations.length} (preserved verbatim on save)\n` +
      atlas.animations.map((a) => `  ${a.name} · ${a.frames.length}f`).join("\n");
    frag.append(facts);
  }

  // The one focused sprite editor.
  const spritesHead = document.createElement("div");
  spritesHead.className = "lib-group-head";
  const spritesTitle = document.createElement("h3");
  spritesTitle.textContent = `Sprites (${atlas.sprites.length})`;
  const addButton = document.createElement("button");
  addButton.className = "mini ghost";
  addButton.textContent = "+ add";
  addButton.addEventListener("click", () => {
    let name = `sprite_${atlas.sprites.length}`;
    let n = atlas.sprites.length;
    while (atlas.sprites.some((s) => s.name === name)) name = `sprite_${++n}`;
    const taken = new Set(atlas.sprites.map((s) => s.index));
    let index = 0;
    while (taken.has(index)) index++;
    edit((a) => {
      a.sprites.push({
        name,
        tags: [],
        index: a.kind === "grid" ? index : null,
        x: a.kind === "grid" ? null : 0,
        y: a.kind === "grid" ? null : 0,
        w: a.kind === "grid" ? null : a.tileWidth,
        h: a.kind === "grid" ? null : a.tileHeight,
        pivotX: null,
        pivotY: null,
        trimmed: false,
        rect: { x: 0, y: 0, w: 0, h: 0 },
      });
    });
    hooks.onSelectSprite(name);
  });
  spritesHead.append(spritesTitle, addButton);
  frag.append(spritesHead);

  const sprite = atlas.sprites.find((s) => s.name === selectedSprite);
  if (!sprite) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Click a cell on the stage (or a name below) to edit that sprite.";
    frag.append(p);
  } else {
    const set = document.createElement("fieldset");
    set.className = "animation selected";
    const legend = document.createElement("legend");
    legend.textContent = sprite.name;
    set.append(legend);

    const spriteName = sprite.name;
    const editSprite = (mutate: (s: AtlasSprite) => void) =>
      edit((a) => {
        const target = a.sprites.find((s) => s.name === spriteName);
        if (target) mutate(target);
      });

    set.append(
      field("name", textInput(sprite.name, "sprite.name", (v) => hooks.onRenameSprite(v))),
      field(
        "tags",
        textInput(sprite.tags.join(", "), "sprite.tags", (v) =>
          editSprite((s) => (s.tags = v.split(",").map((t) => t.trim()).filter((t) => t !== ""))),
        ),
        "comma-separated",
      ),
    );
    if (sprite.index !== null) {
      set.append(
        field("index", numberInput(sprite.index, "sprite.index", (v) => editSprite((s) => (s.index = v)))),
      );
    } else {
      set.append(
        field("x / y", numberPair(sprite.x ?? 0, sprite.y ?? 0, "sprite.pos", (x, y) => editSprite((s) => { s.x = x; s.y = y; }))),
        field("w / h", numberPair(sprite.w ?? 0, sprite.h ?? 0, "sprite.size", (w, h) => editSprite((s) => { s.w = w; s.h = h; }))),
      );
    }

    const remove = document.createElement("button");
    remove.className = "mini danger";
    remove.textContent = "remove";
    remove.addEventListener("click", () => {
      hooks.onSelectSprite(null);
      edit((a) => {
        a.sprites = a.sprites.filter((s) => s.name !== spriteName);
      });
    });
    set.append(remove);
    frag.append(set);
  }

  // Named roster (placeholder-named cells stay discoverable via the stage).
  const named = atlas.sprites.filter((s) => !/^(portrait|sprite|tile)_r?\d/i.test(s.name));
  const listHead = document.createElement("div");
  listHead.className = "lib-group-head";
  const h = document.createElement("h3");
  h.textContent = `Named sprites (${named.length})`;
  listHead.append(h);
  frag.append(listHead);

  const list = document.createElement("ul");
  list.className = "lib-list";
  for (const entry of named) {
    const li = document.createElement("li");
    li.textContent = entry.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${entry.rect.x},${entry.rect.y}`;
    li.append(meta);
    if (entry.name === selectedSprite) li.classList.add("selected");
    li.addEventListener("click", () => hooks.onSelectSprite(entry.name));
    list.append(li);
  }
  frag.append(list);
  return frag;
}

/** Two small number inputs sharing one field row (x/y, w/h pairs). */
function numberPair(
  a: number,
  b: number,
  focusKey: string,
  commit: (a: number, b: number) => void,
): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "pair";
  const first = numberInput(a, `${focusKey}.a`, (v) => commit(v, Number(second.value) || b));
  const second = numberInput(b, `${focusKey}.b`, (v) => commit(Number(first.value) || a, v));
  wrap.append(first, second);
  return wrap;
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
    field("id", textInput(sheet.id, "sheet.id", (v) => hooks.onRename(v))),
    field("path", textInput(sheet.path, "sheet.path", (v) => edit((s) => (s.path = v))), "PNG path, relative to the game repo root"),
    field("kind", kindSelect(sheet.kind, "sheet.kind", (v) => edit((s) => (s.kind = v)))),
    field("frame w", numberInput(sheet.frame_width, "sheet.frame_width", (v) => edit((s) => (s.frame_width = v)))),
    field("frame h", numberInput(sheet.frame_height, "sheet.frame_height", (v) => edit((s) => (s.frame_height = v)))),
    field("columns", numberInput(sheet.columns, "sheet.columns", (v) => edit((s) => (s.columns = v)))),
    field("rows", numberInput(sheet.rows, "sheet.rows", (v) => edit((s) => (s.rows = v)))),
    field("output", textInput(sheet.output_dir, "sheet.output_dir", (v) => edit((s) => (s.output_dir = v))), "Cut frames land here (Generated/Sprites/…)"),
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

  const key = (name: string) => `anim.${index}.${name}`;
  set.append(
    field("name", textInput(animation.name, key("name"), (v) => edit((s) => (s.animations[index].name = v)))),
    field("row", numberInput(animation.row, key("row"), (v) => edit((s) => (s.animations[index].row = v)))),
    field("start col", numberInput(animation.start_column, key("start_column"), (v) => edit((s) => (s.animations[index].start_column = v)))),
    field("frames", numberInput(animation.frame_count, key("frame_count"), (v) => edit((s) => (s.animations[index].frame_count = v)))),
    field("fps", numberInput(animation.fps, key("fps"), (v) => edit((s) => (s.animations[index].fps = v)))),
    field("flip x", checkbox(animation.flip_x, key("flip_x"), (v) => edit((s) => (s.animations[index].flip_x = v)))),
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
    field("id", textInput(tileset.id, "tileset.id", (v) => hooks.onRename(v))),
    field("path", textInput(tileset.path, "tileset.path", (v) => edit((t) => (t.path = v)))),
    field("tile w", numberInput(tileset.tile_width, "tileset.tile_width", (v) => edit((t) => (t.tile_width = v)))),
    field("tile h", numberInput(tileset.tile_height, "tileset.tile_height", (v) => edit((t) => (t.tile_height = v)))),
    field("columns", numberInput(tileset.columns, "tileset.columns", (v) => edit((t) => (t.columns = v)))),
    field("rows", numberInput(tileset.rows, "tileset.rows", (v) => edit((t) => (t.rows = v)))),
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
