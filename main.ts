import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  TFile,
  editorInfoField,
  debounce,
  editorLivePreviewField,
  getIcon,
  requireApiVersion,
  setIcon,
  setTooltip,
} from 'obsidian';
import type { MarkdownPostProcessorContext, WorkspaceLeaf } from 'obsidian';
import { syntaxTree } from '@codemirror/language';
import { Prec, RangeSetBuilder } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';

import { tryParse } from './src/notation.ts';
import { tryRoll } from './src/roll.ts';
import type { Outcome, RollOptions, Rounding } from './src/roll.ts';
import {
  findInlineCode,
  modReplacement,
  noteFields,
  occurrence,
  parseInline,
  resultText,
  rollKey,
  tooltipText,
  totalText,
  validAlias,
} from './src/inline.ts';
import type { DisplayOptions, InlineRoll } from './src/inline.ts';
import { addDie, addEntry, readHistory, readLegacyFormulas, recentFormulas, renameSource, when } from './src/history.ts';
import type { HistoryEntry } from './src/history.ts';

interface DiceRollsSettings {
  /** Faces of a die written without them (`3d`). */
  defaultFaces: number;
  showButton: boolean;
  showFormula: boolean;
  rounding: Rounding;
  signed: boolean;
  /** `dice-mod:` writes `formula -> rolls -> total` rather than the total alone. */
  modFormula: boolean;
  /** Escape `*`, `[` and `]` in what `dice-mod:` writes. */
  escapeMod: boolean;
  /** Clicking a roll in a note adds it to the history. */
  logNoteRolls: boolean;
  historySize: number;
  /** Saved formulas by name, as in Dice Roller. */
  formulas: Record<string, string>;
}

const DEFAULT_SETTINGS: DiceRollsSettings = {
  defaultFaces: 100,
  showButton: true,
  showFormula: false,
  rounding: 'none',
  signed: false,
  modFormula: true,
  escapeMod: true,
  logNoteRolls: true,
  historySize: 100,
  formulas: {},
};

interface StoredData extends Partial<DiceRollsSettings> {
  history?: unknown;
}

const VIEW_TYPE = 'dice-rolls-history';
/** Where Dice Roller keeps its settings, relative to the config folder. */
const LEGACY_DATA = 'plugins/obsidian-dice-roller/data.json';
const QUICK_DICE = [4, 6, 8, 10, 12, 20, 100];
/** Totals outside notes follow the settings alone. */
const NO_FLAGS = { rounding: null, signed: null };

/** What a roll in a note last showed; kept so redrawing a note does not reroll it. */
interface Shown {
  outcome: Outcome | null;
}

/** Where a roll in a note sits, so it can find its fields and, for `dice-mod:`, write its result. */
interface RollPlace {
  key: string;
  source: string;
  /** The note's text, for number fields used as names in the formula. */
  text: () => string;
  /** Writes a `dice-mod:` result into the note; resolves false if the note changed. */
  write?: (replacement: string) => Promise<boolean>;
}

