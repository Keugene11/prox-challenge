/**
 * Convert committed PNG page renders to high-quality JPEGs to shrink the
 * Vercel serverless function bundle. The PNGs are scanned manual pages with
 * photo / line-art content, both of which compress 4-6x as JPEG with no
 * visible quality loss at q=88.
 *
 * Runs idempotently — safe to re-run.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(process.cwd());
const PAGES_DIR = path.join(ROOT, "knowledge", "pages");
const INDEX_PATH = path.join(ROOT, "knowledge", "index.json");

async function main() {
  const idx = JSON.parse(await fs.readFile(INDEX_PATH, "utf8"));
  const files = await fs.readdir(PAGES_DIR);
  const pngs = files.filter((f) => f.endsWith(".png") && !f.endsWith("-thumb.jpg"));

  let convertedBytes = 0;
  let originalBytes = 0;
  for (const png of pngs) {
    const pngPath = path.join(PAGES_DIR, png);
    const jpgPath = pngPath.replace(/\.png$/, ".jpg");
    const stat = await fs.stat(pngPath);
    originalBytes += stat.size;
    await sharp(pngPath).jpeg({ quality: 88, mozjpeg: true }).toFile(jpgPath);
    const jstat = await fs.stat(jpgPath);
    convertedBytes += jstat.size;
    await fs.unlink(pngPath);
    process.stdout.write(`  ${png} → .jpg (${(stat.size / 1024).toFixed(0)}KB → ${(jstat.size / 1024).toFixed(0)}KB)\n`);
  }

  // Update index paths
  for (const p of idx.pages) {
    if (typeof p.image === "string") p.image = p.image.replace(/\.png$/, ".jpg");
  }
  await fs.writeFile(INDEX_PATH, JSON.stringify(idx, null, 2));

  console.log(`\nDone. ${pngs.length} files converted.`);
  console.log(`Total: ${(originalBytes / 1024 / 1024).toFixed(1)}MB → ${(convertedBytes / 1024 / 1024).toFixed(1)}MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
