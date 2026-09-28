import type { XmlComment, XmlElement, XmlNode, XmlProcessingInstruction } from "./types.js";

/** True for elements (not text, comments or processing instructions). */
export function isElement(node: XmlNode): node is XmlElement {
  if (typeof node === "string") return false;
  const first = node.name.codePointAt(0);
  return first !== 35 && first !== 63; // "#", "?"
}

/** True for comments. */
export function isComment(node: XmlNode): node is XmlComment {
  return typeof node !== "string" && node.name === "#comment";
}

/** True for processing instructions (`name` is "?" + target). */
export function isProcessingInstruction(node: XmlNode): node is XmlProcessingInstruction {
  return typeof node !== "string" && node.name.codePointAt(0) === 63;
}

/** The value of attribute `name`, or undefined. */
export function getAttribute(element: XmlElement, name: string): string | undefined {
  const list = element.attrs;
  if (list === null) return undefined;
  for (let index = 0; index < list.length; index += 2) {
    if (list[index] === name) return list[index + 1];
  }
  return undefined;
}

/** All attributes as a null-prototype object (safe for names like `__proto__`). */
export function attributes(element: XmlElement): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  const list = element.attrs;
  if (list !== null) {
    for (let index = 0; index < list.length; index += 2) {
      result[list[index] as string] = list[index + 1] as string;
    }
  }
  return result;
}

/** The element's children as an array, also when a lone text child is stored as a string. */
export function childNodes(element: XmlElement): XmlNode[] {
  const children = element.children;
  if (children === null) return [];
  return typeof children === "string" ? [children] : children;
}

/** Concatenated text of a node and its descendants; comments and PIs contribute nothing. */
export function textContent(node: XmlNode): string {
  if (typeof node === "string") return node;
  if (!isElement(node)) return "";
  let text = "";
  const stack: XmlNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as XmlNode;
    if (typeof current === "string") {
      text += current;
      continue;
    }
    if (!isElement(current)) continue;
    const children = current.children;
    if (children === null) continue;
    if (typeof children === "string") {
      text += children;
      continue;
    }
    for (let index = children.length - 1; index >= 0; index--)
      stack.push(children[index] as XmlNode);
  }
  return text;
}
