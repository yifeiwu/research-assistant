const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "what", "when",
  "where", "which", "who", "whom", "whose", "why", "how", "are", "was",
  "were", "been", "being", "have", "has", "had", "does", "did", "will",
  "would", "could", "should", "into", "about", "over", "after", "before",
  "between", "under", "again", "further", "then", "once", "here", "there",
  "all", "any", "both", "each", "few", "more", "most", "other", "some",
  "such", "only", "own", "same", "than", "too", "very", "can", "just",
  "also", "their", "they", "them", "these", "those", "your", "ours",
]);

const BOILERPLATE_LINE_RE =
  /^(?:skip to (?:main )?content|jump to navigation|we use cookies|this (?:site|website) uses cookies|accept (?:all )?cookies|reject (?:all )?cookies|manage cookie preferences|cookie (?:settings|preferences|policy)|subscribe to (?:our )?newsletter|sign up for (?:our )?newsletter|all rights reserved\.?|privacy policy\s*[|·•]\s*terms|follow us on\b|share (?:this )?(?:article|post|on)\b)/i;

const ANALYTICAL_HEADING_RE =
  /\b(?:results?|findings?|benchmarks?|evaluation|comparisons?|performance|methodology|methods?|data|metrics?|limitations?|caveats?|conclusions?|summary|takeaways?|analysis|pricing|costs?|specifications?|architecture|trade-?offs?)\b/i;

type PassageWindow = {
  index: number;
  heading?: string;
  text: string;
};

function isNavMenuLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("|")) return false; // Preserve markdown tables
  if (trimmed.length > 260) return false;

  // Pipe or middot-separated short navigation labels: "Home | Pricing | Docs | Blog | Sign in"
  const pipeParts = trimmed.split(/\s*(?:\||·|•|›|»)\s*/).filter(Boolean);
  if (
    pipeParts.length >= 4 &&
    pipeParts.every((p) => p.length <= 28 && !/[.!?]$/.test(p))
  ) {
    return true;
  }

  // Row of 4+ markdown links with almost no surrounding prose
  const links = [...trimmed.matchAll(/\[([^\]]{1,30})\]\([^)]+\)/g)];
  if (links.length >= 4) {
    const stripped = trimmed
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "")
      .replace(/[\s|·•,/-]+/g, "");
    if (stripped.length <= 12) return true;
  }

  return false;
}

function stripBoilerplateLines(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && trimmed.length <= 260) {
      if (BOILERPLATE_LINE_RE.test(trimmed)) continue;
      if (isNavMenuLine(trimmed)) continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function tokenizeQuery(query: string): string[] {
  const rawTokens = query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of rawTokens) {
    if (tok.length === 2 && !/\d/.test(tok) && tok !== "ai" && tok !== "ev" && tok !== "uk" && tok !== "us" && tok !== "eu" && tok !== "os" && tok !== "db" && tok !== "ui") {
      continue;
    }
    if (STOPWORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function splitOversizedChunk(text: string, chunkCap: number): string[] {
  if (text.length <= chunkCap) return [text];
  const lines = text.split("\n");
  // If line-structured (lists, tables), group lines up to chunkCap.
  if (lines.length > 1) {
    const out: string[] = [];
    let current = "";
    for (const line of lines) {
      if (!current) {
        current = line;
      } else if (current.length + 1 + line.length <= chunkCap) {
        current += `\n${line}`;
      } else {
        out.push(current);
        current = line;
      }
    }
    if (current) out.push(current);
    if (out.every((c) => c.length <= chunkCap)) return out;
  }

  // Sentence-aware splitting for dense prose paragraphs.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= chunkCap) {
      current += ` ${sentence}`;
    } else {
      out.push(current);
      current = sentence;
    }
  }
  if (current) out.push(current);
  return out.flatMap((part) => {
    if (part.length <= chunkCap) return [part];
    const slices: string[] = [];
    for (let i = 0; i < part.length; i += chunkCap) {
      slices.push(part.slice(i, i + chunkCap));
    }
    return slices;
  });
}

function buildWindows(cleaned: string, maxChars: number): PassageWindow[] {
  const rawBlocks = cleaned
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunkCap = Math.max(550, Math.floor(maxChars * 0.55));
  const windows: PassageWindow[] = [];
  let activeHeading: string | undefined;
  let pendingHeadingLine: string | undefined;

  for (const block of rawBlocks) {
    const isStandaloneHeading =
      /^#{1,6}\s+\S/.test(block) && !block.includes("\n") && block.length <= 140;
    if (isStandaloneHeading) {
      activeHeading = block.replace(/^#{1,6}\s+/, "").trim();
      pendingHeadingLine = block;
      continue;
    }

    // Inline heading on first line of a multi-line block
    const firstNewline = block.indexOf("\n");
    if (firstNewline > 0) {
      const firstLine = block.slice(0, firstNewline).trim();
      if (/^#{1,6}\s+\S/.test(firstLine) && firstLine.length <= 140) {
        activeHeading = firstLine.replace(/^#{1,6}\s+/, "").trim();
      }
    }

    const combined = pendingHeadingLine ? `${pendingHeadingLine}\n${block}` : block;
    pendingHeadingLine = undefined;

    for (const sub of splitOversizedChunk(combined, chunkCap)) {
      windows.push({
        index: windows.length,
        heading: activeHeading,
        text: sub,
      });
    }
  }

  if (pendingHeadingLine) {
    windows.push({
      index: windows.length,
      heading: activeHeading,
      text: pendingHeadingLine,
    });
  }

  return windows;
}

function clipAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const sentenceEnd = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf(".\n"),
    slice.lastIndexOf("\n"),
  );
  if (sentenceEnd >= Math.floor(maxChars * 0.6)) {
    return slice.slice(0, sentenceEnd + 1).trimEnd();
  }
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxChars * 0.6)) {
    return slice.slice(0, lastSpace).trimEnd();
  }
  return slice.trimEnd();
}

