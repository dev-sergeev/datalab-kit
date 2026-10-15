"""Shared utilities for skill-creator scripts.

Changed by Datalab Kit: parse Pi skill frontmatter as YAML, including quoted
and multiline descriptions. Upstream: anthropics/skills
dbd4588f9e1033efb41dad4bef2f7947c8993d44 (Apache-2.0).
"""

from pathlib import Path

import yaml



def parse_skill_md(skill_path: Path) -> tuple[str, str, str]:
    """Parse a SKILL.md file, returning (name, description, full_content)."""
    content = (skill_path / "SKILL.md").read_text()
    lines = content.split("\n")

    if lines[0].strip() != "---":
        raise ValueError("SKILL.md missing frontmatter (no opening ---)")

    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break

    if end_idx is None:
        raise ValueError("SKILL.md missing frontmatter (no closing ---)")

    frontmatter = yaml.safe_load("\n".join(lines[1:end_idx]))
    if not isinstance(frontmatter, dict):
        raise ValueError("SKILL.md frontmatter must be a YAML mapping")
    name = frontmatter.get("name", "")
    description = frontmatter.get("description", "")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("SKILL.md requires a non-empty string name")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("SKILL.md requires a non-empty string description")

    return name, description, content
