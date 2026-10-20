import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dialog = read("src/components/ui/confirmation-dialog.tsx");
const guard = read("src/lib/use-unsaved-changes-guard.ts");
const ide = read("src/app/(authenticated)/projects/project-ide-shell.tsx");
const fileSearch = read("src/app/(authenticated)/projects/use-project-file-search.ts");

assert.match(dialog, /aria-modal="true"/u);
assert.match(dialog, /aria-labelledby=\{titleId\}/u);
assert.match(dialog, /aria-describedby=\{descriptionId\}/u);
assert.match(dialog, /event\.key === "Escape"/u);
assert.match(dialog, /event\.key !== "Tab"/u);
assert.match(dialog, /previouslyFocused\?\.focus/u);
assert.match(guard, /beforeunload/u);
assert.match(guard, /document\.addEventListener\("click"/u);
assert.match(guard, /window\.confirm\(message\)/u);
assert.match(ide, /useUnsavedChangesGuard\(hasUnpublishedChanges \|\| hasUnsavedEditorChange\)/u);
assert.match(ide, /<ConfirmationDialog/u);
assert.match(ide, /useProjectFileSearch/u);
assert.match(fileSearch, /useDeferredValue\(query\)/u);
assert.match(fileSearch, /selectedFileIsVisible/u);

console.log("UI safety and project file-search contracts ok");

function read(relative: string): string {
  return fs.readFileSync(path.join(webRoot, relative), "utf8");
}
