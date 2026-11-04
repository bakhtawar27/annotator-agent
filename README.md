# Annotator Agent

Turn a qualitative codebook into an LLM annotation prompt, annotate tutoring transcripts with it, measure the result against human gold labels with Cohen's kappa, and improve the prompt with AI suggestions that you review. Everything runs on your own computer from the terminal, with your own API key.

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

   - **Any OpenAI-compatible service:**

     ```
     OPENAI_API_KEY=your-gateway-key
     OPENAI_BASE_URL=https://your-gateway-url
     AGENT_MODEL=anthropic.claude-4.6-sonnet
     ```

   You can use a different model per step with `CODEBOOK_MODEL`, `PROMPT_MODEL`, `ANNOTATION_MODEL` and `SUGGESTION_MODEL`. `.env` is never committed to Git.

## Your files

Put your three files in `workspace/input/`. You can drag them into the folder in Finder or File Explorer, or copy them in the terminal:

```bash
cp ~/Downloads/codebook.csv     workspace/input/
cp ~/Downloads/dataset.csv      workspace/input/
cp ~/Downloads/ground_truth.csv workspace/input/
```

```
workspace/input/
├── codebook.csv        your codebook
├── dataset.csv         the transcripts to annotate
└── ground_truth.csv    human labels for some or all of those transcripts (optional)
```

The tool finds each file by its name and type:

| File | What it is |
| --- | --- |
| Codebook: `.pdf`, `.docx`, `.txt` or `.md`, or a `.csv` with "codebook" in its name | Your categories and codes. Write code names exactly as your coders use them |
| Dataset: any other `.csv` | One row per utterance: a session column (`session_id`, or student + question), a speaker column (`role`, `speaker` or `message_type`; S/T and prompt/response become Student/Tutor), a text column (`content` or `text`), and ideally `sequence_id` or `#` |
| Human labels (optional): one or more `.csv` files with **gold**, **GT**, **ground truth** or **human** in the name | The same layout as the dataset, plus one column per codebook category. Columns marked `(AI)` are earlier model labels; they are shown as a baseline, never used as gold. If you have several files for the same sessions, keep only one, or the rows count twice |
| `column-map.json` (optional) | Only if a gold column name doesn't match a category, e.g. `{"answer leak (Human)": "TUTOR_ANSWER_LEAK"}` |

Run `./agent status` to check it found the right file for each role. Everything in `workspace/input/` and `workspace/output/` stays on your computer; Git ignores both folders.

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

What each step does:

1. **codebook** reads your codebook document with the model and turns it into a list of categories and codes. Open `codebook.md` to check it. If a code is missing or misspelled, fix it in `codebook.json`, which is the file later steps use.
2. **prompt** writes an annotation prompt from the codebook: what each code means and when to use it. This is `prompts/v1.md`. Edit it freely; the model gets exactly what's in the file.
3. **annotate** sends each conversation and the prompt to the model, which labels every utterance in every category. The result is your dataset with an `ai_` column per category, plus the model's reasoning.
4. **evaluate** lines up the AI labels with your human labels row by row and computes Cohen's kappa per category, with the most common disagreements.
5. **suggest** gives the model the prompt, the kappa scores and the disagreements, and asks how to change the prompt. It writes the suggestions and a draft of the next prompt.
6. **You decide** what goes into the next prompt: edit the draft, keep or drop each change.
7. **accept** makes your edited draft the next version. Run annotate and evaluate again to see whether kappa went up.

## What you get

```
workspace/output/
├── codebook.md            the codebook as the tool understood it   (read this)
├── codebook.json          the same, used by later steps             (edit this to fix codes)
├── schema.json            the categories and allowed codes for the model
├── prompts/
│   ├── v1.md              prompt v1                                  (edit before annotating)
│   └── v2.draft.md        suggested prompt v2                        (edit, then ./agent accept v2)
└── runs/
    └── v1/                one folder per prompt version
        ├── annotated.csv      your dataset + ai_<category> and ai_reasoning columns
        ├── run.json           model, sessions, utterances annotated, tokens used
        ├── evaluation.md      kappa per category, top disagreements   (show this)
        ├── evaluation.json    the same numbers for scripts
        ├── disagreements.csv  every row where the AI and human labels differ, with the AI's reasoning
        └── suggestions.md     what to change in the prompt, and possible label or codebook issues
```

Each prompt version gets its own `runs/` folder, so you can open `runs/v1/evaluation.md` and `runs/v2/evaluation.md` side by side to see whether the new prompt did better. `./agent status` lists the kappa of every run.

## Good to know

- **You review every step.** Fix codes in `workspace/output/codebook.json` before writing the prompt. Edit any prompt file before running it. `annotate` asks before it sends anything to the model.
- **It starts small.** `annotate` runs only the sessions in your gold files by default, or 5 sessions if you have none. Use `--sessions all` for the whole dataset, or `--sessions 20`.
- **Gold sessions missing from the dataset still work.** If a gold file's session IDs aren't in the dataset, that conversation is taken from the gold file. The model only sees speaker and text, never the human labels.
- **Multi-label codes** ("A, B" from coders, "A | B" from the model) are compared as sets: the model must give exactly the same codes.
- **Previous AI kappa** appears when a gold file has `(AI)` columns, so you can see whether your prompt beats the earlier one.
- **Label problems are flagged.** The evaluation lists human labels that aren't codebook codes (typos like "Specifc question"). The suggestions list possible gold-label or codebook issues separately, so you don't tune the prompt to label noise.
- **Every utterance gets a label.** `annotate` asks the model for 20 utterances at a time (with the whole conversation as context) and asks again for any it skipped. It reports how many utterances were annotated.
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
