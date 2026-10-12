#!/usr/bin/env node
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { extractApkCertificateFingerprint: extract } = require("./apk-signing-certificate.cjs");
const digest = "a1b2c3d4".repeat(8);
test("legacy apksigner Signer #1", () => {
  assert.equal(extract("Signer #1 certificate SHA-256 digest: " + digest + "\n"), digest);
});
test("Android Build Tools v37 V2 Signer", () => {
  assert.equal(extract("V2 Signer: certificate SHA-256 digest: " + digest.toUpperCase() + "\n"), digest);
});
test("V3.0 signer with CRLF", () => {
  assert.equal(extract("V3.0 Signer: certificate SHA-256 digest: " + digest + "\r\n"), digest);
});
test("same certificate in multiple schemes", () => {
  assert.equal(extract("V2 Signer: certificate SHA-256 digest: " + digest +
    "\nV3.0 Signer: certificate SHA-256 digest: " + digest + "\n"), digest);
});
test("rejects different signer certificates", () => {
  assert.throws(() => extract("Signer #1 certificate SHA-256 digest: " + digest +
    "\nSigner #2 certificate SHA-256 digest: " + "f".repeat(64) + "\n"), /Multiple different/);
});
test("rejects unsigned, unsupported or malformed output", () => {
  assert.throws(() => extract("Number of signers: 1\nVerified using v2 scheme: true\n"), /Could not parse/);
  assert.throws(() => extract("V2 Signer: certificate SHA-256 digest: xxxxx\n"), /Could not parse/);
});
test("CLI prints only digest for valid signing output", () => {
  const res = spawnSync(process.execPath, [path.join(__dirname, "apk-signing-certificate.cjs")], {
    input: "V2 Signer: certificate SHA-256 digest: " + digest + "\n", encoding: "utf8",
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, digest + "\n");
  assert.equal(res.stderr, "");
});
test("CLI fails closed for unknown signing output", () => {
  const res = spawnSync(process.execPath, [path.join(__dirname, "apk-signing-certificate.cjs")], {
    input: "Number of signers: 1\n", encoding: "utf8",
  });
  assert.equal(res.status, 1);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /Could not parse/);
});
