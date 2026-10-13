#!/usr/bin/env bash
set -Eeuo pipefail

readonly script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_root="$(cd "$script_root/../../.." && pwd)"
readonly checker="$script_root/check.mjs"
cleanup_root=''

cleanup() {
  [ -z "$cleanup_root" ] || rm -rf -- "$cleanup_root"
}

trap cleanup EXIT

main() {
  case "${1:-}" in
    inventory) node "$checker" readiness --allow-blocked ;;
    preflight) preflight ;;
    acceptance) acceptance ;;
    self-test) self_test ;;
    *) echo "usage: $0 {inventory|preflight|acceptance|self-test}" >&2; exit 2 ;;
  esac
}

preflight() {
  local release_commit script
  node "$checker" readiness
  release_commit="$(required_release_commit)"
  [ "$(git -C "$repository_root" rev-parse HEAD)" = "$release_commit" ] || {
    echo "GATE-005 release commit is not the checked-out HEAD" >&2
    exit 1
  }
  [ -z "$(git -C "$repository_root" status --porcelain=v1 --untracked-files=all)" ] || {
    echo "GATE-005 requires a clean tracked and untracked working tree" >&2
    exit 1
  }
  git -C "$repository_root" merge-base --is-ancestor \
    e09c657bb3454891054e5293f1b3cb3a4f99f102 "$release_commit"
  node "$repository_root/tooling/checks/check-self-hosted-beta-baseline.ts"
  for script in \
    "$repository_root/deploy/compose/relay-save-resume-browser.ts" \
    "$script_root/live-journey.ts" \
    "$script_root/post-restart-journey.ts" \
    "$script_root/stages/git-registry/browser-stage.ts" \
    "$script_root/stages/oidc-notifications/oidc-journey.ts" \
    "$script_root/stages/published-preview/journey.ts"
  do
    node --experimental-strip-types --check "$script" >/dev/null
  done
  echo "GATE-005 preflight ok (${release_commit})"
}

acceptance() {
  local artifact_root driver_real release_commit report_root report_file status=0
  preflight
  release_commit="$(required_release_commit)"
  driver_real="$(realpath "$script_root/acceptance-driver.sh")"
  [ -x "$driver_real" ] || { echo "GATE-005 driver is not executable" >&2; exit 1; }

  report_root="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-gate-005.XXXXXX")"
  cleanup_root="$report_root"
  chmod 700 "$report_root"
  report_file="$report_root/report.json"

  NURITEO_BETA_GATE_RELEASE_COMMIT="$release_commit" \
    NURITEO_BETA_GATE_REPORT_FILE="$report_file" \
    "$driver_real" || status=$?
  [ "$status" -eq 0 ] || {
    echo "GATE-005 aggregate driver failed (status ${status})" >&2
    exit "$status"
  }
  [ -f "$report_file" ] || { echo "GATE-005 driver did not write its report" >&2; exit 1; }
  [ "$(git -C "$repository_root" rev-parse HEAD)" = "$release_commit" ] || {
    echo "GATE-005 release commit changed during acceptance" >&2
    exit 1
  }
  [ -z "$(git -C "$repository_root" status --porcelain=v1 --untracked-files=all)" ] || {
    echo "GATE-005 working tree changed during acceptance" >&2
    exit 1
  }
  node "$checker" report "$report_file" "$release_commit"
  artifact_root="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-gate-005-artifacts-${release_commit:0:12}.XXXXXX")"
  chmod 700 "$artifact_root"
  cp -R "$report_file" "$report_root/evidence" "$artifact_root/"
  echo "GATE-005 sanitized evidence retained at ${artifact_root}"
  echo "GATE-005 self-hosted Beta aggregate passed (${release_commit})"
}

required_release_commit() {
  local value="${NURITEO_BETA_GATE_RELEASE_COMMIT:-}"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || {
    echo "NURITEO_BETA_GATE_RELEASE_COMMIT must be a full 40-character commit" >&2
    return 1
  }
  printf '%s\n' "$value"
}

self_test() {
  local root report commit image
  root="$(mktemp -d "${TMPDIR:-/tmp}/nuriteo-gate-005-self-test.XXXXXX")"
  cleanup_root="$root"
  report="$root/report.json"
  commit=1111111111111111111111111111111111111111
  image=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  mkdir -p "$root/evidence"
  node - "$script_root/contract.json" "$report" "$commit" "$image" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const [contractPath, reportPath, commit, digest] = process.argv.slice(2);
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const composeProject = "nuriteo-gate-005-self-test";
const databaseLineage = "11111111-1111-4111-8111-111111111111";
const objectLineage = "22222222-2222-4222-8222-222222222222";
const stages = {};
for (const name of contract.requiredStages) {
  const relative = `evidence/${name}.json`;
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, gate: "GATE-005", stage: name, status: "PASS", releaseCommit: commit,
    composeProject, databaseLineage, objectLineage,
    assertions: [{ kind: "container", name: "validator self-test runtime assertion", status: "PASS" }]
  })}\n`);
  fs.writeFileSync(path.join(path.dirname(reportPath), relative), bytes);
  stages[name] = { status: "PASS", evidence: relative, sha256: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}` };
}
fs.writeFileSync(reportPath, JSON.stringify({
  schemaVersion: 1,
  gate: "GATE-005",
  verdict: "self-hosted-beta-ready",
  cleanInstall: true,
  sameComposeProject: true,
  sameDatabaseLineage: true,
  secretsFound: false,
  run: {
    composeProject, databaseLineage, objectLineage,
    containerIds: ["111111111111", "222222222222", "333333333333"]
  },
  releaseLineage: {
    alphaBaselineCommit: contract.alphaBaselineCommit,
    releaseCommit: commit,
    workingTreeClean: true,
    images: contract.requiredImages.map((name) => ({ name, digest, sourceCommit: commit, sourceCommitLabelVerified: true }))
  },
  stages
}));
NODE
  node "$checker" self-test-report "$report" "$commit"
  printf ' ' >>"$root/evidence/clean-install.json"
  if node "$checker" self-test-report "$report" "$commit" >"$root/tamper.out" 2>&1; then
    echo "GATE-005 runner accepted tampered evidence" >&2
    return 1
  fi
  echo "GATE-005 runner self-test ok"
}

main "$@"
