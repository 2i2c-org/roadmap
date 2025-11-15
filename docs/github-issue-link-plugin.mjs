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

async function fetchIssue(repoSlug, issueNumber) {
  await loadPersistentCache();
  const cacheKey = `${repoSlug}#${issueNumber}`;
  if (issueCache.has(cacheKey)) {
    return issueCache.get(cacheKey);
  }

  const apiUrl = `https://api.github.com/repos/${repoSlug}/issues/${issueNumber}`;
  const headers = { Accept: 'application/vnd.github+json' };
  const token = process?.env?.GITHUB_TOKEN;
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
    state: data.state,
    state_reason: data.state_reason || '',
  };
  issueCache.set(cacheKey, details);
  cacheDirty = true;
  return details;
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

async function enhanceLink(node, repoSlug, issueNumber) {
  const details = await fetchIssue(repoSlug, issueNumber);
  if (details) {
    applyLinkMetadata(node, details);
  }
}

const githubIssueLinkTransform = {
  name: 'github-issue-link-transform',
  doc: 'Enhance GitHub issue links with state-aware styling.',
  stage: 'document',
  plugin: () => {
    return async (tree) => {
      const tasks = [];
      visitLinks(tree, (node) => {
        const match = node.url.match(ISSUE_LINK_REGEX);
        if (match) {
          tasks.push(enhanceLink(node, match[1], match[2]));
        }
      });
      await Promise.all(tasks);
      await savePersistentCache();
    };
  },
};

const plugin = {
  name: 'GitHub Issue Link Plugin',
  transforms: [githubIssueLinkTransform],
};

export default plugin;
