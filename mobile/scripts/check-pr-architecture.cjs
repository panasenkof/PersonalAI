#!/usr/bin/env node
"use strict";

/** PR-body presence gate. Human reviewers still verify actual architecture and code. */
const fs = require("node:fs");

function architectureReviewProblems(body) {
  if (typeof body !== "string" || !body.trim()) return ["Missing PR description"];
  const headings = [...body.matchAll(/^#{1,6}\s+(C0-A|C3-B)\b[^\n]*$/gim)];
  const problems = [];
  for (const code of ["C0-A", "C3-B"]) {
    const index = headings.findIndex(match => match[1].toUpperCase() === code);
    if (index < 0) {
      problems.push(`Missing mandatory ${code} architecture section`);
      continue;
    }
    const here = headings[index], after = body.slice(here.index + here[0].length);
    // Stop at any next markdown heading, not only at the next architecture section.
    const nextHeading = /^#{1,6}\s+[^\n]+/m.exec(after);
    const details = (nextHeading ? after.slice(0, nextHeading.index) : after).trim();
    const withoutScaffolding = details
      .replace(/<!--[^]*?-->/g, "")
      .replace(/^-\s*(?:TODO|TBD|\.\.\.|N\/A)\s*:?\s*$/gim, "")
      .trim();
    if (withoutScaffolding.length < 90 ||
        /^[-\s:;,.|*_`\[\]()]*(?:TODO|TBD|N\/A|\.\.\.)[-\s:;,.|*_`\[\]()]*$/i.test(withoutScaffolding)) {
      problems.push(`${code} must describe the real architecture and reasoning (N/A needs a reason)`);
    }
  }
  return problems;
}

if (require.main === module) {
  const eventFile = process.env.GITHUB_EVENT_PATH;
  if (!eventFile) {
    console.error("GITHUB_EVENT_PATH is required in the PR architecture gate");
    process.exitCode = 1;
  } else {
    try {
      const event = JSON.parse(fs.readFileSync(eventFile, "utf8"));
      if (!event.pull_request) {
        // Main pushes have no PR body. Never treat this as PR certification.
        console.log("Not a pull_request event; architecture PR-body check not applicable");
      } else {
        const issues = architectureReviewProblems(event.pull_request.body);
        if (issues.length) {
          for (const issue of issues) console.error(`Architecture gate: ${issue}`);
          console.error("See AGENTS.md and docs/DEVELOPMENT_GATES.md. Presence is not proof of code quality.");
          process.exitCode = 1;
        } else {
          console.log("Architecture C0-A/C3-B sections present; human and actual-diff review still required");
        }
      }
    } catch (error) {
      console.error("Unable to validate GitHub PR architecture event", error);
      process.exitCode = 1;
    }
  }
}

module.exports = { architectureReviewProblems };