export default class DiceRollsPlugin extends Plugin {
  settings: DiceRollsSettings = { ...DEFAULT_SETTINGS, formulas: {} };
  history: HistoryEntry[] = [];
  /** Results shown in notes, by `rollKey`. */
  private shown = new Map<string, Shown>();
  /** Bumped to make every roll in the editor redraw (and reroll if forgotten). */
  epoch = 0;
  private editorExtensions: Extension[] = [];

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new HistoryView(leaf, this));
    this.editorExtensions.push(this.buildExtension());
    this.registerEditorExtension(this.editorExtensions);
    this.registerMarkdownPostProcessor((el, ctx) => this.processReading(el, ctx));
    this.addSettingTab(new DiceRollsSettingTab(this.app, this));
    this.addRibbonIcon('dices', 'Open roll history', () => void this.openHistory());

    this.addCommand({
      id: 'roll',
      name: 'Roll dice…',
      icon: 'dices',
      callback: () => new RollModal(this.app, this, this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null).open(),
    });
    this.addCommand({
      id: 'open-history',
      name: 'Open roll history',
      icon: 'history',
      callback: () => void this.openHistory(),
    });
    this.addCommand({
      id: 'insert-roll',
      name: 'Insert inline dice roll',
      icon: 'dice-5',
      editorCallback: (editor) => this.insertRoll(editor),
    });
    this.addCommand({
      id: 'write-dice-mod',
      name: 'Write the results of dice-mod rolls in this note',
      icon: penIcon(),
      editorCallback: (editor, ctx) => this.writeAllMods(editor, ctx.file?.path ?? ''),
    });
    this.addCommand({
      id: 'reroll-note',
      name: 'Reroll every dice roll in this note',
      icon: 'refresh-cw',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.rerollNote(file.path);
        return true;
      },
    });

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.forget(oldPath);
        if (this.history.some((e) => e.source === oldPath)) {
          this.history = renameSource(this.history, oldPath, file.path);
          void this.saveHistory();
        }
      }),
    );
    this.registerEvent(this.app.vault.on('delete', (file) => this.forget(file.path)));
  }

  onunload() {
    this.shown.clear();
  }

  // ── Data ───────────────────────────────────────────────────────────────

  async loadSettings() {
    const stored = ((await this.loadData()) ?? {}) as StoredData;
    const { history, ...rest } = stored;
    this.settings = { ...DEFAULT_SETTINGS, ...rest, formulas: { ...(rest.formulas ?? {}) } };
    if (!Number.isInteger(this.settings.defaultFaces) || this.settings.defaultFaces < 1) this.settings.defaultFaces = 100;
    if (!Number.isInteger(this.settings.historySize) || this.settings.historySize < 0) this.settings.historySize = 100;
    this.history = readHistory(history, this.settings.historySize);
  }

  async saveSettings() {
    await this.saveData({ ...this.settings, history: this.history });
    this.refreshSoon();
  }

  /** Settings change on every keystroke; redraw notes once typing stops. */
  private refreshSoon = debounce(() => this.refreshNotes(), 400, true);

  private async saveHistory() {
    await this.saveData({ ...this.settings, history: this.history });
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof HistoryView) leaf.view.render();
    }
  }

  log(formula: string, outcome: Outcome, source?: string) {
    const entry: HistoryEntry = {
      formula,
      total: totalText(NO_FLAGS, outcome, this.display()),
      breakdown: `${outcome.average ? 'average: ' : ''}${outcome.breakdown}${outcome.notes.length ? ` (${outcome.notes.join(', ')})` : ''}`,
      at: Date.now(),
      ...(source ? { source } : {}),
    };
    this.history = addEntry(this.history, entry, this.settings.historySize);
    void this.saveHistory();
  }

  async clearHistory() {
    this.history = [];
    await this.saveHistory();
  }

  display(): DisplayOptions {
    return { rounding: this.settings.rounding, signed: this.settings.signed, showFormula: this.settings.showFormula };
  }

  /** Roll options for a formula in `text` (a note, or empty outside notes). */
  rollOptions(text: () => string, average = false): RollOptions {
    let fields: Map<string, number> | null = null;
    return {
      defaultFaces: this.settings.defaultFaces,
      average,
      resolve: (name) => {
        const saved = this.settings.formulas[name];
        if (saved !== undefined) return saved;
        fields ??= noteFields(text());
        return fields.get(name);
      },
    };
  }

  /** A formula typed in the dialog or the history: a saved formula's name rolls that formula. */
  rollTyped(formula: string): { outcome: Outcome } | { error: string } {
    const file = this.app.workspace.getActiveFile();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const text = () => (view && view.file === file ? view.editor.getValue() : '');
    return tryRoll(formula, this.rollOptions(text));
  }

  async openHistory(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    // revealLeaf picks the history's tab: on a phone the sidebar is a drawer
    // that otherwise opens on whatever tab it showed last.
    if (requireApiVersion('1.7.2')) await workspace.revealLeaf(leaf);
    else workspace.rightSplit.expand();
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** Redraws rolls in open notes, keeping the results already shown. */
  refreshNotes(): void {
    this.epoch++;
    this.editorExtensions.length = 0;
    this.editorExtensions.push(this.buildExtension());
    this.app.workspace.updateOptions();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView) leaf.view.previewMode.rerender(true);
    }
  }

  private forget(path: string) {
    const prefix = rollKey(path, '', 0).split('\u0000')[0] + '\u0000';
    for (const key of [...this.shown.keys()]) if (key.startsWith(prefix)) this.shown.delete(key);
  }

  rerollNote(path: string) {
    this.forget(path);
    this.refreshNotes();
  }

  // ── Commands ───────────────────────────────────────────────────────────

  /** Wraps the selection as `dice: …`, or inserts `dice: 1d20` with the formula selected. */
  private insertRoll(editor: Editor) {
    const sel = editor.listSelections()[0];
    const from = editor.posToOffset(sel.anchor) < editor.posToOffset(sel.head) ? sel.anchor : sel.head;
    const to = from === sel.anchor ? sel.head : sel.anchor;
    const selected = editor.getRange(from, to).trim();
    const formula = selected && !selected.includes('\n') ? selected : '1d20';
    const text = `\`dice: ${formula}\``;
    const start = editor.posToOffset(from);
    editor.transaction({
      changes: [{ from, to, text }],
      selection: selected
        ? { from: editor.offsetToPos(start + text.length) }
        : { from: editor.offsetToPos(start + 7), to: editor.offsetToPos(start + 7 + formula.length) },
    });
  }

  /** Rolls every `dice-mod:` code of the note and writes the results, in one undoable change. */
  private writeAllMods(editor: Editor, source: string) {
    const text = editor.getValue();
    const changes: { from: ReturnType<Editor['offsetToPos']>; to: ReturnType<Editor['offsetToPos']>; text: string }[] = [];
    let failed = 0;
    for (const span of findInlineCode(text)) {
      const roll = parseInline(span.content);
      if (!roll?.mod) continue;
      const result = tryRoll(roll.formula, this.rollOptions(() => text, roll.average));
      if ('error' in result) {
        failed++;
        continue;
      }
      changes.push({
        from: editor.offsetToPos(span.from),
        to: editor.offsetToPos(span.to),
        text: modReplacement(roll, result.outcome, { ...this.modOptions() }),
      });
      if (this.settings.logNoteRolls) this.log(roll.formula, result.outcome, source || undefined);
    }
    if (changes.length > 0) editor.transaction({ changes });
    if (changes.length === 0 && failed === 0) new Notice('This note has no dice-mod rolls.');
    else if (failed > 0) new Notice(`${failed} dice-mod roll${failed === 1 ? '' : 's'} could not be rolled and stayed as they were.`);
  }

  modOptions() {
    return { ...this.display(), showFormula: this.settings.modFormula, escape: this.settings.escapeMod };
  }

  // ── Rolls in notes ─────────────────────────────────────────────────────

  /**
   * Draws a roll into `el`: its result (rolled now unless remembered), a dice
   * button, a tooltip with the breakdown; a click rerolls. A `dice-mod:`
   * roll shows its formula and writes the result into the note on click.
   */
  renderRoll(el: HTMLElement, content: string, roll: InlineRoll, place: RollPlace): void {
    el.empty();
    el.addClass('dice-rolls-roll');
    const result = el.createSpan({ cls: 'dice-rolls-result' });
    const showButton = roll.showButton ?? this.settings.showButton;
    if (showButton) setIcon(el.createSpan({ cls: 'dice-rolls-button' }), roll.mod ? penIcon() : 'dices');
    if (roll.paren) el.createSpan({ cls: 'dice-rolls-formula', text: ` (${roll.formula})` });
    el.setAttr('role', 'button');
    el.setAttr('tabindex', '0');

    if (roll.mod) {
      el.addClass('is-mod');
      result.setText(roll.formula);
      setTooltip(el, `${roll.formula}\nClick to roll and write the result into the note`);
      const check = tryParse(roll.formula, { defaultFaces: this.settings.defaultFaces });
      if ('error' in check) this.markError(el, result, content, check.error);
      this.onActivate(el, () => {
        const rolled = tryRoll(roll.formula, this.rollOptions(place.text, roll.average));
        if ('error' in rolled) {
          new Notice(`Can't roll ${roll.formula}: ${rolled.error}`);
          return;
        }
        if (!place.write) return;
        const replacement = modReplacement(roll, rolled.outcome, this.modOptions());
        void place.write(replacement).then((ok) => {
          if (!ok) new Notice('The note changed; the dice-mod roll was not written.');
          else if (this.settings.logNoteRolls) this.log(roll.formula, rolled.outcome, place.source || undefined);
        });
      });
      return;
    }

    const show = (state: Shown) => {
      el.removeClass('is-max', 'is-min', 'is-error', 'is-empty');
      if (!state.outcome) {
        result.setText(roll.text ?? '');
        el.addClass('is-empty');
      } else {
        result.setText(roll.text ?? resultText(roll, state.outcome, this.display()));
        if (state.outcome.allMax) el.addClass('is-max');
        if (state.outcome.allMin) el.addClass('is-min');
      }
      setTooltip(el, tooltipText(roll, state.outcome, this.display()));
    };
    const rollNow = (average: boolean): Shown | string => {
      const rolled = tryRoll(roll.formula, this.rollOptions(place.text, average));
      return 'error' in rolled ? rolled.error : { outcome: rolled.outcome };
    };

    let state = this.shown.get(place.key);
    if (!state) {
      const first = roll.none ? { outcome: null } : rollNow(roll.average);
      if (typeof first === 'string') {
        this.markError(el, result, content, first);
        return;
      }
      state = first;
      this.shown.set(place.key, state);
    }
    show(state);
    this.onActivate(el, () => {
      const next = rollNow(false);
      if (typeof next === 'string') {
        new Notice(`Can't roll ${roll.formula}: ${next}`);
        return;
      }
      this.shown.set(place.key, next);
      show(next);
      el.removeClass('is-rolled');
      // Restart the animation.
      void el.offsetWidth;
      el.addClass('is-rolled');
      if (this.settings.logNoteRolls && next.outcome) this.log(roll.formula, next.outcome, place.source || undefined);
    });
  }

  private markError(el: HTMLElement, result: HTMLElement, content: string, error: string) {
    el.addClass('is-error');
    el.find('.dice-rolls-button')?.remove();
    result.setText(content);
    setTooltip(el, `Can't roll: ${error}`);
  }

  /** Click or Enter/Space; the editor must not move the cursor into the code on mousedown. */
  private onActivate(el: HTMLElement, action: () => void) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      action();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        action();
      }
    });
  }

  private processReading(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const codes = Array.from(el.querySelectorAll('code')).filter((c) => !c.closest('pre'));
    if (codes.length === 0) return;
    const info = ctx.getSectionInfo(el);
    const text = info?.text ?? '';
    const spans = info ? findInlineCode(text) : [];
    let sectionStart = 0;
    if (info) {
      const lines = text.split('\n');
      for (let i = 0; i < info.lineStart; i++) sectionStart += lines[i].length + 1;
    }
    const seen = new Map<string, number>();
    for (const code of codes) {
      const content = code.textContent ?? '';
      const roll = parseInline(content);
      if (!roll) continue;
      const before = spans.filter((s) => s.from < sectionStart && s.content === content).length;
      const k = seen.get(content) ?? 0;
      seen.set(content, k + 1);
      const nth = before + k;
      const key = info ? rollKey(ctx.sourcePath, content, nth) : rollKey(ctx.sourcePath, content, -1 - k);
      const chip = createSpan();
      code.replaceWith(chip);
      const path = ctx.sourcePath;
      this.renderRoll(chip, content, roll, {
        key,
        source: path,
        text: () => text,
        write: info ? (replacement) => this.writeInFile(path, content, nth, replacement) : undefined,
      });
    }
  }

  /** Replaces the `nth` code with this content in the note, refusing if it is no longer there. */
  private async writeInFile(path: string, content: string, nth: number, replacement: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    let ok = false;
    await this.app.vault.process(file, (data) => {
      const twins = findInlineCode(data).filter((s) => s.content === content);
      const span = twins[nth];
      if (!span) return data;
      ok = true;
      return data.slice(0, span.from) + replacement + data.slice(span.to);
    });
    return ok;
  }

  /**
   * Live Preview: every `dice:` code outside the selection becomes a roll.
   * Codes are found in the text, then checked against the syntax tree so
   * code blocks, comments and math stay as they are.
   */
  private buildExtension(): Extension {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the ViewPlugin class below needs the plugin.
    const plugin = this;
    const epoch = this.epoch;
    const build = (view: EditorView): DecorationSet => {
      const builder = new RangeSetBuilder<Decoration>();
      const state = view.state;
      if (state.field(editorLivePreviewField, false) !== true) return builder.finish();
      const path = state.field(editorInfoField, false)?.file?.path ?? '';
      const text = state.doc.toString();
      const tree = syntaxTree(state);
      const spans = findInlineCode(text);
      const visible = view.visibleRanges;
      for (let i = 0; i < spans.length; i++) {
        const span = spans[i];
        if (!visible.some((r) => span.to >= r.from && span.from <= r.to)) continue;
        const roll = parseInline(span.content);
        if (!roll) continue;
        if (state.selection.ranges.some((r) => r.from <= span.to && r.to >= span.from)) continue;
        const node = tree.resolveInner(span.from + 1, 1).type.name;
        if (!/inline-code/.test(node) || /comment|math/.test(node)) continue;
        const nth = occurrence(spans, i);
        const key = rollKey(path, span.content, nth);
        builder.add(
          span.from,
          span.to,
          Decoration.replace({ widget: new RollWidget(plugin, key, nth, span.content, text.slice(span.from, span.to), roll, path, epoch) }),
        );
      }
      return builder.finish();
    };

    // Highest precedence, so Obsidian's own decorations hiding the backticks
    // never win over the roll, whatever order the extensions were added in.
    return Prec.highest(
      ViewPlugin.fromClass(
        class {
          decorations: DecorationSet;
          constructor(view: EditorView) {
            this.decorations = build(view);
          }
          update(update: ViewUpdate) {
            const modeChanged =
              update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false);
            if (
              update.docChanged ||
              update.viewportChanged ||
              update.selectionSet ||
              modeChanged ||
              syntaxTree(update.startState) !== syntaxTree(update.state)
            ) {
              this.decorations = build(update.view);
            }
          }
        },
        { decorations: (v) => v.decorations },
      ),
    );
  }
}

