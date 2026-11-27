// The composer's prompt editor (ComposerPromptEditorTiptap): a RichEditor whose `$skill` and `@path`
// tokens are inline atoms (an icon, then the label in the kind's ink), deleted by one Backspace and
// stepped over as one character. The prompt text (`value`) stays the source of truth: every change of
// the document is serialised back to it, and a change of it from outside (a pick, a recalled prompt,
// a cleared draft) rebuilds the document.
import { takeThreadUndoShortcut } from "../../sidebar/threadUndoClaim";
import { textDirection } from "../../../textDirection";
/** composer-text-direction.ts: the prompt follows its words' direction (code spans do not count); NSH sets it per editor, not per block. */
const composerDirection = (text: string) => textDirection(text.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)|`[^`\n]*`/g, " ")) ?? "auto";
import { Clipboard, cleanup, colorScheme, computed, effect, signal, untracked, View } from "nsh";
import { RichEditor, RichEditorPlugin, command as richCommand, createRichEditor, defineSchema, history, inputRules, insertText as richInsertText, keymap as richKeymap, markRule, setNodeAttribute, setTextSelection, toggleMark } from "nsh/base";
import type { RichEditorPastedFiles, RichEditorRef, RichNodeJSON } from "nsh/base";
import type { ViewRef } from "nsh";
import { activeRules, dispatchKeystroke } from "../../../commands/registry";
import { toggleSettings } from "../../../commands/standardCommands";
import { parseColor, tokenAlpha } from "../tokenColor";
import { setAppEditorRelease } from "../../terminal/webKeyboard";
import { noteEditorFocus } from "../../EscapeCancel";
import { chipInk } from "./chipColors";
import { CODE_BLOCK_NODE, nodeSize, SOURCE_MARK, styledRangeAt, collectPromptTokens, docToPrompt, offsetToPos, posToOffset, promptToDoc, retokenize, sameDoc, selectedPromptText, TOKEN_NODE } from "./promptDocument";
import { blockAt, codeBlockEnter, codeBlocks, convertFenceOnEnter, convertFenceOnSpace, indentCodeBlock, unwrapCodeBlockAtStart } from "./codeBlockEditing";
import type { CodeBlockEdit } from "./codeBlockEditing";
import { CodeBlockLanguagePicker } from "./CodeBlockLanguagePicker";
import { withInfoStringLanguage } from "./richMarkdown";
import { settingValue } from "../../../store";
import { codeTextStyle } from "../../../typography";
import { joinParagraphAfterListAtStart, liftBlockPrefixAtStart, listContinuationForEnter, listIndentForTab, listOutdentForTab } from "./listContinuation";
import type { ComposerListEdit } from "./listContinuation";
import type { PromptTokenContext } from "./promptDocument";
import { composerPageScrollKey, scrollTimelineByPage } from "../../thread/timeline/pageScroll";
// Registers the token icon font (tools/gen_composer_icon_font.py).
import "../../../fonts/ComposerTokenIcons.ttf";

/** The family the token icons' glyphs come from, after the text's own stack. */
export const TOKEN_ICON_FAMILY = "Composer Token Icons";

export const promptSchema = defineSchema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", toDOM: ["p", 0] },
    // ComposerListExtensions / ComposerTaskItemExtension / ComposerBlockExtensions: lists, tasks, quotes, headings and
    // rules, each keeping its Markdown as written (indent, marker, spaces, prefix, level) so the prompt round-trips.
    bulletList: { content: "listItem+", group: "block list", listMarker: "bullet", toDOM: ["ul", 0] },
    orderedList: { content: "listItem+", group: "block list", listMarker: "ordered", attrs: { start: { default: 1 } }, toDOM: ["ol", 0] },
    listItem: { content: "paragraph list*", defining: true, attrs: { indent: { default: "" }, marker: { default: "-" }, space: { default: " " } }, toDOM: ["li", 0] },
    taskList: { content: "taskItem+", group: "block list", toDOM: ["ul", { "data-type": "taskList" }, 0] },
    taskItem: { content: "paragraph list*", defining: true, render: "task", attrs: { checked: { default: false }, indent: { default: "" }, markerSpace: { default: " " }, contentSpace: { default: null } }, toDOM: ["li", { "data-type": "taskItem" }, 0] },
    blockquote: { content: "paragraph+", group: "block", defining: true, attrs: { prefix: { default: "> " } }, toDOM: ["blockquote", 0] },
    heading: { content: "inline*", group: "block", defining: true, attrs: { level: { default: 1 }, space: { default: " " } }, toDOM: ["h1", 0] },
    horizontalRule: { group: "block", atom: true, attrs: { source: { default: "---" } }, toDOM: ["hr"] },
    // ComposerCodeBlockExtension: the fence's info string, its opening run and its closing line as written.
    [CODE_BLOCK_NODE]: {
      content: "text*", group: "block", code: true, defining: true, marks: "",
      attrs: { language: { default: "" }, fence: { default: "```" }, close: { default: "\n```" } },
      toDOM: ["pre", ["code", 0]],
    },
    text: { group: "inline" },
    [TOKEN_NODE]: {
      inline: true, group: "inline", atom: true, selectable: false,
      attrs: { kind: { default: "file" }, value: { default: "" }, source: { default: "" }, label: { default: "" }, glyph: { default: "" } },
      // The icon glyph (ComposerTokenIcons) then the label: the chip's icon and label, one atom.
      renderText: "{glyph}{label}",
      toDOM: ["span", { "data-kind": { attr: "kind" } }, { attr: "label" }],
    },
  },
  // The rich composer's marks (ComposerBoldExtension, ComposerItalicExtension, ComposerStrikeExtension,
  // ComposerCodeExtension: code excludes only itself, so `**`x`**` keeps both).
  marks: {
    bold: { toDOM: ["strong", 0] },
    italic: { toDOM: ["em", 0] },
    strike: { toDOM: ["s", 0] },
    code: { excludes: "code", code: true, toDOM: ["code", 0] },
    // MARKDOWN_SOURCE_MARK: styled text shown as its Markdown while the selection touches it.
    markdownSource: { inclusive: true, attrs: { delimiter: { default: false } }, toDOM: ["span", { "data-markdown-source": "" }, 0] },
  },
});

/** composerRichTextEnabled (on by default, as the reference's setting). */
export const richTextEnabled = () => { const value = settingValue("composerRichTextEnabled"); return value === undefined || value === true || value === "true"; };

/**
 * The mark input rules (ComposerBoldExtension, ComposerItalicExtension, ComposerStrikeExtension, ComposerCodeExtension):
 * Tiptap's `**text**`, `__text__`, `*text*`, `~~text~~` and `` `text` `` rules, after the line's start or a space. The
 * host reads Rust regular expressions, which have no lookahead, so "not only spaces inside" is a first and last
 * character that is not a space.
 */
export const MARK_INPUT_RULES = [
  markRule("(?:^|\\s)(\\*\\*([^*\\s]|[^*\\s][^*]*[^*\\s])\\*\\*)$", "bold"),
  markRule("(?:^|\\s)(__([^_\\s]|[^_\\s][^_]*[^_\\s])__)$", "bold"),
  markRule("(?:^|\\s)(\\*([^*\\s]|[^*\\s][^*]*[^*\\s])\\*)$", "italic"),
  markRule("(?:^|\\s)(~~([^~\\s]|[^~\\s][^~]*[^~\\s])~~)$", "strike"),
  markRule("(?:^|\\s)(`([^`]+)`)$", "code"),
];

