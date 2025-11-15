const ISSUE_REGEX = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[/?#].*)?$/;

function visitLinks(node, callback) {
  if (!node) return;
  if (node.type === 'link' && typeof node.url === 'string') {
    callback(node);
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => visitLinks(child, callback));
  }
}

const issueCache = new Map();

async function fetchIssue(repoSlug, issueNumber) {
  const cacheKey = `${repoSlug}#${issueNumber}`;
  if (issueCache.has(cacheKey)) {
    return issueCache.get(cacheKey);
  }
  const headers = { Accept: 'application/vnd.github+json' };
  const token = process?.env?.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(
    `https://api.github.com/repos/${repoSlug}/issues/${issueNumber}`,
    { headers },
  );
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  const payload = {
    title: data.title || `Issue #${issueNumber}`,
    state: (data.state || 'open').toLowerCase(),
  };
  issueCache.set(cacheKey, payload);
  return payload;
}

function decorateLink(node, details) {
  node.data = node.data || {};
  node.data.hProperties = node.data.hProperties || {};
  const props = node.data.hProperties;
  const classes = new Set(
    `${props.class || ''} ${props.className || ''} ${node.class || ''}`
      .split(/\s+/)
      .filter(Boolean),
  );
  classes.add('github-issue-link');
  classes.add(`github-issue-link--${details.state}`);
  const classString = Array.from(classes).join(' ');
  props.class = classString;
  props.className = classString;
  node.class = classString;
  props['data-issue-state'] = details.state;
  props['data-issue-title'] = details.title;
  if (!node.title) {
    node.title = `${details.title} (${details.state.toUpperCase()})`;
  }
}

const plugin = {
  name: 'GitHub Issue Links',
  transforms: [
    {
      name: 'github-issue-links',
      stage: 'document',
      plugin: () => {
        return async (tree) => {
          const targets = [];
          visitLinks(tree, (node) => {
            const match = node.url.match(ISSUE_REGEX);
            if (match) {
              targets.push({
                node,
                repoSlug: match[1],
                issueNumber: Number(match[2]),
              });
            }
          });
          const unique = new Map();
          targets.forEach(({ repoSlug, issueNumber }) => {
            const key = `${repoSlug}#${issueNumber}`;
            if (!unique.has(key)) {
              unique.set(key, { repoSlug, issueNumber });
            }
          });
          if (!unique.size) return;
          const detailsMap = new Map();
          await Promise.all(
            Array.from(unique.values()).map(async ({ repoSlug, issueNumber }) => {
              const details = await fetchIssue(repoSlug, issueNumber);
              if (details) {
                detailsMap.set(`${repoSlug}#${issueNumber}`, details);
              }
            }),
          );
          targets.forEach(({ node, repoSlug, issueNumber }) => {
            const details = detailsMap.get(`${repoSlug}#${issueNumber}`);
            if (details) {
              decorateLink(node, details);
            }
          });
        };
      },
    },
  ],
};

export default plugin;
