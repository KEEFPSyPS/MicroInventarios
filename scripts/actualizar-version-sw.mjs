/* ===========================================================================
 * scripts/actualizar-version-sw.mjs
 * ---------------------------------------------------------------------------
 * Versiona automáticamente el Service Worker (sw.js).
 *
 * PROBLEMA: si se olvida subir `const VERSION` a mano, el navegador puede seguir
 * sirviendo el shell viejo (la caché `microinventarios-<VERSION>` no se
 * reemplaza). Este script deriva la versión del CONTENIDO real del shell, de
 * modo que cualquier cambio en app.js/styles.css/index.html (o en la config)
 * produce una versión nueva sin intervención humana.
 *
 * QUÉ HACE
 *   1. Lee los archivos que forman el "app shell".
 *   2. Calcula un SHA-256 sobre su contenido (nombre + bytes), más —si está
 *      disponible— el SHA del commit de git, para desempatar builds idénticos
 *      en contenido pero distintos en revisión.
 *   3. Reescribe en sw.js la línea `const VERSION = "...";` con `h<12hex>`.
 *
 * USO
 *   node scripts/actualizar-version-sw.mjs          # versiona sw.js
 *   node scripts/actualizar-version-sw.mjs --check  # falla si quedaría distinto
 *                                                   # (útil en CI para exigir bump)
 *
 * Se invoca como `predeploy` de Firebase Hosting (ver firebase.json) y desde
 * `npm run build:sw`.
 * ======================================================================== */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));
const SW = join(RAIZ, "sw.js");

/* Archivos cuyo cambio DEBE invalidar la caché del shell. firebase-config.js es
   opcional (no está versionado); si existe, entra en el hash. */
const ARCHIVOS = [
  "index.html",
  "styles.css",
  "app.js",
  "busqueda.js",
  "manifest.webmanifest",
  "firebase-config.js"
];

function hashContenido() {
  const h = createHash("sha256");
  for (const rel of ARCHIVOS) {
    const abs = join(RAIZ, rel);
    h.update(rel + "\0");
    if (existsSync(abs)) {
      h.update(readFileSync(abs));
    } else {
      h.update("<ausente>");
    }
    h.update("\0");
  }
  return h.digest("hex");
}

function shaCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: RAIZ,
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/* Versión legible: h<12 del hash de contenido>. El commit se añade solo si
   existe, para dejar rastro de la revisión (no afecta a builds sin git). */
function versionNueva() {
  const contenido = hashContenido().slice(0, 12);
  const commit = shaCommit();
  return "h" + contenido + (commit ? "-" + commit : "");
}

const sw = readFileSync(SW, "utf8");
const match = sw.match(/^const VERSION = ".*?";/m);
if (!match) {
  console.error('No se encontró `const VERSION = "...";` en sw.js');
  process.exit(1);
}

const nueva = `const VERSION = "${versionNueva()}";`;
const actualizada = sw.replace(/^const VERSION = ".*?";/m, nueva);

const soloCheck = process.argv.includes("--check");

if (soloCheck) {
  if (actualizada === sw) {
    console.log("sw.js ya está versionado con el contenido actual.");
    process.exit(0);
  }
  console.error("sw.js está DESACTUALIZADO. Ejecuta: node scripts/actualizar-version-sw.mjs");
  process.exit(1);
}

if (actualizada === sw) {
  console.log("sw.js ya está al día:", actualizada.match(/const VERSION = "(.*?)"/)[1]);
} else {
  writeFileSync(SW, actualizada, "utf8");
  console.log("sw.js versionado →", nueva.match(/"(.*?)"/)[1]);
}
