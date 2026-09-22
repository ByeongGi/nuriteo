export interface DroppedFileEntry {
  file: File;
  relativePath: string;
}

export interface DroppedEntryCollection {
  directories: string[];
  errors: string[];
  files: DroppedFileEntry[];
}

export type DroppedEntrySource =
  FileList | Pick<DataTransfer, "files" | "items">;

interface LegacyFileSystemEntry {
  isDirectory: boolean;
  isFile: boolean;
  name: string;
}

interface LegacyFileSystemFileEntry extends LegacyFileSystemEntry {
  file: (
    success: (file: File) => void,
    failure?: (error: DOMException) => void,
  ) => void;
}

interface LegacyFileSystemDirectoryReader {
  readEntries: (
    success: (entries: LegacyFileSystemEntry[]) => void,
    failure?: (error: DOMException) => void,
  ) => void;
}

interface LegacyFileSystemDirectoryEntry extends LegacyFileSystemEntry {
  createReader: () => LegacyFileSystemDirectoryReader;
}

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => LegacyFileSystemEntry | null;
};

function normalizeRelativePath(path: string): string {
  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.join("/");
}

function fileRelativePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string })
    .webkitRelativePath;
  return normalizeRelativePath(relativePath || file.name);
}

function readFileEntry(entry: LegacyFileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryBatch(
  reader: LegacyFileSystemDirectoryReader,
): Promise<LegacyFileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function readAllDirectoryEntries(
  entry: LegacyFileSystemDirectoryEntry,
): Promise<LegacyFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: LegacyFileSystemEntry[] = [];
  while (true) {
    const batch = await readDirectoryBatch(reader);
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

function sourceFiles(source: DroppedEntrySource): File[] {
  return Array.from("files" in source ? source.files : source);
}

function sourceItems(source: DroppedEntrySource): DataTransferItem[] {
  return "items" in source ? Array.from(source.items) : [];
}

/**
 * Materializes browser drag/drop entries while retaining their paths. Chromium's
 * directory reader may return several batches, so callers must await the full
 * traversal before writing anything into the project.
 */
export async function collectDroppedEntries(
  source: DroppedEntrySource | null,
): Promise<DroppedEntryCollection> {
  const filesByPath = new Map<string, File>();
  const directories = new Set<string>();
  const errors: string[] = [];

  const addFile = (target: Map<string, File>, file: File, path: string) => {
    const relativePath = normalizeRelativePath(path);
    if (!relativePath || target.has(relativePath)) return;
    target.set(relativePath, file);
  };

  const walkEntry = async (
    entry: LegacyFileSystemEntry,
    parentPath: string,
    entryFiles: Map<string, File>,
    entryDirectories: Set<string>,
    entryErrors: string[],
  ): Promise<void> => {
    const relativePath = normalizeRelativePath(`${parentPath}/${entry.name}`);
    if (!relativePath) return;
    try {
      if (entry.isFile) {
        const file = await readFileEntry(entry as LegacyFileSystemFileEntry);
        addFile(entryFiles, file, relativePath);
        return;
      }
      if (!entry.isDirectory) return;
      entryDirectories.add(relativePath);
      const children = await readAllDirectoryEntries(
        entry as LegacyFileSystemDirectoryEntry,
      );
      await Promise.all(
        children.map((child) =>
          walkEntry(
            child,
            relativePath,
            entryFiles,
            entryDirectories,
            entryErrors,
          ),
        ),
      );
    } catch (error) {
      entryErrors.push(
        `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  if (!source) return { directories: [], errors, files: [] };

  const itemTasks = sourceItems(source).map(async (item) => {
    if (item.kind !== "file") return null;
    const entry = (item as DataTransferItemWithEntry).webkitGetAsEntry?.();
    if (entry) {
      const entryFiles = new Map<string, File>();
      const entryDirectories = new Set<string>();
      const entryErrors: string[] = [];
      await walkEntry(entry, "", entryFiles, entryDirectories, entryErrors);
      return {
        directories: entryDirectories,
        entryErrors,
        files: entryFiles,
        usedFileSystemEntry: true,
      };
    }
    const file = item.getAsFile();
    return file
      ? {
          directories: new Set<string>(),
          entryErrors: [],
          files: new Map([[fileRelativePath(file), file]]),
          usedFileSystemEntry: false,
        }
      : null;
  });
  const itemResults = await Promise.all(itemTasks);
  const usedFileSystemEntries = itemResults.some(
    (result) => result?.usedFileSystemEntry,
  );
  for (const result of itemResults) {
    if (!result) continue;
    for (const directory of result.directories) directories.add(directory);
    errors.push(...result.entryErrors);
    if (usedFileSystemEntries) {
      for (const [relativePath, file] of result.files)
        addFile(filesByPath, file, relativePath);
    }
  }

  if (!usedFileSystemEntries) {
    const fallbackFiles = sourceFiles(source);
    if (fallbackFiles.length > 0) {
      for (const file of fallbackFiles)
        addFile(filesByPath, file, fileRelativePath(file));
    } else {
      for (const result of itemResults) {
        if (!result) continue;
        for (const [relativePath, file] of result.files)
          addFile(filesByPath, file, relativePath);
      }
    }
  }

  return {
    directories: [...directories].sort(),
    errors: errors.sort(),
    files: [...filesByPath]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, file]) => ({ file, relativePath })),
  };
}
