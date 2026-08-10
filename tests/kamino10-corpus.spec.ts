import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("isolated Kamino 10 corpus", () => {
  it(
    "verifies the immutable tarball, dual generated builders, and fail-closed branch inventory",
    () => {
      execFileSync(process.execPath, ["scripts/verify-kamino10-corpus.mjs"], {
        cwd: resolve(import.meta.dirname, ".."),
        stdio: "inherit",
        env: { ...process.env, GLAM_ALLOW_NON_PINNED_NODE: "1" },
      });
    },
    // The subprocess unpacks and verifies the complete immutable corpus; a
    // cold Node 22 CI worker can need more than 30 seconds.
    60_000,
  );
});