class RollWidget extends WidgetType {
  private plugin: DiceRollsPlugin;
  readonly key: string;
  /** Which of the codes with this content it is, counting from the top of the note. */
  private nth: number;
  readonly content: string;
  /** The code as written, backticks included, to check before a `dice-mod:` writes. */
  private raw: string;
  private roll: InlineRoll;
  private path: string;
  readonly epoch: number;

  constructor(plugin: DiceRollsPlugin, key: string, nth: number, content: string, raw: string, roll: InlineRoll, path: string, epoch: number) {
    super();
    this.plugin = plugin;
    this.key = key;
    this.nth = nth;
    this.content = content;
    this.raw = raw;
    this.roll = roll;
    this.path = path;
    this.epoch = epoch;
  }

  eq(other: RollWidget): boolean {
    return other.key === this.key && other.epoch === this.epoch;
  }

  toDOM(view: EditorView): HTMLElement {
    const el = createSpan();
    this.plugin.renderRoll(el, this.content, this.roll, {
      key: this.key,
      source: this.path,
      text: () => view.state.doc.toString(),
      write: (replacement) => {
        // Found again in the text as it is now, so a change made since the
        // roll was drawn cannot send the result to the wrong place.
        const doc = view.state.doc.toString();
        const span = findInlineCode(doc).filter((s) => s.content === this.content)[this.nth];
        if (!span || doc.slice(span.from, span.to) !== this.raw) return Promise.resolve(false);
        view.dispatch({ changes: { from: span.from, to: span.to, insert: replacement }, userEvent: 'input' });
        return Promise.resolve(true);
      },
    });
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ── Roll dialog ──────────────────────────────────────────────────────────

class RollModal extends Modal {
  private plugin: DiceRollsPlugin;
  private editor: Editor | null;
  private formula = '';
  private last: Outcome | null = null;
  private lastFormula = '';

  constructor(app: App, plugin: DiceRollsPlugin, editor: Editor | null) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.formula = plugin.history[0]?.formula ?? '1d20';
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText('Roll dice');
    contentEl.addClass('dice-rolls-modal');

    const input = contentEl.createEl('input', { type: 'text', cls: 'dice-rolls-input', attr: { placeholder: '2d6+3', 'aria-label': 'Formula', spellcheck: 'false' } });
    input.value = this.formula;
    const status = contentEl.createDiv({ cls: 'dice-rolls-status' });
    const quick = contentEl.createDiv({ cls: 'dice-rolls-quick' });
    for (const faces of QUICK_DICE) {
      const b = quick.createEl('button', { text: `d${faces}` });
      b.addEventListener('click', () => {
        input.value = addDie(input.value, faces);
        validate();
        input.focus();
      });
    }
    const clear = quick.createEl('button', { cls: 'dice-rolls-clear', attr: { 'aria-label': 'Clear the formula' } });
    setIcon(clear, 'x');
    clear.addEventListener('click', () => {
      input.value = '';
      validate();
      input.focus();
    });

    const recent = recentFormulas(this.plugin.history, 8);
    if (recent.length > 0) {
      const row = contentEl.createDiv({ cls: 'dice-rolls-recent' });
      row.createSpan({ text: 'Recent:', cls: 'dice-rolls-label' });
      for (const f of recent) {
        const b = row.createEl('button', { text: f });
        b.addEventListener('click', () => {
          input.value = f;
          doRoll();
        });
      }
    }

    const resultEl = contentEl.createDiv({ cls: 'dice-rolls-modal-result' });
    const buttons = new Setting(contentEl);
    buttons.addButton((b) =>
      b
        .setButtonText('Roll')
        .setCta()
        .onClick(() => doRoll()),
    );
    if (this.editor) {
      buttons.addButton((b) =>
        b.setButtonText('Insert roll').onClick(() => {
          const f = input.value.trim();
          if (f === '' || 'error' in tryParse(f, { defaultFaces: this.plugin.settings.defaultFaces })) {
            validate();
            return;
          }
          this.insert(`\`dice: ${f}\``);
        }),
      );
      buttons.addButton((b) =>
        b.setButtonText('Insert result').onClick(() => {
          if (!this.last) doRoll();
          if (this.last) this.insert(totalText(NO_FLAGS, this.last, this.plugin.display()));
        }),
      );
    }

    const validate = () => {
      const f = input.value.trim();
      status.removeClass('is-error');
      if (f === '') {
        status.setText('Type a formula such as 2d6+3, 4d6dl1 or 1d20kh1+5.');
        return;
      }
      const parsed = tryParse(f, { defaultFaces: this.plugin.settings.defaultFaces });
      if ('error' in parsed) {
        status.setText(parsed.error);
        status.addClass('is-error');
      } else {
        status.setText('Enter to roll.');
      }
    };

    const doRoll = () => {
      const f = input.value.trim();
      if (f === '') return validate();
      const rolled = this.plugin.rollTyped(f);
      resultEl.empty();
      if ('error' in rolled) {
        status.setText(rolled.error);
        status.addClass('is-error');
        this.last = null;
        return;
      }
      this.last = rolled.outcome;
      this.lastFormula = f;
      const total = resultEl.createDiv({
        cls: 'dice-rolls-total',
        text: totalText(NO_FLAGS, rolled.outcome, this.plugin.display()),
      });
      if (rolled.outcome.allMax) total.addClass('is-max');
      if (rolled.outcome.allMin) total.addClass('is-min');
      resultEl.createDiv({ cls: 'dice-rolls-breakdown', text: `${f} → ${rolled.outcome.breakdown}` });
      if (rolled.outcome.notes.length) resultEl.createDiv({ cls: 'dice-rolls-breakdown', text: rolled.outcome.notes.join(', ') });
      this.plugin.log(f, rolled.outcome, this.app.workspace.getActiveFile()?.path);
      validate();
    };

    input.addEventListener('input', () => {
      this.last = null;
      validate();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doRoll();
      }
    });
    validate();
    window.setTimeout(() => input.select(), 0);
  }

