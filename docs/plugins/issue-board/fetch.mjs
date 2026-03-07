// Data fetching for the issue board plugin.
//
// Fetches items from the 2i2c "Product and Services" project board.
// Items are included if they're:
// - From the /initiatives repo OR
// - Have a "type:platform" label (these are how we used to label initiatives)
//
// Results are cached to _build/cache/issue-board.json so GitHub API calls
// only happen once per build. Delete the cache file to force a refetch.

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const CACHE_PATH = "_build/cache/issue-board.json";

function ghGraphQL(query) {
  const result = execSync(`gh api graphql -f query='${query}'`, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(result).data;
}

const ISSUE_FRAGMENT = `
  title url body updatedAt closedAt stateReason
  repository { nameWithOwner }
  labels(first: 10) { nodes { name } }
  subIssues(first: 20) { nodes { title state url updatedAt } }
`;

function fetchProjectItems(cursor) {
  const after = cursor ? `, after: "${cursor}"` : "";
  const query = `{
    organization(login: "2i2c-org") {
      projectV2(number: 57) {
        items(first: 100${after}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
            content {
              ... on Issue { ${ISSUE_FRAGMENT} }
            }
          }
        }
      }
    }
  }`;
  return ghGraphQL(query).organization.projectV2.items;
}

function paginate(fetchFn) {
  const allNodes = [];
  let cursor = null;
  do {
    const page = fetchFn(cursor);
    allNodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return allNodes;
}

// Flatten GitHub's nested GraphQL response into a simple object
function normalizeItem(node, status) {
  return {
    title: node.title.replace(/^\[.*?\]\s*/g, "").trim(),
    url: node.url,
    status,
    stateReason: node.stateReason || "",
    labels: (node.labels?.nodes || []).map((l) => l.name),
    body: node.body,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
    subIssues: (node.subIssues?.nodes || []).filter(Boolean),
  };
}

// Memoized so multiple {issue-board} directives don't re-read the cache
let cachedItems = null;

export function fetchData() {
  if (cachedItems) return cachedItems;

  try {
    cachedItems = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    return cachedItems;
  } catch {
    // No cache — fetch from GitHub
  }

  console.log("issue-board: fetching from GitHub...");

  // Normalize first, then filter to initiatives repo or type:platform label
  const allItems = paginate(fetchProjectItems)
    .filter((node) => node.content?.title)
    .map((node) => normalizeItem(node.content, node.fieldValueByName?.name || ""));

  cachedItems = allItems.filter((item) =>
    item.url.includes("2i2c-org/initiatives") || item.labels.includes("type:platform")
  );

  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cachedItems, null, 2));
  return cachedItems;
}
