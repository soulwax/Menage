// The inspector: plain-DOM forms for one sheet or tileset. Every commit goes
// through doc.apply() (one undo step per changed field); main re-renders on
// doc change, so this file only builds DOM and forwards edits.

import type { AtlasDoc, MenageDoc } from "./doc";
import type { AnimationDef, SheetDef, TilesetDef } from "./instructions";
import { swapAnimationFrames, type AtlasAnimation, type AtlasFile, type AtlasSprite } from "./atlasfile";

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
  /** Open (or close, on null) an atlas animation for editing — drives the
   *  loupe preview and the stage's "add frame" click mode. */
  onSelectAtlasAnimation: (name: string | null) => void;
  /** Same rename-before-mutate convention, for the open atlas animation. */
  onRenameAtlasAnimation: (newName: string) => void;
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
  selectedAtlasAnimation: string | null,
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
    if (atlasDoc) host.append(atlasForm(atlasDoc, selectedSprite, selectedAtlasAnimation, hooks));
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
  selectedAnimation: string | null,
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

  // Animations: a name roster plus one focused editor (frame reorder/add/
  // remove, fps/duration), the same "one open thing" shape as sprites below.
  const animHead = document.createElement("div");
  animHead.className = "lib-group-head";
  const animTitle = document.createElement("h3");
  animTitle.textContent = `Animations (${atlas.animations.length})`;
  const addAnimButton = document.createElement("button");
  addAnimButton.className = "mini ghost";
  addAnimButton.textContent = "+ add";
  addAnimButton.addEventListener("click", () => {
    let name = `animation_${atlas.animations.length}`;
    let n = atlas.animations.length;
    while (atlas.animations.some((a) => a.name === name)) name = `animation_${++n}`;
    edit((a) => {
      a.animations.push({ name, frames: [], fps: 8, frameDurationMs: null });
    });
    hooks.onSelectAtlasAnimation(name);
  });
  animHead.append(animTitle, addAnimButton);
  frag.append(animHead);

  if (atlas.animations.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No animations yet.";
    frag.append(p);
  } else {
    const animList = document.createElement("ul");
    animList.className = "lib-list";
    for (const animation of atlas.animations) {
      const li = document.createElement("li");
      li.textContent = animation.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${animation.frames.length}f`;
      li.append(meta);
      if (animation.name === selectedAnimation) li.classList.add("selected");
      li.addEventListener("click", () =>
        hooks.onSelectAtlasAnimation(animation.name === selectedAnimation ? null : animation.name),
      );
      animList.append(li);
    }
    frag.append(animList);
  }

  const openAnimation = atlas.animations.find((a) => a.name === selectedAnimation);
  if (openAnimation) frag.append(atlasAnimationEditor(atlasDoc, openAnimation, hooks));

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

/** The focused editor for one open atlas animation: rename, fps/duration,
 *  and the frame list — reorder (up/down), remove, and add by name (the
 *  primary "add" path is clicking a cell on the stage; see main.ts's
 *  frame-picker mode, wired through onSelectAtlasAnimation being non-null). */
function atlasAnimationEditor(
  atlasDoc: AtlasDoc,
  animation: AtlasAnimation,
  hooks: InspectorHooks,
): HTMLFieldSetElement {
  const atlas = atlasDoc.atlas;
  const name = animation.name;
  const editAnimation = (mutate: (a: AtlasAnimation) => void) =>
    atlasDoc.apply((current) => {
      const target = current.animations.find((a) => a.name === name);
      if (target) mutate(target);
    });

  const set = document.createElement("fieldset");
  set.className = "animation selected";
  const legend = document.createElement("legend");
  legend.textContent = `▶ ${animation.name}`;
  legend.title = "Click a cell on the stage to append it as a frame";
  set.append(legend);

  set.append(
    field("name", textInput(animation.name, "atlasanim.name", (v) => hooks.onRenameAtlasAnimation(v))),
    field("fps", numberInput(animation.fps ?? 8, "atlasanim.fps", (v) => editAnimation((a) => (a.fps = v)))),
    field(
      "duration ms",
      numberInput(animation.frameDurationMs ?? 0, "atlasanim.duration", (v) =>
        editAnimation((a) => (a.frameDurationMs = v > 0 ? v : null)),
      ),
      "alternative to fps; 0 clears it",
    ),
  );

  const frameHead = document.createElement("div");
  frameHead.className = "lib-group-head";
  const frameTitle = document.createElement("h3");
  frameTitle.textContent = `Frames (${animation.frames.length})`;
  frameHead.append(frameTitle);
  set.append(frameHead);

  if (animation.frames.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No frames yet — click a cell on the stage to add one.";
    set.append(p);
  }

  animation.frames.forEach((frameName, index) => {
    const row = document.createElement("div");
    row.className = "frame-row";
    const label = document.createElement("span");
    label.className = "frame-name";
    label.textContent = frameName;
    if (!atlas.sprites.some((s) => s.name === frameName)) {
      label.classList.add("frame-missing");
      label.title = "No sprite named this — the game will reject it";
    }
    row.append(label);

    const up = document.createElement("button");
    up.className = "mini ghost";
    up.textContent = "↑";
    up.disabled = index === 0;
    up.addEventListener("click", () =>
      editAnimation((a) => swapAnimationFrames(a, index, index - 1)),
    );

    const down = document.createElement("button");
    down.className = "mini ghost";
    down.textContent = "↓";
    down.disabled = index === animation.frames.length - 1;
    down.addEventListener("click", () =>
      editAnimation((a) => swapAnimationFrames(a, index, index + 1)),
    );

    const remove = document.createElement("button");
    remove.className = "mini danger";
    remove.textContent = "×";
    remove.title = "Remove this frame";
    remove.addEventListener("click", () => editAnimation((a) => a.frames.splice(index, 1)));

    row.append(up, down, remove);
    set.append(row);
  });

  const closeButton = document.createElement("button");
  closeButton.className = "small ghost";
  closeButton.textContent = "close";
  closeButton.addEventListener("click", () => hooks.onSelectAtlasAnimation(null));

  const removeButton = document.createElement("button");
  removeButton.className = "mini danger";
  removeButton.textContent = "remove animation";
  removeButton.addEventListener("click", () => {
    hooks.onSelectAtlasAnimation(null);
    atlasDoc.apply((current) => {
      current.animations = current.animations.filter((a) => a.name !== name);
    });
  });

  set.append(closeButton, removeButton);
  return set;
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
