import { ErrorCodes, UiProError } from '../errors';
import { PRIMITIVES, type Primitive } from '../schema/common';
import {
  type AttributeOperator,
  type ComplexSelector,
  type Compound,
  SELECTOR_ATTRIBUTES,
  type SelectorAttribute,
  type SelectorList,
  type SimpleSelector,
  type Step,
} from './ast';

const WORD = /[A-Za-z][A-Za-z0-9-]*/y;
const ID_CHARS = /[A-Za-z0-9_]+/y;
const COMPONENT_CHARS = /[A-Za-z0-9_]+/y;
const SCREEN_QUALIFIER = /(\*|[a-z][a-z0-9_-]{0,63})\//y;
const BARE_ATTRIBUTE_VALUE = /[^\s\]"']+/y;
const BARE_CONCEPT_VALUE = /[^\s,)>[#:(@"']+/y;

const SYNTAX_HINT = '例如 #id、button、[role=badge.notification]、concept:红点、#topbar > button';

const isPrimitive = (word: string): word is Primitive =>
  (PRIMITIVES as readonly string[]).includes(word);
const isAttribute = (word: string): word is SelectorAttribute =>
  (SELECTOR_ATTRIBUTES as readonly string[]).includes(word);
const attribute = (
  name: SelectorAttribute,
  operator: AttributeOperator,
  value: string,
): SimpleSelector => ({ kind: 'attribute', name, operator, value });

class Parser {
  private pos = 0;
  private readonly input: string;

  constructor(input: string) {
    this.input = input;
  }

  parse(): SelectorList {
    this.skipSpace();
    if (this.atEnd()) throw this.error('选择器为空');
    const list = this.parseList();
    if (!this.atEnd()) throw this.error(`多余的字符 '${this.peek()}'`);
    return list;
  }

  /** Comma-separated selectors; stops before a closing `)` or the end of input. */
  private parseList(): SelectorList {
    const items: ComplexSelector[] = [];
    for (;;) {
      this.skipSpace();
      items.push(this.parseComplex());
      this.skipSpace();
      if (this.peek() !== ',') return { items };
      this.pos++;
    }
  }

  private parseComplex(): ComplexSelector {
    const screen = this.parseQualifier();
    const steps: Step[] = [{ combinator: null, compound: this.parseCompound() }];
    for (;;) {
      const resume = this.pos;
      const spaced = this.skipSpace();
      const next = this.peek();
      if (next === '>') {
        this.pos++;
        this.skipSpace();
        steps.push({ combinator: 'child', compound: this.parseCompound() });
      } else if (spaced && next !== undefined && next !== ',' && next !== ')') {
        steps.push({ combinator: 'descendant', compound: this.parseCompound() });
      } else {
        this.pos = resume;
        return screen === undefined ? { steps } : { screen, steps };
      }
    }
  }

  private parseQualifier(): string | undefined {
    SCREEN_QUALIFIER.lastIndex = this.pos;
    const match = SCREEN_QUALIFIER.exec(this.input);
    if (!match?.[1]) return undefined;
    this.pos += match[0].length;
    return match[1];
  }

  private parseCompound(): Compound {
    const start = this.pos;
    const tests: SimpleSelector[] = [];
    if (this.peek() === '*') this.pos++;
    for (;;) {
      const next = this.peek();
      if (next === '#') tests.push(this.parseId());
      else if (next === '[') tests.push(this.parseAttribute());
      else if (next === '@') tests.push(this.parseSelectionRef());
      else if (next !== undefined && /[A-Za-z]/.test(next)) {
        tests.push(this.parseWordSelector(this.pos === start));
      } else break;
    }
    if (this.pos === start) {
      const found = this.atEnd() ? '选择器意外结束' : `遇到 '${this.peek()}'`;
      throw this.error(`这里应该是选择器，${found}`);
    }
    return { tests };
  }

  private parseId(): SimpleSelector {
    this.pos++;
    const id = this.match(ID_CHARS);
    if (id === undefined) throw this.error("'#' 后面需要节点 id");
    return { kind: 'id', id };
  }

  private parseSelectionRef(): SimpleSelector {
    const at = this.pos;
    this.pos++;
    if (this.match(WORD) !== 'selection') throw this.error("只支持 '@selection'", at);
    return { kind: 'selection' };
  }

  /** A type name (compound start only), `concept:…`, `component:…` or `like(…)`. */
  private parseWordSelector(atStart: boolean): SimpleSelector {
    const at = this.pos;
    const word = this.match(WORD) ?? '';
    if (this.peek() === ':') {
      this.pos++;
      if (word === 'concept') {
        return attribute('concept', '=', this.parseValue(BARE_CONCEPT_VALUE, '概念名'));
      }
      if (word === 'component') {
        return attribute('instanceOf', '=', this.parseValue(COMPONENT_CHARS, '组件名'));
      }
      throw this.error(`未知的简写 '${word}:'，支持 concept: 和 component:`, at);
    }
    if (this.peek() === '(' && word === 'like') return this.parseLike();
    if (!atStart) throw this.error(`类型名 '${word}' 只能写在复合选择器的开头`, at);
    if (!isPrimitive(word)) {
      throw this.error(`未知的基元类型 '${word}'`, at, `可用类型：${PRIMITIVES.join('、')}`);
    }
    return { kind: 'type', type: word };
  }

  private parseLike(): SimpleSelector {
    this.pos++;
    const inner = this.parseList();
    this.skipSpace();
    if (this.peek() !== ')') throw this.error("like( 缺少右括号 ')'");
    this.pos++;
    return { kind: 'like', inner };
  }

  private parseAttribute(): SimpleSelector {
    this.pos++;
    this.skipSpace();
    const nameAt = this.pos;
    const name = this.match(WORD) ?? '';
    if (!isAttribute(name)) {
      throw this.error(
        `未知的属性 '${name}'`,
        nameAt,
        `可用属性：${SELECTOR_ATTRIBUTES.join('、')}`,
      );
    }
    this.skipSpace();
    if (this.peek() === ']') {
      this.pos++;
      return attribute(name, 'exists', '');
    }
    const operator = this.parseOperator();
    this.skipSpace();
    const value = this.parseValue(BARE_ATTRIBUTE_VALUE, '属性值');
    this.skipSpace();
    if (this.peek() !== ']') throw this.error("属性选择器缺少 ']'");
    this.pos++;
    return attribute(name, operator, value);
  }

  private parseOperator(): AttributeOperator {
    for (const operator of ['^=', '~=', '='] as const) {
      if (this.input.startsWith(operator, this.pos)) {
        this.pos += operator.length;
        return operator;
      }
    }
    throw this.error("属性名后需要 '='、'^=' 或 '~='，或直接以 ']' 结束");
  }

  private parseValue(bare: RegExp, what: string): string {
    const quote = this.peek();
    if (quote === '"' || quote === "'") return this.parseQuoted(quote);
    const value = this.match(bare);
    if (value === undefined) throw this.error(`缺少${what}`);
    return value;
  }

  private parseQuoted(quote: string): string {
    const start = this.pos;
    this.pos++;
    let value = '';
    while (!this.atEnd()) {
      const char = this.input.charAt(this.pos++);
      if (char === quote) return value;
      if (char === '\\' && !this.atEnd()) value += this.input.charAt(this.pos++);
      else value += char;
    }
    throw this.error('引号没有闭合', start);
  }

  private match(pattern: RegExp): string | undefined {
    pattern.lastIndex = this.pos;
    const match = pattern.exec(this.input);
    if (!match) return undefined;
    this.pos += match[0].length;
    return match[0];
  }

  /** Skips whitespace; reports whether any was skipped. */
  private skipSpace(): boolean {
    const start = this.pos;
    while (/\s/.test(this.input.charAt(this.pos))) this.pos++;
    return this.pos > start;
  }

  private peek(): string | undefined {
    return this.atEnd() ? undefined : this.input.charAt(this.pos);
  }

  private atEnd(): boolean {
    return this.pos >= this.input.length;
  }

  private error(message: string, at = this.pos, extraHint?: string): UiProError {
    const column = at + 1;
    return new UiProError(
      ErrorCodes.selectorSyntax,
      `选择器语法错误（第 ${column} 列）：${message}`,
      {
        hint: extraHint ?? SYNTAX_HINT,
        details: { selector: this.input, column },
      },
    );
  }
}

export function parseSelector(input: string): SelectorList {
  return new Parser(input).parse();
}
