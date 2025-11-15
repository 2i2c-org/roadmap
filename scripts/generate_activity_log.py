#!/usr/bin/env python3
"""Generate an activity log table showing initiatives and sub-issues by recency."""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple, Any
from urllib.parse import urlparse

from sync_roadmap import fetch_issue_details


FRONTMATTER_PATTERN = re.compile(r"^([^:]+):\s*(.*)$")


def parse_frontmatter(path: Path) -> Dict[str, str]:
    """Return a small dict of frontmatter values we care about."""
    data: Dict[str, str] = {}
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return data
    parts = text.split("---", 2)
    if len(parts) < 3:
        return data
    body = parts[1].strip().splitlines()
    for line in body:
        match = FRONTMATTER_PATTERN.match(line.strip())
        if not match:
            continue
        key, value = match.groups()
        if value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        data[key.strip()] = value.strip()
    return data


def parse_issue_url(issue_url: str) -> Tuple[str, str]:
    """Extract the repo slug (owner/repo) and issue number from a GitHub issue URL."""
    parsed = urlparse(issue_url)
    segments = [seg for seg in parsed.path.strip("/").split("/") if seg]
    if len(segments) < 4:
        raise ValueError(f"Unrecognized issue URL: {issue_url}")
    owner, repo, _, number = segments[:4]
    return f"{owner}/{repo}", number


def parse_timestamp(value: str) -> datetime:
    """Convert an ISO timestamp to datetime, falling back to minimal value."""
    if not value:
        return datetime.min
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min


def format_timestamp(value: str) -> str:
    dt = parse_timestamp(value)
    if dt == datetime.min:
        return ""
    return dt.strftime("%Y-%m-%d %H:%M UTC")


def collect_initiatives(initiative_dir: Path) -> List[Dict[str, Any]]:
    """Load initiative metadata from synced markdown files."""
    initiatives = []
    for path in sorted(initiative_dir.glob("*.md")):
        meta = parse_frontmatter(path)
        issue_url = meta.get("issue_url")
        if not issue_url:
            continue
        repo_slug, issue_number = parse_issue_url(issue_url)
        details = fetch_issue_details(repo_slug, issue_number)
        if not details:
            continue
        initiatives.append(
            {
                "title": meta.get("title", details.get("title", "")),
                "status": meta.get("status", ""),
                "issue_url": issue_url,
                "repo": repo_slug,
                "issue_number": issue_number,
                "local_link": f"initiative/{path.name}",
                "updated_at": details.get("updated_at", ""),
                "state": details.get("state", ""),
                "tracked_issues": details.get("tracked_issues", []),
            }
        )
    return initiatives


def generate_activity_table(initiatives: List[Dict[str, Any]], output_path: Path) -> None:
    """Write a markdown table sorted by latest activity."""
    def is_in_progress(status: str) -> bool:
        if not status:
            return False
        status_lower = status.lower()
        return "in flight" in status_lower or "in progress" in status_lower

    groups = []
    for initiative in initiatives:
        if not is_in_progress(initiative.get("status", "")):
            continue
        sub_entries = []
        for tracked in initiative.get("tracked_issues", []):
            issue_url = tracked.get("issue_url") or tracked.get("url", "")
            repo_slug = tracked.get("repository", "") or initiative["repo"]
            sub_entries.append(
                {
                    "title": tracked.get("title", ""),
                    "issue_url": issue_url,
                    "repo": repo_slug,
                    "issue_number": tracked.get("number"),
                    "state": tracked.get("state", ""),
                    "updated_at": tracked.get("updated_at", ""),
                    "type": tracked.get("type", "issue"),
                }
            )
        sub_entries.sort(
            key=lambda s: parse_timestamp(s.get("updated_at", "")), reverse=True
        )
        latest = parse_timestamp(initiative.get("updated_at", ""))
        if sub_entries:
            latest = max(
                [latest] + [parse_timestamp(s.get("updated_at", "")) for s in sub_entries]
            )
        groups.append(
            {
                "latest": latest,
                "initiative": initiative,
                "sub_entries": sub_entries,
            }
        )

    groups.sort(key=lambda g: g["latest"], reverse=True)

    def cleanup(text: str) -> str:
        if not isinstance(text, str):
            return text
        return (
            text.replace("|", "/")
            .replace("_", r"\_")
            .replace("[", r"\[")
            .replace("]", r"\]")
        )

    lines = [
        "| Last updated | Type | Item | Parent Initiative | State | Issue |",
        "|--------------|------|------|-------------------|-------|-------|",
    ]

    for group in groups:
        initiative = group["initiative"]
        parent_updated = initiative.get("updated_at", "")
        lines.append(
            "| {updated} | Initiative | [{title}]({link}) | — | {state} | [{issue}]({url}) |".format(
                updated=format_timestamp(parent_updated),
                title=cleanup(initiative["title"]),
                link=initiative["local_link"],
                state=cleanup(initiative.get("state", "").title()),
                issue=f"{initiative['repo']}#{initiative['issue_number']}",
                url=initiative["issue_url"],
            )
        )
        for sub in group["sub_entries"]:
            title_text = cleanup(sub.get("title", ""))
            issue_url = sub.get("issue_url", "")
            number = sub.get("issue_number")
            item_display = (
                f"[#{number} – {title_text}]({issue_url})"
                if number and issue_url
                else f"[{title_text}]({issue_url})"
            )
            entry_type = (
                "Pull request" if sub.get("type") == "pull_request" else "Sub-issue"
            )
            lines.append(
                "| {updated} | {etype} | {item} | [{parent}]({plink}) | {state} | [{issue}]({url}) |".format(
                    updated=format_timestamp(sub.get("updated_at", "")),
                    etype=entry_type,
                    item=item_display,
                    parent=cleanup(initiative["title"]),
                    plink=initiative["local_link"],
                    state=cleanup(sub.get("state", "").title()),
                    issue=f"{sub.get('repo')}#{number}",
                    url=issue_url,
                )
            )

    output_path.write_text("\n".join(lines), encoding="utf-8")


def main():
    repo_root = Path(__file__).parent.parent
    initiative_dir = repo_root / "docs" / "initiative"
    output_file = repo_root / "docs" / "data" / "activity-log.md"
    output_file.parent.mkdir(parents=True, exist_ok=True)

    initiatives = collect_initiatives(initiative_dir)
    if not initiatives:
        print("No initiatives found. Did you run scripts/sync_roadmap.py?")
        return
    generate_activity_table(initiatives, output_file)
    print(f"Wrote activity log with {len(initiatives)} initiatives to {output_file}")


if __name__ == "__main__":
    main()
