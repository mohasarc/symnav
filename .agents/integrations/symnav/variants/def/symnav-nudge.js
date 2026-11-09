const input = JSON.parse(process.env.CLAUDE_TOOL_INPUT || "{}");
const text = input.command || input.pattern || input.file_path || "";

if (/\b(rg|grep|find|cat|sed|head|awk)\b/.test(text) && !/\bsymnav\b/.test(text)) {
  console.error(
    "The global def command is available for symbol navigation in this benchmark arm. Reach for it ahead of reads and search. Run symnav calls on their own or with `;`. `Cannot answer` exits 1 and stops an `&&` chain.",
  );
}
