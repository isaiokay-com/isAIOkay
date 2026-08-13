import { emitKeypressEvents, type Key } from "node:readline";

export interface TerminalChoice {
  value: string;
  label: string;
  hint?: string;
}

export interface TerminalFormField {
  name: string;
  label: string;
  choices: readonly TerminalChoice[];
  initialValue?: string;
}

interface MenuOptions {
  initialValue?: string;
  color?: boolean;
}

interface MultiMenuOptions {
  initialValues?: string[];
  color?: boolean;
  maxSelections?: number;
}

type TtyInput = NodeJS.ReadStream & { isRaw?: boolean };
type TtyOutput = NodeJS.WriteStream & { columns?: number; rows?: number };

const ansi = (enabled: boolean, open: string, close: string, text: string): string =>
  enabled ? `${open}${text}${close}` : text;

const truncate = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;

const createMenu = (
  input: TtyInput,
  output: TtyOutput,
  question: string,
  choices: readonly TerminalChoice[],
  options: MenuOptions | MultiMenuOptions,
  multiple: boolean
): Promise<string | string[] | undefined> => {
  if (choices.length === 0) return Promise.resolve(multiple ? [] : undefined);
  const color = options.color === true;
  const selected = new Set(multiple && "initialValues" in options ? options.initialValues ?? [] : []);
  const initialValue = !multiple && "initialValue" in options ? options.initialValue : undefined;
  let active = Math.max(0, choices.findIndex((choice) => choice.value === initialValue));
  const visibleCount = Math.min(8, choices.length);
  const renderedRows = visibleCount + 2;
  let rendered = false;
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing;

  return new Promise((resolve) => {
    const clear = (): void => {
      if (rendered) output.write(`\u001b[${renderedRows}A\r\u001b[0J`);
    };
    const render = (): void => {
      clear();
      const maxWidth = Math.max(24, (output.columns ?? 80) - 7);
      const start = Math.min(Math.max(0, active - Math.floor(visibleCount / 2)), choices.length - visibleCount);
      const visible = choices.slice(start, start + visibleCount);
      output.write(`${ansi(color, "\u001b[36m", "\u001b[39m", "?")} ${ansi(color, "\u001b[1m", "\u001b[22m", question)}\n`);
      for (let offset = 0; offset < visible.length; offset += 1) {
        const index = start + offset;
        const choice = visible[offset];
        if (!choice) continue;
        const pointer = index === active ? ansi(color, "\u001b[36m", "\u001b[39m", "❯") : " ";
        const marker = multiple ? (selected.has(choice.value) ? ansi(color, "\u001b[32m", "\u001b[39m", "◉") : "○") : "";
        const detail = choice.hint ? `${choice.label} — ${choice.hint}` : choice.label;
        const label = index === active ? ansi(color, "\u001b[1m", "\u001b[22m", truncate(detail, maxWidth)) : truncate(detail, maxWidth);
        output.write(`  ${pointer} ${marker}${marker ? " " : ""}${label}\n`);
      }
      const position = choices.length > visibleCount ? ` · ${active + 1}/${choices.length}` : "";
      const help = multiple ? `↑/↓ move · Space toggle · Enter continue${position}` : `↑/↓ move · Enter select${position}`;
      output.write(`  ${ansi(color, "\u001b[2m", "\u001b[22m", help)}\n`);
      rendered = true;
    };
    const finish = (value: string | string[] | undefined): void => {
      clear();
      input.removeListener("keypress", onKeypress);
      input.setRawMode(wasRaw);
      if (wasFlowing !== true) input.pause();
      output.write("\u001b[?25h");
      if (value === undefined) {
        output.write(`${ansi(color, "\u001b[33m", "\u001b[39m", "!")} ${question} ${ansi(color, "\u001b[2m", "\u001b[22m", "Cancelled")}\n`);
      } else {
        const values = Array.isArray(value) ? value : [value];
        const labels = choices.filter((choice) => values.includes(choice.value)).map((choice) => choice.label);
        output.write(`${ansi(color, "\u001b[32m", "\u001b[39m", "✓")} ${question} ${ansi(color, "\u001b[2m", "\u001b[22m", labels.length > 0 ? labels.join(", ") : "None")}\n`);
      }
      resolve(value);
    };
    const onKeypress = (_text: string, key: Key): void => {
      if (key.ctrl && key.name === "c" || key.name === "escape") {
        finish(undefined);
        return;
      }
      if (key.name === "up" || key.name === "k") active = (active - 1 + choices.length) % choices.length;
      else if (key.name === "down" || key.name === "j") active = (active + 1) % choices.length;
      else if (key.name === "home") active = 0;
      else if (key.name === "end") active = choices.length - 1;
      else if (multiple && key.name === "space") {
        const value = choices[active]?.value;
        if (value) {
          if (selected.has(value)) selected.delete(value);
          else if (selected.size < (("maxSelections" in options ? options.maxSelections : undefined) ?? Number.POSITIVE_INFINITY)) selected.add(value);
        }
      } else if (key.name === "return" || key.name === "enter") {
        finish(multiple ? [...selected] : choices[active]?.value);
        return;
      } else {
        return;
      }
      render();
    };

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    output.write("\u001b[?25l");
    render();
  });
};

export const createTerminalSelect = (input: TtyInput, output: TtyOutput) => async (
  question: string,
  choices: readonly TerminalChoice[],
  options: MenuOptions = {}
): Promise<string | undefined> => await createMenu(input, output, question, choices, options, false) as string | undefined;

