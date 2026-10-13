import assert from "node:assert/strict";

export function normalizeRunResult(result) {
  return {
    status: result.status,
    stdoutBase64: Buffer.from(result.stdout || "").toString("base64"),
    stderrBase64: Buffer.from(result.stderr || "").toString("base64"),
    files: result.files || {}
  };
}

export function compareRunResults(actual, expected) {
  const mismatches = [];
  if (actual.status !== expected.status) {
    mismatches.push(`status: actual ${actual.status}, expected ${expected.status}`);
  }
  if (actual.stdoutBase64 !== expected.stdoutBase64) {
    mismatches.push("stdout bytes differ");
  }
  if (actual.stderrBase64 !== expected.stderrBase64) {
    mismatches.push("stderr bytes differ");
  }
  const actualFiles = actual.files || {};
  const expectedFiles = expected.files || {};
  for (const key of new Set([...Object.keys(actualFiles), ...Object.keys(expectedFiles)])) {
    if (actualFiles[key] !== expectedFiles[key]) {
      mismatches.push(`file ${key}: bytes differ`);
    }
  }
  return mismatches;
}

export function assertRunResultsEqual(actual, expected) {
  const mismatches = compareRunResults(actual, expected);
  assert.deepEqual(mismatches, []);
}
