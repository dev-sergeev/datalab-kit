---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
---

# Skill Creator

> **Datalab Kit Pi adaptation — modified from Anthropic's original.**
> Source: [anthropics/skills, `skills/skill-creator`](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator),
> revision `dbd4588f9e1033efb41dad4bef2f7947c8993d44`.
> Licensed under [Apache-2.0](LICENSE.txt). The runtime, paths, evaluation isolation,
> telemetry guidance, and delivery instructions below have been changed for Pi.

## Pi setup and writable paths

This workflow runs entirely through Pi. The Python utilities require **Python 3.10+**
and **PyYAML**; install PyYAML in the Python environment used for the commands
(for example, `python3 -m pip install PyYAML`, preferably in a virtual environment).
Pi must already be installed and authenticated for the selected provider. This
package supplies skills, not the Pi executable. Use `PI_EXECUTABLE_PATH` when set;
otherwise find `pi` on `PATH`. Model arguments accept Pi's `provider/model` syntax.

Resolve `<creator-root>` to the absolute directory containing this SKILL.md.
Read its supporting files there, but **never write generated files into that
directory**: npm installations may be read-only and upgrades replace their files.
Choose a writable, user-visible workspace, normally
`<current-project>/<skill-name>-workspace/`, or a user-selected writable directory.
Keep iterations, snapshots, trigger evals, reports, archives, and temporary files
there. If updating a package-provided or otherwise read-only skill, first copy the
whole skill to `<workspace>/candidate/<original-name>/` and edit that copy.
Preserve the existing directory name and frontmatter `name` when updating.

For a **new skill**, an explicit destination supplied by the user takes priority.
Otherwise use Pi's global agent directory: nonempty `PI_CODING_AGENT_DIR`
(expand `~` and resolve a relative value against the current directory), or
`~/.pi/agent`; the destination is `<agent-dir>/skills/<skill-name>/`.
Create only the new skill's directory; do not overwrite Pi settings or unrelated
skills. Stage a candidate in the workspace when practical, then copy the completed
skill to its destination. A new Pi session or `/reload` discovers installed skills.
Pi's native invocation is `/skill:<name>`; this kit also provides `/skill-creator`.

Run Python module commands **from the workspace**, with the creator root on the
module search path and bytecode writes disabled:

```bash
export PYTHONPATH="<creator-root>${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1
```

All paths in commands below should be absolute. These environment settings let
`python3 -m scripts.<module>` work without changing into the installed package.
Use explicit output paths inside the workspace whenever a command accepts one.

The bundled `@gotgenes/pi-subagents` extension supplies `subagent`,
`get_subagent_result`, and `steer_subagent`. Its agent types are not the files in
this skill's `agents/` directory: those files are task instructions to read, not
registered agent definitions. For grading, comparison, analysis, and orchestration:

```text
subagent({
  subagent_type: "general-purpose",
  description: "Grade spreadsheet evaluation",
  prompt: "Read <creator-root>/agents/grader.md. Expectations: [...]. Transcript: <absolute-path>. Outputs: <absolute-path>. Save grading.json beside outputs.",
  inherit_context: false,
  run_in_background: true
})
```

Use the returned ID with
`get_subagent_result({agent_id: "<id>", wait: true, verbose: true})` when the
result is needed. Background runs notify on completion; do useful work meanwhile.
Set `model: "<provider/model>"` only when needed and keep executor models the
same across comparison arms. Do not invent a `tasks`, `agentScope`, `cwd`, or
`skills` spawn parameter: this extension has none. Children can see the parent's
skills, so functional evals require the fresh, isolated Pi sessions described
below, not simply a request to a child to "ignore" the candidate.

A skill for creating new skills and iteratively improving them.

At a high level, the process of creating a skill goes like this:

- Decide what you want the skill to do and roughly how it should do it
- Write a draft of the skill
- Create a few test prompts and run Pi with access to the skill on them
- Help the user evaluate the results both qualitatively and quantitatively
  - While the runs happen in the background, draft some quantitative evals if there aren't any (if there are some, you can either use as is or modify if you feel something needs to change about them). Then explain them to the user (or if they already existed, explain the ones that already exist)
  - Use the `eval-viewer/generate_review.py` script to show the user the results for them to look at, and also let them look at the quantitative metrics
