/* ===========================================================================
 * generar-iconos.mjs
 * Genera los PNG del manifest a partir de icons/icon.svg usando sharp.
 *
 * Uso:
 *   1) Instalar sharp (una sola vez):
 *        npm install sharp
 *      (o, sin package.json:  npm install --no-save sharp)
 *   2) Ejecutar:
 *        node generar-iconos.mjs
 *
 * Salidas (en icons/):
 *   - icon-192.png            (192x192, purpose "any")
 *   - icon-512.png            (512x512, purpose "any")
 *   - icon-512-maskable.png   (512x512, purpose "maskable", 20% de margen)
 *   - apple-touch-icon-180.png(180x180, para iOS)
 *   - favicon-32.png          (32x32, opcional)
 *
 * El "maskable" reduce el arte al 80% (≈20% de margen de seguridad) y pinta el
 * fondo completo #1b2430, de modo que cualquier recorte circular/squircle del
 * sistema deje visible el símbolo.
 * ======================================================================== */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS = join(__dirname, "icons");
const SVG = join(ICONS, "icon.svg");
const BG = "#1b2430"; // --ink: relleno del lienzo maskable

async function main() {
  const svg = await readFile(SVG);

  // 1) any: 192 y 512 (arte a tamaño completo)
  await sharp(svg, { density: 384 })
    .resize(192, 192, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(ICONS, "icon-192.png"));

  await sharp(svg, { density: 384 })
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(ICONS, "icon-512.png"));

  // 2) maskable 512: lienzo 512 con fondo --ink y arte reducido al 80% (≈20% margen)
  const inner = Math.round(512 * 0.8); // 410 px
  const art = await sharp(svg, { density: 384 })
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({
    create: { width: 512, height: 512, channels: 4, background: BG },
  })
    .composite([{ input: art, gravity: "center" }])
    .png()
    .toFile(join(ICONS, "icon-512-maskable.png"));

  // 3) apple-touch-icon 180 (fondo --ink para que iOS no lo muestre transparente)
  const inner180 = Math.round(180 * 0.86);
  const art180 = await sharp(svg, { density: 384 })
    .resize(inner180, inner180, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({
    create: { width: 180, height: 180, channels: 4, background: BG },
  })
    .composite([{ input: art180, gravity: "center" }])
    .png()
    .toFile(join(ICONS, "apple-touch-icon-180.png"));

  // 4) favicon 32
  await sharp(svg, { density: 384 })
    .resize(32, 32, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(ICONS, "favicon-32.png"));

  console.log("Iconos generados en ./icons/");
}

main().catch((err) => {
  console.error("Error generando iconos:", err);
  process.exit(1);
});
