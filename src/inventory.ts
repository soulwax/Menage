// Pure cross-reference logic: instructions × PNGs on disk × the asset_pack
// listing. No I/O here — main.ts feeds it data through the bridge, tests feed
// it fixtures.

import type { Instructions } from "./instructions";

/** Normalize a repo-relative path for comparison (the game always uses
 *  forward slashes; Windows tooling sometimes hands us backslashes). */
export function normalizePath(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Parse `asset_pack --dry-run --list` output: one relative path per line,
 *  with `asset_pack:` summary lines at the end. Tolerant of noise. */
export function parsePackList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("asset_pack:"))
    .map(normalizePath);
}

export interface AuditRow {
  path: string;
  /** Instruction ids (sheets/tilesets) that reference this image. */
  registeredBy: string[];
  /** Whether asset_pack discovered it (it will ship in data.pak). */
  ships: boolean;
}

export interface Audit {
  /** Every image referenced by the instructions. */
  rows: AuditRow[];
  /** PNGs on disk under the scanned root that no instruction references. */
  unregistered: string[];
}

/** Cross-reference the three sources of truth. `diskPngs` and `packList` are
 *  repo-relative paths; either may be empty when a source is unavailable
 *  (web-only mode, missing binary) — the audit degrades instead of failing. */
export function crossReference(
  instructions: Instructions,
  diskPngs: string[],
  packList: string[],
): Audit {
  const registered = new Map<string, string[]>();
  for (const sheet of instructions.sheets) {
    const key = normalizePath(sheet.path);
    registered.set(key, [...(registered.get(key) ?? []), sheet.id]);
  }
  for (const tileset of instructions.tilesets) {
    const key = normalizePath(tileset.path);
    registered.set(key, [...(registered.get(key) ?? []), tileset.id]);
  }

  const shipping = new Set(packList.map(normalizePath));

  const rows: AuditRow[] = [...registered.entries()]
    .map(([path, ids]) => ({ path, registeredBy: ids, ships: shipping.has(path) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const unregistered = diskPngs
    .map(normalizePath)
    .filter((path) => !registered.has(path))
    .sort();

  return { rows, unregistered };
}

/** Human-readable audit report for the report panel. */
export function formatAudit(audit: Audit, packListAvailable: boolean): string {
  const lines: string[] = [];
  lines.push(`registered images: ${audit.rows.length}`);
  for (const row of audit.rows) {
    const ship = packListAvailable ? (row.ships ? "ships" : "NOT IN PACK") : "pack unknown";
    lines.push(`  [${ship}] ${row.path}  ← ${row.registeredBy.join(", ")}`);
  }
  lines.push("");
  lines.push(`unregistered PNGs under Assets/Graphics/sprites: ${audit.unregistered.length}`);
  for (const path of audit.unregistered) lines.push(`  [orphan] ${path}`);
  return lines.join("\n");
}
