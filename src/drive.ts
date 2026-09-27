import { createHash } from "node:crypto";

// Grammar used in the Backchannel Google Doc. Agents append:
//   ## ASK <agent> [| <qid>]
//   <question text>
// The daemon (or the human) answers with:
//   ## ANSWER [| <qid>]
//   <answer text>
// Tolerated variants: missing "##", ASKED/A/ANSWERED, "—" or ":" separators.

export interface DocBlock {
  type: "ask" | "answer";
  agent?: string;
  qid?: string;
  text: string;
}

export interface AskPair {
  ask: DocBlock | null;
  answer: DocBlock | null;
  orphan?: boolean;
}

const HEADER_RE = /^\s*(?:#+\s*)?(ASK|ANSWER)(?:ED)?\b(.*)$/i;
const QID_RE = /\|\s*(q-\S+)\s*$/;

export function parseDoc(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let current: DocBlock | null = null;
  const push = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const line of text.split("\n")) {
    const m = line.match(HEADER_RE);
    if (m) {
      push();
      const type = m[1].toUpperCase() === "ASK" ? "ask" : "answer";
      // rest of the line: "<agent> [| q-…] [inline text]"
      let rest = (m[2] ?? "").trim().replace(/^[—:\-]\s*/, "");
      let qid: string | undefined;
      const qm = rest.match(QID_RE);
      if (qm) {
        qid = qm[1];
        rest = rest.slice(0, qm.index).trim();
      }
      let agent: string | undefined;
      let inline = "";
      if (type === "ask" && rest) {
        const firstSpace = rest.indexOf(" ");
        const first = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
        agent = first.replace(/[:—\-]+$/, "") || undefined;
        inline = firstSpace === -1 ? "" : rest.slice(firstSpace + 1).trim();
      } else if (rest) {
        inline = rest;
      }
      current = { type, agent, qid, text: inline ? inline + "\n" : "" };
    } else if (current) {
      current.text += line + "\n";
    }
    // lines before the first header are the preamble — ignored
  }
  push();
  for (const b of blocks) b.text = b.text.trim();
  return blocks.filter((b) => b.text || b.type === "ask");
}

export function pairBlocks(blocks: DocBlock[]): AskPair[] {
  const pairs: AskPair[] = [];
  const unpaired = new Map<string, AskPair>();
  for (const block of blocks) {
    if (block.type === "ask") {
      const qid = block.qid ?? qidFor(block);
      block.qid = qid;
      const pair: AskPair = { ask: block, answer: null };
      pairs.push(pair);
      unpaired.set(qid, pair);
    } else {
      // answer: explicit qid wins, else earliest unmatched ask in order
      let target: AskPair | undefined;
      if (block.qid && unpaired.has(block.qid)) target = unpaired.get(block.qid);
      if (!target) target = pairs.find((p) => p.ask && !p.answer);
      if (target?.ask) {
        target.answer = block;
        unpaired.delete(target.ask.qid!);
      } else {
        pairs.push({ ask: null, answer: block, orphan: true });
      }
    }
  }
  return pairs;
}

export function qidFor(ask: DocBlock): string {
  const normalized = `${(ask.agent ?? "").toLowerCase()}\n${ask.text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()}`;
  return `q-${createHash("sha1").update(normalized).digest("hex").slice(0, 8)}`;
}

export function buildAppendAnswer(qid: string, answerText: string): string {
  return `## ANSWER | ${qid}\n${answerText.trim()}\n`;
}

export function buildPreamble(): string {
  // "> "-prefixed example lines deliberately do NOT match the header grammar,
  // so this preamble never parses into ask/answer blocks.
  return [
    "BACKCHANNEL — shared board between Tayden's cloud agents and his local knowledge agent.",
    "",
    "To ask a question, append to the END of this document:",
    "",
    "> ## ASK <your agent name>",
    "> <the question>",
    "",
    "A local agent posts the answer as '## ANSWER | q-xxxxxxxx' at the end of the doc.",
    "If no answer appears, Tayden is reviewing it — check back later; do not re-ask.",
    "Never ask for passwords, credentials, or raw document dumps.",
    "",
  ].join("\n");
}