- Rewrite the skill based on feedback from the user's evaluation of the results (and also if there are any glaring flaws that become apparent from the quantitative benchmarks)
- Repeat until you're satisfied
- Expand the test set and try again at larger scale

Your job when using this skill is to figure out where the user is in this process and then jump in and help them progress through these stages. So for instance, maybe they're like "I want to make a skill for X". You can help narrow down what they mean, write a draft, write the test cases, figure out how they want to evaluate, run all the prompts, and repeat.

On the other hand, maybe they already have a draft of the skill. In this case you can go straight to the eval/iterate part of the loop.

Of course, you should always be flexible and if the user is like "I don't need to run a bunch of evaluations, just vibe with me", you can do that instead.

Then after the skill is done (but again, the order is flexible), you can also run the skill description improver, which we have a whole separate script for, to optimize the triggering of the skill.

Cool? Cool.

## Communicating with the user

The skill creator is liable to be used by people across a wide range of familiarity with coding jargon. Some users are opening a terminal for the first time; others are experienced developers.

So please pay attention to context cues to understand how to phrase your communication! In the default case, just to give you some idea:

- "evaluation" and "benchmark" are borderline, but OK
- for "JSON" and "assertion" you want to see serious cues from the user that they know what those things are before using them without explaining them

It's OK to briefly explain terms if you're in doubt, and feel free to clarify terms with a short definition if you're unsure if the user will get it.

---

## Creating a skill

### Capture Intent

Start by understanding the user's intent. The current conversation might already contain a workflow the user wants to capture (e.g., they say "turn this into a skill"). If so, extract answers from the conversation history first — the tools used, the sequence of steps, corrections the user made, input/output formats observed. The user may need to fill the gaps, and should confirm before proceeding to the next step.

1. What should this skill enable Pi to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases to verify the skill works? Skills with objectively verifiable outputs (file transforms, data extraction, code generation, fixed workflow steps) benefit from test cases. Skills with subjective outputs (writing style, art) often don't need them. Suggest the appropriate default based on the skill type, but let the user decide.

### Interview and Research

Proactively ask questions about edge cases, input/output formats, example files, success criteria, and dependencies. Wait to write test prompts until you've got this part ironed out.

Check available MCPs - if useful for research (searching docs, finding similar skills, looking up best practices), research in parallel via subagents if available, otherwise inline. Come prepared with context to reduce burden on the user.

### Write the SKILL.md

Based on the user interview, fill in these components:

- **name**: Skill identifier
- **description**: When to trigger, what it does. This is the primary triggering mechanism — include both what the skill does AND specific contexts for when to use it. All "when to use" info goes here, not in the body. Models sometimes undertrigger skills; make the description explicit about relevant tasks and adjacent wording without promising unrelated capabilities. For example, explain that a dashboard skill applies to data visualization and internal metrics even when the user does not explicitly ask for a "dashboard".
- **compatibility**: Required tools, dependencies (optional, rarely needed)
- **the rest of the skill :)**

### Skill Writing Guide

#### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons, fonts)
```

#### Progressive Disclosure

Skills use a three-level loading system:
1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - In context whenever skill triggers (<500 lines ideal)
3. **Bundled resources** - As needed (unlimited, scripts can execute without loading)

These word counts are approximate and you can feel free to go longer if needed.

**Key patterns:**
- Keep SKILL.md under 500 lines; if you're approaching this limit, add an additional layer of hierarchy along with clear pointers about where the model using the skill should go next to follow up.
- Reference files clearly from SKILL.md with guidance on when to read them
- For large reference files (>300 lines), include a table of contents

**Domain organization**: When a skill supports multiple domains/frameworks, organize by variant:
```
cloud-deploy/
├── SKILL.md (workflow + selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```
Pi reads only the relevant reference file.

#### Principle of Lack of Surprise

This goes without saying, but skills must not contain malware, exploit code, or any content that could compromise system security. A skill's contents should not surprise the user in their intent if described. Don't go along with requests to create misleading skills or skills designed to facilitate unauthorized access, data exfiltration, or other malicious activities. Things like a "roleplay as an XYZ" are OK though.

#### Writing Patterns

Prefer using the imperative form in instructions.

**Defining output formats** - You can do it like this:
```markdown
## Report structure
ALWAYS use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

**Examples pattern** - It's useful to include examples. You can format them like this (but if "Input" and "Output" are in the examples you might want to deviate a little):
```markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

### Writing Style

Try to explain to the model why things are important in lieu of heavy-handed musty MUSTs. Use theory of mind and try to make the skill general and not super-narrow to specific examples. Start by writing a draft and then look at it with fresh eyes and improve it.

### Test Cases

After writing the skill draft, come up with 2-3 realistic test prompts — the kind of thing a real user would actually say. Share them with the user: [you don't have to use this exact language] "Here are a few test cases I'd like to try. Do these look right, or do you want to add more?" Then run them.

Save test cases to `evals/evals.json` inside the writable candidate skill, never inside the installed creator package. Don't write assertions yet — just the prompts. You'll draft assertions in the next step while the runs are in progress.

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
```

See [references/schemas.md](references/schemas.md) for the full schema. Store the assertion strings in `expectations` in evals.json and copy them to `assertions` in each run's eval_metadata.json; these names serve different consumers.

## Running and evaluating test cases

This section is one continuous sequence — don't stop partway through. Do NOT use `/skill-test` or any other testing skill.

Put results in the writable `<workspace>/` chosen above, not beside a package-managed skill. Organize results by iteration (`iteration-1/`, `iteration-2/`, etc.), then by descriptive test directory (`eval-0-table-extraction/`, for example). Create directories as needed. Use separate inputs, execution cwd, and outputs for each arm so runs cannot overwrite or learn from one another's files.

### Step 1: Spawn with-skill AND baseline runs together

For each test case launch two independent executions in the same batch. Use
background `general-purpose` subagents to orchestrate them, with
`inherit_context: false`. Each orchestrator launches a **fresh Pi CLI process**
from its own writable run directory, rather than performing the task itself:

```bash
"${PI_EXECUTABLE_PATH:-pi}" --print --mode json --no-session \
  --no-skills --no-prompt-templates --no-themes \
  --no-context-files --no-approve --model "<provider/model>" \
  --system-prompt '' --append-system-prompt '' \
  --skill "<absolute-candidate-path>/SKILL.md" \
  "<task prompt, absolute input paths, absolute output directory; first read the supplied skill and follow it>" \
  > "<run-dir>/transcript.jsonl" 2> "<run-dir>/stderr.log"
```

`--no-skills` disables discovery while the explicit `--skill` adds only the
candidate. Disable project context and prompt templates, and pass empty
`--system-prompt` and `--append-system-prompt` values to suppress discovered
SYSTEM.md/APPEND_SYSTEM.md while retaining Pi's built-in base prompt.
`--no-context-files` alone does not suppress those system-prompt files.
This keeps normal creator instructions and globally installed skills out of
both arms. Keep configured
extensions enabled: the selected provider (including DataLab/GigaChat) may be
registered by an extension. Preserve the user's `PI_CODING_AGENT_DIR`, settings,
and authentication; do not manufacture a separate agent home or fall back to
another provider. Use identical extensions and tools in both arms, record any
extension-specific prompt/context additions, and do not claim stronger isolation
than the actual configuration provides. `--no-approve` declines project resource
trust for this controlled run; it is not a filesystem sandbox.

**With-skill:** use the writable candidate and save deliverables to
`<workspace>/iteration-N/eval-ID-name/with_skill/run-1/outputs/`.

**Baseline:**
- Creating a new skill: omit `--skill` and the instruction to read it; use the
  identical task, inputs, model, and tools. Save to `without_skill/run-1/outputs/`.
- Improving a skill: snapshot the entire original skill before editing at
  `<workspace>/skill-snapshot/<name>/`; use that snapshot with `--skill`.
  Still name this comparison arm `without_skill/run-1/` for aggregation/viewer
  compatibility, and record that it is the **old skill**, not a no-skill run.

The orchestrator should save raw JSONL, stderr, exit status, timing, and the final
assistant text (as an output file when the requested deliverable is prose).
Preserve failed runs and distinguish execution failure from an assertion failure.
Do not pass assertions, expected answers, grading rules, previous outputs, or
creator conversation to the execution process. Supply only the task, inputs,
output location, and candidate instructions for that arm. Restrict file writes
to the run directory where the task permits; Pi is not a filesystem sandbox.

Keep the `run-1/` layer even when running each prompt just once: aggregation
discovers `run-*` directories, not `with_skill/grading.json` directly. Repeated
runs use `run-2/`, `run-3/`, and so on in both comparison arms.

Write an `eval_metadata.json` for each test case (assertions can be empty for now). Give each eval a descriptive name based on what it's testing — not just "eval-0". Use this name for the directory too. If this iteration uses new or modified eval prompts, create these files for each new eval directory — don't assume they carry over from previous iterations.

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "assertions": []
}
```

### Step 2: While runs are in progress, draft assertions

Don't just wait for the runs to finish — you can use this time productively. Draft quantitative assertions for each test case and explain them to the user. If assertions already exist in `evals/evals.json`, review them and explain what they check.

Good assertions are objectively verifiable and have descriptive names — they should read clearly in the benchmark viewer so someone glancing at the results immediately understands what each one checks. Subjective skills (writing style, design quality) are better evaluated qualitatively — don't force assertions onto things that need human judgment.

Update the `eval_metadata.json` files and `evals/evals.json` with the assertions once drafted. Also explain to the user what they'll see in the viewer — both the qualitative outputs and the quantitative benchmark.

### Step 3: As runs complete, capture timing data

Measure the **executor process**, not the orchestration subagent. Wrap each Pi
launch with Python's `time.monotonic()` (or an equivalent monotonic clock) and
save the elapsed milliseconds and seconds in `<run-dir>/timing.json`.
Pi JSONL `message_end` events contain completed messages: sum available
`message.usage.totalTokens` across assistant messages for `total_tokens`.
Only include usage from the executor, not the orchestrator or grader.

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.332
}
```

