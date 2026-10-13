// A small YAML 1.2 writer for JSON-compatible values (enough for OpenAPI and AsyncAPI files).

const PLAIN = /^[A-Za-z_/][\w ./-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?([eE][+-]?\d+)?|\.inf|\.nan)$/i;

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  if (text !== "" && PLAIN.test(text) && !RESERVED.test(text) && !/[:#]\s|\s$/.test(text))
    return text;
  return JSON.stringify(text);
}

function key(name: string): string {
  return PLAIN.test(name) && !RESERVED.test(name) && !name.includes(": ")
    ? name
    : JSON.stringify(name);
}

function isEmpty(value: unknown): boolean {
  return Array.isArray(value)
    ? value.length === 0
    : !!value && typeof value === "object" && Object.keys(value).length === 0;
}

function lines(value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item && typeof item === "object" && !isEmpty(item)) {
        const [first, ...rest] = lines(item, indent + "  ");
        return [`${indent}- ${(first ?? "").trimStart()}`, ...rest];
      }
      return [`${indent}- ${isEmpty(item) ? (Array.isArray(item) ? "[]" : "{}") : scalar(item)}`];
    });
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .flatMap(([name, item]) => {
      if (item && typeof item === "object" && !isEmpty(item))
        return [`${indent}${key(name)}:`, ...lines(item, indent + "  ")];
      if (typeof item === "string" && item.includes("\n"))
        return [
          `${indent}${key(name)}: |-`,
          ...item.split("\n").map((line) => `${indent}  ${line}`),
        ];
      return [
        `${indent}${key(name)}: ${isEmpty(item) ? (Array.isArray(item) ? "[]" : "{}") : scalar(item)}`,
      ];
    });
}

export function toYaml(value: unknown): string {
  return lines(value, "").join("\n") + "\n";
}
