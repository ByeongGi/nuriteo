import { useEffect, useRef } from "react";

interface EditorBreadcrumbsProps {
  path: string | null;
  displayPath: (path: string) => string;
}

function projectRelativeParts(path: string, displayPath: (path: string) => string): string[] {
  return displayPath(path).split(/[\\/]/).filter(Boolean);
}

export function EditorBreadcrumbs({ path, displayPath }: EditorBreadcrumbsProps) {
  const currentFileRef = useRef<HTMLSpanElement>(null);
  const relativePath = path ? displayPath(path) : "";
  const parts = path ? projectRelativeParts(path, displayPath) : [];

  useEffect(() => {
    currentFileRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [relativePath]);

  return (
    <nav
      id="editor-breadcrumbs"
      className="min-w-0 flex-1 overflow-x-auto font-mono text-cargo-muted"
      aria-label="Editor breadcrumbs"
      title={relativePath || "Open a file"}
    >
      {parts.length === 0 ? (
        <span id="editor-path" className="block py-0.5">Open a file</span>
      ) : (
        <ol className="flex min-w-max items-center gap-1 py-0.5" aria-label={relativePath}>
          {parts.map((part, index) => {
            const isCurrentFile = index === parts.length - 1;
            return (
              <li key={`${part}-${index}`} className="flex shrink-0 items-center gap-1">
                {index > 0 ? <span aria-hidden="true" className="opacity-50">/</span> : null}
                <span
                  ref={isCurrentFile ? currentFileRef : undefined}
                  aria-current={isCurrentFile ? "page" : undefined}
                  className={isCurrentFile ? "font-medium text-cargo-ink" : undefined}
                >
                  {part}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {parts.length > 0 ? <span id="editor-path" className="sr-only">{relativePath}</span> : null}
    </nav>
  );
}
