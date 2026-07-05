# Menage

> *Ménage* is French for housekeeping. This is the asset housekeeper for
> **EchoWarrior** — a desktop app for the developers who own the pipeline:
> it manages the game's *graphics instructions* (which image is a sprite
> sheet, how its tiles are cut, which frames belong to which animation) and
> shows the exact end product before a single file is written.

Menage is a **Tauri + web** app, built parallel to
[Leitmotif](https://github.com/soulwax/Leitmotif) (the scene director) and
[soundgarden](https://github.com/soulwax/soundgarden) (the audio studio).
Where those two face writers and sound designers, Menage faces deep
developers. Same family, same rules, same look.

See the design spec in the game repo:
`Docs/superpowers/specs/2026-07-05-menage-asset-manager-design.md`.

## The one architectural rule

Menage does not touch game code. It talks to EchoWarrior through three doors
and nothing else:

- **`Assets/Metadata/spritesheets.toml`** — the cut-instruction file. The only
  file under `Assets/` Menage ever writes.
- **the `sprite_cutter` CLI** — `--dry-run` is the *authoritative* validator;
  the real cut writes `Generated/Sprites/`. Menage never cuts files itself.
- **the `asset_pack` CLI** — `--dry-run --list` is the ground truth for
  "does this asset actually ship in `data.pak`".

Known deviation, stated plainly: `sprite_cutter` has no lossless TOML↔JSON
door (unlike `choreo` / `audio`), so Menage parses and serializes
`spritesheets.toml` in the web layer (`smol-toml`). Drift cannot silently
break the game because **every save passes through `sprite_cutter --dry-run`
first** — the game's own parser and validator remain the authority.

## What it does (Phase 1 — the cutting room)

- **Stage**: the source sheet pixel-perfect, cutting grid overlaid, each
  animation's cells tinted and labelled, hover for cell/pixel info, click a
  band to select its animation. Zoom fit/1×/2×/4×/8×.
- **Atlas — end product**: a WYSIWYG contact sheet of exactly what the cutter
  will write — crops, `flip_x`, output filenames, output dirs — composed live
  from the source PNG and the current (unsaved) instructions.
- **Instructions editor**: forms for sheets, tilesets, and animations. Every
  edit flows through one document model (`MenageDoc`) with dirty tracking and
  undo/redo (`Ctrl+Z` / `Ctrl+Y`).
- **Loupe**: plays the selected animation at its authored fps.
- **Findings ribbon**: client-side lint (duplicate ids, frames past the grid,
  the cutter's exact-dimension rule, …) as a green/amber/red chip.
- **Save to game**: refuses on error-level findings, then runs the *unsaved*
  text through `sprite_cutter --dry-run` (via a temp file) before writing —
  the editor can never break the repo. `Ctrl+S` works.
- **Cut**: dry-run / cut sheet / cut all through the game's own binary; the
  CLI report shows verbatim. Cutting is blocked while the doc is dirty.
- **Unregistered scan**: PNGs under `Assets/Graphics/sprites` that no
  instruction references; one click registers a sheet with a suggested id.
- **Audit**: cross-references instructions × disk × `asset_pack --dry-run
  --list` — what ships, what doesn't, what's orphaned.

## Build & run

```bash
# 1. Build the game's CLIs (from the EchoWarrior repo root):
cargo build --bin sprite_cutter --bin asset_pack

# 2. Run Menage (from this folder):
npm install
MENAGE_GAME_ROOT=/path/to/EchoWarrior \
MENAGE_SPRITE_CUTTER_BIN=/path/to/EchoWarrior/target/debug/sprite_cutter \
MENAGE_ASSET_PACK_BIN=/path/to/EchoWarrior/target/debug/asset_pack \
npm run tauri:dev
```

Without the env vars, the binaries are looked up on PATH and the app asks you
to pick the game repo folder on launch.

### Web-only mode (read-only)

```bash
npm run dev   # http://localhost:5174
```

`vite dev` serves the game repo itself (root from `MENAGE_GAME_ROOT`, default
`../..` — the `tools/menage` submodule spot), so the stage, atlas, loupe, and
findings all work in a plain browser. Saving and cutting need the desktop
shell and say so.

## Tests

```bash
npm test        # vitest: instruction round-trips, lint table, cutter math, audit
npm run build   # tsc + vite build
```

The atlas math (`src/atlas.ts`) mirrors the game's `src/bin/sprite_cutter.rs`
frame for frame — including row wrap, the full-grid fallback, and the
`animation.toml` manifest text, which is tested byte-for-byte. If the cutter
changes, that file follows.