  private insert(text: string) {
    const editor = this.editor;
    if (!editor) return;
    const sel = editor.listSelections()[0];
    const a = editor.posToOffset(sel.anchor);
    const h = editor.posToOffset(sel.head);
    const from = editor.offsetToPos(Math.min(a, h));
    const to = editor.offsetToPos(Math.max(a, h));
    editor.transaction({ changes: [{ from, to, text }], selection: { from: editor.offsetToPos(Math.min(a, h) + text.length) } });
    this.close();
    editor.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── History view ─────────────────────────────────────────────────────────

class HistoryView extends ItemView {
  private plugin: DiceRollsPlugin;
  private listEl: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: DiceRollsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Roll history';
  }

  getIcon(): string {
    return 'dices';
  }

  onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('dice-rolls-history');

    const form = contentEl.createDiv({ cls: 'dice-rolls-history-form' });
    const input = form.createEl('input', { type: 'text', cls: 'dice-rolls-input', attr: { placeholder: '2d6+3', 'aria-label': 'Formula', spellcheck: 'false' } });
    this.input = input;
    const go = form.createEl('button', { cls: 'mod-cta', text: 'Roll' });
    const roll = () => {
      const f = input.value.trim();
      if (f === '') return;
      const rolled = this.plugin.rollTyped(f);
      if ('error' in rolled) {
        new Notice(`Can't roll ${f}: ${rolled.error}`);
        return;
      }
      this.plugin.log(f, rolled.outcome);
    };
    go.addEventListener('click', roll);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        roll();
      }
    });

    const quick = contentEl.createDiv({ cls: 'dice-rolls-quick' });
    for (const faces of QUICK_DICE) {
      const b = quick.createEl('button', { text: `d${faces}`, attr: { 'aria-label': `Roll 1d${faces}` } });
      b.addEventListener('click', () => {
        const rolled = this.plugin.rollTyped(`1d${faces}`);
        if ('outcome' in rolled) this.plugin.log(`1d${faces}`, rolled.outcome);
      });
    }
    const clear = quick.createEl('button', { cls: 'dice-rolls-clear', attr: { 'aria-label': 'Clear the history' } });
    setIcon(clear, 'trash-2');
    clear.addEventListener('click', () => void this.plugin.clearHistory());

    this.listEl = contentEl.createDiv({ cls: 'dice-rolls-list' });
    this.render();
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.contentEl.empty();
    this.listEl = null;
    return Promise.resolve();
  }

  render(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    if (this.plugin.history.length === 0) {
      list.createDiv({ cls: 'dice-rolls-empty', text: 'No rolls yet. Click a dice roll in a note, or roll one above.' });
      return;
    }
    const now = Date.now();
    for (const entry of this.plugin.history) {
      const row = list.createDiv({ cls: 'dice-rolls-entry' });
      row.createDiv({ cls: 'dice-rolls-total', text: entry.total });
      const body = row.createDiv({ cls: 'dice-rolls-entry-body' });
      body.createDiv({ cls: 'dice-rolls-entry-formula', text: entry.formula });
      if (entry.breakdown && entry.breakdown !== entry.total) body.createDiv({ cls: 'dice-rolls-breakdown', text: entry.breakdown });
      const meta = body.createDiv({ cls: 'dice-rolls-meta' });
      meta.createSpan({ text: when(entry.at, now) });
      const source = entry.source;
      if (source) {
        meta.createSpan({ text: ' · ' });
        const link = meta.createEl('a', { text: source.replace(/\.md$/, '').split('/').pop() ?? source, cls: 'dice-rolls-source' });
        link.addEventListener('click', (e) => {
          e.preventDefault();
          void this.app.workspace.openLinkText(source, '', false);
        });
      }
      const actions = row.createDiv({ cls: 'dice-rolls-actions' });
      const again = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Roll again' } });
      setIcon(again, 'rotate-ccw');
      again.addEventListener('click', () => {
        const rolled = this.plugin.rollTyped(entry.formula);
        if ('error' in rolled) new Notice(`Can't roll ${entry.formula}: ${rolled.error}`);
        else this.plugin.log(entry.formula, rolled.outcome, entry.source);
      });
      const edit = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Edit the formula' } });
      setIcon(edit, 'pencil');
      edit.addEventListener('click', () => {
        if (!this.input) return;
        this.input.value = entry.formula;
        this.input.focus();
      });
      const copy = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Copy the result' } });
      setIcon(copy, 'copy');
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(`${entry.formula} → ${entry.breakdown} → ${entry.total}`).then(() => new Notice('Copied.'));
      });
    }
  }
}

