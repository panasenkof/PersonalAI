#!/usr/bin/env node
"use strict";
const fs = require("node:fs");

/** Parse old Signer #1 and newer V2/V3 Signer certificate fingerprints; fail closed. */
function extractApkCertificateFingerprint(output) {
  if (typeof output !== "string" || output.length > 100000) throw new Error("Invalid apksigner output");
  const pattern = /^(?:Signer #\d+|V\d+(?:\.\d+)? Signer:) certificate SHA-256 digest: ([a-fA-F0-9]{64})\r?$/gm;
  const digests = [...output.matchAll(pattern)].map(match => match[1].toLowerCase());
  if (!digests.length) throw new Error("Could not parse a SHA-256 certificate digest from apksigner output");
  if (new Set(digests).size !== 1) throw new Error("Multiple different APK signing certificates detected");
  return digests[0];
}
if (require.main === module) {
  try {
    process.stdout.write(extractApkCertificateFingerprint(fs.readFileSync(0, "utf8")) + "\n");
  } catch (error) {
    process.stderr.write("APK certificate verification: " + error.message + "\n");
    process.exitCode = 1;
  }
}
module.exports = { extractApkCertificateFingerprint };
