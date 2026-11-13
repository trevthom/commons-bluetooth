// Runs every test suite in order and fails if any of them does.
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ["mesh-test.mjs", "app-test.mjs"];

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, suite)], { stdio: "inherit" });
    p.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) failed++;
}
console.log(failed ? `\n${failed} suite(s) failed\n` : "\nall suites passed\n");
process.exit(failed ? 1 : 0);