// ── Settings ─────────────────────────────────────────────────────────────

/** Names and descriptions shared by the declarative tab (1.13+) and the older one. */
const TEXT = {
  notes: 'Rolls in notes',
  showButton: { name: 'Show a dice button', desc: 'Next to each result. Override one roll with |dice or |nodice.' },
  showFormula: { name: 'Show the formula with the result', desc: 'Such as 2d6+3 → [3, 4]+3 → 10. Override one roll with |form or |noform.' },
  rounding: { name: 'Rounding', desc: 'For results with decimals, such as 1d6/4. Override one roll with |round, |ceil, |floor or |noround.' },
  signed: { name: 'Plus sign on positive results', desc: 'Shows +3 instead of 3. Override one roll with |signed.' },
  defaultFaces: { name: 'Faces of a die written without them', desc: 'What 3d rolls. The default, 100, matches Dice Roller.' },
  mod: 'Rolls that write into the note',
  modFormula: { name: 'Write the formula and the dice', desc: 'A dice-mod roll writes 2d6+3 -> [3, 4]+3 -> 10 instead of 10. Override one roll with |form or |noform.' },
  escapeMod: { name: 'Escape Markdown', desc: 'Writes \\[3, 4\\] so the dice do not read as a link.' },
  history: 'History',
  logNoteRolls: { name: 'Add rolls from notes', desc: 'Clicking a roll in a note adds it to the history. Rolls from the dialog and the history view are always added.' },
  historySize: { name: 'Rolls to keep', desc: 'Older rolls are dropped.' },
  formulas: 'Saved formulas',
  formulasDesc: 'Use a name in place of a formula, alone (dice: attack) or inside one (dice: attack + 2).',
  addFormula: 'Add formula',
  legacy: { name: 'Import from Dice Roller', desc: 'Copies the saved formulas of Dice Roller in this vault. Formulas with the same name are replaced.' },
};

