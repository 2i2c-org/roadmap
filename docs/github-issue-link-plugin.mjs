import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Simplified MyST transform that swaps bare GitHub issue links
 * for styled links annotated with the issue title and state.
 */
const ISSUE_LINK_REGEX =
  /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[/?#].*)?$/;
const issueCache = new Map();
const CACHE_DIR =
  process.env.GITHUB_ISSUE_CACHE_DIR || path.join(process.cwd(), '_build');
const CACHE_FILE = path.join(CACHE_DIR, 'github-issue-cache.json');
let cacheReady;
let cacheDirty = false;

function visitLinks(node, callback) {
  if (!node) return;
  if (node.type === 'link' && node.url) {
    callback(node);
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => visitLinks(child, callback));
  }
}

async function loadPersistentCache() {
  if (cacheReady) {
    return cacheReady;
  }
  cacheReady = (async () => {
    try {
      const data = await readFile(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      Object.entries(parsed).forEach(([key, value]) => {
        issueCache.set(key, value);
      });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(
          `[github-issue-link-plugin] Failed to read cache ${CACHE_FILE}: ${error.message}`,
        );
      }
    }
  })();
  return cacheReady;
}

async function savePersistentCache() {
  if (!cacheDirty) return;
  await mkdir(CACHE_DIR, { recursive: true });
  const payload = Object.fromEntries(issueCache.entries());
  await writeFile(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  cacheDirty = false;
}

function cacheIssueDetails(repoSlug, issueNumber, details) {
  if (!details) return;
  const cacheKey = `${repoSlug}#${issueNumber}`;
  issueCache.set(cacheKey, details);
  cacheDirty = true;
}

async function fetchIssueREST(repoSlug, issueNumber) {
  const apiUrl = `https://api.github.com/repos/${repoSlug}/issues/${issueNumber}`;
  const headers = { Accept: 'application/vnd.github+json' };
  const token = process?.env?.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(apiUrl, { headers });
  if (!response.ok) {
    console.warn(
      `[github-issue-link-plugin] Failed to fetch ${apiUrl}: ${response.status} ${response.statusText}`,
    );
    return null;
  }

  const data = await response.json();
  const details = {
    title: data.title,
    state: (data.state || '').toLowerCase(),
    state_reason: data.state_reason || '',
  };
  cacheIssueDetails(repoSlug, issueNumber, details);
}

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const MAX_REPOS_PER_QUERY = 5;
const MAX_ISSUES_PER_REPO = 20;

function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

function escapeGraphQLString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function fetchIssuesGraphQL(requests) {
  if (!requests.length) return;
  const token = process?.env?.GH_TOKEN;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const repoToNumbers = new Map();
  requests.forEach(({ repoSlug, issueNumber }) => {
    if (!repoToNumbers.has(repoSlug)) {
      repoToNumbers.set(repoSlug, new Set());
    }
    repoToNumbers.get(repoSlug).add(issueNumber);
  });

  const repoEntries = [];
  for (const [repoSlug, numbersSet] of repoToNumbers.entries()) {
    const numbers = Array.from(numbersSet);
    numbers.sort((a, b) => a - b);
    chunkArray(numbers, MAX_ISSUES_PER_REPO).forEach((chunk) => {
      repoEntries.push({ repoSlug, numbers: chunk });
    });
  }

  const repoChunks = chunkArray(repoEntries, MAX_REPOS_PER_QUERY);
  for (const chunk of repoChunks) {
    const { query, aliasMap } = buildGraphQLQuery(chunk);
    try {
      const response = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query }),
      });
      if (!response.ok) {
        console.warn(
          `[github-issue-link-plugin] GraphQL fetch failed: ${response.status} ${response.statusText}`,
        );
        continue;
      }
      const payload = await response.json();
      if (payload.errors) {
        console.warn('[github-issue-link-plugin] GraphQL errors:', payload.errors);
      }
      if (!payload.data) continue;
      Object.entries(payload.data).forEach(([repoAlias, repoData]) => {
        if (!repoData) return;
        Object.entries(repoData).forEach(([issueAlias, issueData]) => {
          const key = `${repoAlias}.${issueAlias}`;
          const target = aliasMap.get(key);
          if (!target || !issueData) return;
          const details = {
            title: issueData.title,
            state: (issueData.state || '').toLowerCase(),
            state_reason: issueData.stateReason
              ? issueData.stateReason.toLowerCase()
              : '',
          };
          cacheIssueDetails(target.repoSlug, target.issueNumber, details);
        });
      });
    } catch (error) {
      console.warn(
        `[github-issue-link-plugin] GraphQL request error: ${error.message}`,
      );
    }
  }
}

