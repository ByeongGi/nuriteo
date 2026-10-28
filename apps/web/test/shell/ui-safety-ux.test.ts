import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readStudioShellSources } from "../studio/shell-sources.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dialog = read("src/components/ui/confirmation-dialog.tsx");
const guard = read("src/lib/use-unsaved-changes-guard.ts");
const ide = readStudioShellSources();
const fileSearch = read("src/projects/use-project-file-search.ts");

assert.match(dialog, /@base-ui\/react\/alert-dialog/u);
assert.match(dialog, /<AlertDialog\.Root/u);
assert.match(dialog, /<AlertDialog\.Title/u);
assert.match(dialog, /<AlertDialog\.Description/u);
assert.match(dialog, /initialFocus=\{cancelRef\}/u);
assert.doesNotMatch(dialog, /addEventListener|FOCUSABLE_ELEMENTS|previouslyFocused/u);
assert.match(guard, /beforeunload/u);
assert.match(guard, /document\.addEventListener\("click"/u);
assert.match(guard, /window\.confirm\(message\)/u);
assert.match(ide, /useUnsavedChangesGuard\(hasUnpublishedChanges \|\| hasUnsavedEditorChange\)/u);
assert.match(ide, /<ConfirmationDialog/u);
assert.match(ide, /useProjectFileSearch/u);
assert.match(ide, /visibleStudioExplorerFiles/u);
assert.match(fileSearch, /useDeferredValue\(query\)/u);
assert.match(fileSearch, /selectedFileIsVisible/u);

console.log("UI safety and project file-search contracts ok");

function read(relative: string): string {
  return fs.readFileSync(path.join(webRoot, relative), "utf8");
}
