const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || "{}");
const text = input.command || input.pattern || input.file_path || "";

if (/\b(rg|grep|find|cat|sed|head|awk)\b/.test(text) && !/\bsymnav\b/.test(text)) {
  console.error(
    "If this read or search is for code, use symnav instead: `symnav overview <file>` before opening a file, `symnav def --source <target>` instead of sed or cat, `symnav refs <target>` instead of grepping for a name. Run symnav calls on their own or with `;`. `Cannot answer` exits 1 and stops an `&&` chain.",
  );
}