/** A registry keystroke (`mod+shift+k`) as a ProseMirror key name (`Mod-Shift-k`); null for keys the editor keeps. */
export function editorKeyName(keystroke: string): string | null {
  const parts = keystroke.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  if (parts.length === 0) return null;
  const named: Record<string, string> = { enter: "Enter", escape: "Escape", tab: "Tab", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", backspace: "Backspace", delete: "Delete", space: " ", plus: "=", minus: "-", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
  const mods = parts.map((mod) => mod === "mod" || mod === "cmdorctrl" ? "Mod" : mod === "cmd" || mod === "command" || mod === "meta" ? "Meta" : mod === "ctrl" || mod === "control" ? "Ctrl" : mod === "alt" || mod === "option" || mod === "opt" ? "Alt" : mod === "shift" ? "Shift" : mod);
  const name = `${mods.join("-")}-${named[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key)}`;
  return name === "Mod-Enter" ? null : name;
}

/** Chords a text editor uses for editing: clipboard, select all, undo/redo, and any modified arrow, Backspace or Delete. */
export function isEditingChord(name: string): boolean {
  if (/^(Mod|Meta|Ctrl)-(Shift-)?[acvxzy]$/.test(name)) return true;
  return /-(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Backspace|Delete|Home|End)$/.test(name);
}

/** composer-undo-grouping.ts COMPOSER_UNDO_GROUP_DELAY: edits within 1 s group into one undo step. The reference also
 * closes a group when the change kind (insert / delete / other) flips; the host's transaction hooks never see platform
 * input, so that split cannot be made from the app. */
export const COMPOSER_UNDO_GROUP_DELAY = 1000;

/** The editing keymap the editor binds itself (the starter keymap's history and selection chords). */
export const EDITING_KEYMAP = {
  "Mod-z": { command: "undo" }, "Mod-Shift-z": { command: "redo" }, "Mod-y": { command: "redo" },
  "Mod-a": { command: "selectAll" }, "Shift-Enter": { command: "splitBlock" },
} as const;

export interface PromptEditorKeys {
  /** Enter, Tab, Up, Down and Escape go to the app while these say so (the suggestion menu, sending, history). */
  captureEnter: () => boolean;
  /** `caretOnVisualEdge`: the caret is collapsed on the first visual line (ArrowUp) or the last (ArrowDown),
   * soft-wrapped lines included (composer editor isCaretOnVisualEdge, measured with coordsAtPos). */
  captureArrows: (key: "ArrowUp" | "ArrowDown", caretOnVisualEdge: boolean) => boolean;
  captureTab: () => boolean;
  captureEscape: () => boolean;
  /** The suggestion menu is open: its Enter wins over a list item's (composerCommandKey's order). */
  menuOpen?: () => boolean;
  onKey: (key: "Enter" | "ArrowUp" | "ArrowDown" | "Tab" | "Escape" | "Mod-Enter") => void;
}

export interface PromptEditorProps {
  value: () => string;
  onChange: (text: string) => void;
  /** The caret moved: its offset in the prompt text. */
  onCaret: (offset: number) => void;
  /** A caret the app places once (a pick, a recalled prompt). */
  forcedCaret: () => number | undefined;
  onForcedCaretApplied: () => void;
  context: () => PromptTokenContext;
  placeholder: () => string;
  editable: () => boolean;
  keys: PromptEditorKeys;
  textStyle: () => { fontFamily?: string; fontSize?: number };
  minHeight: number;
  maxHeight: number;
  onFocus: () => void;
  onBlur: () => void;
  onPasteFiles: (files: File[], uris: string[]) => void;
  /** Which prompt the editor holds (the thread or draft id): a change makes a new session for that prompt (its own undo
   * history and caret), swapped in after the old view gave the keyboard up, so one thread's text never stays behind. */
  documentKey?: () => string;
  /** ChatComposer's editor label: "Message <thread title>" (switching threads lands focus here, so it names the thread). */
  accessibilityLabel?: () => string;
  ref?: (handle: { focus: () => void; blur?: () => void; editor: ReturnType<typeof createRichEditor> }) => void;
}

type MadeSession = { session: ReturnType<typeof createRichEditor>; enter: RichEditorPlugin; arrows: RichEditorPlugin; arrowDown: RichEditorPlugin; tab: RichEditorPlugin; escape: RichEditorPlugin; listEnter: RichEditorPlugin; shiftTab: RichEditorPlugin; codeBackspace: RichEditorPlugin; boldKey: RichEditorPlugin; markKeys: RichEditorPlugin; rich: boolean };

type ListEditKind = "enter" | "indent" | "outdent";

// A RichEditor view taken out while it holds the keyboard leaves its key table behind (the NSH runtime: the focused view
// binds every named key, Backspace, the arrows, Home/End, Enter, Escape, with `when: always`, and nothing unbinds them
// when the focused view goes). Every plain text field in the app then loses those keys, while letters, which come
// through the input method, still type. So an editor must give the keyboard up BEFORE it is taken out:
// `releasePromptKeyboard()` blurs the focused editors and resolves once they reported the blur.
const mounted = new Set<{ isFocused: () => boolean; blur: () => void; waiters: (() => void)[] }>();
export function releasePromptKeyboard(): Promise<void> {
  const focused = [...mounted].filter((entry) => entry.isFocused());
  if (focused.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let left = focused.length;
    // The blur report comes before the view has dropped its key table (seen in a real window: a draft composer removed
    // in the same tick as its blur report still left the table behind), so the removal waits two frames after it.
    const done = () => { left -= 1; if (left === 0) requestAnimationFrame(() => requestAnimationFrame(() => resolve())); };
    let settled = false;
    const once = () => { if (!settled) { settled = true; resolve(); } };
    for (const entry of focused) { entry.waiters.push(done); entry.blur(); }
    // The blur normally reports within a frame; never hold the caller longer than this.
    setTimeout(once, 300);
  });
}

