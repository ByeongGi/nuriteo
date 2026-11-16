export const writeEachSource = `const project = await loadContainerCase(kind);
const files = new Map();
const filesystem = memoryFilesystem(files);
const written = [];
for (const file of project.files) {
  const path = \`/workspace/\${file.path}\`;
  await filesystem.writeFile(path, file.contents);
  written.push(path);
}
const container = createContainer({ ...runtime, services: { filesystem } });
const ready = await container.boot({ timeoutMs: 20_000 });
const listing = await container.services.fs.readdir("/workspace");
const status = container.status;
await container.teardown();
return { protocolVersion: ready.protocolVersion, status, written, listing };`;

export const fetchFileSource = `const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(sourceUrl);
const text = await response.text();
const path = \`/workspace/\${filePath}\`;
const files = new Map();
const filesystem = memoryFilesystem(files);
await filesystem.writeFile(path, text);
const container = createContainer({ ...runtime, services: { filesystem } });
const ready = await container.boot({ timeoutMs: 20_000 });
const entry = await container.services.fs.readFile(path);
const status = container.status;
await container.teardown();
return { protocolVersion: ready.protocolVersion, status, entry };`;

export const replaceEntrySource = `const entryPath = \`/workspace/\${project.entry}\`;
await filesystem.writeFile(entryPath, "replaced-entry\\n");
const entry = await container.services.fs.readFile(entryPath);
const status = container.status;
await container.teardown();
return { status, entryPath, entry };`;

export const scriptSource = `const htmlFile = project.files.find((file) => file.path === "index.html");
const scriptPath = scriptSrcFromHtml(htmlFile.contents);
const script = project.files.find((file) => file.path === scriptPath);
await filesystem.writeFile("/workspace/index.html", htmlFile.contents);
await filesystem.writeFile(\`/workspace/\${scriptPath}\`, script.contents);
const entry = await container.services.fs.readFile(\`/workspace/\${scriptPath}\`);`;

export const prefixSource = `const picked = project.files.filter((file) => file.path.startsWith(prefix));
for (const file of picked) {
  await filesystem.writeFile(\`/workspace/\${file.path}\`, file.contents);
}
const entry = await container.services.fs.readFile(\`/workspace/\${project.entry}\`);`;

export const missingSource = `let missing = null;
try {
  await container.services.fs.readFile("/workspace/missing.txt");
} catch (error) {
  missing = error.message;
}
const entry = await container.services.fs.readFile(entryPath);
const status = container.status;
return { status, missing, entry };`;

export const bufferSource = `const source = pageSource;
const files = new Map();
const filesystem = memoryFilesystem(files);
await filesystem.writeFile("/workspace/src/main.js", source);
const container = createContainer({ ...runtime, services: { filesystem } });
const ready = await container.boot({ timeoutMs: 20_000 });
const entry = await container.services.fs.readFile("/workspace/src/main.js");
const status = container.status;
await container.teardown();
return { protocolVersion: ready.protocolVersion, status, entry };`;