Those numbers are illustrative, not defaults. If a provider omits token usage,
omit `total_tokens` and explain the missing measurement; never estimate tokens
from character counts or insert zero for unavailable telemetry. Tool counts can
be derived from actual `tool_execution_end` events, not inferred from prose.
The subagent extension's human-readable summaries can be rounded, and its
lifetime token accounting differs from Pi's provider usage. Do not assume a
notification has numeric `total_tokens`/`duration_ms`. Raw JSONL and saved timing
remain available for later grading and analysis.

### Step 4: Grade, aggregate, and launch the viewer

Once all runs are done:

1. **Grade each run** — spawn a `general-purpose` subagent whose prompt tells it to read [agents/grader.md](agents/grader.md), supplies the assertion strings and absolute transcript/output paths, and asks it to save `grading.json` beside `outputs/`. Or grade inline. The expectations array must use `text`, `passed`, and `evidence` — the viewer depends on these exact names. For programmatically checkable assertions, write and run a checker rather than eyeballing. Do not fabricate missing metrics.

2. **Aggregate into benchmark** — from the writable workspace, with the Python environment above:
   ```bash
   python3 -m scripts.aggregate_benchmark <workspace>/iteration-N --skill-name <name>
   ```
   This produces `benchmark.json` and `benchmark.md` in the iteration directory, comparing pass rates, measured time, and available tokens with mean ± standard deviation. Use the layout and field names in [references/schemas.md](references/schemas.md), especially `with_skill` and `without_skill`. Repeat each case multiple times in separate `run-N/` directories when measuring variance; one observation cannot establish stability. Missing telemetry is not zero usage.
Put each with_skill version before its baseline counterpart.

3. **Do an analyst pass** — read the benchmark data and surface patterns the aggregate stats might hide. See `agents/analyzer.md` (the "Analyzing Benchmark Results" section) for what to look for — things like assertions that always pass regardless of skill (non-discriminating), high-variance evals (possibly flaky), and time/token tradeoffs.

4. **Launch the viewer** with both qualitative outputs and quantitative data:
   ```bash
   nohup python3 <creator-root>/eval-viewer/generate_review.py \
     <workspace>/iteration-N \
     --skill-name "my-skill" \
     --benchmark <workspace>/iteration-N/benchmark.json \
     > /dev/null 2>&1 &
   VIEWER_PID=$!
   ```
   For iteration 2+, also pass `--previous-workspace <workspace>/iteration-<N-1>`.

   **Remote or headless Pi:** If a local browser cannot be opened, add `--static <workspace>/iteration-N/review.html` to generate a standalone HTML file instead of a server. Give the user that file to open. "Submit All Reviews" downloads `feedback.json`; copy the downloaded file into the iteration directory before the next iteration. Do not skip the viewer or baseline because there is no display.

