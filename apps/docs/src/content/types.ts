export type Lang = "ko" | "en";

export type Block =
  | { type: "p"; text: string }
  | { type: "h2"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "code"; text: string }
  | { type: "links"; items: { to: string; label: string }[] }
  | { type: "table"; columns: [string, string]; rows: [string, string][] };

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
