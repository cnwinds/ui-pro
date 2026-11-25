import { ErrorCodes, UiProError } from '../errors';
import { NODE_REF_PATTERN } from '../schema/common';

/** A node qualified by its screen. */
export interface NodeRef {
  screen: string;
  id: string;
}

/** `<screen>/#<id>`, the form stored in glossaries and accepted by selectors. */
export function formatRef(ref: NodeRef): string {
  return `${ref.screen}/#${ref.id}`;
}

export function parseRef(text: string): NodeRef {
  const match = NODE_REF_PATTERN.exec(text);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new UiProError(ErrorCodes.opInvalid, `不是合法的节点引用：${text}`, {
      hint: '节点引用形如 <screen>/#<id>',
    });
  }
  return { screen: match[1], id: match[2] };
}
