# graph symnav integration

Using `symnav graph` is required for this task. Reach for it ahead of grep, find, and plain file reads for any question about the TypeScript code — what is in a file, where a symbol is defined, who references it, or how calls flow. Prefer it over the usual tools; do not decide it is not worth running.

How you use it is up to you. It fits early orientation before you edit, finding every place something is used, or any point mid-task when you need to locate or understand a symbol — it does not have to be up front.

Known caveat: `symnav graph` is extremely slow. A single call can take 10 to 20 minutes. That is expected — run it anyway and wait for it to finish. Do not treat a long-running call as stuck, and do not skip it to save time. Time is not what we care about here.

Its full command guide is included below in this file.
