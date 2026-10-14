import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("heldout freeze preserves author gold, exclusions, Unicode offsets, and download cap", () => {
  const bundled = join(process.env.USERPROFILE ?? "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
  const python = process.env.HELDOUT_FREEZE_PYTHON
    ?? (process.platform === "win32" && existsSync(bundled) ? bundled : process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, ["tests/heldout-study-freeze.test.py"], { encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
