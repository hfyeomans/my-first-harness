# my-first-harness

A small coding agent you can read in one sitting. The loop is `runAgent` in `src/loop.ts`. Model calls go through `@earendil-works/pi-ai`. The tools are `read_file`, `write_file`, `edit_file`, and `bash`. This step saves every run as a session you can resume, and compacts a long conversation so it fits the model's context window.

`@earendil-works/pi-ai` is the published name of the `packages/ai` package from [pi](https://github.com/earendil-works/pi). This repo was written against version 1.4.0.

## Install

You need Node.js 22.19 or newer and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm test
pnpm build
```

`pnpm test` typechecks and runs the tests. The tests use a scripted model, so they make no network calls. `pnpm build` writes `dist/cli.js`, which the `myagent` bin runs.

## Run

Tool calls are printed to stderr, so you can watch the loop. The final answer is printed to stdout.

Offline, with no API key, `--provider faux` is a scripted stand-in (`createFauxModel` in `src/faux-model.ts`). It is not a model. It reads the newest prompt and the newest message, never a step counter. With no edit in the prompt, it takes the filename, calls `read_file`, and prints what the tool returned:

```bash
printf 'hello from disk\n' > sample.txt
pnpm exec tsx src/cli.ts -p "Read sample.txt" --provider faux
```

In a terminal that mixes the two streams, that looks like:

```
session 20261026-140720-f951f2
tool read_file {"path":"sample.txt"}
The file says:
hello from disk
```

The `session` and `tool` lines are stderr. The answer is stdout.

If the prompt contains `replace "..." with "..."`, the same script reads the file, calls `edit_file`, then runs `grep` to check the new text:

```bash
pnpm exec tsx src/cli.ts -p 'Edit sample.txt, replace "hello" with "goodbye", and verify' --provider faux
```

```
session 20261026-140721-9c04be
tool read_file {"path":"sample.txt"}
tool edit_file {"path":"sample.txt","old_string":"hello","new_string":"goodbye"}
tool bash {"command":"grep -F -n -- 'goodbye' 'sample.txt'"}
Updated sample.txt.
exit_code: 0
stdout:
1:goodbye from disk
stderr:
```

That overwrites `sample.txt`. The `session` line and the three `tool` lines are stderr. The rest is stdout.

After `pnpm build`, the compiled CLI is the same program:

```bash
node dist/cli.js -p "Read sample.txt" --provider faux
```

`package.json` names that file `myagent`, so once this package is installed the command is `myagent`. `pnpm myagent` is a shortcut for the `tsx` command above. pnpm also prints its own script header on stdout, so the two commands here are the ones whose stdout is only the answer.

### A real model

Pick a provider and a model id with flags or environment variables:

| Flag | Environment variable | Meaning |
| --- | --- | --- |
| `--provider` | `MYAGENT_PROVIDER` | Provider id, such as `openai`, `anthropic`, or `google`. `faux` is the offline script. |
| `--model` | `MYAGENT_MODEL` | Model id, such as `gpt-4o-mini` or `claude-haiku-4-5`. Unused for `faux`. |
| `--max-turns` | `MYAGENT_MAX_TURNS` | Maximum accepted model replies. Default 8. |
| `--cwd` | | Working directory for the tools. Default: where you ran the command. |
| `-p`, `--prompt` | | The prompt. |
| `--resume [id]` | | Continue a saved session with this prompt. With no id, the session written to most recently. |
| `--sessions-dir` | `MYAGENT_SESSIONS_DIR` | Where sessions are saved. Default: `.myagent/sessions` in the working directory. |
| `--faux-context-window` | | A context window in tokens for `--provider faux`, so compaction can run offline. Only with `faux`. |

The API key is the provider's own variable. pi-ai reads it. This program does not have a separate key variable.

| Provider | Environment variable |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` |
| Google | `GEMINI_API_KEY` |

Other providers use the variables documented in the `@earendil-works/pi-ai` README. A few need an extra variable besides the key (Azure needs `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`; Cloudflare needs an account id). Amazon Bedrock and Vertex AI can use ambient credentials instead of one of the variables above. If you name a provider this program knows and none of its key variables are set, `myagent` exits and tells you which variable to set.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node dist/cli.js -p "Read sample.txt and quote the first line" --provider anthropic --model claude-haiku-4-5
```

`gpt-4o-mini`, `claude-haiku-4-5`, `claude-sonnet-4-5`, and `gemini-2.5-flash` are ids in the pi-ai 1.4.0 catalog.

## How the loop works

Start at `runAgent` in `src/loop.ts`.

1. It appends the history to the session, compacts if the session is getting too big (see [Compaction](#compaction)), and calls `model.complete` with `session.messages()`. For a real provider, that model is `piModel` in `src/pi-model.ts`, which calls pi-ai's `models.complete` with the declarations from `toolDeclarations` and a short system prompt. The prompt names the four tools, says that a non-zero bash exit is a result, and says that bash runs with the user's permissions. The CLI passes `agentTools` from `src/registry.ts`. A test can pass a different list.
2. The assistant message comes back as pi-ai sent it. `classifyReply` (`src/messages.ts`) decides what it means. `stop` and `toolUse` are accepted and appended. A context overflow is retried once after compacting. Any other stop throws. A `length` stop throws `The model stopped because it hit its output limit.` An error throws the provider's message. A refused reply is never appended. `toolCallsOf` collects content blocks whose `type` is `"toolCall"`.
3. When there are no tool calls, `runAgent` returns. That assistant text is the answer. `finalAnswer` finds it, and `main` writes it to stdout.
4. When there are tool calls, `main`'s `onToolCall` writes a `tool <name> <json>` line to stderr. Then the private `executeTool` calls `findTool`. An unknown name becomes `{ ok: false, error }`. Otherwise it calls `parse` and `run`. If either throws, that error is also `{ ok: false }`. The loop keeps going.
5. `toolResultMessage` is the only conversion. It turns our `ToolResult` into a pi-ai message with `role: "toolResult"`, `toolCallId`, `toolName`, and `isError`. That message is appended, and the loop calls the model again with what the session holds.
6. Each accepted reply counts as one turn. Summary calls and a reply refused as too long do not. `DEFAULT_MAX_TURNS` is 8. Tool calls from the last allowed reply still run, and then `runAgent` returns without another model call. `finalAnswer` is undefined in that case, and `main` exits with status 1 and writes `stopped after N model turns` to stderr.

## Sessions

Every run is saved. `myagent` appends each message to `.myagent/sessions/<id>.jsonl` under the working directory as soon as the message exists, one JSON record per line. The directory is created mode `0700` and each new file mode `0600`, because the lines hold tool output. The session id goes to stderr before the model runs.

To continue a session, pass its id to `--resume` with a new prompt. `--resume` with no id continues the session written to most recently, by file modification time. The model sees the earlier conversation. With no filename in the prompt, the faux script answers by quoting the prompt before it:

```bash
pnpm exec tsx src/cli.ts --resume -p "What did I ask before?" --provider faux
```

```
session 20261026-140720-f951f2
Earlier you asked: Read sample.txt
```

`--sessions-dir` or `MYAGENT_SESSIONS_DIR` keeps sessions somewhere else. A relative path there resolves against where you ran the command, not against `--cwd`. An id has to look like the ones `myagent` prints, so `--resume ../x` is refused before any file is opened.

Line 1 of a session file is a header with the id, `created_at`, provider, model, and cwd. Each message record holds pi-ai's `Message` unchanged, with a `seq` that starts at 1 and goes up by one. `src/session.ts` is the only code that reads or writes these lines. The loop and the compaction code call `appendMessage` and `appendCompaction` on a `Session` and read `messages()` and `entries()` back.

If the process died while writing, the last line can be incomplete. `--resume` drops that line, cuts it off the file, prints a warning to stderr, and continues. A last line that is complete but missing its newline is kept. Any other line that does not parse, or a `seq` that skips or repeats, stops `--resume` with `<file>:<line>: <reason>`. Skipping such a line could lose a tool result or a compaction.

`runAgent` takes the session as `options.session`. Without one it uses an empty session that writes nothing. Either way it returns `session.messages()` as a new array and leaves the caller's array alone.

### Compaction

Before each model call, the loop estimates the conversation's size with pi-ai's `estimateContextTokens`. When the estimate passes `COMPACT_AT_RATIO` (75%) of the model's context window, the loop asks the model to summarize the older messages and replaces them with that summary. The window is `Model.contextWindow` from the pi-ai catalog. Nothing in the loop names a size. The ratios live in `src/compaction.ts`.

The most recent messages stay word for word. An assistant message and the tool results after it form one group, and only whole groups are summarized, so a tool call is never split from its results. The newest group is always kept. Older groups are kept while they fit in `KEEP_RECENT_RATIO` (25%) of the window.

The summary is a separate model call with its own prompt and no tools. It becomes a user message at the front of the history, so after a compaction `runAgent` returns a history that starts with the summary. The session file keeps every original line. Compaction appends one `compaction` record holding the summary and the `seq` where the kept messages start. `--resume` rebuilds the history from the newest one.

User text, assistant text, tool-call argument strings, and tool-result text in that summary request are cut to a head and a tail, marked `[... N bytes elided]`. If the copy is still over half the window, the oldest turns are left out of it and one line counts them. A previous summary that is too long is cut the same way. The session line keeps the full text. Tool call ids and names are left as they are.

If the provider still says the request is too long (pi-ai's `isContextOverflow`), the loop compacts again, keeping only the newest group, and retries that call once. If there is nothing older to summarize, or the retry is too long as well, the run fails with `The conversation does not fit in the model's context window.`

The faux script has no real window. `--faux-context-window` gives it one so you can watch compaction offline. Its summary is the earlier prompt plus a count:

```bash
head -c 2000 /dev/zero | tr '\0' x > big.txt
pnpm exec tsx src/cli.ts -p "Read big.txt" --provider faux --faux-context-window 40
pnpm exec tsx src/cli.ts --resume -p "What did I ask before?" --provider faux --faux-context-window 40
```

The second command prints:

```
session 20261026-140720-01df4a
Earlier you asked: Read big.txt
(faux summary of 3 earlier messages)
```

The answer quotes the summary. After compaction, the summary is the earlier message the model can see.

## The tool registry

`src/registry.ts` is the list of tools.

`agentTools` is a plain array: `read_file`, `write_file`, `edit_file`, `bash`. `findTool(tools, name)` walks that array. `toolDeclarations(tools)` maps each tool through pi-ai's `toToolDeclaration`, which keeps `name`, `description`, and `parameters` and drops `parse` and `run`. That object is what the provider sees. The functions stay in this process.

Four tools do not need a class, a map built at startup, or a register function. Those would only wrap the same three things: the list, the lookup, and the declaration. A new tool later is a file plus one line in the array. The loop still takes the array as an argument, which is why a test can pass one tool, or a tool that throws, without editing the registry.

## Why tool errors look like this

Every tool returns `ToolResult`: `{ ok: true, output }` or `{ ok: false, error }`. `executeTool` turns a throw, a failed `parse`, or an unknown name into `{ ok: false, error }` too. `toolResultMessage` sets `isError` from `ok`. The model reads that text on the next turn and can call the tool again. Throwing out of the loop would end the turn instead.

`parse` (`src/parse-args.ts`) checks the arguments with pi-ai's `validateToolArguments`. A missing field or a non-object is a thrown error, which the loop turns into the same `{ ok: false, error }`. The message starts with `Validation failed`, so the model can see which field was wrong.

### read_file, write_file, and edit_file

The path rules live in `src/workspace-path.ts`. `read_file` and `write_file` both use them, so the checks are not copied. `edit_file` reads with `read_file` and writes with the same writer as `write_file`.

A path must be relative. `..` that stays inside the working directory is allowed. A path that resolves outside it is not. The opened file is checked again by its descriptor, not only by the name, so a symlink that points outside is refused. On Linux that check follows `/proc/self/fd`, which is the descriptor rather than a second lookup of the name. The check opens write-only, so a file you can write but not read can still be replaced.

The new bytes go to a temporary file in the directory that was checked. That file is synced, then renamed onto the target. When the path already exists, the temporary file takes that file's mode first, so an executable stays executable and a private file stays private. A new file keeps the usual permissions. A failed write deletes the temporary file and leaves the original bytes in place. A new file is created only when the parent already exists. `O_NOFOLLOW` refuses a symlink as the temporary name. A dangling symlink is refused rather than replaced. A symlink that stays inside the working directory is followed, and the write replaces the file it points at.

A refused path does not create or change a file. The error says which check failed (`Path escapes the working directory.`, `No such file: ...`, `... is not a file.`, `No such directory: ...`). The same shape as a missing `read_file`. The cap for both reading and writing is 200000 bytes.

`edit_file` has two extra failures, and both leave the file as it was:

- `old_string was not found in <path>.` The text did not match. Read the file and try the exact characters.
- `old_string appears N times in <path>. Include more surrounding text so it matches once.` Replacing every copy would be a guess. One exact match is the whole behavior. A longer `old_string` makes it unique, which is why the count is in the error. Overlapping copies count separately, so `aa` in `aaa` is two matches.

`old_string` is literal text, not a regular expression. An empty `old_string` fails validation. `new_string` may be empty, which deletes the matched text.

After the replacement is synced, `edit_file` reads the file again and skips the rename if the text is no longer what it read. The error is `<path> changed while editing. Read it and try again.` There is no lock around the edit.

### bash

`bash` runs the command with `bash -c` in the working directory, with your environment. The result is text the model can read:

```
exit_code: 0
stdout:
hello
stderr:
```

A non-zero exit uses the same shape, with `ok: true`, so `isError` is false. A failing test or a compiler error is information for the next turn, not a broken tool. Stdout and stderr are captured separately, not interleaved.

Each stream stops at 100000 bytes. The label becomes `stdout (truncated):` or `stderr (truncated):`. The cut does not split a UTF-8 character. The process is still allowed to finish, so the exit code is the real one.

If the command runs longer than 30000 milliseconds, the tool kills the process group, destroys the output pipes, and returns `{ ok: false, error: "Command timed out after 30000ms." }` at that deadline. There is no exit code to show, and output from before the kill is discarded. Killing the group matters because a child such as `sleep` would otherwise keep running. A descendant that leaves the group, for example with `setsid`, can still hold the pipes. The tool does not wait for those pipes to close.

`bash` is not jailed to the working directory. It runs with your permissions and can `cd` anywhere you can. `read_file`, `write_file`, and `edit_file` cannot. This step does not ask before it runs a command. A later step can add a permission check. There is no safety prompt here.

## Types

The transcript uses pi-ai's `Message` rather than a second message type. An assistant reply has to go back to the provider unchanged, including thinking blocks and provider metadata, so copying it into `{ role: "assistant", text, toolCalls }` would drop fields the next turn needs.

pi-ai's shapes, and the sketch they replace:

| Sketch | Here |
| --- | --- |
| `{ role: "user", content: string }` | Same, plus the `timestamp` pi-ai requires. |
| `{ role: "assistant", text, toolCalls }` | `{ role: "assistant", content }`. Text and tool calls are content blocks. A tool call has `arguments`, not `args`. |
| `{ role: "tool", callId, result }` | `{ role: "toolResult", toolCallId, toolName, content, isError }`. Our `ToolResult` (`{ ok: true, output }` or `{ ok: false, error }`) is converted by `toolResultMessage`. |
| `Tool.schema: JSONSchema` | `Tool.parameters`, a TypeBox schema, which is what pi-ai's `Tool` and `validateToolArguments` take. |
| `runAgent(history, tools)` | `runAgent(history, tools, options)`. `options.model` is required because the loop does not pick a provider itself. `options.maxTurns`, `options.cwd`, `options.onToolCall`, and `options.session` live there too. The CLI passes `agentTools`. |

`ToolContext` is `{ cwd: string }`.