// A web view the user clicked into asks the focused prompt editors to let go through this (webKeyboard.ts).
setAppEditorRelease(releasePromptKeyboard);

/**
 * `read` as a boolean for a layout switch that can take a prompt editor out: it notifies only when the value flips
 * (so a branch is not re-rendered, and the editor remounted, on every update of what it reads), and only once the
 * focused prompt editors gave the keyboard up (`releasePromptKeyboard`). Call inside a component.
 */
export function settledLayout(read: () => boolean, onBeforeCommit?: () => void): () => boolean {
  const shown = signal(untracked(read));
  let generation = 0;
  effect(() => {
    const next = read();
    if (next === untracked(shown)) return;
    const mine = ++generation;
    void releasePromptKeyboard().then(() => {
      if (mine !== generation) return;
      const value = untracked(read);
      if (value !== untracked(shown)) {
        onBeforeCommit?.();
        shown.set(value);
      }
    });
  });
  return shown;
}


/** The registry's resolved bindings as editor key names, with the keystroke each dispatches. */
export function forwardedShortcuts(): Map<string, string> {
  const shortcuts = new Map<string, string>();
  for (const rule of activeRules()) {
    const name = rule.keystroke ? editorKeyName(rule.keystroke) : null;
    if (!name || !rule.keystroke) continue;
    // The editor's own chords (select all, clipboard, undo, word and line moves and deletes) stay the editor's,
    // unless a composer command claims one while the composer has the keyboard (alt+up edits the last queued message).
    if (isEditingChord(name) && !/(^|[^!])composerFocus/.test(rule.when ?? "")) continue;
    shortcuts.set(name, rule.keystroke);
  }
  // mod+, is the fixed Settings binding (App.tsx), not a registry command.
  shortcuts.set("Mod-,", "mod+,");
  return shortcuts;
}

