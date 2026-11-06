import { $applyNodeReplacement, TextNode, type EditorConfig, type NodeKey, type SerializedTextNode } from "lexical";

type SerializedSkillNode = SerializedTextNode & { name: string };

export class SkillNode extends TextNode {
  __name: string;

  static getType() { return "skill"; }
  static clone(node: SkillNode) { return new SkillNode(node.__name, node.__key); }

  constructor(name = "", key?: NodeKey) {
    super(name, key);
    this.__name = name;
  }

  getName() { return this.getLatest().__name; }
  static importJSON(value: SerializedSkillNode) { return $createSkillNode(value.name); }
  exportJSON(): SerializedSkillNode {
    return { ...super.exportJSON(), type: "skill", name: this.getName(), version: 1 };
  }

  createDOM(config: EditorConfig) {
    const element = super.createDOM(config);
    element.classList.add("composer-skill");
    element.spellcheck = false;
    return element;
  }

  canInsertTextBefore() { return false; }
  canInsertTextAfter() { return false; }
  isTextEntity(): true { return true; }
}

export function $createSkillNode(name: string) {
  return $applyNodeReplacement(new SkillNode(name).setMode("token"));
}
