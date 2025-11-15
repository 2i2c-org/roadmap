const HANDLE_REGEX = /(^|\s|[(\[])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/g;
const SIMPLE_HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SKIP_PARENTS = new Set(['link', 'definition', 'inlineCode', 'code']);

function visit(node, parent, callback) {
  if (!node) return;
  callback(node, parent);
  if (Array.isArray(node.children)) {
    node.children.forEach((child) => visit(child, node, callback));
  }
}

function gatherResolvedHandles(file) {
  const resolved = new Set();
  const citeRefs = file?.data?.references?.cite?.data || {};
  Object.keys(citeRefs).forEach((key) => resolved.add(key.toLowerCase()));
  return resolved;
}

function collectTextMentions(root, resolved) {
  const mentions = [];
  visit(root, null, (node, parent) => {
    if (!node || node.type !== 'text') return;
    if (!node.value || !node.value.includes('@')) return;
    if (parent && SKIP_PARENTS.has(parent.type)) return;
    const value = node.value;
    const hits = [];
    HANDLE_REGEX.lastIndex = 0;
    let match;
    while ((match = HANDLE_REGEX.exec(value)) !== null) {
      const handle = match[2];
      if (resolved.has(handle.toLowerCase())) continue;
      const start = match.index + match[1].length;
      const end = start + handle.length + 1;
      hits.push({ start, end, handle, raw: value.slice(start, end) });
    }
    if (hits.length) {
      mentions.push({ node, parent, hits, value });
    }
  });
  return mentions;
}

function collectCiteMentions(root, resolved, handledLabels) {
  const mentions = [];
  visit(root, null, (node, parent) => {
    if (!node || node.type !== 'cite') return;
    if (!parent || !Array.isArray(parent.children)) return;
    const label = node.label || node.identifier || '';
    const handle = (node.identifier || label || '').replace(/^@/, '');
    const lower = handle.toLowerCase();
    if (!handle) return;
    handledLabels.add(lower);
    if (!SIMPLE_HANDLE.test(handle) || resolved.has(lower)) {
      const textNode = { type: 'text', value: `@${label || handle}` };
      const index = parent.children.indexOf(node);
      if (index !== -1) {
        parent.children.splice(index, 1, textNode);
      }
      return;
    }
    mentions.push({ node, parent, handle, lower, label: label || handle });
  });
  return mentions;
}

async function fetchHandle(handle) {
  const headers = { Accept: 'application/vnd.github+json' };
  const token = process?.env?.GITHUB_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`https://api.github.com/users/${handle}`, {
    headers,
  });
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return {
    login: data.login || handle,
    url: data.html_url || `https://github.com/${handle}`,
  };
}

function replaceTextNode({ node, parent, hits, value }, profiles) {
  if (!parent || !Array.isArray(parent.children)) return;
  const index = parent.children.indexOf(node);
  if (index === -1) return;
  const parts = [];
  let cursor = 0;
  hits.forEach((hit) => {
    const profile = profiles.get(hit.handle.toLowerCase());
    if (!profile) return;
    if (hit.start > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, hit.start) });
    }
    parts.push(createLinkNode(profile, hit.raw));
    cursor = hit.end;
  });
  if (cursor < value.length) {
    parts.push({ type: 'text', value: value.slice(cursor) });
  }
  parent.children.splice(index, 1, ...parts);
}

function replaceCiteNode({ node, parent, lower, label }, profiles) {
  if (!parent || !Array.isArray(parent.children)) return;
  const profile = profiles.get(lower);
  if (!profile) return;
  const index = parent.children.indexOf(node);
  if (index === -1) return;
  parent.children.splice(index, 1, createLinkNode(profile, `@${label}`));
}

function createLinkNode(profile, text) {
  return {
    type: 'link',
    url: profile.url,
    title: `GitHub profile for ${profile.login}`,
    children: [{ type: 'text', value: text }],
    data: {
      hProperties: {
        class: 'github-handle-link',
        'data-github-user': profile.login,
      },
    },
  };
}

function filterWarnings(file, handledLabels) {
  if (!handledLabels.size) return;
  const messages = file?.messages;
  if (!Array.isArray(messages)) return;
  file.messages = messages.filter((message) => {
    const reason = message?.reason || '';
    if (!reason.includes('Could not link citation')) return true;
    const match = reason.match(/"([^"]+)"/);
    if (!match) return true;
    return !handledLabels.has(match[1].toLowerCase());
  });
}

const plugin = {
  name: 'GitHub Handle Links',
  transforms: [
    {
      name: 'github-handle-links',
      stage: 'document',
      plugin: () => {
        return async (tree, file) => {
          const resolvedHandles = gatherResolvedHandles(file);
          const handledLabels = new Set();
          const textMentions = collectTextMentions(tree, resolvedHandles);
          const citeMentions = collectCiteMentions(
            tree,
            resolvedHandles,
            handledLabels,
          );
          const handles = new Set();
          textMentions.forEach(({ hits }) =>
            hits.forEach((hit) => handles.add(hit.handle.toLowerCase())),
          );
          citeMentions.forEach((mention) => handles.add(mention.lower));
          if (!handles.size) {
            filterWarnings(file, handledLabels);
            return;
          }
          const profiles = new Map();
          for (const handle of handles) {
            const profile = await fetchHandle(handle);
            if (profile) {
              profiles.set(handle, profile);
            }
          }
          textMentions.forEach((mention) => replaceTextNode(mention, profiles));
          citeMentions.forEach((mention) => replaceCiteNode(mention, profiles));
          filterWarnings(file, handledLabels);
        };
      },
    },
  ],
};

export default plugin;