function scoreWindow(
  win: PassageWindow,
  queryTerms: string[],
  idfByTerm: Map<string, number>,
  normalizedQuery: string,
): number {
  const lower = `${win.heading ?? ""}\n${win.text}`.toLowerCase();
  let score = 0;

  // 1. IDF-weighted query term overlap + term frequency saturation
  for (const term of queryTerms) {
    const idf = idfByTerm.get(term) ?? 1;
    let count = 0;
    let pos = lower.indexOf(term);
    while (pos !== -1) {
      count += 1;
      pos = lower.indexOf(term, pos + term.length);
    }
    if (count > 0) {
      const tfSat = count / (count + 1.2);
      score += idf * (1 + tfSat);
    }
  }

  // Exact multi-word query phrase match bonus
  if (normalizedQuery.length >= 6 && normalizedQuery.includes(" ") && lower.includes(normalizedQuery)) {
    score += 2.5;
  }

  // 2. Quantitative & empirical evidence density
  const metricMatches =
    win.text.match(
      /\b\d+(?:\.\d+)?(?:\s*%|\s*(?:ms|s|gb|mb|tb|kb|khz|mhz|ghz|w|kw|mw|x|bps|fps|usd|eur|million|billion|trillion))\b|\$\s?\d/gi,
    ) ?? [];
  score += Math.min(4, metricMatches.length) * 0.45;

  const yearMatches = win.text.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  if (yearMatches.length > 0) score += 0.25;

  const tableRows = win.text.match(/^\|.+\|$/gm) ?? [];
  if (tableRows.length >= 2) score += 0.9;

  if (/\[\d+\]|\b(?:et al\.|benchmark|dataset|sample size|p\s*[<=>]\s*0\.\d+|median|percentile)\b/i.test(win.text)) {
    score += 0.5;
  }

  // 3. Findings / conclusion / methodology section signals
  if (win.heading && ANALYTICAL_HEADING_RE.test(win.heading)) {
    score += 0.75;
  } else if (ANALYTICAL_HEADING_RE.test(win.text.slice(0, 160))) {
    score += 0.4;
  }

  return score;
}

/**
 * Extract the most query-relevant, evidence-dense passages from a full-page
 * document within `maxChars`, preserving original document order and opening
 * framing context at zero LLM/API cost.
 */
