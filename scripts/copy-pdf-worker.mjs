/**
 * pdf.js needs its worker served as a static file, and the worker build must
 * match the library version exactly. Copying it on install keeps the two in
 * step instead of pinning a stale copy in the repo.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

try {
  const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  const candidates = [
    join(pdfjsRoot, "build", "pdf.worker.min.mjs"),
    join(pdfjsRoot, "build", "pdf.worker.mjs"),
  ];
  const source = candidates.find((p) => existsSync(p));

  if (!source) {
    console.warn("[pdf-worker] no worker build found — page analysis will be disabled");
    process.exit(0);
  }

  mkdirSync("public", { recursive: true });
  copyFileSync(source, join("public", "pdf.worker.min.mjs"));
  console.log("[pdf-worker] copied to public/pdf.worker.min.mjs");
} catch (error) {
  console.warn("[pdf-worker] skipped:", error.message);
}
