// Data fetching for the issue board plugin.
//
// Two data sources:
// 1. Project board (#57) — active initiatives from 2i2c-org/initiatives
// 2. GitHub search — completed "type:platform" issues from across the org
//
// Results are cached to _build/cache/issue-board.json so GitHub API calls
// only happen once per build. Delete the cache file to force a refetch.

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const CACHE_PATH = "_build/cache/issue-board.json";

function ghGraphQL(query) {
  const result = execSync(`gh api graphql -f query='${query}'`, {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(result).data;
}

// Shared fields for both queries
const ISSUE_FRAGMENT = `
  title url body updatedAt closedAt stateReason
  repository { nameWithOwner }
  labels(first: 10) { nodes { name } }
  subIssues(first: 20) { nodes { title state url updatedAt } }
`;

// Active initiatives from the "Product and Services" project board
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

// Historical completed initiatives found by label search across the org
function fetchCompletedItems(cursor) {
  const after = cursor ? `, after: "${cursor}"` : "";
  const query = `{
    search(query: "org:2i2c-org label:\\"type:platform\\" is:closed", type: ISSUE, first: 50${after}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue { ${ISSUE_FRAGMENT} }
      }
    }
  }`;
  return ghGraphQL(query).search;
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
    title: node.title.replace(/^\[.*?\]\s*/g, "").trim(), // Strip "[Platform Initiative]" prefixes
    url: node.url,
    status,
    stateReason: node.stateReason || "",
    labels: (node.labels?.nodes || []).map((l) => l.name),
    body: node.body,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
    subIssues: node.subIssues?.nodes || [],
  };
}

export function fetchData() {
  if (existsSync(CACHE_PATH)) {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  }

  console.log("issue-board: fetching from GitHub...");

  // Project board items (initiatives repo only)
  const items = paginate(fetchProjectItems)
    .filter((node) => node.content?.repository?.nameWithOwner === "2i2c-org/initiatives")
    .map((node) => normalizeItem(node.content, node.fieldValueByName?.name || ""));

  // Completed items from across the org, deduplicated against project board
  const existingUrls = new Set(items.map((i) => i.url));
  for (const node of paginate(fetchCompletedItems)) {
    if (node.stateReason !== "COMPLETED" || existingUrls.has(node.url)) continue;
    items.push(normalizeItem(node, "Done"));
    existingUrls.add(node.url);
  }

  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(items, null, 2));
  return items;
}
