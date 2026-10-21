/**
 * Verify the exact approved binary refs before anyone modifies Nebula artwork.
 * No npm dependencies. Usage: node mobile/scripts/check-nebula-references.cjs
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const archive = path.resolve(__dirname, "../../docs/design/references/PersAI_Nebula_Approved_References.zip");
const expectedZipSha256 = "3939d2ccd2b1f814addc4e51802fb5e3875a94f2e456895f8abd82af501b2b2f";
const referenceFiles = {
  "REF-ICON-A.png": [2753575, "eca4233fdb6ab8e3d5287fd1979242151f52a12753aca1fd0d568550291f88ee"],
  "REF-ORB-B.jfif": [37933, "4533219948abbb7deace795da0d391c849d88874e014cbd8795a02d455b2a914"],
  "REF-UI-C.png": [1895495, "7c4a3d20476130b1df354e6f19d578e9a1d7f16181c753eb4626926668314462"],
};
function sha256(data) { return crypto.createHash("sha256").update(data).digest("hex"); }
function main() {
  assert.ok(fs.existsSync(archive), "Missing original Nebula ZIP. Do not replace with preview images.");
  const zip = fs.readFileSync(archive);
  assert.equal(sha256(zip), expectedZipSha256, "Approved Nebula ZIP was modified or recompressed");
  const found = new Set(); let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const flags = zip.readUInt16LE(offset + 6), method = zip.readUInt16LE(offset + 8);
    const compressed = zip.readUInt32LE(offset + 18);
    const plainSize = zip.readUInt32LE(offset + 22);
    const nameLength = zip.readUInt16LE(offset + 26), extraLength = zip.readUInt16LE(offset + 28);
    assert.equal(flags & 0x08, 0, "Unexpected streaming ZIP descriptor");
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength, end = start + compressed;
    assert.ok(end <= zip.length, `ZIP entry ${name} outside archive`);
    const raw = method === 8 ? zlib.inflateRawSync(zip.subarray(start, end))
      : method === 0 ? zip.subarray(start, end) : null;
    assert.ok(raw, `Unsupported ZIP compression for ${name}`);
    assert.equal(raw.length, plainSize, `ZIP entry ${name} has invalid length`);
    if (Object.hasOwn(referenceFiles, name)) {
      assert.ok(!found.has(name), `Duplicate reference: ${name}`);
      const [length, hash] = referenceFiles[name];
      assert.equal(raw.length, length, `Original ${name} size changed`);
      assert.equal(sha256(raw), hash, `Original ${name} checksum changed`);
      found.add(name); console.log(`PASS ${name} (${length} bytes)`);
    }
    offset = end;
  }
  assert.deepEqual([...found].sort(), Object.keys(referenceFiles).sort(), "Missing original Nebula reference");
  console.log("PASS original Nebula ZIP and 3 user-approved files");
}
main();