export const createTerminalMultiSelect = (input: TtyInput, output: TtyOutput) => async (
  question: string,
  choices: readonly TerminalChoice[],
  options: MultiMenuOptions = {}
): Promise<string[] | undefined> => await createMenu(input, output, question, choices, options, true) as string[] | undefined;

export const createTerminalForm = (input: TtyInput, output: TtyOutput) => async (
  title: string,
  fields: readonly TerminalFormField[],
  options: { color?: boolean; submitLabel?: string; cancelLabel?: string } = {}
): Promise<Record<string, string> | undefined> => {
  if (fields.length === 0) return {};
  const color = options.color === true;
  const indexes = fields.map((field) => Math.max(0, field.choices.findIndex((choice) => choice.value === field.initialValue)));
  let activeField = 0;
  let renderedRows = 0;
  let rendered = false;
  const wasRaw = input.isRaw === true;
  const wasFlowing = input.readableFlowing;

  return await new Promise((resolve) => {
    const clear = (): void => {
      if (rendered) output.write(`\u001b[${renderedRows}A\r\u001b[0J`);
    };
    const render = (): void => {
      clear();
      const field = fields[activeField];
      if (!field) return;
      const terminalWidth = Math.max(40, output.columns ?? 80);
      const maxWidth = Math.max(24, terminalWidth - 7);
      const visibleCount = Math.min(Math.max(5, (output.rows ?? 16) - 6), field.choices.length);
      const activeChoice = indexes[activeField] ?? 0;
      const start = Math.min(Math.max(0, activeChoice - Math.floor(visibleCount / 2)), field.choices.length - visibleCount);
      const visible = field.choices.slice(start, start + visibleCount);
      const step = fields.length > 1 ? ` ${activeField + 1}/${fields.length}` : "";
      output.write(`${ansi(color, "\u001b[36m", "\u001b[39m", "?")} ${ansi(color, "\u001b[1m", "\u001b[22m", title)}${ansi(color, "\u001b[2m", "\u001b[22m", step)}\n`);
      output.write(`  ${ansi(color, "\u001b[1m", "\u001b[22m", field.label)}\n`);
      for (let offset = 0; offset < visible.length; offset += 1) {
        const index = start + offset;
        const choice = visible[offset];
        if (!choice) continue;
        const pointer = index === activeChoice ? ansi(color, "\u001b[36m", "\u001b[39m", "❯") : " ";
        const detail = choice.hint ? `${choice.label} — ${choice.hint}` : choice.label;
        const label = index === activeChoice
          ? ansi(color, "\u001b[1m", "\u001b[22m", truncate(detail, maxWidth))
          : truncate(detail, maxWidth);
        output.write(`  ${pointer} ${label}\n`);
      }
      const position = field.choices.length > visibleCount ? ` · ${activeChoice + 1}/${field.choices.length}` : "";
      const hasRatingHotkeys = field.choices.some((choice) => /^[1-5]$/u.test(choice.value));
      const enterLabel = activeField === fields.length - 1 ? options.submitLabel ?? "submit" : "next";
      const backLabel = activeField > 0 ? " · ← back" : "";
      output.write(`  ${ansi(color, "\u001b[2m", "\u001b[22m", `↑/↓ choose${hasRatingHotkeys ? " · 1–5 jump" : ""} · Enter ${enterLabel}${backLabel} · Esc ${options.cancelLabel ?? "cancel"}${position}`)}\n`);
      renderedRows = visible.length + 3;
      rendered = true;
    };
    const finish = (value: Record<string, string> | undefined): void => {
      clear();
      input.removeListener("keypress", onKeypress);
      input.setRawMode(wasRaw);
      if (wasFlowing !== true) input.pause();
      output.write("\u001b[?25h");
      if (value !== undefined) output.write(`${ansi(color, "\u001b[32m", "\u001b[39m", "✓")} ${title}\n`);
      resolve(value);
    };
    const onKeypress = (_text: string, key: Key): void => {
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        finish(undefined);
        return;
      }
      const choices = fields[activeField]?.choices ?? [];
      if (key.name === "up" || key.name === "k") indexes[activeField] = ((indexes[activeField] ?? 0) - 1 + choices.length) % choices.length;
      else if (key.name === "down" || key.name === "j") indexes[activeField] = ((indexes[activeField] ?? 0) + 1) % choices.length;
      else if (key.name === "home") indexes[activeField] = 0;
      else if (key.name === "end") indexes[activeField] = choices.length - 1;
      else if (/^[1-5]$/u.test(_text) || /^[1-5]$/u.test(key.name ?? "")) {
        const directValue = /^[1-5]$/u.test(_text) ? _text : key.name ?? "";
        const directIndex = choices.findIndex((choice) => choice.value === directValue);
        if (directIndex === -1) return;
        indexes[activeField] = directIndex;
      } else if ((key.name === "left" || key.name === "h" || key.name === "backspace") && activeField > 0) {
        activeField -= 1;
      } else if (key.name === "return" || key.name === "enter") {
        if (activeField < fields.length - 1) {
          activeField += 1;
          render();
          return;
        }
        const result = Object.fromEntries(fields.flatMap((field, index) => {
          const value = field.choices[indexes[index] ?? 0]?.value;
          return value === undefined ? [] : [[field.name, value]];
        }));
        finish(result);
        return;
      } else {
        return;
      }
      render();
    };

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    output.write("\u001b[?25l");
    render();
  });
};
