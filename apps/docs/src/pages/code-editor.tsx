import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import javascriptGrammar from "shiki/langs/javascript.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";

import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";
import type { Lang } from "../content/types.ts";
import { useDocsPreferences } from "../preferences.tsx";

const docsHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--n-color-action-primary)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--n-color-status-success)" },
  { tag: tags.comment, color: "var(--n-color-fg-subtle)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--n-color-status-warning)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--n-color-fg-link)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--n-color-fg-muted)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--n-color-fg-default)" }
]);

type CodeLanguage = "javascript" | "bash" | "text";

function codeLanguage(text: string): CodeLanguage {
  if (isJavaScript(text)) return "javascript";
  if (isEnvNameList(text)) return "text";
  return "bash";
}

function isJavaScript(text: string): boolean {
  const start = text.trimStart();
  const startsWithKeyword = /^(const|let|var|await|import|export|return|function|class|async)\b/.test(start);
  const callsRuntime = start.includes("container.") || start.includes("createContainer") || start.includes("createNuriteo") || start.includes("new NuriteoServices");
  return startsWithKeyword || callsRuntime;
}

function isEnvNameList(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 && lines.every((line) => /^[A-Z0-9_]+$/.test(line));
}

function highlightLanguage(language: CodeLanguage): "javascript" | "bash" {
  if (language === "text") return "bash";
  return language;
}

function codeLabel(language: CodeLanguage, lang: Lang): string {
  if (language === "javascript") return "JavaScript";
  if (language === "bash") return "Shell";
  if (lang === "ko") return "이름";
  return "Names";
}

const highlighter = createHighlighterCoreSync({
  themes: [githubLight, githubDark],
  langs: [bash, javascriptGrammar],
  engine: createJavaScriptRegexEngine()
});

const surfaceTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--n-color-fg-default)",
    fontSize: "var(--n-font-size-sm)"
  },
  ".cm-scroller": {
    fontFamily: "var(--n-font-family-mono)",
    lineHeight: "1.55",
    overflow: "auto"
  },
  ".cm-content": {
    padding: "0.9rem 0",
    caretColor: "var(--n-color-fg-default)",
    minHeight: "16rem"
  },
  ".cm-gutters": {
    backgroundColor: "var(--n-color-bg-subtle)",
    color: "var(--n-color-fg-subtle)",
    border: "none",
    borderRight: "1px solid var(--n-color-border-muted)"
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--n-color-bg-hover)"
  },
  "&.cm-focused": {
    outline: "2px solid var(--n-color-border-focus)",
    outlineOffset: "-2px"
  },
  ".cm-line": { padding: "0 1rem" }
});

export function CodeBlock({ text, embedded = false }: { text: string; embedded?: boolean }) {
  const { lang } = useDocsPreferences();
  const language = codeLanguage(text);
  const html = highlighter.codeToHtml(text, {
    lang: highlightLanguage(language),
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false
  });
  return (
    <div className={cn("shiki-block overflow-hidden", embedded ? "border-0" : "mb-6 rounded-lg border border-border bg-surface")}>
      <div className="flex items-center justify-between gap-3 border-b px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{codeLabel(language, lang)}</span>
        <CopyButton text={text} copied={lang === "ko" ? "복사됨" : "Copied"} idle={lang === "ko" ? "복사" : "Copy"} />
      </div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

const COPY_ACK_MS = 1500;

function CopyButton({ text, copied, idle }: { text: string; copied: string; idle: string }) {
  const [done, setDone] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      window.setTimeout(() => setDone(false), COPY_ACK_MS);
    } catch {
      setDone(false);
    }
  }

  return (
    <Button className="h-7 px-2 text-muted-foreground" variant="ghost" size="sm" type="button" onClick={() => void onCopy()}>
      {done ? copied : idle}
    </Button>
  );
}

export function CodeEditor({
  initialText,
  label,
  onChange
}: {
  initialText: string;
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-h-80 overflow-hidden bg-surface">
      <div className="border-b px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{label}</span>
      </div>
      <CodeSurface initialText={initialText} label={label} onChange={onChange} />
    </div>
  );
}

function CodeSurface({
  initialText,
  label,
  onChange
}: {
  initialText: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const labelRef = useRef(label);
  onChangeRef.current = onChange;
  labelRef.current = label;
  const initial = useRef(initialText);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          basicSetup,
          surfaceTheme,
          syntaxHighlighting(docsHighlight),
          javascript(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": labelRef.current }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          })
        ]
      })
    });
    return () => view.destroy();
  }, []);

  return <div ref={host} />;
}
