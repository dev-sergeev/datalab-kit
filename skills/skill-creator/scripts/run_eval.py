#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes Pi to trigger (read the skill)
for a set of queries. Outputs results as JSON.

Changed by Datalab Kit: isolated Pi JSON CLI backend, error propagation and
cancellation cleanup. Upstream: anthropics/skills
dbd4588f9e1033efb41dad4bef2f7947c8993d44 (Apache-2.0).
"""

import argparse
import json
import sys
import threading
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import yaml

from scripts.pi_runtime import interrupt_on_termination, run_pi

from scripts.utils import parse_skill_md


def find_project_root() -> Path:
    """Use the caller's workspace; no host-specific discovery files are written."""
    return Path.cwd()


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    model: str | None = None,
    cancel: threading.Event | None = None,
) -> bool:
    """Evaluate natural skill selection in a fresh, isolated Pi session.

    Only the candidate description is advertised, not the creator or any other
    installed skills. The read-only tool allowlist prevents evaluation queries
    from modifying the caller's workspace. A read of this exact SKILL.md is
    the trigger signal; narration and reads of unrelated files do not count.
    """
    with tempfile.TemporaryDirectory(prefix="pi-skill-trigger-") as workdir:
        root = Path(workdir)
        candidate = root / "SKILL.md"
        frontmatter = yaml.safe_dump(
            {"name": skill_name, "description": skill_description},
            sort_keys=False, allow_unicode=True,
        )
        candidate.write_text(
            f"---\n{frontmatter}---\n\n# {skill_name}\n\n"
            "This is a description-trigger evaluation. The skill has been loaded.\n",
            encoding="utf-8",
        )
        triggered = False

        def detect_trigger(event):
            nonlocal triggered
            if event.get("type") != "tool_execution_start" or event.get("toolName") != "read":
                return False
            path = event.get("args", {}).get("path")
            if not isinstance(path, str):
                return False
            requested = Path(path).expanduser()
            if not requested.is_absolute():
                requested = root / requested
            triggered = requested.resolve() == candidate.resolve()
            return triggered

        run_pi(
            query, model, timeout, root,
            ["--skill", str(candidate), "--tools", "read"],
            on_event=detect_trigger, cancel=cancel,
        )
        return triggered


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
) -> dict:
    """Run the full eval set and return results."""
    results = []

    cancel = threading.Event()
    executor = ThreadPoolExecutor(max_workers=num_workers)
    try:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    timeout,
                    str(project_root),
                    model,
                    cancel,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as error:
                raise RuntimeError(f"Trigger evaluation failed for {query!r}: {error}") from error
    finally:
        cancel.set()
        executor.shutdown(wait=True, cancel_futures=True)

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Pi model provider/id[:thinking] (default: configured model)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = find_project_root()

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    with interrupt_on_termination():
        main()
