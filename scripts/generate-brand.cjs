// Rebuild platform icons from the selected PersAI light mark.
// Install sharp >=0.34 locally or supply NODE_PATH pointing to its installation.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'brand/persai-approved-light.png'));
(async () => {
  const metadata = await sharp(source).metadata();
  if (Math.min(metadata.width, metadata.height) < 1024) throw new Error("Use the approved high-resolution original (at least 1024px), never upscale the old compact mark.");
  for (const [file, size] of [
    ['mobile/assets/icon.png', 1024],
    ['backend/app/web/icon-192.png', 192],
    ['backend/app/web/icon-512.png', 512],
    ['backend/app/web/apple-touch-icon.png', 180],
    ['backend/app/web/favicon.png', 48],
  ]) {
    await sharp(source).resize(size, size).png().toFile(path.join(root, file));
  }
  // Adaptive icon's foreground should remain inside Android's central safe zone.
  const foreground = await sharp(source).resize(674, 674).png().toBuffer();
  await sharp(foreground).extend({ top: 175, bottom: 175, left: 175, right: 175,
    background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toFile(path.join(root, 'mobile/assets/adaptive-icon.png'));
  await sharp(source).resize(1024, 1024).png().toFile(path.join(root, 'mobile/assets/splash.png'));
})().catch(err => { console.error(err); process.exitCode = 1; });
