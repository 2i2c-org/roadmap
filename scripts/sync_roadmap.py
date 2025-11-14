#!/usr/bin/env python3
"""Sync roadmap from GitHub Project Board to Markdown files."""
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any
from jinja2 import Environment, FileSystemLoader
from tqdm import tqdm


def sanitize_title(title: str) -> str:
    """Sanitize title for use as filename.

    Args:
        title: Issue title

    Returns:
        Sanitized filename (lowercase, alphanumeric + hyphens)
    """
    # Convert to lowercase
    filename = title.lower()

    # Replace spaces and special chars with hyphens
    filename = re.sub(r'[^a-z0-9]+', '-', filename)

    # Remove leading/trailing hyphens
    filename = filename.strip('-')

    # Collapse multiple hyphens
    filename = re.sub(r'-+', '-', filename)

    return filename


def check_gh_cli():
    """Verify gh CLI is installed and authenticated."""
    try:
        result = subprocess.run(
            ["gh", "auth", "status"],
            capture_output=True,
            text=True,
            check=False
        )
        if result.returncode != 0:
            print("Error: gh CLI not authenticated", file=sys.stderr)
            print("Run: gh auth login", file=sys.stderr)
            sys.exit(1)
    except FileNotFoundError:
        print("Error: gh CLI not found", file=sys.stderr)
        print("Install from: https://cli.github.com/", file=sys.stderr)
        sys.exit(1)


