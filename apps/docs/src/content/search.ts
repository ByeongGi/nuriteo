import { catalog } from "./catalog.ts";
import { blockPlain } from "./plain.ts";
import type { Lang } from "./types.ts";

const RESULT_LIMIT = 12;
const TITLE_WEIGHT = 8;
const NAV_WEIGHT = 6;
const GROUP_WEIGHT = 4;
const LEAD_WEIGHT = 3;
const BODY_WEIGHT = 2;

export interface SearchHit {
  path: string;
  title: string;
  nav: string;
  group: string;
  snippet: string;
}

export function searchDocs(query: string, lang: Lang): SearchHit[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return [];

  const hits: Array<SearchHit & { score: number }> = [];
  for (const entry of catalog) {
    const copy = entry[lang];
    const fields = [
      { weight: TITLE_WEIGHT, text: copy.title },
      { weight: NAV_WEIGHT, text: copy.nav },
      { weight: GROUP_WEIGHT, text: entry.group[lang] },
      { weight: LEAD_WEIGHT, text: copy.lead },
      { weight: BODY_WEIGHT, text: copy.blocks.map(blockPlain).join("\n") }
    ];
    const score = scoreFields(fields, terms);
    if (score === 0) continue;
    hits.push({
      path: entry.path,
      title: copy.title,
      nav: copy.nav,
      group: entry.group[lang],
      snippet: snippetFor(fields, terms, copy.lead),
      score
    });
  }

  return hits
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, RESULT_LIMIT)
    .map(({ score: _score, ...hit }) => hit);
}

function scoreFields(fields: Array<{ weight: number; text: string }>, terms: string[]): number {
  let score = 0;
  for (const term of terms) {
    let matched = false;
    for (const field of fields) {
      if (!field.text.toLowerCase().includes(term)) continue;
      matched = true;
      score += field.weight;
    }
    if (!matched) return 0;
  }
  return score;
}

function snippetFor(fields: Array<{ weight: number; text: string }>, terms: string[], lead: string): string {
  const body = [...fields].reverse().find((field) => terms.some((term) => field.text.toLowerCase().includes(term)));
  const source = body?.text ?? lead;
  const lower = source.toLowerCase();
  const index = terms.reduce((found, term) => {
    if (found >= 0) return found;
    return lower.indexOf(term);
  }, -1);
  return clip(source, index);
}

function clip(source: string, index: number): string {
  const start = Math.max(0, index - 48);
  const slice = source.slice(start, start + 160).replaceAll("\n", " ").trim();
  const prefix = start > 0 ? "…" : "";
  return `${prefix}${slice}`;
}
