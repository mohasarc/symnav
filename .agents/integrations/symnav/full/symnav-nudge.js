const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || "{}");
const text = input.command || input.pattern || input.file_path || "";

if (/\b(rg|grep|find|cat|sed|head|awk)\b/.test(text) && !/\bsymnav\b/.test(text)) {
  console.error(
    "The global overview, resolve, def, refs, context, and graph commands are available for TypeScript symbol navigation in this benchmark arm. Invoke them alongside normal reads and search.",
  );
}