export function selectRelevantExcerpt(
  rawBody: string,
  query: string,
  maxChars: number,
): string {
  if (maxChars <= 0) return "";
  if (rawBody.length <= maxChars) return rawBody;

  // Fast-path unstructured / single-block strings (< 2 paragraph breaks) to preserve exact slicing semantics.
  const paragraphBreaks = rawBody.match(/\n\s*\n/g) ?? [];
  if (paragraphBreaks.length < 2) {
    return rawBody.slice(0, maxChars);
  }

  const cleaned = stripBoilerplateLines(rawBody);
  if (!cleaned) return rawBody.slice(0, maxChars);
  if (cleaned.length <= maxChars) return cleaned;

  const windows = buildWindows(cleaned, maxChars);
  if (windows.length <= 1) {
    return clipAtBoundary(cleaned, maxChars);
  }

  const queryTerms = tokenizeQuery(query);
  const idfByTerm = new Map<string, number>();
  for (const term of queryTerms) {
    let df = 0;
    for (const win of windows) {
      if (`${win.heading ?? ""}\n${win.text}`.toLowerCase().includes(term)) {
        df += 1;
      }
    }
    idfByTerm.set(term, Math.log(1 + windows.length / (1 + df)) + 0.5);
  }

  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");

  type Chosen = { index: number; text: string; clipped: boolean };
  const chosen = new Map<number, Chosen>();

  // Always include the opening lead window (capped at ~400 chars or 25% of budget) for source framing.
  const leadCap = Math.min(400, Math.max(160, Math.floor(maxChars * 0.25)));
  const leadWindow = windows[0];
  const leadClipped = leadWindow.text.length > leadCap;
  const leadText = leadClipped
    ? clipAtBoundary(leadWindow.text, leadCap)
    : leadWindow.text;
  chosen.set(0, { index: 0, text: leadText, clipped: leadClipped });

  const renderChosen = (candidateMap: Map<number, Chosen>): string => {
    const ordered = [...candidateMap.values()].sort((a, b) => a.index - b.index);
    let out = "";
    for (let i = 0; i < ordered.length; i++) {
      const curr = ordered[i];
      if (i === 0) {
        out = curr.text;
        continue;
      }
      const prev = ordered[i - 1];
      const sep =
        prev.index + 1 === curr.index && !prev.clipped ? "\n\n" : "\n[...]\n";
      out += sep + curr.text;
    }
    return out;
  };

  const candidates = windows.slice(1).map((win) => ({
    win,
    score: scoreWindow(win, queryTerms, idfByTerm, normalizedQuery),
  }));

  // Rank body windows highest-score first, breaking ties by earlier position.
  candidates.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.win.index - b.win.index,
  );

  // Track which headings are already represented so deep body passages carry section context.
  const representedHeadings = new Set<string>();
  if (leadWindow.heading) representedHeadings.add(leadWindow.heading);

  for (const { win } of candidates) {
    const needsHeadingPrefix =
      Boolean(win.heading) &&
      !representedHeadings.has(win.heading!) &&
      !win.text.startsWith("#");
    const candidateText = needsHeadingPrefix
      ? `### ${win.heading}\n${win.text}`
      : win.text;

    const trial = new Map(chosen);
    trial.set(win.index, { index: win.index, text: candidateText, clipped: false });
    const rendered = renderChosen(trial);
    if (rendered.length <= maxChars) {
      chosen.set(win.index, { index: win.index, text: candidateText, clipped: false });
      if (win.heading) representedHeadings.add(win.heading);
      continue;
    }

    // Try fitting a clipped slice of this high-scoring window if meaningful space remains.
    const currentLen = renderChosen(chosen).length;
    const sepAllowance = 7; // "\n[...]\n".length
    const available = maxChars - currentLen - sepAllowance;
    if (available >= 180) {
      const clippedText = clipAtBoundary(candidateText, available);
      if (clippedText.length >= 100) {
        const clippedTrial = new Map(chosen);
        clippedTrial.set(win.index, {
          index: win.index,
          text: clippedText,
          clipped: true,
        });
        if (renderChosen(clippedTrial).length <= maxChars) {
          chosen.set(win.index, {
            index: win.index,
            text: clippedText,
            clipped: true,
          });
          if (win.heading) representedHeadings.add(win.heading);
        }
      }
    }
  }

  // If lead was clipped earlier and unused space remains (e.g., short body), expand lead if possible.
  if (leadClipped && chosen.size === 1) {
    return clipAtBoundary(cleaned, maxChars);
  }

  return renderChosen(chosen).slice(0, maxChars);
}
