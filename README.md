# Annotator Agent

Turn a qualitative codebook into an LLM annotation prompt, annotate tutoring transcripts with it, measure the result against human gold labels with Cohen's kappa, and improve the prompt with AI suggestions that you review. Everything runs on your own computer from the terminal, with your own API key. There's no app, login, database or server.

```
codebook  →  prompt v1  →  annotate  →  kappa vs human labels  →  suggestions  →  you edit  →  prompt v2  →  …
```

## Setup (once)

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. Download this repository (Code → Download ZIP, or `git clone`) and open a terminal in its folder.
3. Install: `npm install`
4. Copy `.env.example` to `.env` and fill it in:

   - **Your own OpenAI key:**

     ```
     OPENAI_API_KEY=sk-...
     AGENT_MODEL=gpt-4o
     ```

   - ** Any OpenAI-compatible service:**

     ```
     OPENAI_API_KEY=your-gateway-key
     OPENAI_BASE_URL=https://your-gateway-url
     AGENT_MODEL=anthropic.claude-4.6-sonnet
     ```

   You can use a different model per step with `CODEBOOK_MODEL`, `PROMPT_MODEL`, `ANNOTATION_MODEL` and `SUGGESTION_MODEL`. `.env` is never committed to Git.

## Your files

Put these in `workspace/input/`:

| File | What it is |
| --- | --- |
| `codebook.pdf` (or `.docx`, `.txt`, `.md`, or a `.csv` with "codebook" in its name) | Your codebook. Write code names exactly as your coders use them |
| `dataset.csv` | One row per utterance: a session column (`session_id`, or student + question), a speaker column (`role`, `speaker` or `message_type`; S/T and prompt/response become Student/Tutor), a text column (`content` or `text`), and ideally `sequence_id` or `#` |
| Gold-label CSVs (optional) | Human labels: one or more files with **gold** or **GT** in the name. Same layout rules as the dataset, plus one column per codebook category. Columns marked `(AI)` are earlier model labels; they are shown as a baseline, never used as gold |
| `column-map.json` (optional) | Only if a gold column name doesn't match a category, e.g. `{"answer leak (Human)": "TUTOR_ANSWER_LEAK"}` |

Everything in `workspace/input/` and `workspace/output/` stays on your computer; Git ignores both folders.

## The loop

On Windows, type `agent` instead of `./agent`.

```bash
./agent status          # what's there and what to do next (run any time)

./agent codebook        # 1. read the codebook  → workspace/output/codebook.md   (review it)
./agent prompt          # 2. write prompt v1    → workspace/output/prompts/v1.md (review it)
./agent annotate        # 3. run v1             → workspace/output/runs/v1/annotated.csv
./agent evaluate        # 4. kappa vs gold      → workspace/output/runs/v1/evaluation.md
./agent suggest         # 5. AI suggestions     → runs/v1/suggestions.md + prompts/v2.draft.md
                        # 6. edit prompts/v2.draft.md yourself
./agent accept v2       # 7. it becomes prompt v2
./agent annotate        # repeat 3–7 with v2, v3, …
```

## Good to know

- **You review every step.** Fix codes in `workspace/output/codebook.json` before writing the prompt. Edit any prompt file before running it. `annotate` asks before it sends anything to the model.
- **It starts small.** `annotate` runs only the sessions in your gold files by default, or 5 sessions if you have none. Use `--sessions all` for the whole dataset, or `--sessions 20`.
- **Gold sessions missing from the dataset still work.** If a gold file's session IDs aren't in the dataset, that conversation is taken from the gold file. The model only sees speaker and text, never the human labels.
- **Multi-label codes** ("A, B" from coders, "A | B" from the model) are compared as sets: the model must give exactly the same codes.
- **Previous AI kappa** appears when a gold file has `(AI)` columns, so you can see whether your prompt beats the earlier one.
- **Label problems are flagged.** The evaluation lists human labels that aren't codebook codes (typos like "Specifc question"). The suggestions list possible gold-label or codebook issues separately, so you don't tune the prompt to label noise.
- **Cost.** Each command prints how many model calls and tokens it used; `run.json` records it per run. Annotation is most of the cost, so you can set a cheaper `ANNOTATION_MODEL`.
- **Privacy.** Transcripts are sent to the API you configure. Use de-identified data and a provider your IRB approves.

## Other options

| Option | Meaning |
| --- | --- |
| `--prompt v2` / `--run v2` | Pick a version (default: the newest) |
| `--sessions gold\|all\|<n>` | Which sessions to annotate |
| `--model <name>` | Annotation model for this run only |
| `--concurrency 3` | Sessions annotated in parallel |
| `--yes` | Don't ask before annotating |
| `--codebook`, `--data`, `--gold a.csv,b.csv` | Use files outside `workspace/input/` (paths relative to this folder) |
| `AGENT_WORKSPACE=other-folder` | Use a different workspace folder, e.g. one per project |

## Project layout

| Folder | What's in it |
| --- | --- |
| `src/cli.ts`, `src/workspace.ts` | The commands and folder layout |
| `src/llm.ts` | The OpenAI-compatible client (JSON answers, retries, token counts) |
| `src/codebook/` | Reading the document, extracting the codebook, writing the prompt |
| `src/annotate/` | Transcripts, the annotation instructions and the response schema |
| `src/evaluate/` | Matching gold rows, Cohen's kappa, F1, confusions, disagreements |
| `src/suggest/` | Prompt-improvement suggestions |
| `test/` | Unit tests: `npm test` |

## Credits

Parts of this tool are adapted from [Sandpiper](https://github.com/National-Tutoring-Observatory/sandpiper) by the National Tutoring Observatory (MIT License); see `NOTICE`. The codebook format matches Sandpiper's, so codebooks and prompts can move between the two.
