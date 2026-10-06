import assert from "node:assert/strict";
import test from "node:test";

import { formatDuration } from "../src/app/format.js";

test("formats command durations for human-readable console metadata", () => {
  assert.equal(formatDuration(696), "696 ms");
  assert.equal(formatDuration(16_250), "16 s");
  assert.equal(formatDuration(496_938), "8m 17s");
  assert.equal(formatDuration(3_732_000), "1h 2m 12s");
});
