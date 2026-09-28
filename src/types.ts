/**
 * An element. Every node kind shares this `{ name, attrs, children }` shape, so V8 keeps them
 * all on one hidden class; element names never start with "#" or "?", which tells them apart
 * from comments and processing instructions.
 */
export interface XmlElement {
  name: string;
  /** Attributes as a flat `[name, value, name, value, …]` list in document order, or `null`. */
  attrs: string[] | null;
  /**
   * Child nodes and text in document order, or `null` when empty. An element whose only child
   * is text stores that string directly (use `childNodes()` for a uniform array).
   */
  children: XmlNode[] | string | null;
}

/** A comment: `<!--data-->`. */
export interface XmlComment {
  name: "#comment";
  attrs: null;
  children: string;
}

/** A processing instruction: `<?target data?>`, named "?" + target. */
export interface XmlProcessingInstruction {
  name: `?${string}`;
  attrs: null;
  children: string;
}

/** Anything that can appear in `children`; text is a plain string. */
export type XmlNode = XmlElement | XmlComment | XmlProcessingInstruction | string;

/** A parsed document. */
export interface XmlDocument {
  /** The root element. */
  root: XmlElement;
  /** Every top-level node in document order: comments, processing instructions and the root. */
  children: XmlNode[];
}

/** Limits that bound the work and memory a document can cause. All are optional. */
export interface ParseOptions {
  /** Maximum element nesting depth. Default 256. */
  maxDepth?: number;
  /** Maximum attributes on one element. Default 200. */
  maxAttributes?: number;
  /** Maximum length of an element, attribute or PI target name, in UTF-16 code units. Default 1000. */
  maxNameLength?: number;
}
