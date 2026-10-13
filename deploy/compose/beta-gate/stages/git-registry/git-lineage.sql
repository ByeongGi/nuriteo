SELECT json_build_object(
  'databaseLineage', lineage.database_lineage::text,
  'objectLineage', lineage.object_lineage::text,
  'projectId', project.id::text,
  'workingHeadBundleId', project.working_head_bundle_id::text,
  'bundleVerificationState', bundle.verification_state,
  'objectKey', bundle.object_key,
  'remoteHeadSha', remote.remote_head_sha,
  'materializationCount', (
    SELECT count(*) FROM git_working_head_materializations materialization
    WHERE materialization.project_id = project.id
  )
)
FROM projects project
JOIN project_git_remotes remote ON remote.project_id = project.id
JOIN bundles bundle ON bundle.id = project.working_head_bundle_id
CROSS JOIN LATERAL (SELECT database_lineage, object_lineage FROM beta_gate_lineage LIMIT 1) lineage
WHERE project.id = :'project_id'::uuid;
