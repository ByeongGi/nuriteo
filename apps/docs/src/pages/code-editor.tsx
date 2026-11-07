import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useDocsPreferences } from "../preferences.tsx";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import javascriptGrammar from "shiki/langs/javascript.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";

const docsHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--n-color-action-primary)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--n-color-status-success)" },
  { tag: tags.comment, color: "var(--n-color-fg-subtle)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--n-color-status-warning)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--n-color-fg-link)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--n-color-fg-muted)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--n-color-fg-default)" }
]);

function codeLanguage(text: string): "javascript" | "bash" {
  const start = text.trimStart();
  if (/^(const|let|var|await|import|export|return|function|class|async)\b/.test(start)) return "javascript";
  if (start.includes("container.") || start.includes("createContainer") || start.includes("createNuriteo")) return "javascript";
  return "bash";
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

export function CodeBlock({ text }: { text: string }) {
  const { lang } = useDocsPreferences();
  const language = codeLanguage(text);
  const html = highlighter.codeToHtml(text, {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false
  });
  const label = language === "javascript" ? "JavaScript" : "Shell";
  return (
    <Card className="shiki-block mb-6 gap-0 overflow-hidden py-0 shadow-none">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-1.5">
        <Badge className="font-mono" variant="secondary">{label}</Badge>
        <CopyButton text={text} copied={lang === "ko" ? "복사됨" : "Copied"} idle={lang === "ko" ? "복사" : "Copy"} />
      </div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </Card>
  );
}

function CopyButton({ text, copied, idle }: { text: string; copied: string; idle: string }) {
  const [done, setDone] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      window.setTimeout(() => setDone(false), 1500);
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
  text,
  label,
  onChange
}: {
  text: string;
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-h-80 overflow-hidden bg-surface">
      <div className="border-b px-3 py-1.5">
        <Badge className="font-mono" variant="secondary">{label}</Badge>
      </div>
      <CodeSurface text={text} label={label} onChange={onChange} />
    </div>
  );
}

function CodeSurface({
  text,
  label,
  onChange
}: {
  text: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const labelRef = useRef(label);
  onChangeRef.current = onChange;
  labelRef.current = label;
  const initial = useRef(text);

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
