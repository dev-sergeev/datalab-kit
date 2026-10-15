# JSON Schemas

> Modified for Datalab Kit/Pi from Anthropic's skill-creator,
> revision `dbd4588f9e1033efb41dad4bef2f7947c8993d44`.
> Changes: Pi telemetry, writable workspace layout, and evaluation field guidance.
> See [Apache-2.0 license](../LICENSE.txt) and [source attribution](../SKILL.md).

## Contents

- [Workspace layout](#workspace-layout)
- [evals.json](#evalsjson)
- [eval_metadata.json](#eval_metadatajson)
- [history.json](#historyjson)
- [grading.json](#gradingjson)
- [metrics.json](#metricsjson)
- [timing.json](#timingjson)
- [benchmark.json](#benchmarkjson)
- [comparison.json](#comparisonjson)
- [analysis.json](#analysisjson)

## Workspace layout

Use a writable workspace outside the installed skill-creator package:

```text
<workspace>/
  candidate/<skill-name>/SKILL.md
  skill-snapshot/<skill-name>/SKILL.md
  iteration-1/
    eval-1-descriptive-name/
      eval_metadata.json
      with_skill/run-1/
        transcript.jsonl
        stderr.log
        timing.json
        grading.json
        outputs/
      without_skill/run-1/
        transcript.jsonl
        stderr.log
        timing.json
        grading.json
        outputs/
    benchmark.json
    benchmark.md
    feedback.json
```

Repeat under `run-2/`, `run-3/`, etc. for variance measurements; `run-1/` is
required even for a single run because aggregation searches `run-*` directories.
For an update, `without_skill` contains the old-skill snapshot execution; record
that baseline identity explicitly in metadata and benchmark notes. It does not
mean that the old-skill arm lacked a skill.

Examples below illustrate values, not telemetry that every Pi provider supplies.
Omit unavailable measurements; never substitute character counts for tokens or
zero for missing usage. Keep executor usage/time separate from grading and
orchestration. Use absolute paths in executor prompts; keep raw Pi JSONL for
auditing and derive metrics only from complete events.

This document defines the JSON schemas used by skill-creator.

---

## evals.json

Defines the evals for a skill. Located at `evals/evals.json` within the writable candidate skill, not the installed creator package.

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's example prompt",
      "expected_output": "Description of expected result",
      "files": ["evals/files/sample1.pdf"],
      "expectations": [
        "The output includes X",
        "The skill used script Y"
      ]
    }
  ]
}
```

**Fields:**
- `skill_name`: Name matching the skill's frontmatter
- `evals[].id`: Unique integer identifier
- `evals[].prompt`: The task to execute
- `evals[].expected_output`: Human-readable description of success
- `evals[].files`: Optional list of input file paths (relative to skill root)
- `evals[].expectations`: List of verifiable statements

The main workflow calls these statements "assertions". Store them as
`expectations` here and copy the strings into `assertions` in eval_metadata.json.

---

## eval_metadata.json

Located at `<workspace>/iteration-N/eval-ID-name/eval_metadata.json`.

```json
{
  "eval_id": 1,
  "eval_name": "table-extraction",
  "prompt": "Extract the line items from the supplied invoice into a CSV.",
  "assertions": ["Every invoice line item is present in the CSV"],
  "baseline": "original skill snapshot"
}
```

`eval_id`, `eval_name`, `prompt`, and `assertions` support the viewer and grading
workflow. `baseline` is optional human-readable context: use `"no skill"` for a
new skill or identify the snapshot used for an update. Keep this metadata outside
executor outputs so the executor cannot accidentally consume expected answers.

---

## history.json

Tracks version progression in Improve mode. Located at workspace root.

```json
{
  "started_at": "2026-01-15T10:30:00Z",
  "skill_name": "pdf",
  "current_best": "v2",
  "iterations": [
    {
      "version": "v0",
      "parent": null,
      "expectation_pass_rate": 0.65,
      "grading_result": "baseline",
      "is_current_best": false
    },
    {
      "version": "v1",
      "parent": "v0",
      "expectation_pass_rate": 0.75,
      "grading_result": "won",
      "is_current_best": false
    },
    {
      "version": "v2",
      "parent": "v1",
      "expectation_pass_rate": 0.85,
      "grading_result": "won",
      "is_current_best": true
    }
  ]
}
```

**Fields:**
- `started_at`: ISO timestamp of when improvement started
- `skill_name`: Name of the skill being improved
- `current_best`: Version identifier of the best performer
- `iterations[].version`: Version identifier (v0, v1, ...)
- `iterations[].parent`: Parent version this was derived from
- `iterations[].expectation_pass_rate`: Pass rate from grading
- `iterations[].grading_result`: "baseline", "won", "lost", or "tie"
- `iterations[].is_current_best`: Whether this is the current best version

---

## grading.json

Output from the grader agent. Located at `<run-dir>/grading.json`.

```json
{
  "expectations": [
    {
      "text": "The output includes the name 'John Smith'",
      "passed": true,
      "evidence": "Found in transcript Step 3: 'Extracted names: John Smith, Sarah Johnson'"
    },
    {
      "text": "The spreadsheet has a SUM formula in cell B10",
      "passed": false,
      "evidence": "No spreadsheet was created. The output was a text file."
    }
  ],
  "summary": {
    "passed": 2,
    "failed": 1,
    "total": 3,
    "pass_rate": 0.67
  },
  "execution_metrics": {
    "tool_calls": {
      "read": 5,
      "write": 2,
      "bash": 8
    },
    "total_tool_calls": 15,
    "total_steps": 6,
    "errors_encountered": 0,
    "output_chars": 12450,
    "transcript_chars": 3200
  },
  "timing": {
    "executor_duration_seconds": 165.0,
    "grader_duration_seconds": 26.0,
    "total_duration_seconds": 165.0
  },
  "claims": [
    {
      "claim": "The form has 12 fillable fields",
      "type": "factual",
      "verified": true,
      "evidence": "Counted 12 fields in field_info.json"
    }
  ],
  "user_notes_summary": {
    "uncertainties": ["Used 2023 data, may be stale"],
    "needs_review": [],
    "workarounds": ["Fell back to text overlay for non-fillable fields"]
  },
  "eval_feedback": {
    "suggestions": [
      {
        "assertion": "The output includes the name 'John Smith'",
        "reason": "A hallucinated document that mentions the name would also pass"
      }
    ],
    "overall": "Assertions check presence but not correctness."
  }
}
```

**Fields:**
- `expectations[]`: Graded expectations with evidence
- `summary`: Aggregate pass/fail counts
- `execution_metrics`: Optional recorded tool usage and output size (from executor's metrics.json or measured JSONL events); omit when unavailable
- `timing`: Optional measured executor wall time (from timing.json); do not include grader/orchestrator usage in benchmark time
- `claims`: Extracted and verified claims from the output
- `user_notes_summary`: Issues flagged by the executor
- `eval_feedback`: (optional) Improvement suggestions for the evals, only present when the grader identifies issues worth raising

---

## metrics.json

Output from the executor agent. Located at `<run-dir>/outputs/metrics.json`.

```json
{
  "tool_calls": {
    "read": 5,
    "write": 2,
    "bash": 8,
    "edit": 1,
    "find": 2,
    "grep": 0
  },
  "total_tool_calls": 18,
  "total_steps": 6,
  "files_created": ["filled_form.pdf", "field_values.json"],
  "errors_encountered": 0,
  "output_chars": 12450,
  "transcript_chars": 3200
}
```

**Fields:**
- `tool_calls`: Count per tool type
- `total_tool_calls`: Sum of all tool calls
- `total_steps`: Number of major execution steps
- `files_created`: List of output files created
- `errors_encountered`: Number of errors during execution
- `output_chars`: Total character count of output files
- `transcript_chars`: Character count of transcript

Pi emits `tool_execution_start`/`tool_execution_end` events with `toolName`,
`toolCallId`, and (on completion) `isError`. Count each executed call once.
`total_steps` is an optional workflow-level count, not a native Pi metric.
File sizes and created-file lists can be measured from the outputs; they are not
automatically emitted by Pi. Include only measurements actually collected.

---

## timing.json

Wall clock timing for a run. Located at `<run-dir>/timing.json`.

**How to capture:** Measure the fresh executor Pi process using a monotonic clock. For tokens, sum `message.usage.totalTokens` from completed assistant `message_end` events in that executor's JSONL, once per message. Preserve the JSONL so this can be audited or recovered. Do not use rounded subagent summaries or assume completion notifications contain numeric `total_tokens`/`duration_ms`. Pi subagent lifetime usage is a different accounting surface and can include orchestration; do not mix it into executor measurements.

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.332,
  "executor_start": "2026-01-15T10:30:00Z",
  "executor_end": "2026-01-15T10:30:23.332Z",
  "executor_duration_seconds": 23.332
}
```

`total_tokens` is optional when the provider supplies no usable token telemetry.
The start/end timestamps are optional context; elapsed durations should come
from a monotonic clock. If separately measuring grading, use explicitly named
grader fields, but keep `total_duration_seconds` as executor time for benchmark
compatibility. A provider-reported zero is not the same as missing telemetry.

---

## benchmark.json

Output from benchmark aggregation. Located at `<workspace>/iteration-N/benchmark.json` (or the explicitly selected benchmark directory).

```json
{
  "metadata": {
    "skill_name": "pdf",
    "skill_path": "/path/to/pdf",
    "executor_model": "provider/model-id",
    "analyzer_model": "most-capable-model",
    "timestamp": "2026-01-15T10:30:00Z",
    "evals_run": [1, 2, 3],
    "runs_per_configuration": 3
  },

  "runs": [
    {
      "eval_id": 1,
      "eval_name": "Ocean",
      "configuration": "with_skill",
      "run_number": 1,
      "result": {
        "pass_rate": 0.85,
        "passed": 6,
        "failed": 1,
        "total": 7,
        "time_seconds": 42.5,
        "tokens": 3800,
        "tool_calls": 18,
        "errors": 0
      },
      "expectations": [
        {"text": "...", "passed": true, "evidence": "..."}
      ],
      "notes": [
        "Used 2023 data, may be stale",
        "Fell back to text overlay for non-fillable fields"
      ]
    }
  ],

  "run_summary": {
    "with_skill": {
      "pass_rate": {"mean": 0.85, "stddev": 0.05, "min": 0.80, "max": 0.90},
      "time_seconds": {"mean": 45.0, "stddev": 12.0, "min": 32.0, "max": 58.0},
      "tokens": {"mean": 3800, "stddev": 400, "min": 3200, "max": 4100}
    },
    "without_skill": {
      "pass_rate": {"mean": 0.35, "stddev": 0.08, "min": 0.28, "max": 0.45},
      "time_seconds": {"mean": 32.0, "stddev": 8.0, "min": 24.0, "max": 42.0},
      "tokens": {"mean": 2100, "stddev": 300, "min": 1800, "max": 2500}
    },
    "delta": {
      "pass_rate": "+0.50",
      "time_seconds": "+13.0",
      "tokens": "+1700"
    }
  },

  "notes": [
    "Assertion 'Output is a PDF file' passes 100% in both configurations - may not differentiate skill value",
    "Eval 3 shows high variance (50% ± 40%) - may be flaky or model-dependent",
    "Without-skill runs consistently fail on table extraction expectations",
    "Skill adds 13s average execution time but improves pass rate by 50%"
  ]
}
```

**Fields:**
- `metadata`: Information about the benchmark run
  - `skill_name`: Name of the skill
  - `timestamp`: When the benchmark was run
  - `evals_run`: List of eval names or IDs
  - `runs_per_configuration`: Observed repetitions per evaluation/configuration pair; null when counts differ or are unavailable. Per-run records remain authoritative.
- `runs[]`: Individual run results
  - `eval_id`: Numeric eval identifier
  - `eval_name`: Human-readable eval name (used as section header in the viewer)
  - `configuration`: Use `"with_skill"` or `"without_skill"` for the documented comparison workflow (the viewer uses these names for grouping and color coding). An old-skill baseline still uses `"without_skill"` with its real identity explained in notes.
  - `run_number`: Integer run number (1, 2, 3...)
  - `result`: Nested object with graded `pass_rate`, `passed`, `total`; `time_seconds`, `tokens`, tool counts, and errors are measured numbers or `null` when unavailable
- `run_summary`: Statistical aggregates per configuration
  - `with_skill` / `without_skill`: Each contains metric objects with `mean`, `stddev`, `min`, and `max`; absent measurements produce null statistic values, not zero usage
  - `delta`: Difference strings like `"+0.50"`, `"+13.0"`, `"+1700"`, or `null` when unavailable
- `notes`: Freeform observations from the analyzer

**Important:** The viewer reads these field names exactly. Using `config` instead of `configuration`, or putting `pass_rate` at the top level of a run instead of nested under `result`, will cause the viewer to show empty/zero values. Always reference this schema when generating benchmark.json manually.

---

## comparison.json

Output from blind comparator. Located at `<grading-dir>/comparison-N.json`.

```json
{
  "winner": "A",
  "reasoning": "Output A provides a complete solution with proper formatting and all required fields. Output B is missing the date field and has formatting inconsistencies.",
  "rubric": {
    "A": {
      "content": {
        "correctness": 5,
        "completeness": 5,
        "accuracy": 4
      },
      "structure": {
        "organization": 4,
        "formatting": 5,
        "usability": 4
      },
      "content_score": 4.7,
      "structure_score": 4.3,
      "overall_score": 9.0
    },
    "B": {
      "content": {
        "correctness": 3,
        "completeness": 2,
        "accuracy": 3
      },
      "structure": {
        "organization": 3,
        "formatting": 2,
        "usability": 3
      },
      "content_score": 2.7,
      "structure_score": 2.7,
      "overall_score": 5.4
    }
  },
  "output_quality": {
    "A": {
      "score": 9,
      "strengths": ["Complete solution", "Well-formatted", "All fields present"],
      "weaknesses": ["Minor style inconsistency in header"]
    },
    "B": {
      "score": 5,
      "strengths": ["Readable output", "Correct basic structure"],
      "weaknesses": ["Missing date field", "Formatting inconsistencies", "Partial data extraction"]
    }
  },
  "expectation_results": {
    "A": {
      "passed": 4,
      "total": 5,
      "pass_rate": 0.80,
      "details": [
        {"text": "Output includes name", "passed": true}
      ]
    },
    "B": {
      "passed": 3,
      "total": 5,
      "pass_rate": 0.60,
      "details": [
        {"text": "Output includes name", "passed": true}
      ]
    }
  }
}
```

---

## analysis.json

Output from post-hoc analyzer. Located at `<grading-dir>/analysis.json`.

```json
{
  "comparison_summary": {
    "winner": "A",
    "winner_skill": "path/to/winner/skill",
    "loser_skill": "path/to/loser/skill",
    "comparator_reasoning": "Brief summary of why comparator chose winner"
  },
  "winner_strengths": [
    "Clear step-by-step instructions for handling multi-page documents",
    "Included validation script that caught formatting errors"
  ],
  "loser_weaknesses": [
    "Vague instruction 'process the document appropriately' led to inconsistent behavior",
    "No script for validation, agent had to improvise"
  ],
  "instruction_following": {
    "winner": {
      "score": 9,
      "issues": ["Minor: skipped optional logging step"]
    },
    "loser": {
      "score": 6,
      "issues": [
        "Did not use the skill's formatting template",
        "Invented own approach instead of following step 3"
      ]
    }
  },
  "improvement_suggestions": [
    {
      "priority": "high",
      "category": "instructions",
      "suggestion": "Replace 'process the document appropriately' with explicit steps",
      "expected_impact": "Would eliminate ambiguity that caused inconsistent behavior"
    }
  ],
  "transcript_insights": {
    "winner_execution_pattern": "Read skill -> Followed 5-step process -> Used validation script",
    "loser_execution_pattern": "Read skill -> Unclear on approach -> Tried 3 different methods"
  }
}
```
