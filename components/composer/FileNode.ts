import { $applyNodeReplacement, TextNode, type EditorConfig, type NodeKey, type SerializedTextNode } from "lexical";

type SerializedFileNode = SerializedTextNode & { path: string };

export class FileNode extends TextNode {
  __path: string;

  static getType() { return "file"; }
  static clone(node: FileNode) { return new FileNode(node.__path, node.__key); }

  constructor(path = "", key?: NodeKey) {
    super(path, key);
    this.__path = path;
  }

  getPath() { return this.getLatest().__path; }
  static importJSON(value: SerializedFileNode) { return $createFileNode(value.path); }
  exportJSON(): SerializedFileNode {
    return { ...super.exportJSON(), type: "file", path: this.getPath(), version: 1 };
  }

  createDOM(config: EditorConfig) {
    const element = super.createDOM(config);
    element.classList.add("composer-file");
    element.title = this.getPath();
    element.spellcheck = false;
    return element;
  }

  canInsertTextBefore() { return false; }
  canInsertTextAfter() { return false; }
  isTextEntity(): true { return true; }
}

export function $createFileNode(path: string) {
  return $applyNodeReplacement(new FileNode(path).setMode("token"));
}
