export type Lang = "ko" | "en";

export type CalloutTone = "note" | "limit";

export interface ApiItem {
  name: string;
  signature: string;
  text: string;
}

export interface StepItem {
  title: string;
  text: string;
}

export interface DocLink {
  to: string;
  label: string;
  detail?: string;
}

export type Block =
  | { type: "p"; text: string }
  | { type: "h2"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "code"; text: string }
  | { type: "example"; title: string; text: string; code: string; result: string }
  | { type: "playground" }
  | { type: "cases" }
  | { type: "links"; items: DocLink[] }
  | { type: "table"; columns: [string, string]; rows: [string, string][] }
  | { type: "callout"; tone: CalloutTone; title?: string; text: string }
  | { type: "steps"; items: StepItem[] }
  | { type: "api"; items: ApiItem[] };

export interface Copy {
  nav: string;
  eyebrow: string;
  title: string;
  lead: string;
  blocks: Block[];
}

export interface DocEntry {
  path: string;
  group: Record<Lang, string>;
  playground?: boolean;
  ko: Copy;
  en: Copy;
}
