import { defineConfig } from "vite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function countFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce(
    (total, entry) => total + (entry.isDirectory() ? countFiles(join(directory, entry.name)) : 1),
    0,
  );
}

export default defineConfig({
  root: "public",
  publicDir: false,
  plugins: [{
    name: "notelet-resource-manifest",
    generateBundle() {
      for (const file of ["notelet.mjs", "publish.mjs"]) {
        this.emitFile({
          type: "asset",
          fileName: `skills/notelet-publish/scripts/${file}`,
          source: readFileSync(resolve(`skill-assets/notelet-publish/scripts/${file}`)),
        });
      }
      this.emitFile({
        type: "asset",
        fileName: "resource-manifest.json",
        source: JSON.stringify({ version: 1, staticAssetFiles: 0 }),
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      writeFileSync(
        join(options.dir, "resource-manifest.json"),
        JSON.stringify({ version: 1, staticAssetFiles: countFiles(options.dir) }),
      );
    },
  }],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve("public/index.html"),
        mermaidRenderer: resolve("public/mermaid-renderer.html"),
      },
    },
  },
});
