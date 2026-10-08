SELECT json_build_object(
  'databaseLineage', (SELECT database_lineage::text FROM beta_gate_lineage LIMIT 1),
  'objectLineage', (SELECT object_lineage::text FROM beta_gate_lineage LIMIT 1),
  'administratorIds', (SELECT COALESCE(json_agg(id::text ORDER BY id::text), '[]'::json) FROM users WHERE is_instance_admin),
  'userIds', (SELECT COALESCE(json_agg(id::text ORDER BY id::text), '[]'::json) FROM users),
  'organizationIds', (SELECT COALESCE(json_agg(id::text ORDER BY id::text), '[]'::json) FROM organizations),
  'teamIds', (SELECT COALESCE(json_agg(id::text ORDER BY id::text), '[]'::json) FROM teams),
  'projectIds', (SELECT COALESCE(json_agg(id::text ORDER BY id::text), '[]'::json) FROM projects)
);

