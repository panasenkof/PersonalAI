// Deterministic build assets from the owner's immutable REF-ICON-A; no image generation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '../..');
const assets = path.join(root, 'mobile/assets');
const archive = path.join(root, 'docs/design/references/PersAI_Nebula_Approved_References.zip');
const ORIGINAL_SHA = 'eca4233fdb6ab8e3d5287fd1979242151f52a12753aca1fd0d568550291f88ee';
const ZIP_SHA = '3939d2ccd2b1f814addc4e51802fb5e3875a94f2e456895f8abd82af501b2b2f';
const REVISION = 'approved-icon-a-safe-zone-v1';
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
function approvedPngFromZip(zip) {
  if (digest(zip) !== ZIP_SHA) throw new Error('Approved design references ZIP does not match immutable SHA-256');
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid reference ZIP: missing central directory');
  let at = zip.readUInt32LE(eocd + 16);
  const count = zip.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid central directory');
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const compressed = zip.readUInt32LE(at + 20);
    const method = zip.readUInt16LE(at + 10);
    const local = zip.readUInt32LE(at + 42);
    if (name === 'REF-ICON-A.png' || name.endsWith('/REF-ICON-A.png')) {
      if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid local ZIP header');
      const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const buffer = zip.subarray(data, data + compressed);
      const result = method === 0 ? buffer : method === 8 ? zlib.inflateRawSync(buffer) : null;
      if (!result || digest(result) !== ORIGINAL_SHA) throw new Error('REF-ICON-A original SHA-256 mismatch');
      return result;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('REF-ICON-A missing from approved archive');
}
function resizeInto(source, dest, left, top, size, monochrome = false) {
  for (let y = 0; y < size; y++) {
    const sy = Math.max(0, Math.min(source.height - 1, (y + .5) * source.height / size - .5));
    const ya = Math.floor(sy), yb = Math.min(source.height - 1, ya + 1), fy = sy - ya;
    for (let x = 0; x < size; x++) {
      const sx = Math.max(0, Math.min(source.width - 1, (x + .5) * source.width / size - .5));
      const xa = Math.floor(sx), xb = Math.min(source.width - 1, xa + 1), fx = sx - xa;
      const target = ((top + y) * dest.width + left + x) * 4;
      const sample = c => {
        const a = source.data[(ya * source.width + xa) * 4 + c] * (1 - fx)
                + source.data[(ya * source.width + xb) * 4 + c] * fx;
        const b = source.data[(yb * source.width + xa) * 4 + c] * (1 - fx)
                + source.data[(yb * source.width + xb) * 4 + c] * fx;
        return a * (1 - fy) + b * fy;
      };
      if (monochrome) {
        // Themed icon: remove opaque dark square, retain bright nebula silhouette.
        const r = sample(0), g = sample(1), b = sample(2);
        const brightness = Math.max(r, g, b);
        const radial = Math.hypot((x + .5) / size - .5, (y + .5) / size - .5);
        const edge = Math.max(0, Math.min(1, (.49 - radial) / .09));
        const alpha = Math.max(0, Math.min(255, (brightness - 24) * 3.2)) * edge;
        dest.data[target] = dest.data[target + 1] = dest.data[target + 2] = 255;
        dest.data[target + 3] = Math.round(alpha);
      } else {
        for (let c = 0; c < 4; c++) dest.data[target + c] = Math.round(sample(c));
      }
    }
  }
}
function replaceIfChanged(name, bytes) {
  const file = path.join(assets, name);
  if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) fs.writeFileSync(file, bytes);
  return { name, sha256: digest(bytes), bytes: bytes.length };
}
function buildApprovedBrand() {
  const original = approvedPngFromZip(fs.readFileSync(archive));
  const source = PNG.sync.read(original);
  if (source.width !== source.height || source.width < 1024) throw new Error('Approved icon must be a high-resolution square PNG');
  fs.mkdirSync(assets, { recursive: true });
  const normal = new PNG({ width: 1024, height: 1024 });
  resizeInto(source, normal, 0, 0, 1024);
  const padded = new PNG({ width: 1024, height: 1024, fill: true });
  const mono = new PNG({ width: 1024, height: 1024, fill: true });
  padded.data.fill(0); mono.data.fill(0);
  resizeInto(source, padded, 184, 184, 656); // Android adaptive central safe zone
  resizeInto(source, mono, 184, 184, 656, true);
  const normalBytes = PNG.sync.write(normal);
  const files = [
    replaceIfChanged('icon.png', normalBytes),
    replaceIfChanged('splash.png', normalBytes),
    replaceIfChanged('adaptive-icon.png', PNG.sync.write(padded)),
    replaceIfChanged('monochrome-icon.png', PNG.sync.write(mono)),
  ];
  return { revision: REVISION, sourceSha256: ORIGINAL_SHA, files };
}
if (require.main === module) console.log(JSON.stringify(buildApprovedBrand(), null, 2));
module.exports = { buildApprovedBrand, approvedPngFromZip, ORIGINAL_SHA, ZIP_SHA };
