# GATE-005 published-preview stage

This stage extends an already-running GATE-005 Compose project. It does not create a database,
reset a schema, publish another fixture, or start a substitute Web/Core pair. It resolves the
publication that the aggregate journey created for the existing gate Project Version, then runs an
anonymous Chromium journey against that fixed public version.

The stage writes a journey fragment shaped as:

```json
{"published-preview":[{"kind":"browser","name":"...","status":"PASS"}]}
```

The caller must provide the same exported Compose and lineage environment used by
`acceptance-driver.sh`, plus `NURITEO_BETA_GATE_STAGE_OUTPUT`. Run it after `live-journey.ts` has
created the published Example and before the same-volume restart:

```sh
export NURITEO_BETA_GATE_STAGE_OUTPUT="$run_root/published-preview.journey.json"
deploy/compose/beta-gate/stages/published-preview/run.sh
```

Merge only the `published-preview` member into the aggregate journey JSON. The stage fails before
writing PASS unless the database sentinel is unchanged, the publication belongs to the exact gate
Project Version, both anonymous runs render the real Bundle, sensitive application state is absent
at every public boundary, and both wildcard-origin Service Workers are disposed.