Note: please use generate_review.py to create the viewer; there's no need to write custom HTML.

5. **Tell the user** where the viewer is running or where its static HTML file is saved. Only say it opened in a browser if that actually happened. Explain the two tabs: "Outputs" for per-case feedback and "Benchmark" for the quantitative comparison. Ask them to return when finished reviewing.

### What the user sees in the viewer

The "Outputs" tab shows one test case at a time:
- **Prompt**: the task that was given
- **Output**: the files the skill produced, rendered inline where possible
- **Previous Output** (iteration 2+): collapsed section showing last iteration's output
- **Formal Grades** (if grading was run): collapsed section showing assertion pass/fail
- **Feedback**: a textbox that auto-saves as they type
- **Previous Feedback** (iteration 2+): their comments from last time, shown below the textbox

The "Benchmark" tab shows the stats summary: pass rates, timing, and token usage for each configuration, with per-eval breakdowns and analyst observations.

Navigation is via prev/next buttons or arrow keys. When done, they click "Submit All Reviews" which saves all feedback to `feedback.json`.

### Step 5: Read the feedback

When the user tells you they're done, read `feedback.json`:

```json
{
  "reviews": [
    {"run_id": "eval-0-with_skill", "feedback": "the chart is missing axis labels", "timestamp": "..."},
    {"run_id": "eval-1-with_skill", "feedback": "", "timestamp": "..."},
    {"run_id": "eval-2-with_skill", "feedback": "perfect, love this", "timestamp": "..."}
  ],
  "status": "complete"
}
```

Empty feedback means the user thought it was fine. Focus your improvements on the test cases where the user had specific complaints.

Kill the viewer server when you're done with it:

```bash
kill $VIEWER_PID 2>/dev/null
```

---

## Improving the skill

This is the heart of the loop. You've run the test cases, the user has reviewed the results, and now you need to make the skill better based on their feedback.

### How to think about improvements

1. **Generalize from the feedback.** The big picture thing that's happening here is that we're trying to create skills that can be used a million times (maybe literally, maybe even more who knows) across many different prompts. Here you and the user are iterating on only a few examples over and over again because it helps move faster. The user knows these examples in and out and it's quick for them to assess new outputs. But if the skill you and the user are codeveloping works only for those examples, it's useless. Rather than put in fiddly overfitty changes, or oppressively constrictive MUSTs, if there's some stubborn issue, you might try branching out and using different metaphors, or recommending different patterns of working. It's relatively cheap to try and maybe you'll land on something great.

2. **Keep the prompt lean.** Remove things that aren't pulling their weight. Make sure to read the transcripts, not just the final outputs — if it looks like the skill is making the model waste a bunch of time doing things that are unproductive, you can try getting rid of the parts of the skill that are making it do that and seeing what happens.

3. **Explain the why.** Try hard to explain the **why** behind everything you're asking the model to do. Today's LLMs are *smart*. They have good theory of mind and when given a good harness can go beyond rote instructions and really make things happen. Even if the feedback from the user is terse or frustrated, try to actually understand the task and why the user is writing what they wrote, and what they actually wrote, and then transmit this understanding into the instructions. If you find yourself writing ALWAYS or NEVER in all caps, or using super rigid structures, that's a yellow flag — if possible, reframe and explain the reasoning so that the model understands why the thing you're asking for is important. That's a more humane, powerful, and effective approach.

4. **Look for repeated work across test cases.** Read the transcripts from the test runs and notice if the subagents all independently wrote similar helper scripts or took the same multi-step approach to something. If all 3 test cases resulted in the subagent writing a `create_docx.py` or a `build_chart.py`, that's a strong signal the skill should bundle that script. Write it once, put it in `scripts/`, and tell the skill to use it. This saves every future invocation from reinventing the wheel.

This task is pretty important (we are trying to create billions a year in economic value here!) and your thinking time is not the blocker; take your time and really mull things over. I'd suggest writing a draft revision and then looking at it anew and making improvements. Really do your best to get into the head of the user and understand what they want and need.

### The iteration loop

After improving the skill:

1. Apply your improvements to the skill
2. Rerun all test cases into a new `iteration-<N+1>/` directory, including baseline runs. If you're creating a new skill, the baseline is always `without_skill` (no skill) — that stays the same across iterations. If you're improving an existing skill, use your judgment on what makes sense as the baseline: the original version the user came in with, or the previous iteration.
3. Launch the reviewer with `--previous-workspace` pointing at the previous iteration
4. Wait for the user to review and tell you they're done
5. Read the new feedback, improve again, repeat

Keep going until:
- The user says they're happy
- The feedback is all empty (everything looks good)
- You're not making meaningful progress

---

## Advanced: Blind comparison

For situations where you want a more rigorous comparison between two versions of a skill (e.g., the user asks "is the new version actually better?"), there's a blind comparison system. Read `agents/comparator.md` and `agents/analyzer.md` for the details. The basic idea is: give two outputs to an independent agent without telling it which is which, and let it judge quality. Then analyze why the winner won.

Use fresh `general-purpose` comparator and analyzer subagents with `inherit_context: false`. Randomize which result is A or B and stage copies under neutral paths in `<workspace>/blind/`; strip configuration labels from filenames and metadata given to the comparator. Supply the task and optional expectations, but neither skill identity nor the A/B mapping. Save comparison.json, then give only the analyzer the mapping, skill paths, and execution transcripts. On a TIE, report the tie and analyze differences without inventing a winner. This is optional; the human review loop is usually sufficient.

---

## Description Optimization

The description field in SKILL.md frontmatter is the primary mechanism that determines whether Pi reads a skill. After creating or improving a skill, offer to optimize the description for better triggering accuracy. This measures **selection**, not whether the selected skill completes the task successfully.

### Step 1: Generate trigger eval queries

Create 20 eval queries — a mix of should-trigger and should-not-trigger. Save as JSON:

```json
[
  {"query": "the user prompt", "should_trigger": true},
  {"query": "another prompt", "should_trigger": false}
]
```

The queries must be realistic requests a Pi user would actually type, not abstract tasks: include file paths, job context, column names, company names, or URLs where relevant. Mix lengths, informal phrasing, and near-misses. The user gets a chance to review them.

Bad: `"Format this data"`, `"Extract text from PDF"`, `"Create a chart"`

Good: `"ok so my boss just sent me this xlsx file (its in my downloads, called something like 'Q4 sales final FINAL v2.xlsx') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in column C and costs are in column D i think"`

For the **should-trigger** queries (8-10), think about coverage. You want different phrasings of the same intent — some formal, some casual. Include cases where the user doesn't explicitly name the skill or file type but clearly needs it. Throw in some uncommon use cases and cases where this skill competes with another but should win.

For the **should-not-trigger** queries (8-10), the most valuable ones are the near-misses — queries that share keywords or concepts with the skill but actually need something different. Think adjacent domains, ambiguous phrasing where a naive keyword match would trigger but shouldn't, and cases where the query touches on something the skill does but in a context where another tool is more appropriate.

The key thing to avoid: don't make should-not-trigger queries obviously irrelevant. "Write a fibonacci function" as a negative test for a PDF skill is too easy — it doesn't test anything. The negative cases should be genuinely tricky.

### Step 2: Review with user

Present the eval set to the user for review using the HTML template:

1. Read [assets/eval_review.html](assets/eval_review.html).
2. Replace `__EVAL_DATA_PLACEHOLDER__` with the JSON array, `__SKILL_NAME_PLACEHOLDER__` with the name, and `__SKILL_DESCRIPTION_PLACEHOLDER__` with the current description. Escape values for their HTML/JavaScript context; in particular escape `<` in embedded JSON so a query cannot end a script tag.
3. Write `<workspace>/trigger-eval-review.html` and open it using the platform's browser opener when available, or give the user the path to open locally.
4. The user edits queries, toggles should-trigger, adds/removes entries, and clicks "Export Eval Set".
5. Read the actual downloaded JSON file the user exported, then save it as `<workspace>/trigger-eval.json`. Browser download paths vary; do not assume `~/Downloads/eval_set.json` is the exported file.

This step matters — bad eval queries lead to bad descriptions.

### Step 3: Run the optimization loop

Tell the user that this runs repeated independent Pi queries and consumes model
usage. Save the reviewed eval set in the workspace. First, the standalone trigger
evaluation can establish a baseline:

```bash
python3 -m scripts.run_eval \
  --eval-set <workspace>/trigger-eval.json \
  --skill-path <absolute-candidate-path> \
  --model <provider/model>
```

