// npm dependencies are intentionally kept out of the runtime application.
// Run with NODE_PATH pointing to a directory containing sharp (0.34+).
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'brand/icon.svg'));
(async () => {
  for (const [file, size] of [['mobile/assets/icon.png',1024],['backend/app/web/icon-192.png',192],['backend/app/web/icon-512.png',512],['backend/app/web/apple-touch-icon.png',180]]) {
    await sharp(source).resize(size,size).png().toFile(path.join(root,file));
  }
  // Foreground fits Android's central 66% safe zone, with transparent surroundings.
  const foreground = source.toString().replace('<rect width="1024" height="1024" fill="#2458d3"/>','');
  await sharp(Buffer.from(foreground)).png().toFile(path.join(root,'mobile/assets/adaptive-icon.png'));
  await sharp(Buffer.from(foreground)).resize(256,256).png().toFile(path.join(root,'mobile/assets/splash.png'));
})();
