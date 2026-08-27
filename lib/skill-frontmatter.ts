import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const KEY = "disable-model-invocation";
const KEY_LINE = `[ \t]*(?:${KEY}|"${KEY}"|'${KEY}')[ \t]*:`;

/**
 * Toggle the `disable-model-invocation` frontmatter key with a surgical line
 * edit that preserves the original YAML formatting of every other field.
 */
export function setDisableModelInvocation(content: string, disable: boolean): string {
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
  const hasKey = Object.prototype.hasOwnProperty.call(frontmatter, KEY);
  if (!disable && !hasKey) return content;

  // Only edit inside frontmatter, never a body line that documents the key.
  const closing = content.startsWith("---") ? content.indexOf("\n---", 3) : -1;
  const head = closing === -1 ? content : content.slice(0, closing);
  const tail = closing === -1 ? "" : content.slice(closing);

  if (disable) {
    if (hasKey) {
      const keyLine = new RegExp(`^(${KEY_LINE})[^\r\n]*(\r?)$`, "m");
      if (!keyLine.test(head)) throw new Error(`Cannot edit ${KEY}: unsupported frontmatter formatting`);
      return head.replace(keyLine, "$1 true$2") + tail;
    }
    const withKey = head.replace(/^---(\r?\n)/, `---$1${KEY}: true$1`);
    if (withKey === head) return `---\n${KEY}: true\n---\n${content}`;
    return withKey + tail;
  }

  const keyLine = new RegExp(`\n${KEY_LINE}[^\n]*`);
  if (!keyLine.test(head)) throw new Error(`Cannot edit ${KEY}: unsupported frontmatter formatting`);
  return head.replace(keyLine, "") + tail;
}
