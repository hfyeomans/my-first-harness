# my-first-harness

A small coding agent you can read in one sitting. This step is the agent loop and one tool, `read_file`. Model calls go through `@earendil-works/pi-ai`. The loop itself is `runAgent` in this repo.

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

Offline, with no API key, `--provider faux` is a scripted stand-in (`createFauxModel` in `src/faux-model.ts`). It is not a model. It takes the first filename in your prompt, calls `read_file`, and prints what the tool returned:

```bash
printf 'hello from disk\n' > sample.txt
pnpm exec tsx src/cli.ts -p "Read sample.txt" --provider faux
```

In a terminal that mixes the two streams, that looks like:

```
tool read_file {"path":"sample.txt"}
The file says:
hello from disk
```

The `tool` line is stderr. The answer is stdout.

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
| `--model` | `MYAGENT_MODEL` | Model id, such as `gpt-4o-mini`. Unused for `faux`. |
| `--max-turns` | `MYAGENT_MAX_TURNS` | Maximum model calls. Default 8. |
| `--cwd` | | Working directory for `read_file`. Default: where you ran the command. |
| `-p`, `--prompt` | | The prompt. |

The API key is the provider's own variable. pi-ai reads it. This program does not have a separate key variable.

| Provider | Environment variable |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` |
| Google | `GEMINI_API_KEY` |

Other providers use the variables documented in the `@earendil-works/pi-ai` README. A few need an extra variable besides the key (Azure needs `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`; Cloudflare needs an account id). Amazon Bedrock and Vertex AI can use ambient credentials instead of one of the variables above. If you name a provider this program knows and none of its key variables are set, `myagent` exits and tells you which variable to set.

```bash
export OPENAI_API_KEY=sk-...
node dist/cli.js -p "Read sample.txt and quote the first line" --provider openai --model gpt-4o-mini
```

`gpt-4o-mini`, `claude-sonnet-4-5`, and `gemini-2.5-flash` are ids in the pi-ai 1.4.0 catalog.

## How the loop works

Start at `runAgent` in `src/loop.ts`.

1. It copies the history and calls `model.complete`. For a real provider, that model is `piModel` in `src/pi-model.ts`, which calls pi-ai's `models.complete` with the `read_file` schema and a short system prompt. The CLI chooses the model in `main` (`src/cli.ts`): `createFauxModel`, or `loadPiModel`.
2. The assistant message comes back as pi-ai sent it. `toolCallsOf` (`src/messages.ts`) collects content blocks whose `type` is `"toolCall"`.
3. When there are no tool calls, `runAgent` returns. That assistant text is the answer. `finalAnswer` finds it, and `main` writes it to stdout.
4. When there are tool calls, `main`'s `onToolCall` writes a `tool <name> <json>` line to stderr. Then the private `executeTool` in `src/loop.ts` looks up the tool. An unknown name becomes `{ ok: false, error }`. Otherwise it calls `parse` and `run`. If either throws, that error is also `{ ok: false }`. The loop keeps going.
5. `toolResultMessage` is the only conversion. It turns our `ToolResult` into a pi-ai message with `role: "toolResult"`, `toolCallId`, `toolName`, and `isError`. That message is appended, and the loop calls the model again with the whole transcript.
6. Each model call counts as one turn. `DEFAULT_MAX_TURNS` is 8. Tool calls from the last allowed call still run, and then `runAgent` returns without another model call. `finalAnswer` is undefined in that case, and `main` exits with status 1 and writes `stopped after N model turns` to stderr.

The only tool in this step is `readFileTool` in `src/read-file.ts`. `parse` checks the arguments with pi-ai's `validateToolArguments`. `run` reads a UTF-8 file whose path stays inside the working directory. A missing file, a directory, bytes that are not valid UTF-8, a UTF-8 file that contains a NUL byte, a file over 200000 bytes, or a path that escapes the directory comes back as `{ ok: false, error }`. A file of valid UTF-8 with no NUL byte is returned, including one that happens to be data rather than prose.

## Types

The transcript uses pi-ai's `Message` rather than a second message type. An assistant reply has to go back to the provider unchanged, including thinking blocks and provider metadata, so copying it into `{ role: "assistant", text, toolCalls }` would drop fields the next turn needs.

pi-ai's shapes, and the sketch they replace:

| Sketch | Here |
| --- | --- |
| `{ role: "user", content: string }` | Same, plus the `timestamp` pi-ai requires. |
| `{ role: "assistant", text, toolCalls }` | `{ role: "assistant", content }`. Text and tool calls are content blocks. A tool call has `arguments`, not `args`. |
| `{ role: "tool", callId, result }` | `{ role: "toolResult", toolCallId, toolName, content, isError }`. Our `ToolResult` (`{ ok: true, output }` or `{ ok: false, error }`) is converted by `toolResultMessage`. |
| `Tool.schema: JSONSchema` | `Tool.parameters`, a TypeBox schema, which is what pi-ai's `Tool` and `validateToolArguments` take. |
| `runAgent(history, tools)` | `runAgent(history, tools, options)`. `options.model` is required because the loop does not pick a provider itself. `options.maxTurns`, `options.cwd`, and `options.onToolCall` live there too. |

`ToolContext` is `{ cwd: string }`.