function buildGraphQLQuery(repoEntries) {
  let query = 'query {\n';
  const aliasMap = new Map();
  repoEntries.forEach((entry, repoIdx) => {
    const [owner, name] = entry.repoSlug.split('/');
    const repoAlias = `repo_${repoIdx}`;
    query += `  ${repoAlias}: repository(owner: "${escapeGraphQLString(owner)}", name: "${escapeGraphQLString(name)}") {\n`;
    entry.numbers.forEach((issueNumber, issueIdx) => {
      const issueAlias = `issue_${issueIdx}`;
      aliasMap.set(`${repoAlias}.${issueAlias}`, {
        repoSlug: entry.repoSlug,
        issueNumber,
      });
      query += `    ${issueAlias}: issue(number: ${issueNumber}) {\n`;
      query += '      number\n      title\n      state\n      stateReason\n';
      query += '    }\n';
    });
    query += '  }\n';
  });
  query += '}\n';
  return { query, aliasMap };
}

async function ensureIssueDetails(requests) {
  if (!requests.length) return;
  await loadPersistentCache();
  let missing = requests.filter(
    ({ repoSlug, issueNumber }) =>
      !issueCache.has(`${repoSlug}#${issueNumber}`),
  );
  if (!missing.length) return;

  await fetchIssuesGraphQL(missing);
  missing = missing.filter(
    ({ repoSlug, issueNumber }) =>
      !issueCache.has(`${repoSlug}#${issueNumber}`),
  );
  for (const { repoSlug, issueNumber } of missing) {
    await fetchIssueREST(repoSlug, issueNumber);
  }
}

function applyLinkMetadata(node, details) {
  node.data = node.data || {};
  node.data.hProperties = node.data.hProperties || {};
  const props = node.data.hProperties;

  const existingClasses = `${props.class || props.className || ''} ${node.class || ''}`
    .split(/\s+/)
    .filter(Boolean);
  const merged = new Set([
    ...existingClasses,
    'github-issue-link',
    `github-issue-link--${details.state}`,
  ]);
  const classString = Array.from(merged).join(' ');
  props.class = classString;
  props.className = classString;
  node.class = classString;

  props['data-state'] = details.state;
  if (details.state_reason) {
    props['data-state-reason'] = details.state_reason;
  } else {
    delete props['data-state-reason'];
  }
  props['data-issue-title'] = details.title;

  if (!node.title) {
    node.title = `${details.title} (${details.state.toUpperCase()})`;
  }
}

const githubIssueLinkTransform = {
  name: 'github-issue-link-transform',
  doc: 'Enhance GitHub issue links with state-aware styling.',
  stage: 'document',
  plugin: () => {
    return async (tree) => {
      const targets = [];
      visitLinks(tree, (node) => {
        const match = node.url.match(ISSUE_LINK_REGEX);
        if (match) {
          targets.push({
            node,
            repoSlug: match[1],
            issueNumber: Number(match[2]),
          });
        }
      });

      await ensureIssueDetails(
        targets.map(({ repoSlug, issueNumber }) => ({ repoSlug, issueNumber })),
      );

      targets.forEach(({ node, repoSlug, issueNumber }) => {
        const details = issueCache.get(`${repoSlug}#${issueNumber}`);
        if (details) {
          applyLinkMetadata(node, details);
        }
      });

      await savePersistentCache();
    };
  },
};

const plugin = {
  name: 'GitHub Issue Link Plugin',
  transforms: [githubIssueLinkTransform],
};

export default plugin;
