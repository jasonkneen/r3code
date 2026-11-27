import { expect, test } from "nsh/test";
import { CODE_BLOCK_NODE, docToPrompt, offsetToPos, posToOffset, promptToDoc } from "./promptDocument";
import type { RichNodeJSON } from "nsh/base";

const rich = { skills: new Map([["my-skill", "My skill"]]), richText: true };
const roundTrip = (value: string) => docToPrompt(promptToDoc(value, rich));

// composer-rich-text-doc.test.ts "round-trips %s through a real ProseMirror document" (the inline and fence cases; the
// port has no list or quote nodes, so its list lines stay text and round-trip as such).
const ROUND_TRIPS = [
  "", "\n\n", "plain text", "hello **bold** world", "a *italic* word and `code` here", "struck ~~out~~ now",
  "**`x`**", "*`x`*", "~~`x`~~", "**a `code` c**", "***bold italic*** keeps nesting", "line one\nline two", "trailing newline\n",
  "1. foo\n2. asdf\n", "- [ ] buy milk", "**before @README.md after**", "*a **b** c*", "*a**b***", "**a*b***", "**a *b* c**",
  "@README.md explain this", "@\"docs/My File.md\" and $my-skill please", "snake_case stays literal", "unmatched ** stays literal",
  "**bold** then @README.md then *italic*", "```ts\nab\n```", "before\n```\n```", "```\ncode", "````\ninitial\n```\nsecret\n````",
  // Lists, tasks, quotes, headings and rules (the reference's block cases).
  "1. foo\n2. asdf", "-   [ ]  buy milk", "\t-\t[x]\t\titem", "- [ ]  ", "- [ ]\n  - [ ] child", "  - [ ] first\n - [ ] second\n  - [ ] child",
  "- [x] done\n- [ ] next", "- [ ] parent\n  - [ ] child\n  - [ ] sibling\n- [ ] uncle", "- [ ] empty task follows\n- [ ]",
  "- [ ] **bold** task with @README.md", "para\n- [ ] task\n\npara", "- [ ]No space stays literal", "-[ ] also literal",
  "# Title\nbody", "### three", "> quoted\n> more", "> q\n\nafter", "---\nbelow", "- a\n  - b\n- c", "* star\n+ plus",
];
for (const value of ROUND_TRIPS) {
  test(`round-trips ${JSON.stringify(value)}`, () => { expect(roundTrip(value)).toBe(value); });
}

test("emphasis becomes marks, a chip inside bold keeps the mark, and a fence becomes a code block with its language", () => {
  const doc = promptToDoc("**before @README.md after**\n```ts\nconst a = 1\n```", rich);
  const [first, second] = doc.content!;
  expect(first!.content!.map((node) => [node.type, (node.marks ?? []).map((mark) => mark.type)])).toEqual([["text", ["bold"]], ["token", ["bold"]], ["text", ["bold"]]]);
  expect(second!.type).toBe(CODE_BLOCK_NODE);
  expect(second!.attrs).toEqual({ language: "ts", fence: "```", close: "\n```" });
  expect(second!.content![0]!.text).toBe("const a = 1");
});

test("without rich text the delimiters and fences stay text", () => {
  const doc = promptToDoc("**b**\n```\nx\n```", { skills: new Map() });
  expect(doc.content!.length).toBe(4);
  expect(doc.content![0]!.content![0]).toEqual({ type: "text", text: "**b**" });
});

test("code holding a closing fence is written inside a longer fence; an unclosed fence before a block is closed", () => {
  const code = (text: string, close: string): RichNodeJSON => ({ type: CODE_BLOCK_NODE, attrs: { language: "", fence: "```", close }, content: [{ type: "text", text }] });
  expect(docToPrompt({ type: "doc", content: [code("initial\n```\nsecret", "\n```")] })).toBe("````\ninitial\n```\nsecret\n````");
  expect(docToPrompt({ type: "doc", content: [code("code", ""), { type: "paragraph", content: [{ type: "text", text: "after" }] }] })).toBe("```\ncode\n```\nafter");
});

test("caret offsets skip delimiters and fence lines", () => {
  const doc = promptToDoc("a **bc** d", rich);
  // positions: 1 a, 2 " ", 3 b, 4 c, 5 " ", 6 d
  expect(posToOffset(doc, 3)).toBe("a **".length);
  expect(posToOffset(doc, 5)).toBe("a **bc**".length);
  expect(offsetToPos(doc, "a *".length)).toBe(3);
  const fenced = promptToDoc("```ts\nab\n```", rich);
  expect(posToOffset(fenced, 1)).toBe("```ts\n".length);
  expect(posToOffset(fenced, 3)).toBe("```ts\nab".length);
  for (let offset = 0; offset <= "```ts\n".length; offset += 1) expect(offsetToPos(fenced, offset)).toBe(1);
  expect(offsetToPos(fenced, "```ts\nab\n``".length)).toBe(3);
});

test("lists, tasks, quotes, headings and rules become their nodes", () => {
  const doc = promptToDoc("# Head\n- a\n  - b\n1. one\n- [x] done\n> q\n---", rich);
  expect(doc.content!.map((node) => node.type)).toEqual(["heading", "bulletList", "orderedList", "taskList", "blockquote", "horizontalRule", "paragraph"]);
  const bullet = doc.content![1]!;
  expect(bullet.content![0]!.content!.map((node) => node.type)).toEqual(["paragraph", "bulletList"]);
  expect(doc.content![3]!.content![0]!.attrs!.checked).toBe(true);
});

test("caret offsets map through list markers and quote prefixes", () => {
  const doc = promptToDoc("- ab\n> cd", rich);
  // bulletList(0) listItem(1) paragraph(2) "a"=3 "b"=4; blockquote at 8, paragraph 9, "c"=10
  expect(posToOffset(doc, 3)).toBe("- ".length);
  expect(posToOffset(doc, 10)).toBe("- ab\n> ".length);
  expect(offsetToPos(doc, "- a".length)).toBe(4);
});

test("orderedList items with default or missing marker attrs keep ordered markers", () => {
  const doc: RichNodeJSON = {
    type: "doc",
    content: [
      {
        type: "orderedList",
        attrs: { start: 1 },
        content: [
          { type: "listItem", attrs: { indent: "", marker: "1.", space: " " }, content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
          { type: "listItem", attrs: { indent: "", marker: "-", space: " " }, content: [{ type: "paragraph" }] },
        ],
      },
    ],
  };
  expect(docToPrompt(doc)).toBe("1. first\n2. ");
  expect(promptToDoc(docToPrompt(doc), rich).content?.map((node) => node.type)).toEqual(["orderedList"]);

  const parenDoc: RichNodeJSON = {
    type: "doc",
    content: [
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [
          { type: "listItem", attrs: { indent: "", marker: "3)", space: " " }, content: [{ type: "paragraph", content: [{ type: "text", text: "third" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "fourth" }] }] },
        ],
      },
    ],
  };
  expect(docToPrompt(parenDoc)).toBe("3) third\n4) fourth");

  const zeroDoc = promptToDoc("0) zero", rich);
  zeroDoc.content![0]!.content!.push({ type: "listItem", attrs: { indent: "", marker: "-", space: " " }, content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] });
  expect(docToPrompt(zeroDoc)).toBe("0) zero\n1) one");

  const afterGapDoc = promptToDoc("1. x\n\nafter", rich);
  expect(offsetToPos(afterGapDoc, "1. x".length)).toBe(4);
});
