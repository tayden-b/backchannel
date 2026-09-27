import { describe, it, expect } from "vitest";
import { parseDoc, pairBlocks, buildAppendAnswer, buildPreamble, qidFor } from "../src/drive.js";

describe("parseDoc", () => {
  it("parses ASK/ANSWER blocks and ignores preamble", () => {
    const blocks = parseDoc(
      `preamble line one
## ASK instinct
what coffee does Tayden like?

## ANSWER | q-abc12345
oat milk lattes.
## ASK muse
his wifi password?`
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: "ask", agent: "instinct" });
    expect(blocks[0].text).toBe("what coffee does Tayden like?");
    expect(blocks[1]).toMatchObject({ type: "answer", qid: "q-abc12345" });
    expect(blocks[2]).toMatchObject({ type: "ask", agent: "muse" });
  });

  it("tolerates header variants", () => {
    const blocks = parseDoc(
      `ASK instinct — favorite airline?
## ASKED muse: home address?
ANSWER
42`
    );
    expect(blocks.map((b) => b.type)).toEqual(["ask", "ask", "answer"]);
    expect(blocks[0].agent).toBe("instinct");
    expect(blocks[1].agent).toBe("muse");
  });

  it("captures explicit qid via | separator", () => {
    const blocks = parseDoc(`## ASK instinct | q-custom1\nhi`);
    expect(blocks[0].qid).toBe("q-custom1");
  });
});

describe("pairBlocks", () => {
  it("pairs an untagged answer with the earliest unmatched ask", () => {
    const pairs = pairBlocks(
      parseDoc(`## ASK instinct\nq1\n## ASK muse\nq2\n## ANSWER\na1`)
    );
    expect(pairs).toHaveLength(2);
    expect(pairs[0].answer?.text).toBe("a1");
    expect(pairs[1].answer).toBeNull();
  });

  it("explicit qid pairs out of order", () => {
    const pairs = pairBlocks(
      parseDoc(
        `## ASK instinct | q-first\nq1\n## ASK muse | q-second\nq2\n## ANSWER | q-second\na2`
      )
    );
    expect(pairs[0].answer).toBeNull();
    expect(pairs[1].answer?.text).toBe("a2");
  });

  it("flags orphan answers", () => {
    const pairs = pairBlocks(parseDoc(`## ANSWER\nno one asked`));
    expect(pairs[0].orphan).toBe(true);
    expect(pairs[0].ask).toBeNull();
  });

  it("qid is deterministic and distinct per question", () => {
    const a = pairBlocks(parseDoc(`## ASK instinct\nhello`))[0].ask!.qid!;
    const b = pairBlocks(parseDoc(`## ASK instinct\nhello`))[0].ask!.qid!;
    const c = pairBlocks(parseDoc(`## ASK muse\nhello`))[0].ask!.qid!;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^q-[0-9a-f]{8}$/);
  });
});

describe("builders", () => {
  it("buildAppendAnswer emits a tagged answer block", () => {
    expect(buildAppendAnswer("q-deadbeef", "it works")).toBe(
      "## ANSWER | q-deadbeef\nit works\n"
    );
  });

  it("buildPreamble documents the format", () => {
    const p = buildPreamble();
    expect(p).toContain("## ASK");
    expect(p).toContain("## ANSWER");
    // preamble must not itself parse into ask/answer blocks
    expect(pairBlocks(parseDoc(p))).toHaveLength(0);
  });
});