const ROUNDING_OPTIONS: Record<Rounding, string> = { none: 'Two decimals', round: 'Round', up: 'Round up', down: 'Round down' };

type ControlKey = 'showButton' | 'showFormula' | 'rounding' | 'signed' | 'defaultFaces' | 'modFormula' | 'escapeMod' | 'logNoteRolls' | 'historySize';

class DiceRollsSettingTab extends PluginSettingTab {
  private plugin: DiceRollsPlugin;
  /** Set once Obsidian has drawn the tab through `display()`, which it does only before 1.13. */
  private legacy = false;

  constructor(app: App, plugin: DiceRollsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * The settings, described rather than drawn. Obsidian 1.13 and later
   * renders this itself and indexes it for the settings search. Older
   * versions ignore it and call `display()`.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    return [
      {
        type: 'group',
        heading: TEXT.notes,
        items: [
          { ...TEXT.showButton, control: { type: 'toggle', key: 'showButton', defaultValue: DEFAULT_SETTINGS.showButton } },
          { ...TEXT.showFormula, control: { type: 'toggle', key: 'showFormula', defaultValue: DEFAULT_SETTINGS.showFormula } },
          { ...TEXT.rounding, control: { type: 'dropdown', key: 'rounding', options: ROUNDING_OPTIONS, defaultValue: DEFAULT_SETTINGS.rounding } },
          { ...TEXT.signed, control: { type: 'toggle', key: 'signed', defaultValue: DEFAULT_SETTINGS.signed } },
          {
            ...TEXT.defaultFaces,
            control: {
              type: 'number',
              key: 'defaultFaces',
              min: 1,
              defaultValue: DEFAULT_SETTINGS.defaultFaces,
              validate: (v: number) => (Number.isInteger(v) && v >= 1 ? undefined : 'A whole number of 1 or more.'),
            },
          },
        ],
      },
      {
        type: 'group',
        heading: TEXT.mod,
        items: [
          { ...TEXT.modFormula, control: { type: 'toggle', key: 'modFormula', defaultValue: DEFAULT_SETTINGS.modFormula } },
          { ...TEXT.escapeMod, control: { type: 'toggle', key: 'escapeMod', defaultValue: DEFAULT_SETTINGS.escapeMod } },
        ],
      },
      {
        type: 'group',
        heading: TEXT.history,
        items: [
          { ...TEXT.logNoteRolls, control: { type: 'toggle', key: 'logNoteRolls', defaultValue: DEFAULT_SETTINGS.logNoteRolls } },
          {
            ...TEXT.historySize,
            control: {
              type: 'number',
              key: 'historySize',
              min: 0,
              defaultValue: DEFAULT_SETTINGS.historySize,
              validate: (v: number) => (Number.isInteger(v) && v >= 0 ? undefined : 'A whole number of 0 or more.'),
            },
          },
        ],
      },
      {
        type: 'list',
        heading: TEXT.formulas,
        emptyState: TEXT.formulasDesc,
        items: Object.entries(s.formulas).map(([name, formula]) => ({
          name,
          aliases: [formula],
          render: (setting: Setting) => this.formulaRow(setting, name),
        })),
        onDelete: (index: number) => {
          const name = Object.keys(s.formulas)[index];
          if (name !== undefined) delete s.formulas[name];
          this.saveAndRedraw();
        },
        addItem: { name: TEXT.addFormula, action: () => this.addFormula() },
      },
      { ...TEXT.legacy, action: () => void this.importLegacy() },
    ];
  }

