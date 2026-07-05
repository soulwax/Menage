import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

// Vite config for the Menage web frontend. Tauri serves the built app; during
// development `vite dev` runs the UI. Web-only mode is read-only: the plugin
// below serves the game repo so the stage/atlas views work in a plain browser,
// while saving and cutting still require the Tauri shell.

/** Serve the EchoWarrior repo (read-only) for web-dev mode:
 *  - GET /@game/<rel-path>          → the file's bytes (png/toml/…)
 *  - GET /@game-ls?dir=<rel>&ext=png → JSON array of matching rel paths (recursive)
 *  Root: MENAGE_GAME_ROOT env var, else ../.. (the tools/menage submodule spot). */
function serveGameRepo(): Plugin {
  const gameRoot = path.resolve(process.env.MENAGE_GAME_ROOT ?? "../..");

  const contentTypes: Record<string, string> = {
    ".png": "image/png",
    ".toml": "text/plain; charset=utf-8",
    ".json": "application/json",
  };

  function listFiles(dir: string, ext: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) listFiles(full, ext, out);
      else if (entry.name.toLowerCase().endsWith(ext)) {
        out.push(path.relative(gameRoot, full).replaceAll("\\", "/"));
      }
    }
  }

  return {
    name: "menage-serve-game",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname.startsWith("/@game/")) {
          const rel = decodeURIComponent(url.pathname.slice("/@game/".length));
          const full = path.resolve(gameRoot, rel);
          if (!full.startsWith(gameRoot) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          res.setHeader(
            "Content-Type",
            contentTypes[path.extname(full).toLowerCase()] ?? "application/octet-stream",
          );
          res.end(fs.readFileSync(full));
          return;
        }
        if (url.pathname === "/@game-ls") {
          const rel = url.searchParams.get("dir") ?? "";
          const ext = "." + (url.searchParams.get("ext") ?? "png").replace(/^\./, "");
          const full = path.resolve(gameRoot, rel);
          const out: string[] = [];
          if (full.startsWith(gameRoot)) listFiles(full, ext.toLowerCase(), out);
          out.sort();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(out));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [serveGameRepo()],
  server: {
    port: 5174, // 5173 belongs to Leitmotif; keep both tools runnable at once.
    strictPort: true,
    // Never watch the Rust side (locked build artifacts crash the watcher).
    watch: {
      ignored: ["**/src-tauri/**", "**/target/**", "**/node_modules/**", "**/dist/**"],
    },
  },
  // Tauri expects a relative base so the built assets load from the app bundle.
  base: "./",
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
