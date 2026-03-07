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

export function fetchData() {
  if (existsSync(CACHE_PATH)) {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  }

  console.log("issue-board: fetching from GitHub...");

  // Include items from initiatives repo OR with type:platform label
  const allNodes = paginate(fetchProjectItems).filter((node) => node.content?.title);
  const items = allNodes
    .filter((node) => {
      const labels = (node.content.labels?.nodes || []).map((l) => l.name);
      const isInitiativesRepo = node.content.repository?.nameWithOwner === "2i2c-org/initiatives";
      const hasPlatformLabel = labels.includes("type:platform");
      return isInitiativesRepo || hasPlatformLabel;
    })
    .map((node) => normalizeItem(node.content, node.fieldValueByName?.name || ""));

  console.log(`issue-board: fetched ${items.length} items from project board`);

  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(items, null, 2));
  return items;
}
