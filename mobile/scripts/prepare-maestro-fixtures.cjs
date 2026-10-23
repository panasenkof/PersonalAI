#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const n of bytes) {
    crc ^= n;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const payload = Buffer.concat([Buffer.from(name, "ascii"), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}
function png() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const pixels = Buffer.alloc(8 * (1 + 8 * 3));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const offset = y * (1 + 8 * 3) + 1 + x * 3;
    pixels[offset] = 44; pixels[offset + 1] = x * 25; pixels[offset + 2] = y * 25;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write("usage: node prepare-maestro-fixtures.cjs DIR\n"); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, "persai-qa-photo.png");
  fs.writeFileSync(filepath, png()); process.stdout.write(filepath + "\n");
}
module.exports = { png };
