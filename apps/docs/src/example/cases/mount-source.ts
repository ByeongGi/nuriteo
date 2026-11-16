export const MOUNT_CASE_BOOT_MS = 20_000;

export const mountCaseSource = `const kind = "spa";
const project = await loadContainerCase(kind);
const files = new Map(project.files.map((file) => [\`/workspace/\${file.path}\`, file.contents]));
const container = createContainer({
  ...runtime,
  services: { filesystem: memoryFilesystem(files) }
});
const ready = await container.boot({ timeoutMs: 20_000 });
const entryPath = \`/workspace/\${project.entry}\`;
const entry = await container.services.fs.readFile(entryPath);
const status = container.status;
await container.teardown();
return {
  protocolVersion: ready.protocolVersion,
  status,
  kind: project.kind,
  previewScript: project.previewScript,
  entryPath,
  entry
};`;