  getControlValue(key: string): unknown {
    return this.plugin.settings[key as ControlKey];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    Object.assign(this.plugin.settings, { [key]: value });
    if (key === 'historySize') this.plugin.history = this.plugin.history.slice(0, this.plugin.settings.historySize);
    await this.plugin.saveSettings();
  }

  /** The pre-1.13 rendering. Obsidian skips it once `getSettingDefinitions()` returns anything. */
  display(): void {
    this.legacy = true;
    this.draw();
  }

  private draw(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    const toggle = (key: 'showButton' | 'showFormula' | 'signed' | 'modFormula' | 'escapeMod' | 'logNoteRolls', text: { name: string; desc: string }) =>
      new Setting(containerEl)
        .setName(text.name)
        .setDesc(text.desc)
        .addToggle((t) => t.setValue(s[key]).onChange((v) => void this.setControlValue(key, v)));
    const number = (key: 'defaultFaces' | 'historySize', text: { name: string; desc: string }, min: number) =>
      new Setting(containerEl)
        .setName(text.name)
        .setDesc(text.desc)
        .addText((t) =>
          t.setValue(String(s[key])).onChange((v) => {
            const n = Number(v);
            if (v.trim() !== '' && Number.isInteger(n) && n >= min) void this.setControlValue(key, n);
          }),
        );

    new Setting(containerEl).setName(TEXT.notes).setHeading();
    toggle('showButton', TEXT.showButton);
    toggle('showFormula', TEXT.showFormula);
    new Setting(containerEl)
      .setName(TEXT.rounding.name)
      .setDesc(TEXT.rounding.desc)
      .addDropdown((d) => d.addOptions(ROUNDING_OPTIONS).setValue(s.rounding).onChange((v) => void this.setControlValue('rounding', v)));
    toggle('signed', TEXT.signed);
    number('defaultFaces', TEXT.defaultFaces, 1);

    new Setting(containerEl).setName(TEXT.mod).setHeading();
    toggle('modFormula', TEXT.modFormula);
    toggle('escapeMod', TEXT.escapeMod);

    new Setting(containerEl).setName(TEXT.history).setHeading();
    toggle('logNoteRolls', TEXT.logNoteRolls);
    number('historySize', TEXT.historySize, 0);

    new Setting(containerEl).setName(TEXT.formulas).setHeading();
    containerEl.createEl('p', { cls: 'setting-item-description', text: TEXT.formulasDesc });
    for (const name of Object.keys(s.formulas)) {
      const row = new Setting(containerEl);
      this.formulaRow(row, name);
      row.addExtraButton((b) =>
        b.setIcon('trash-2').onClick(() => {
          delete s.formulas[name];
          this.saveAndRedraw();
        }),
      );
    }
    new Setting(containerEl).addButton((b) => b.setButtonText(TEXT.addFormula).setCta().onClick(() => this.addFormula()));
    new Setting(containerEl)
      .setName(TEXT.legacy.name)
      .setDesc(TEXT.legacy.desc)
      .addButton((b) => b.setButtonText('Import').onClick(() => void this.importLegacy()));
  }

