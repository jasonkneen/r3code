import { expect, test } from "nsh/test";
import { TextView } from "nsh/base";
import type { TextViewBlock, TextViewInline } from "nsh/base";
import { assistantCitationLabel, parseAssistantCitationHref, serializeAssistantCitation, type AssistantCitation } from "./assistantCitations";
import { labelFileChips, matchInlineSkills, tableCellLabelMaxWidth, transformMarkdownBlocks, WEB_CHIP_MAX_LABEL, type FileChipData, type InlineContext, type ThreadChipData } from "./markdownInline";
import type { MarkdownFileLinkMeta } from "./fileLinkMeta";

const CONTEXT: InlineContext = { cwd: "/Users/dev/app", skills: [{ name: "review", displayName: "Code Review" }, { name: "deploy", displayName: null }], webLinkChips: true };

function inlinesOf(markdown: string, context: InlineContext = CONTEXT): TextViewInline[] {
  // The app parses with math off by default (the "Math rendering" setting), so `$` is plain text here.
  const document = TextView.parse(markdown, { math: false }, null);
  const blocks = transformMarkdownBlocks(document.blocks, context);
  const first = blocks[0] as Extract<TextViewBlock, { type: "paragraph" }>;
  return first.content;
}
// Chips only: plain inline code is drawn as an "inlinecode" pill custom node (ChatMarkdown InlineCodePill), not a chip.
const customs = (content: TextViewInline[]) => content.filter((node): node is Extract<TextViewInline, { type: "custom" }> => node.type === "custom" && node.name !== "inlinecode");

const CITATION: AssistantCitation = { version: 1, environmentId: "env-a", threadId: "thread-1", messageId: "msg-9", text: "the quoted text", start: 4, end: 19, prefix: "see ", suffix: " and", comment: "why?" };

test("a citation link round trips and its label prefers the comment, folds whitespace and cuts at 64", () => {
  const href = /\((.*)\)$/.exec(serializeAssistantCitation(CITATION))![1]!;
  expect(parseAssistantCitationHref(href)).toEqual(CITATION);
  expect(assistantCitationLabel(CITATION)).toBe("why?");
  expect(assistantCitationLabel({ ...CITATION, comment: undefined, text: "a\n  b" })).toBe("a b");
  expect(assistantCitationLabel({ ...CITATION, comment: undefined, text: "x".repeat(80) })).toBe(`${"x".repeat(64)}…`);
  expect(parseAssistantCitationHref(href.replace("end=19", "end=4"))).toBe(null);
  expect(parseAssistantCitationHref(`${href}&extra=1`)).toBe(null);
  expect(parseAssistantCitationHref("https://example.com")).toBe(null);
});

test("a citation link in text becomes a citation chip, and a thread link a thread chip", () => {
  const href = /\((.*)\)$/.exec(serializeAssistantCitation(CITATION))![1]!;
  const content = inlinesOf(`See [Assistant quote](${href}) and [the plan](t3-thread://v2/env-a/thread-2) or <t3-thread://v1/thread-3>.`);
  const names = customs(content).map((node) => node.name);
  expect(names).toEqual(["citation", "threadlink", "threadlink"]);
  expect(customs(content)[1]!.data).toEqual({ threadId: "thread-2", environmentId: "env-a", label: "the plan" });
  expect(customs(content)[2]!.data).toEqual({ threadId: "thread-3", environmentId: null, label: null });
});

test("a file link is a chip with its position; a link that only repeats the file stands alone, otherwise its text comes first", () => {
  const files: MarkdownFileLinkMeta[] = [];
  const document = TextView.parse("Open [src/a.ts](/Users/dev/app/src/a.ts#L12) and [the entry point](src/b.ts:3), see `lib/c.ts:9` or `const x`.", {}, null);
  const blocks = transformMarkdownBlocks(document.blocks, CONTEXT, files);
  labelFileChips(blocks, files);
  const content = (blocks[0] as Extract<TextViewBlock, { type: "paragraph" }>).content;
  const chips = customs(content).map((node) => node.data as FileChipData);
  expect(chips.map((chip) => chip.label)).toEqual(["a.ts · L12", "b.ts · L3", "c.ts · L9"]);
  expect(chips.map((chip) => chip.inlineCode)).toEqual([false, false, true]);
  expect(chips[0]!.meta.workspaceRelativePath).toBe("src/a.ts");
  expect(chips[1]!.copyMarkdown).toBe("[the entry point](src/b.ts:3)");
  // "the entry point" stays in front of its chip, as text.
  expect(content.some((node) => node.type === "text" && node.text === "the entry point")).toBe(true);
  expect(content.some((node) => node.type === "custom" && node.name === "inlinecode" && (node.data as { code: string }).code === "const x")).toBe(true);
});