def fetch_project_items(project_number: str) -> List[Dict[str, Any]]:
    """Fetch items from GitHub project board using minimal GraphQL query.

    Args:
        project_number: GitHub project number (e.g., "57")

    Returns:
        List of project items with just issue number, repo, and status
    """
    # Minimal GraphQL query - only fetch what we need
    query = """
    query($org: String!, $number: Int!, $after: String) {
      organization(login: $org) {
        projectV2(number: $number) {
          items(first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              isArchived
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                }
              }
              content {
                ... on Issue {
                  number
                  title
                  repository {
                    nameWithOwner
                  }
                }
              }
            }
          }
        }
      }
    }
    """

    try:
        variables = {
            "org": "2i2c-org",
            "number": int(project_number),
            "after": None
        }

        all_items = []
        has_next = True

        while has_next:
            result = subprocess.run(
                ["gh", "api", "graphql",
                 "-f", f"query={query}",
                 "-F", f"org={variables['org']}",
                 "-F", f"number={variables['number']}",
                 "-f", f"after={variables['after'] or ''}"],
                capture_output=True,
                text=True,
                check=False
            )

            if result.returncode != 0:
                print(f"Error fetching project items (exit code {result.returncode})", file=sys.stderr)
                print(f"Stderr: {result.stderr}", file=sys.stderr)
                return []

            data = json.loads(result.stdout)
            project_data = data.get("data", {}).get("organization", {}).get("projectV2", {})
            items_data = project_data.get("items", {})

            # Parse items
            for node in items_data.get("nodes", []):
                # Skip archived items
                if node.get("isArchived", False):
                    continue

                # Skip if not an issue
                content = node.get("content")
                if not content or "number" not in content:
                    continue

                # Get status
                status_field = node.get("fieldValueByName")
                status = status_field.get("name", "") if status_field else ""

                all_items.append({
                    "status": status,
                    "title": content.get("title", ""),
                    "content": {
                        "number": content["number"],
                        "repository": content["repository"]["nameWithOwner"]
                    }
                })

            # Check pagination
            page_info = items_data.get("pageInfo", {})
            has_next = page_info.get("hasNextPage", False)
            variables["after"] = page_info.get("endCursor")

        return all_items

    except json.JSONDecodeError as e:
        print(f"Error parsing JSON response: {e}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"Error fetching project items: {e}", file=sys.stderr)
        return []


ROADMAP_COLUMNS = [
    "Upcoming P&S initiatives",
    "P&S Initiatives in flight",
    "Done",
]


def filter_by_status(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Filter for items in roadmap columns.

    Args:
        items: List of project items

    Returns:
        Filtered list containing only items in roadmap columns
    """
    filtered = []

    for item in items:
        # Check if in roadmap column
        status = item.get("status", "")
        if status in ROADMAP_COLUMNS:
            filtered.append(item)

    return filtered


def is_platform_initiative(title: str, labels: List[str]) -> bool:
    """Check if this is a platform initiative.

    Checks both the title and labels for platform initiative markers.

    Args:
        title: Issue title
        labels: List of label names

    Returns:
        True if platform initiative marker found
    """
    # Check title for "platform initiative" marker only
    title_lower = title.lower()
    if "platform" in title_lower and "initiative" in title_lower:
        return True

    # Also check labels as fallback
    for label in labels:
        normalized = label.lower().strip()
        if "platform" in normalized and "initiative" in normalized:
            return True

    return False


def clean_title_for_display(title: str) -> str:
    """Remove metadata in brackets/parentheses from title for display.

    Args:
        title: Original issue title

    Returns:
        Cleaned title without bracketed/parenthesized metadata
    """
    # Remove content in brackets and parentheses
    cleaned = re.sub(r'\[.*?\]', '', title)
    cleaned = re.sub(r'\(.*?\)', '', cleaned)

    # Clean up extra whitespace
    cleaned = re.sub(r'\s+', ' ', cleaned)
    cleaned = cleaned.strip()

    return cleaned if cleaned else title  # Fallback to original if everything was removed


def fetch_sub_issues(issue_number: int, repo: str) -> List[Dict[str, Any]]:
    """Fetch sub-issues for a parent issue using GitHub REST API.

    Args:
        issue_number: The parent issue number
        repo: Repository in format "owner/repo"

    Returns:
        List of sub-issue dicts with keys: number, title, html_url, state
    """
    try:
        # GitHub REST API endpoint for sub-issues
        result = subprocess.run(
            ["gh", "api", f"/repos/{repo}/issues/{issue_number}/sub_issues"],
            capture_output=True,
            text=True,
            check=True
        )
        sub_issues_data = json.loads(result.stdout)

        # Extract relevant fields
        sub_issues = []
        for sub in sub_issues_data:
            sub_issues.append({
                "number": sub["number"],
                "title": sub["title"],
                "html_url": sub["html_url"],
                "state": sub["state"]
            })

        return sub_issues

    except subprocess.CalledProcessError:
        # API might return 404 if no sub-issues or endpoint not available
        # Treat as no sub-issues (this is normal)
        return []
    except json.JSONDecodeError as e:
        print(f"  Warning: Error parsing sub-issues JSON for {issue_number}: {e}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"  Warning: Error fetching sub-issues for {issue_number}: {e}", file=sys.stderr)
        return []


def fetch_issue_details(repo: str, issue_number: str) -> Dict[str, Any]:
    """Fetch full details for a GitHub issue.

    Args:
        repo: Repository in format "owner/repo"
        issue_number: Issue number

    Returns:
        Dict with issue details (title, body, url, labels, etc.)
    """
    try:
        result = subprocess.run(
            ["gh", "issue", "view", issue_number,
             "--repo", repo,
             "--json", "title,body,url,labels,updatedAt,closedAt"],
            capture_output=True,
            text=True,
            check=True
        )

        data = json.loads(result.stdout)

        # Extract label names
        labels = [label["name"] for label in data.get("labels", [])]

        # Fetch sub-issues for this issue
        sub_issues = fetch_sub_issues(int(issue_number), repo)

        return {
            "title": data.get("title", ""),
            "body": data.get("body", ""),
            "url": data.get("url", ""),
            "labels": labels,
            "updated_at": data.get("updatedAt", ""),
            "closed_at": data.get("closedAt", ""),
            "sub_issues": sub_issues,
        }

    except subprocess.CalledProcessError as e:
        print(f"Error fetching issue {issue_number}: {e}", file=sys.stderr)
        return {}
    except json.JSONDecodeError as e:
        print(f"Error parsing issue JSON: {e}", file=sys.stderr)
        return {}


def get_short_description(body: str, max_words: int = 150) -> str:
    """Extract short description from issue body.

    Args:
        body: Full issue body
        max_words: Maximum words to include

    Returns:
        Short description (first paragraph or up to max_words)
    """
    if not body:
        return "No description available."

    # Split into paragraphs
    paragraphs = body.split('\n\n')

    # Find first paragraph that isn't a header
    first_para = ""
    for para in paragraphs:
        para = para.strip()
        # Skip if it's a markdown header (starts with #)
        if not para.startswith('#'):
            first_para = para
            break

    if not first_para:
        return "No description available."

    # Limit to max_words
    words = first_para.split()
    if len(words) > max_words:
        return ' '.join(words[:max_words]) + '...'

    return first_para


def generate_initiative_page(initiative: Dict[str, Any], output_dir: Path):
    """Generate Markdown page for an initiative.

    Args:
        initiative: Initiative data dict
        output_dir: Directory to write file to
    """
    # Set up Jinja2 environment
    template_dir = Path(__file__).parent / "templates"
    env = Environment(loader=FileSystemLoader(template_dir))
    template = env.get_template("initiative.md.j2")

    # Render template
    content = template.render(**initiative)

    # Write file
    output_file = output_dir / f"{initiative['filename']}.md"
    output_file.write_text(content)


def generate_roadmap_table(data: Dict[str, Any], output_dir: Path):
    """Generate markdown table file with roadmap data for index page.

    Args:
        data: Dict with in_flight and upcoming initiatives
        output_dir: Directory to write file to
    """
    data_dir = output_dir / "data"
    data_dir.mkdir(exist_ok=True)
    output_file = data_dir / "roadmap-table.md"

    lines = []
    lines.append("| Status | Title | Description | Issue | Labels |")
    lines.append("|--------|-------|-------------|-------|--------|")

    # Write in-flight initiatives (in order from project board)
    for item in data.get('in_flight', []):
        labels = ', '.join(f"`{label}`" for label in item['labels'])
        lines.append(
            f"| 🚀 In Flight | [{item['title']}](initiative/{item['filename']}.md) | "
            f"{item['short_description']} | [#{item['issue_number']}]({item['issue_url']}) | {labels} |"
        )

    # Write upcoming initiatives (in order from project board)
    for item in data.get('upcoming', []):
        labels = ', '.join(f"`{label}`" for label in item['labels'])
        lines.append(
            f"| 📋 Upcoming | [{item['title']}](initiative/{item['filename']}.md) | "
            f"{item['short_description']} | [#{item['issue_number']}]({item['issue_url']}) | {labels} |"
        )

    output_file.write_text('\n'.join(lines))


def generate_completed_table(data: Dict[str, Any], output_dir: Path):
    """Generate markdown table file with completed initiatives.

    Args:
        data: Dict with done initiatives
        output_dir: Directory to write file to
    """
    data_dir = output_dir / "data"
    data_dir.mkdir(exist_ok=True)
    output_file = data_dir / "completed-table.md"

    lines = []
    lines.append("| Completed | Title | Description | Issue | Labels |")
    lines.append("|-----------|-------|-------------|-------|--------|")

    # Write completed initiatives (sorted by closed date, recent first)
    for item in data.get('done', []):
        labels = ', '.join(f"`{label}`" for label in item['labels'])
        # Format closed date if available
        closed_date = ""
        if item.get('closed_at'):
            try:
                dt = datetime.fromisoformat(item['closed_at'].replace('Z', '+00:00'))
                closed_date = dt.strftime('%Y-%m-%d')
            except:
                closed_date = ""

        lines.append(
            f"| ✅ {closed_date} | [{item['title']}](initiative/{item['filename']}.md) | "
            f"{item['short_description']} | [#{item['issue_number']}]({item['issue_url']}) | {labels} |"
        )

    output_file.write_text('\n'.join(lines))


def sync_roadmap():
    """Main function to sync roadmap from GitHub to Markdown files."""
    print("Starting roadmap sync...")

    # Check gh CLI
    check_gh_cli()

    # Fetch project items
    print("Fetching project board items...")
    project_number = "57"  # 2i2c P&S project
    items = fetch_project_items(project_number)
    print(f"Found {len(items)} total items")

    # Filter by status first (roadmap columns only)
    print("Filtering by roadmap status...")
    roadmap_items = filter_by_status(items)
    print(f"Found {len(roadmap_items)} items in roadmap columns")

    # Filter by title first (before making REST API calls)
    print("Pre-filtering by title for platform initiatives...")
    title_filtered = []
    for item in roadmap_items:
        # Check title for "platform initiative" marker
        if is_platform_initiative(item.get("title", ""), []):
            title_filtered.append(item)

    print(f"Found {len(title_filtered)} items with 'platform initiative' in title")

    # Fetch full details only for title-filtered items
    print("Fetching issue details for filtered items...")
    detailed_initiatives = []

    for item in tqdm(title_filtered, desc="Fetching issues", unit="issue"):
        # Extract repo and issue number from content
        content = item.get("content", {})
        repo = content.get("repository", "2i2c-org/infrastructure")
        issue_number = content.get("number", "")

        # Parse repo if it's in "owner/repo" format
        if "/" in str(repo):
            repo = repo
        else:
            repo = "2i2c-org/infrastructure"

        if not issue_number:
            print(f"Skipping item without issue number: {item.get('title')}")
            continue

        # Fetch details (includes labels)
        details = fetch_issue_details(repo, str(issue_number))
        if not details:
            continue

        # Check for platform initiative marker (in title or labels)
        if not is_platform_initiative(details["title"], details.get("labels", [])):
            continue

        # Combine with status info
        original_title = details["title"]
        cleaned_title = clean_title_for_display(original_title)
        details["status"] = item["status"]
        details["title"] = cleaned_title  # Clean for display
        details["filename"] = sanitize_title(cleaned_title)  # Use cleaned title for filename
        details["issue_number"] = issue_number
        details["issue_url"] = details.get("url", "")
        details["short_description"] = get_short_description(details["body"])

        detailed_initiatives.append(details)

    print(f"Found {len(detailed_initiatives)} platform initiatives")

    # Organize by status (preserving order from project board)
    in_flight = [i for i in detailed_initiatives
                 if i["status"] == "P&S Initiatives in flight"]
    upcoming = [i for i in detailed_initiatives
                if i["status"] == "Upcoming P&S initiatives"]
    done = [i for i in detailed_initiatives
            if i["status"] == "Done"]

    # Sort completed by closed date (recent first)
    done.sort(key=lambda x: x.get("closed_at", ""), reverse=True)

    # Set up output directories
    docs_dir = Path(__file__).parent.parent / "docs"
    initiative_dir = docs_dir / "initiative"
    initiative_dir.mkdir(parents=True, exist_ok=True)

    # Generate initiative pages
    print(f"Generating {len(detailed_initiatives)} initiative pages...")
    for initiative in detailed_initiatives:
        generate_initiative_page(initiative, initiative_dir)

    # Generate roadmap table (active initiatives only)
    print("Generating roadmap table...")
    table_data = {
        "in_flight": in_flight,
        "upcoming": upcoming,
    }
    generate_roadmap_table(table_data, docs_dir)

    # Generate completed table (separate file)
    print("Generating completed initiatives table...")
    completed_data = {
        "done": done,
    }
    generate_completed_table(completed_data, docs_dir)

    print("Sync complete!")
    print(f"  - {len(in_flight)} initiatives in flight")
    print(f"  - {len(upcoming)} upcoming initiatives")
    print(f"  - {len(done)} completed initiatives")


if __name__ == "__main__":
    sync_roadmap()