Then run the full optimization loop from the workspace:

```bash
python3 -m scripts.run_loop \
  --eval-set <workspace>/trigger-eval.json \
  --skill-path <absolute-candidate-path> \
  --model <provider/model> \
  --max-iterations 5 \
  --results-dir <workspace>/description-optimization \
  --report <workspace>/description-optimization.html \
  --verbose
```

Use the actual Pi model selection, not a guessed model ID; the user may choose a
different authenticated provider/model. Run in the background when supported,
save logs in the workspace, and report observed iteration results.
By default, the loop splits queries into 60% training and 40% held-out testing
(`--holdout 0.4`), runs each query three times, and chooses `best_description`
by held-out score rather than training score. It evaluates descriptions through
Pi and asks Pi for evidence-based improvements, retaining the HTML report and
JSON results. Do not replace actual trigger reads with a model's self-report.
Trigger evaluation uses only `read` in a temporary cwd and observes an exact
read of the candidate SKILL.md; it does not execute the skill's full workflow.
Errors and timeouts are failed evaluations, not successful non-triggers.
The scripts retain configured provider extensions and authentication while
disabling discovered skills, prompt templates, themes, context files, and custom
SYSTEM.md/APPEND_SYSTEM.md discovery; Pi's built-in base prompt remains.
Description improvement runs Pi with `--no-tools`. If an extension injects
additional prompt/context, note that condition when interpreting trigger scores.
Keep generated results outside the installed package. The report path above
can be opened locally in a headless environment; `--report none` disables only
HTML report generation. See each module's `--help` for tuning flags.

### How skill triggering works

Pi presents discovered skills as a catalogue of names, descriptions, and paths.
The model decides whether to read a SKILL.md using Pi's `read` tool. Trigger
evaluation detects an actual read of the candidate, not a claim in response text.
An explicit `/skill:<name>` invocation is different: it intentionally loads the
skill and is not a test of description-driven selection.

Use substantive queries for which the skill adds value, including negative
near-misses. Do not hard-code a supposed rule that simple requests never trigger:
selection depends on the model, catalogue, and description. Controlled evaluations
isolate the candidate; real installed skill catalogues may produce different rates.

### Step 4: Apply the result

Take `best_description` from the JSON output and update the skill's SKILL.md frontmatter. Show the user before/after and report the scores.

---

### Validate, install, and package

Validate the completed writable candidate with the bundled validator:

```bash
python3 -m scripts.quick_validate <absolute-candidate-path>
```

Copy the skill directory (SKILL.md plus required scripts, references, and assets)
to the user-specified destination, or the global Pi skills path described above.
For updates, preserve the original name and avoid editing an npm-managed copy
in place. Tell the user the actual installation path and to start a new Pi
session or use `/reload`.

When the user wants a portable archive, package it from the workspace:

```bash
python3 -m scripts.package_skill <absolute-candidate-path> <workspace>/dist
```

The `.skill` file is a ZIP archive for sharing, **not** a `pi install` package.
To use it in Pi, extract its top-level skill directory into the chosen Pi skills
directory, then reload. Return the archive's real path without assuming a
`present_files` tool exists. Do not include evaluation workspaces, private inputs,
credentials, or unrelated generated output in the archive. Validate and review
the final contents before handing it over.

---

## Reference files

The agents/ directory contains instructions for specialized subagents. Read them when you need to spawn the relevant subagent.

- `agents/grader.md` — How to evaluate assertions against outputs
- `agents/comparator.md` — How to do blind A/B comparison between two outputs
- `agents/analyzer.md` — How to analyze why one version beat another

The references/ directory has additional documentation:
- `references/schemas.md` — JSON structures for evals.json, grading.json, etc.

---

Repeating one more time the core loop here for emphasis:

- Figure out what the skill is about
- Draft or edit the skill
- Run isolated Pi executions with the candidate and the appropriate baseline
- With the user, evaluate the outputs:
  - Create benchmark.json and run `eval-viewer/generate_review.py` to help the user review them
  - Run quantitative evals
- Repeat until you and the user are satisfied
- Package the final skill and return it to the user.

Keep the human review, quantitative benchmark, and description-trigger evaluation
distinct: they answer different questions. Preserve the upstream loop's real
executions and evidence rather than substituting self-assessment.