export function PromptEditor(props: PromptEditorProps) {
  // The rich composer reads Markdown marks and fences (composerRichTextEnabled); the setting changing makes a new session.
  const rich = computed(richTextEnabled);
  const context = (): PromptTokenContext => ({ ...props.context(), richText: rich() });
  let lastText = props.value();
  // Where the caret is, for the keys a code block or a selection claims before they arrive.
  const caretState = signal<{ inCode: boolean; codeStart: boolean; fenceLine: boolean; range: boolean; inList: boolean; blockStart: boolean; inHeading: boolean; afterList: boolean }>({ inCode: false, codeStart: false, fenceLine: false, range: false, inList: false, blockStart: false, inHeading: false, afterList: false });
  const LIST_BLOCK_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
  const isAfterList = (doc: RichNodeJSON, head: number): boolean => {
    const blocks = doc.content ?? [];
    let pos = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      const size = nodeSize(block);
      if (head >= pos && head < pos + size) {
        return index > 0 && block.type === "paragraph" && head === pos + 1 && LIST_BLOCK_TYPES.has(blocks[index - 1]!.type);
      }
      pos += size;
    }
    return false;
  };
  const paragraphText = (node: RichNodeJSON) => docToPrompt({ type: "doc", content: [node] });
  // A document's block tree without its text: what a typed Markdown block shortcut changes.
  const blockShape = (node: RichNodeJSON): string => node.type === "text" || node.type === TOKEN_NODE ? "" : `${node.type}(${(node.content ?? []).map(blockShape).join("")})`;
  // composer editor isCaretOnVisualEdge: a collapsed caret whose line box is the document's first (start) or last (end)
  // visual line. coordsAtPos is in content coordinates (SPECS-editor.md E1: unscrolled), which is enough to compare lines.
  const caretEdges = signal<{ start: boolean; end: boolean }>({ start: true, end: true });
  const readEdges = (live: ReturnType<typeof createRichEditor>) => {
    const { anchor, head, type } = live.selection;
    if (type === "all" || head === undefined || (anchor ?? head) !== head) { caretEdges.set({ start: false, end: false }); return; }
    const text = docToPrompt(live.doc);
    const offset = posToOffset(live.doc, Number(head));
    let start = !text.slice(0, offset).includes("\n");
    let end = !text.slice(offset).includes("\n");
    try {
      const caret = live.coordsAtPos(Number(head)) as { y: number; height: number } | null;
      const first = live.coordsAtPos(offsetToPos(live.doc, 0)) as { y: number; height: number } | null;
      const last = live.coordsAtPos(offsetToPos(live.doc, text.length)) as { y: number; height: number } | null;
      if (caret && first && last) {
        const sameLine = (a: { y: number; height: number }, b: { y: number; height: number }) => Math.abs(a.y - b.y) < Math.max(2, Math.min(a.height, b.height) / 2);
        start = sameLine(caret, first);
        end = sameLine(caret, last);
      }
    } catch { /* keep the logical-line answer */ }
    const prev = untracked(caretEdges);
    if (prev.start !== start || prev.end !== end) caretEdges.set({ start, end });
  };
  const readCaret = (live: ReturnType<typeof createRichEditor>) => {
    readEdges(live);
    const { anchor, head, type } = live.selection;
    // Select all is an AllSelection: no anchor or head, the whole document.
    if (type === "all") { caretState.set({ inCode: false, codeStart: false, fenceLine: false, range: !live.isEmpty, inList: false, blockStart: false, inHeading: false, afterList: false }); return; }
    if (head === undefined) return;
    const at = blockAt(live.doc, Number(head));
    const range = (anchor ?? head) !== head;
    caretState.set({
      inCode: at?.node.type === CODE_BLOCK_NODE,
      codeStart: !range && at?.node.type === CODE_BLOCK_NODE && at.offset === 0,
      fenceLine: !range && at?.node.type === "paragraph" && /^(`{3,}|~{3,})/.test(paragraphText(at.node)),
      range,
      afterList: !range && isAfterList(live.doc, Number(head)),
      ...textblockAt(live, Number(head), range),
    });
  };
  // The textblock the caret is in: inside a list item, at its start, a heading (resolve() / findParentNode).
  const textblockAt = (live: ReturnType<typeof createRichEditor>, head: number, range: boolean) => {
    try {
      const resolved = live.resolve(head) as { parent?: string; parentOffset?: number } | null;
      const inList = Boolean(live.findParentNode("listItem", head) ?? live.findParentNode("taskItem", head));
      return { inList, blockStart: !range && resolved?.parentOffset === 0, inHeading: resolved?.parent === "heading" };
    } catch { return { inList: false, blockStart: false, inHeading: false }; }
  };
  let firstBlockMarked = "";
  let lastSelectionKey = "";
  let blockCheckPending = false;
  const markFirstBlock = (live: ReturnType<typeof createRichEditor>) => {
    const first = live.doc.content?.[0];
    const key = first && first.type !== "paragraph" ? `${first.type}:${nodeSize(first)}` : "";
    if (key === firstBlockMarked) return;
    firstBlockMarked = key;
    live.setDecorations("firstBlock", first && key ? [{ from: 0, to: nodeSize(first), kind: "node", attrs: { class: "mt-0", style: "margin-top: 0" } }] : []);
  };
  // The rich composer's block keys on the prompt's Markdown: Enter in a list item continues or leaves the list
  // (splitOrLiftListItem), Backspace at an item's or a heading's start lifts it (backspaceAcrossList, Tiptap's clearNodes).
  const markdownEdit = (edit: (text: string, offset: number) => { text: string; caret: number } | null): boolean => {
    const live = session();
    const { anchor, head } = selection();
    if (anchor !== head) return false;
    const text = docToPrompt(live.doc);
    const next = edit(text, posToOffset(live.doc, head));
    if (next === null) return false;
    rebuild(next.text, next.caret);
    return true;
  };
  const listEnterEdit = () => markdownEdit((text, offset) => {
    const ranges = collectPromptTokens(text, untracked(context));
    const edit = listContinuationForEnter(text, offset, ranges);
    return edit ? { text: text.slice(0, edit.start) + edit.replacement + text.slice(edit.end), caret: edit.cursorAfter } : null;
  });
  const liftAtStart = () => markdownEdit((text, offset) => {
    const ranges = collectPromptTokens(text, untracked(context));
    return liftBlockPrefixAtStart(text, offset, ranges);
  });
  const joinAfterList = () => markdownEdit((text, offset) => joinParagraphAfterListAtStart(text, offset));
  // composer-markdown-source.ts: styled text the selection touches is shown as its Markdown (editable delimiters, the
  // styling previewed); once the selection leaves it is read back. The prompt text is the same either way.
  let revealed: { start: number; end: number } | null = null;
  const syncReveal = () => {
    if (!untracked(rich)) return;
    const live = session();
    if (live.composing) return;
    const { anchor, head, type } = live.selection;
    if (type === "all" || head === undefined) return;
    const text = docToPrompt(live.doc);
    const a = posToOffset(live.doc, Number(anchor ?? head));
    const h = posToOffset(live.doc, Number(head));
    const next = styledRangeAt(live.doc, text, Math.min(a, h), Math.max(a, h));
    if (next?.start === revealed?.start && next?.end === revealed?.end) return;
    revealed = next;
    const doc = promptToDoc(text, { ...untracked(context), reveal: next });
    live.setContent(doc);
    live.run(setTextSelection(offsetToPos(doc, a), offsetToPos(doc, h)));
  };
  const applyCodeEdit = (edit: CodeBlockEdit | null): boolean => {
    if (edit === null) return false;
    const live = session();
    if ("insert" in edit) { live.run(richInsertText(edit.insert)); return true; }
    live.setContent(edit.doc);
    live.run(setTextSelection(edit.anchor ?? edit.caret, edit.caret));
    return true;
  };
  const selection = () => { const { anchor, head } = session().selection; const end = Number(head ?? 0); return { anchor: Number(anchor ?? end), head: end }; };
  // Enter in a code block, or on a typed fence line, is the editor's (ChatComposer's handleKeyDown order); else the app's.
  const codeEnter = (): boolean => {
    if (!untracked(rich)) return false;
    const live = session();
    const { anchor, head } = selection();
    const at = blockAt(live.doc, head);
    if (at?.node.type === CODE_BLOCK_NODE) return applyCodeEdit(codeBlockEnter(live.doc, anchor, head));
    // Enter in a list item makes the next item, or lifts an empty one (composerCommandKey: a list item's Enter is not a send).
    // A list line typed in one burst may not have become a list node yet: the Markdown decides.
    if (!props.keys.menuOpen?.() && listEnterEdit()) return true;
    return at?.node.type === "paragraph" ? applyCodeEdit(convertFenceOnEnter(live.doc, anchor, head, paragraphText(at.node))) : false;
  };
  // The prompt text and the caret (a collapsed selection's offset, null for a range) as the last revision left them:
  // whether Shift+Enter, Tab or Shift+Tab is a list edit there (composerCommandKey.ts applyListEdit) is decided from it
  // before the key arrives, since a key is captured natively or not at all.
  const listCaret = signal<{ text: string; offset: number | null }>({ text: lastText, offset: null });
  const listEditFor = (kind: ListEditKind, text: string, offset: number): ComposerListEdit | null => {
    const ranges = collectPromptTokens(text, untracked(context));
    return kind === "enter" ? listContinuationForEnter(text, offset, ranges) : kind === "indent" ? listIndentForTab(text, offset, offset, ranges) : listOutdentForTab(text, offset, offset, ranges);
  };
  const canListEdit = (kind: ListEditKind) => { const at = listCaret(); return at.offset !== null && listEditFor(kind, at.text, at.offset) !== null; };
  const applyListEdit = (kind: ListEditKind): boolean => {
    const live = session();
    const { anchor, head } = live.selection;
    if (head === undefined || (anchor ?? head) !== head) return false;
    const text = docToPrompt(live.doc);
    const edit = listEditFor(kind, text, posToOffset(live.doc, Number(head)));
    if (edit === null) return false;
    rebuild(text.slice(0, edit.start) + edit.replacement + text.slice(edit.end), edit.cursorAfter);
    return true;
  };
  // A captured key's handler runs before the deferred `revision` listener (base.d.ts: listeners run in JS's next turn), so
  // text typed just before the key (a fast typist, a test's type then press) had not reached the draft: mod+s stashed
  // nothing and Up read an empty prompt. The handler first applies a revision the listener has not handled yet.
  const plugin = (keys: string[], handler: (key: string) => void) => new RichEditorPlugin(`keys:${keys.join(",")}`).captureKeys(keys, (key) => { flushRevision(); handler(key); });
  // A focused rich editor takes every keystroke, so the app's shortcuts (the command registry) are passed on from
  // here. Capture lists are fixed when a session is made, so a change of the resolved bindings makes a new session
  // (and view) holding the same document and caret.
  const shortcutKey = computed(() => [...forwardedShortcuts().entries()].map((entry) => entry.join("=")).sort().join("|"));
  const make = (doc: RichNodeJSON, caret: number | null): MadeSession => {
    const richNow = untracked(rich);
    // Rich text claims Enter always and decides when it arrives (a code block, a typed fence, a list item), so a key that
    // lands before the caret state reached JS (a fast typist, a pasted burst) is not sent by mistake.
    const enter = plugin(["Enter"], () => {
      if (codeEnter()) return;
      if (props.keys.captureEnter()) props.keys.onKey("Enter");
      else untracked(current).session.run(richCommand("splitBlock"));
    });
    // Up and Down capture separately: on a multiline prompt the caret may sit on the first visual line but not the last.
    const arrows = plugin(["ArrowUp"], () => props.keys.onKey("ArrowUp"));
    const arrowDown = plugin(["ArrowDown"], () => props.keys.onKey("ArrowDown"));
    // Tab is the app's while it says so (a menu, the suggestion); otherwise it nests a list item.
    const tab = plugin(["Tab"], () => {
      if (props.keys.captureTab()) { props.keys.onKey("Tab"); return; }
      const { anchor, head } = selection();
      if (!applyCodeEdit(richNow ? indentCodeBlock(untracked(current).session.doc, anchor, head, "in") : null)) applyListEdit("indent");
    });
    const shiftTab = plugin(["Shift-Tab"], () => {
      const { anchor, head } = selection();
      if (!applyCodeEdit(richNow ? indentCodeBlock(untracked(current).session.doc, anchor, head, "out") : null)) applyListEdit("outdent");
    });
    // Backspace at a code block's start turns it back into lines (unwrapCodeBlockAtStart).
    const codeBackspace = plugin(["Backspace"], () => {
      const { anchor, head } = selection();
      const doc = untracked(current).session.doc;
      if (applyCodeEdit(unwrapCodeBlockAtStart(doc, anchor, head))) return;
      if (liftAtStart()) return;
      if (anchor === head && isAfterList(doc, head) && joinAfterList()) return;
      untracked(current).session.run(richCommand("joinBackward"));
    });
    // Mod+B bolds selected text only (ComposerBoldSelectionOnlyExtension); without a selection it stays the sidebar toggle.
    const boldKey = plugin(["Mod-b"], () => { untracked(current).session.run(toggleMark("bold")); });
    // showThreadUndoNotice: right after a thread action, mod+z undoes it even here; otherwise it is the editor's undo.
    const undoKey = plugin(["Mod-z"], () => { if (!takeThreadUndoShortcut()) untracked(current).session.run(richCommand("undo")); });
    undoKey.capturing = true;
    // Tiptap's Italic, Code and Strike chords.
    const markKeys = plugin(["Mod-i", "Mod-e", "Mod-Shift-s"], (key) => { untracked(current).session.run(toggleMark(key === "Mod-i" ? "italic" : key === "Mod-e" ? "code" : "strike")); });
    markKeys.capturing = richNow;
    // Shift+Enter (a new line) continues a list; elsewhere it splits the line as before.
    const listEnter = plugin(["Shift-Enter"], () => { if (!applyListEdit("enter")) untracked(current).session.run(richCommand("splitBlock")); });
    const escape = plugin(["Escape"], () => props.keys.onKey("Escape"));
    // pageScrollController: unmodified PageUp / PageDown page the timeline (the editor keeps focus and caret).
    const pageKeys = plugin(["PageUp", "PageDown"], (key) => { const page = composerPageScrollKey(key); if (page) scrollTimelineByPage(page); });
    pageKeys.capturing = true;
    const modEnter = plugin(["Mod-Enter"], () => props.keys.onKey("Mod-Enter"));
    modEnter.capturing = true;
    const shortcuts = forwardedShortcuts();
    const registry = plugin([...shortcuts.keys()], (key) => { const keystroke = shortcuts.get(key); if (keystroke === "mod+,") toggleSettings(); else if (keystroke) dispatchKeystroke(keystroke); });
    registry.capturing = true;
    // Copy and cut put the selection's prompt text on the clipboard (tokens as their source), so a paste chips them again.
    let sessionRef: ReturnType<typeof createRichEditor> | null = null;
    const copyKeys = plugin(["Mod-c", "Mod-x"], (key) => {
      const live = sessionRef;
      if (!live) return;
      // RichSelectionJSON carries anchor and head (base.d.ts), not from/to: the range is their ordered pair.
      const { anchor, head } = live.selection;
      if (anchor === undefined || head === undefined || anchor === head) return;
      void Clipboard.writeText(selectedPromptText(live.doc, Math.min(anchor, head), Math.max(anchor, head)));
      if (key === "Mod-x") live.run(richCommand("deleteSelection"));
    });
    copyKeys.capturing = true;
    // `.composer-tiptap > :first-child { margin-top: 0 }`: a leading heading, list or quote does not push the first line down.
    const firstBlock = new RichEditorPlugin("firstBlock");
    firstBlockMarked = "";
    lastSelectionKey = "";
    blockCheckPending = false;
    const session = createRichEditor({
      schema: promptSchema,
      doc,
      ...(caret !== null ? { selection: { type: "text", anchor: caret, head: caret } } : {}),
      plugins: [
        history({ newGroupDelay: COMPOSER_UNDO_GROUP_DELAY }), ...(richNow ? [inputRules(MARK_INPUT_RULES)] : []), listEnter, codeBackspace, boldKey, markKeys,
        richKeymap(EDITING_KEYMAP as never), enter, arrows, arrowDown, tab, shiftTab, escape, pageKeys, modEnter, copyKeys, undoKey, registry, firstBlock,
      ],
    });
    sessionRef = session;
    return { session, enter, arrows, arrowDown, tab, escape, listEnter, shiftTab, codeBackspace, boldKey, markKeys, rich: richNow };
  };
  const current = signal(make(promptToDoc(lastText, untracked(context)), null));
  // The rich text setting changed: a new session reads the prompt again with or without Markdown.
  effect(() => {
    const on = rich();
    if (on === untracked(current).rich) return;
    requestSwap(() => ({ doc: promptToDoc(lastText, untracked(context)), caret: null }));
  });
  let madeFor = untracked(shortcutKey);
  // The swap to a new session waits for the old view to give the keyboard up. A RichEditor binds every named key
  // (Backspace, the arrows, Home/End, Escape) as a view binding while it is focused, and a view taken out while focused
  // left that table behind: every plain field in the app then lost those keys (they were swallowed), while letters,
  // which come through the input method, still typed. Blurring first lets the view drop its table while it is mounted.
  let pendingSwap: (() => void) | null = null;
  // `fresh` says what the new session holds: the old one's document and caret (rebound shortcuts) or another prompt.
  let pendingFresh: (() => { doc: RichNodeJSON; caret: number | null }) | null = null;
  const requestSwap = (fresh: () => { doc: RichNodeJSON; caret: number | null }) => {
    // A second request while one waits replaces what the new session holds (the latest prompt wins).
    if (pendingSwap) { pendingFresh = fresh; return; }
    pendingFresh = fresh;
    const swap = (refocus: boolean) => {
      pendingSwap = null;
      const made = pendingFresh!();
      pendingFresh = null;
      const old = untracked(current).session;
      const next = make(made.doc, made.caret);
      current.set(next);
      queueMicrotask(() => { if (refocus) next.session.focus(); old.dispose(); });
    };
    if (focusedNow && editorRef) {
      pendingSwap = () => swap(true);
      editorRef.blur();
      // The blur normally reports at once; never leave the swap waiting on it.
      setTimeout(() => pendingSwap?.(), 300);
    } else {
      swap(false);
    }
  };
  effect(() => {
    const key = shortcutKey();
    if (key === madeFor) return;
    madeFor = key;
    requestSwap(() => { const old = untracked(current).session; return { doc: old.doc, caret: Number(old.selection.head ?? 0) }; });
  });
  let docKey = untracked(() => props.documentKey?.() ?? "");
  effect(() => {
    const key = props.documentKey?.() ?? "";
    if (key === docKey) return;
    docKey = key;
    requestSwap(() => {
      const text = untracked(props.value);
      lastText = text;
      return { doc: promptToDoc(text, untracked(context)), caret: null };
    });
  });
  let focusedNow = false;
  const entry = { isFocused: () => focusedNow, blur: () => editorRef?.blur(), waiters: [] as (() => void)[] };
  mounted.add(entry);
  cleanup(() => {
    mounted.delete(entry);
    if (settleTimer) clearTimeout(settleTimer);
    if (focusedNow) { focusedNow = false; noteEditorFocus(false); }
  });
  effect(() => { const c = current(); c.enter.capturing = props.keys.captureEnter() || c.rich; });
  effect(() => { const c = current(); const at = caretState(); c.codeBackspace.capturing = c.rich && (at.codeStart || (at.blockStart && (at.inList || at.inHeading || at.afterList))); });
  effect(() => { const c = current(); c.boldKey.capturing = c.rich && caretState().range; });
  effect(() => { const c = current(); const edges = caretEdges(); c.arrows.capturing = props.keys.captureArrows("ArrowUp", edges.start); c.arrowDown.capturing = props.keys.captureArrows("ArrowDown", edges.end); });
  // Rich text claims Tab and Shift+Tab always (the handlers decide), so a Tab that lands before the caret state reached JS
  // never moves the keyboard out of the editor (onto the code block's language picker).
  effect(() => { const c = current(); c.tab.capturing = props.keys.captureTab() || canListEdit("indent") || c.rich; });
  effect(() => { const c = current(); c.shiftTab.capturing = !props.keys.captureTab() && (canListEdit("outdent") || c.rich); });
  effect(() => { const c = current(); c.listEnter.capturing = canListEdit("enter"); });
  effect(() => { const c = current(); c.escape.capturing = props.keys.captureEscape(); });
  effect(() => { current().session.setEditable(props.editable()); });

  const session = () => untracked(current).session;
  const select = (offset: number) => { const pos = offsetToPos(session().doc, offset); session().run(setTextSelection(pos, pos)); };
  const rebuild = (next: string | RichNodeJSON, caret: number) => {
    // A rebuilt prompt shows no source; the selection's sync reveals it again where the caret lands.
    revealed = null;
    lastSelectionKey = "";
    const doc = typeof next === "string" ? promptToDoc(next, untracked(context)) : next;
    session().setContent(doc);
    select(caret);
  };

  let handledRevision = -1;
  const selectionKey = (live: ReturnType<typeof createRichEditor>) => {
    const { type, anchor, head } = live.selection;
    return `${live.revision}:${type}:${anchor ?? ""}:${head ?? ""}`;
  };
  const sameMap = <V,>(a?: ReadonlyMap<string, V>, b?: ReadonlyMap<string, V>): boolean => {
    if (a === b) return true;
    const aSize = a?.size ?? 0;
    const bSize = b?.size ?? 0;
    if (aSize !== bSize) return false;
    if (aSize === 0) return true;
    for (const [key, value] of a!) if (b!.get(key) !== value) return false;
    return true;
  };
  const sameSet = (a?: ReadonlySet<string>, b?: ReadonlySet<string>): boolean => {
    if (a === b) return true;
    const aSize = a?.size ?? 0;
    const bSize = b?.size ?? 0;
    if (aSize !== bSize) return false;
    if (aSize === 0) return true;
    for (const value of a!) if (!b!.has(value)) return false;
    return true;
  };
  const sameContext = (a: PromptTokenContext | null, b: PromptTokenContext): boolean =>
    a !== null && a.richText === b.richText && sameMap(a.skills, b.skills) && sameSet(a.folders, b.folders) && sameMap(a.models, b.models) && sameMap(a.fileAttachments, b.fileAttachments);
  const flushRevision = () => { const c = untracked(current).session; if (c.revision !== handledRevision) onRevision(() => c); };
  const onRevision = (session: () => ReturnType<typeof createRichEditor>) => {
    handledRevision = session().revision;
    const doc = session().doc;
    const text = docToPrompt(doc);
    const offset = posToOffset(doc, Number(session().selection.head ?? 0));
    const textChanged = text !== lastText;
    if (untracked(rich) && session().composing) {
      if (textChanged) blockCheckPending = true;
    } else if (untracked(rich)) {
      if (applyCodeEdit(convertFenceOnSpace(doc, Number(session().selection.head ?? 0)))) return;
      if (textChanged || blockCheckPending) {
        blockCheckPending = false;
        const reread = promptToDoc(text, untracked(context));
        const fences = (node: RichNodeJSON) => (node.content ?? []).filter((block) => block.type === CODE_BLOCK_NODE).length;
        if (fences(reread) === fences(doc) && blockShape(reread) !== blockShape(doc)) { rebuild(text, offset); return; }
      }
    }
    const chipped = session().composing ? doc : retokenize(doc, untracked(context));
    if (!sameDoc(doc, chipped)) rebuild(chipped, offset);
    if (textChanged) { lastText = text; props.onChange(text); }
    props.onCaret(offset);
    const live = session();
    const { anchor, head } = live.selection;
    listCaret.set({ text, offset: head !== undefined && (anchor ?? head) === head ? offset : null });
    lastSelectionKey = selectionKey(live);
    readCaret(live);
    measureHeaders();
    syncReveal();
    markFirstBlock(live);
  };
  effect(() => { const c = current().session; const stop = c.on("revision", () => { if (untracked(current).session === c) onRevision(() => c); }); cleanup(stop); });
  // A prompt loaded with a heading first (a draft, a recall) gets the first-block rule without waiting for an edit.
  effect(() => { const c = current().session; queueMicrotask(() => { if (untracked(current).session === c) markFirstBlock(c); }); });

  let lastContext: PromptTokenContext | null = null;
  effect(() => {
    const text = props.value();
    const forced = props.forcedCaret();
    const nextContext = { ...props.context(), richText: rich() };
    const contextChanged = !sameContext(lastContext, nextContext);
    lastContext = nextContext;
    if (text !== lastText) {
      lastText = text;
      rebuild(text, forced ?? text.length);
    } else if (contextChanged) {
      const chipped = retokenize(session().doc, nextContext);
      if (!sameDoc(session().doc, chipped)) rebuild(chipped, forced ?? posToOffset(session().doc, Number(session().selection.head ?? 0)));
      else if (forced !== undefined) select(forced);
    } else if (forced !== undefined) {
      select(forced);
    }
    if (forced !== undefined) props.onForcedCaretApplied();
  });

  // The tokens' ink per kind, solved on the composer's surface (contextChipVariables).
  const nodeStyles = () => {
    const family = props.textStyle().fontFamily;
    // The host draws a text run in the first family of the list and does not fall through to a later one for a glyph that family
    // lacks (the icon drew as a "?" box when Bricolage came first). So the first family is the icon font, which is Bricolage
    // Grotesque UI Regular with the icons added (tools/gen_composer_icon_font.py) and so also draws the label; the prompt's
    // own stack follows for any character Bricolage lacks.
    const fontFamily = `"${TOKEN_ICON_FAMILY}"${family ? `, ${family}` : ""}`;
    const surface = parseColor(tokenAlpha(colorScheme() === "dark" ? "surface-raised" : "card", 1)) ?? [255, 255, 255];
    return {
      [`${TOKEN_NODE}[kind=skill]`]: { color: chipInk("skill", surface), fontFamily },
      [`${TOKEN_NODE}[kind=file]`]: { color: chipInk("file", surface), fontFamily },
      [`${TOKEN_NODE}[kind=folder]`]: { color: chipInk("mention", surface), fontFamily },
      [`${TOKEN_NODE}[kind=model]`]: { color: chipInk("model", surface), fontFamily },
      [`${TOKEN_NODE}[kind=pull-request]`]: { color: chipInk("pull-request", surface), fontFamily },
      [`${TOKEN_NODE}[kind=thread]`]: { color: chipInk("thread", surface), fontFamily },
      [`${TOKEN_NODE}[kind=terminal]`]: { color: chipInk("terminal", surface), fontFamily },
      [`${TOKEN_NODE}[kind=preview-annotation]`]: { color: chipInk("preview-annotation", surface), fontFamily },
      [`${TOKEN_NODE}[kind=citation]`]: { color: chipInk("citation", surface), fontFamily },
      // The code block's frame (MarkdownCodeBlockFrame): the code font on the code background; its header sits in the top padding.
      [CODE_BLOCK_NODE]: { ...codeTextStyle(), backgroundColor: tokenAlpha("code-background", 1), color: tokenAlpha("code-foreground", 1) },
    };
  };
  // `.composer-tiptap :not(pre) > code` and the emphasis marks.
  const markStyles = () => ({
    bold: { fontWeight: "bold" as const },
    italic: { fontStyle: "italic" as const },
    strike: { textDecorationLine: "line-through" as const },
    code: { ...codeTextStyle(), fontSize: Math.round((codeTextStyle().fontSize ?? 14) * 0.92), backgroundColor: tokenAlpha("muted-foreground", 0.12) },
    // .composer-rich-marker: the shown delimiters, muted at 75%, never styled themselves.
    [`${SOURCE_MARK}[delimiter=true]`]: { color: tokenAlpha("muted-foreground", 0.75), fontWeight: "normal" as const, fontStyle: "normal" as const, textDecorationLine: "none" as const },
  });

  // ComposerCodeBlockNodeView's header: the language picker over each code block's top padding, placed from the
  // position of the block's first character (the host draws no app views inside the document).
  const HEADER_HEIGHT = 28;
  let wrapperRef: ViewRef | null = null;
  const contentHeight = signal(0);
  const headers = signal<{ start: number; language: string; x: number; y: number }[]>([]);
  let measureQueued = false;
  // The editor scrolls the caret into view after a change, a frame or two later: measure again once it has.
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWrapperWidth = -1;
  function measureHeaders() {
    const live = session();
    const structuredDoc = untracked(rich) && (live.doc.content ?? []).some((node) => node.type !== "paragraph");
    if (!structuredDoc && untracked(headers).length === 0 && untracked(contentHeight) === 0) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { settleTimer = null; measureNow(); }, 150);
    measureNow();
  }
  function measureNow() {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => {
      measureQueued = false;
      const live = session();
      const blocks = untracked(rich) ? codeBlocks(live.doc) : [];
      const structuredDoc = untracked(rich) && (live.doc.content ?? []).some((node) => node.type !== "paragraph");
      void ((blocks.length || structuredDoc) && wrapperRef ? wrapperRef.measure() : Promise.resolve(null)).then((frame) => {
        const height = frame?.bounds.size.height ?? Infinity;
        const next = blocks.flatMap((block) => {
          const box = live.coordsAtPos(block.start) as { x: number; y: number } | null;
          return box && box.y - HEADER_HEIGHT >= -4 && box.y - HEADER_HEIGHT < height ? [{ ...block, x: box.x, y: box.y }] : [];
        });
        if (JSON.stringify(next) !== JSON.stringify(untracked(headers))) headers.set(next);
        const endPos = offsetToPos(live.doc, docToPrompt(live.doc).length);
        let end: { y: number; height: number } | null = null;
        let first: { y: number; height: number } | null = null;
        const structured = (live.doc.content ?? []).some((node) => node.type !== "paragraph");
        if (structured) {
          try {
            end = live.coordsAtPos(endPos) as { y: number; height: number } | null;
            first = live.coordsAtPos(offsetToPos(live.doc, 0)) as { y: number; height: number } | null;
          } catch {
            end = null;
            first = null;
          }
        }
        const last = (live.doc.content ?? [])[(live.doc.content ?? []).length - 1];
        const firstBlockTop = live.doc.content?.[0]?.type === CODE_BLOCK_NODE ? 32 : 0;
        const scrollTop = first && first.y < firstBlockTop ? first.y - firstBlockTop : 0;
        const needed = end ? Math.ceil(end.y - scrollTop + end.height + (last?.type === CODE_BLOCK_NODE ? 14 : last?.type === "paragraph" ? 0 : 10)) : 0;
        if (needed !== untracked(contentHeight)) contentHeight.set(needed);
      });
    });
  }
  const changeLanguage = (start: number, info: string, language: string) => {
    const live = session();
    live.run(setNodeAttribute(start - 1, "language", withInfoStringLanguage(info, language)));
    const at = blockAt(live.doc, start);
    if (at) live.run(setTextSelection(at.start + (at.node.content ?? []).reduce((sum, node) => sum + (node.text ?? "").length, 0), at.start + (at.node.content ?? []).reduce((sum, node) => sum + (node.text ?? "").length, 0)));
    editorRef?.focus();
  };

  // The caret where the editor lost the keyboard: a programmatic focus (the composer taking the keyboard back after
  // Settings, the palette or a menu closes) puts it back there; the view alone came back with the caret at the start.
  // Only while the text is still what it was: a draft set meanwhile places its own caret.
  let caretAtBlur: { pos: number; text: string } | null = null;
  const focusEditor = () => {
    editorRef?.focus();
    const at = caretAtBlur;
    if (at === null || at.text !== lastText) return;
    queueMicrotask(() => {
      try { session().run(setTextSelection(at.pos, at.pos)); } catch { /* a position the document no longer has */ }
    });
  };
  props.ref?.({ focus: focusEditor, blur: () => editorRef?.blur(), get editor() { return untracked(current).session; } });
  let editorRef: RichEditorRef | null = null;
  const pasted = (paste: RichEditorPastedFiles) => {
    // RichEditor serializes native byte vectors as number arrays. A plain array
    // is stringified by File, corrupting the pasted image; turn it into bytes.
    const files = paste.files.map((file) => new File([new Uint8Array(file.data)], file.name, { type: file.mime }));
    props.onPasteFiles(files, paste.uris);
  };
  // One row per session: a new session (rebound shortcuts) makes a new view, as RichEditor requires.
  return (
    <View class="relative w-full" ref={(node: ViewRef) => { wrapperRef = node; }} onLayout={(event) => { const width = event.bounds.size.width; if (width !== lastWrapperWidth) { lastWrapperWidth = width; measureHeaders(); requestAnimationFrame(() => readEdges(session())); } }}>
    <Each of={[current()]}>{(item) => (
    <RichEditor
      ref={(node: RichEditorRef) => { editorRef = node; }}
      editor={item().session}
      accessibilityLabel={props.accessibilityLabel?.() ?? "Message"}
      testID="composer-prompt"
      autoFocus
      placeholder={props.placeholder()}
      onFocus={() => { if (!focusedNow) noteEditorFocus(true); focusedNow = true; props.onFocus(); }}
      onBlur={() => { caretAtBlur = { pos: Number(session().selection.head ?? 0), text: lastText }; if (focusedNow) noteEditorFocus(false); const waiting = entry.waiters.splice(0); for (const resolve of waiting) resolve(); focusedNow = false; props.onBlur(); if (pendingSwap) requestAnimationFrame(() => requestAnimationFrame(() => pendingSwap?.())); }}
      onPasteFiles={(event) => pasted(event.paste)}
      onSelectionChange={() => { const live = session(); const key = selectionKey(live); if (key === lastSelectionKey) return; lastSelectionKey = key; readCaret(live); measureHeaders(); syncReveal(); }}
      class="w-full bg-transparent text-foreground leading-relaxed"
      style={{ minHeight: Math.min(props.maxHeight, Math.max(props.minHeight, contentHeight())), maxHeight: props.maxHeight, ...props.textStyle() }}
      classes={{
        content: "p-0",
        // index.css `.composer-tiptap` and `:is(.chat-markdown, .composer-tiptap)`: block spacing, list gutters, the quote's
        // rule, heading sizes (h1 1.25rem, h2 1.125rem, h3 1rem, h4-h6 0.875rem, all 600 at 1.3 line height).
        nodes: {
          [CODE_BLOCK_NODE]: "my-1 rounded-lg px-3 pb-2.5 pt-8",
          bulletList: "my-[0.65rem] ps-5", orderedList: "my-[0.65rem] ps-5",
          // `.composer-tiptap ul[data-type="taskList"]`: no marker, no margin; the checkbox and the text in a row, gap 0.5rem.
          taskList: "m-0 p-0", taskItem: "flex-row items-start gap-2",
          blockquote: "my-[0.65rem] border-l-2 border-border ps-[0.8rem]",
          horizontalRule: "my-[0.65rem] h-px bg-border",
          heading: "mt-5 mb-2 font-semibold leading-[1.3]",
          "heading[level=1]": "text-xl", "heading[level=2]": "text-lg", "heading[level=3]": "text-base",
          "heading[level=4]": "text-sm", "heading[level=5]": "text-sm", "heading[level=6]": "text-sm text-muted-foreground",
        },
        marks: { code: "rounded-sm px-1" },
        // `li[data-checked] > label input`: a 0.95rem box, as tall as the line.
        taskCheckbox: "mt-[0.2rem] size-[0.95rem] rounded-[4px] border border-input checked:bg-primary checked:border-primary",
      }}
      styles={{ nodes: nodeStyles(), marks: markStyles(), placeholder: { color: tokenAlpha("placeholder", 1) }, content: { writingDirection: composerDirection(props.value()) } }}
    />
    )}</Each>
    <Each of={headers()} key={(header) => `${header.start}:${header.language}`}>
      {(header) => (
        <View class="absolute flex-row items-center" style={{ left: header().x, top: header().y - HEADER_HEIGHT + 2, height: HEADER_HEIGHT - 4 }}>
          <CodeBlockLanguagePicker language={() => header().language} disabled={() => !props.editable()} onChange={(language) => changeLanguage(header().start, header().language, language)} />
        </View>
      )}
    </Each>
    </View>
  );
}