test("without a workspace no link is a file link, and web links chip only when their text is short and plain", () => {
  const none = inlinesOf("[a.ts](src/a.ts) and `src/b.ts`", { ...CONTEXT, cwd: null });
  expect(customs(none)).toEqual([]);
  const web = inlinesOf(`[docs](https://example.com/docs) [${"long ".repeat(12)}](https://example.com/x) [**bold**](https://example.com/y)`);
  expect(customs(web).map((node) => node.name)).toEqual(["weblink"]);
  expect(customs(web)[0]!.data).toEqual({ url: "https://example.com/docs", host: "example.com", label: "docs" });
  expect("long ".repeat(12).length).toBeGreaterThan(WEB_CHIP_MAX_LABEL);
  expect(customs(inlinesOf("[docs](https://example.com)", { ...CONTEXT, webLinkChips: false }))).toEqual([]);
});

test("a skill name written as $name becomes a chip only for a known skill and outside code and links", () => {
  expect(matchInlineSkills("Run $review now, then $unknown, then $deploy", CONTEXT.skills).map((match) => match.raw)).toEqual(["$review", "$deploy"]);
  expect(matchInlineSkills("It costs $5 and $10k", CONTEXT.skills)).toEqual([]);
  const content = inlinesOf("Run $review now `$deploy` [$deploy](https://example.com)");
  const chips = customs(content).filter((node) => node.name === "skill");
  expect(chips.map((node) => node.text)).toEqual(["$review"]);
});

test("chips inside lists, quotes, tables and headings are found too", () => {
  const document = TextView.parse("- item [a](src/a.ts)\n\n> quoted `src/b.ts`\n\n| h |\n| - |\n| [c](src/c.ts) |\n\n## Head [d](src/d.ts)", {}, null);
  const blocks = transformMarkdownBlocks(document.blocks, CONTEXT);
  const text = JSON.stringify(blocks);
  expect((text.match(/"name":"filelink"/g) ?? []).length).toBe(4);
});

test("model:<instance>/<model> becomes a chip only for a model the resolver knows, outside code and links", async () => {
  const { collectComposerModelMentions } = await import("./modelMentions");
  expect(collectComposerModelMentions("Use model:codex/gpt-6.1-sol. Or (model:claude/opus[1m]) and model:oc/a/b/c, not xmodel:a/b").map((mention) => mention.source)).toEqual(["model:codex/gpt-6.1-sol", "model:claude/opus[1m]", "model:oc/a/b/c"]);
  const known = { label: "GPT 6.1 Sol", providerLabel: "Codex", driver: "codex", providerDisplayName: "Codex", accentColor: null, instanceId: "codex" };
  const context: InlineContext = { ...CONTEXT, models: (instance, model) => (instance === "codex" && model === "gpt-6.1-sol" ? known : null) };
  const content = inlinesOf("Try model:codex/gpt-6.1-sol or model:codex/other, and `model:codex/gpt-6.1-sol` too", context);
  const chips = customs(content).filter((node) => node.name === "model");
  expect(chips.length).toBe(1);
  expect((chips[0] as { data: { source: string } }).data.source).toBe("model:codex/gpt-6.1-sol");
});

test("table cell chips carry column bounds so wide tables cap labels inside their column", () => {
  const markdown = [
    "| Role Thread | Platform | Sent (CST) | Receipt | Next |",
    "| --- | --- | --- | --- | --- |",
    "| [China Telecom Data Development Center](t3-thread://v1/thread-1) | BOSS | `2026-11-26 19:28:12` | `ok` | `2026-11-27` |",
  ].join("\n");
  const document = TextView.parse(markdown, { math: false }, null);
  const blocks = transformMarkdownBlocks(document.blocks, CONTEXT);
  const table = blocks[0] as Extract<TextViewBlock, { type: "table" }>;
  const chip = customs(table.rows![0]![0]!.content)[0]!.data as ThreadChipData;
  expect(chip.tableColumn).toBeDefined();
  const capped = tableCellLabelMaxWidth(chip.tableColumn!, 640);
  expect(capped).toBeGreaterThanOrEqual(64);
  expect(capped).toBeLessThan(chip.tableColumn!.minPx);
  expect(capped).toBeLessThan(288);
});
