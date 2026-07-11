const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || "{}");
const text = input.command || input.pattern || input.file_path || "";

if (/\b(rg|grep|find|cat|sed|head|awk)\b/.test(text) && !/\bsymnav\b/.test(text)) {
  console.error(
    "The global overview command is available for TypeScript symbol navigation in this benchmark arm. Invoke it alongside normal reads and search.",
  );
}