  /** One saved formula: its name, and its formula to edit in place. */
  private formulaRow(row: Setting, name: string): void {
    const s = this.plugin.settings;
    row.setName(name);
    row.addText((t) =>
      t.setValue(s.formulas[name] ?? '').onChange((v) => {
        const ok = v.trim() !== '' && 'node' in tryParse(v, { defaultFaces: s.defaultFaces });
        t.inputEl.toggleClass('dice-rolls-invalid', !ok);
        if (!ok) return;
        s.formulas[name] = v.trim();
        void this.plugin.saveSettings();
      }),
    );
  }

  private addFormula(): void {
    new FormulaModal(this.app, this.plugin.settings, (name, formula) => {
      this.plugin.settings.formulas[name] = formula;
      this.saveAndRedraw();
    }).open();
  }

  private async importLegacy(): Promise<void> {
    const path = `${this.app.vault.configDir}/${LEGACY_DATA}`;
    let raw: unknown = null;
    try {
      if (await this.app.vault.adapter.exists(path)) raw = JSON.parse(await this.app.vault.adapter.read(path));
    } catch {
      raw = null;
    }
    const found = Object.entries(readLegacyFormulas(raw)).filter(([name]) => validAlias(name));
    if (found.length === 0) {
      new Notice('No saved formulas from Dice Roller were found in this vault.');
      return;
    }
    for (const [name, formula] of found) this.plugin.settings.formulas[name] = formula;
    this.saveAndRedraw();
    new Notice(`Imported ${found.length} formula${found.length === 1 ? '' : 's'}.`);
  }

  private saveAndRedraw(): void {
    void this.plugin.saveSettings();
    if (this.legacy) {
      this.draw();
      return;
    }
    // Obsidian 1.13's re-render of the declarative definitions. Looked up
    // rather than called directly, because older versions do not have it.
    const tab = this as unknown as { update?: () => void };
    tab.update?.();
  }
}

/** Asks for a new saved formula's name and formula. */
class FormulaModal extends Modal {
  private settings: DiceRollsSettings;
  private done: (name: string, formula: string) => void;

  constructor(app: App, settings: DiceRollsSettings, done: (name: string, formula: string) => void) {
    super(app);
    this.settings = settings;
    this.done = done;
  }

  onOpen() {
    this.titleEl.setText(TEXT.addFormula);
    let name = '';
    let formula = '';
    const error = this.contentEl.createDiv({ cls: 'dice-rolls-status' });
    new Setting(this.contentEl)
      .setName('Name')
      .setDesc('One word, such as attack or fireball.')
      .addText((t) => t.onChange((v) => (name = v.trim())));
    new Setting(this.contentEl)
      .setName('Formula')
      .setDesc('Such as 1d20+5.')
      .addText((t) => t.onChange((v) => (formula = v.trim())));
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText('Add')
        .setCta()
        .onClick(() => {
          error.addClass('is-error');
          if (!validAlias(name)) {
            error.setText('The name must be one word that does not read as dice.');
            return;
          }
          const parsed = tryParse(formula, { defaultFaces: this.settings.defaultFaces });
          if ('error' in parsed) {
            error.setText(parsed.error);
            return;
          }
          this.done(name, formula);
          this.close();
        }),
    );
    this.contentEl.prepend(error);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** `pen-line`, or `edit-3`, its name in the icon set of Obsidian before 1.7. */
function penIcon(): string {
  return getIcon('pen-line') ? 'pen-line' : 'edit-3';
}
