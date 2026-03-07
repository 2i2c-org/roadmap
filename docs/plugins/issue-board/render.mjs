// Rendering logic for the issue board plugin.
//
// Converts normalized initiative data into MyST AST nodes. Each initiative
// becomes an expandable <details> element with:
// - Summary row: title link, theme badges (optional), sub-issue count, timestamp
// - Expanded body: problem statement (parsed as MyST) + sub-issue links

const SHOW_THEME_BADGES = false;

// 2i2c brand colors for theme badges — see https://2i2c.org/brand
// TODO: These aren't currently used, because badges are hidden behind a feature flag
//   Re-activate it when this issue is resolved https://github.com/2i2c-org/infrastructure/issues/7858
const THEME_COLORS = {
  "knowledge-sharing":      { bg: "#057761", fg: "#fff" },
  "platform-resilience":    { bg: "#1D4EF5", fg: "#fff" },
  "multi-cloud-support":    { bg: "#B86BFC", fg: "#fff" },
  "resource-management":    { bg: "#FF4E4F", fg: "#fff" },
  "3rd-party-integration":  { bg: "#0CEFAE", fg: "#230344" },
  "access-control":         { bg: "#C60A76", fg: "#fff" },
  "cost-mitigation":        { bg: "#FFDE17", fg: "#230344" },
  "analytics":              { bg: "#230344", fg: "#fff" },
};

function badgeStyle(theme) {
  const c = THEME_COLORS[theme] || { bg: "#230344", fg: "#fff" };
  return {
    backgroundColor: c.bg, color: c.fg,
    fontSize: "0.65rem", padding: "0.05rem 0.35rem",
    borderRadius: "999px", fontWeight: "500",
  };
}

export function formatTimeAgo(isoDate, prefix = "Updated") {
  if (!isoDate) return null;
  const diffDays = Math.floor((Date.now() - new Date(isoDate)) / 86400000);
  if (diffDays === 0) return `${prefix} today`;
  if (diffDays === 1) return `${prefix} 1d ago`;
  if (diffDays < 30) return `${prefix} ${diffDays}d ago`;
  if (diffDays < 365) return `${prefix} ${Math.floor(diffDays / 30)}mo ago`;
  return `${prefix} ${Math.floor(diffDays / 365)}y ago`;
}

// Extract the raw markdown between a "## Problem Statement" header and the next header.
const HEADER_PATTERN = /^#{1,4}\s*problem\s*statement/i;
const NEXT_HEADER_PATTERN = /^#{1,4}\s/;

function extractProblemStatement(body) {
  if (!body) return null;
  const lines = body.split("\n");
  let foundHeader = false;
  const sectionLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (HEADER_PATTERN.test(trimmed)) { foundHeader = true; continue; }
    if (!foundHeader) continue;
    if (trimmed === "" && sectionLines.length === 0) continue;
    if (NEXT_HEADER_PATTERN.test(trimmed)) break;
    sectionLines.push(line);
  }

  if (sectionLines.length === 0) return null;
  return sectionLines.join("\n").trim();
}

// Render the item as AST nodes for MyST
export function renderItem(item, ctx) {
  const summaryChildren = [
    { type: "link", url: item.url, children: [{ type: "text", value: item.title }] },
  ];

  // Right side: badges + "3/5" count + "Completed 2mo ago"
  const rightChildren = [];
  // TODO: FEATURE FLAG: badges are currently disabled (see TODO above)
  if (SHOW_THEME_BADGES) {
    for (const label of item.labels.filter((l) => l.startsWith("theme:"))) {
      const theme = label.replace(/^theme:/, "");
      rightChildren.push({
        type: "span", style: badgeStyle(theme),
        children: [{ type: "text", value: theme }],
      });
    }
  }
  const done = item.subIssues.filter((s) => s.state === "CLOSED").length;
  
  // CSS donut: conic-gradient fills a circle proportionally, with a white center cutout
  const total = item.subIssues.length;
  const deg = total > 0 ? Math.round((done / total) * 360) : 0;
  rightChildren.push({
    type: "span", class: "issue-board-progress",
    children: [
      {
        type: "span", class: "issue-board-donut",
        style: {
          background: `conic-gradient(#8250df ${deg}deg, #e1e4e8 ${deg}deg)`,
        },
      },
      {
        type: "span", class: "issue-board-count",
        children: [{ type: "text", value: `${done}/${total}` }],
      },
    ],
  });
  if (item.status === "Done") {
    const label = formatTimeAgo(item.closedAt, "Completed");
    if (label) {
      rightChildren.push({
        type: "span", class: "issue-board-updated",
        children: [{ type: "text", value: label }],
      });
    }
  }
  summaryChildren.push({
    type: "span", class: "issue-board-right", children: rightChildren,
  });

  // Expanded body: parsed problem statement + sub-issue links
  const detailsBody = [];
  const problemMd = extractProblemStatement(item.body);
  if (problemMd && ctx) {
    const parsed = ctx.parseMyst(problemMd);
    if (parsed?.children?.length > 0) {
      detailsBody.push({
        type: "div", class: "issue-board-description",
        children: parsed.children,
      });
    }
  }

  // Sub-issues shown as bare URLs so the github-issue-link plugin decorates them.
  if (item.subIssues.length > 0) {
    detailsBody.push({
      type: "div", class: "issue-board-subissues",
      children: item.subIssues.map((sub) => {
        const children = [
          { type: "link", url: sub.url, children: [{ type: "text", value: sub.url }] },
        ];
        const subUpdated = formatTimeAgo(sub.updatedAt);
        if (subUpdated) {
          children.push({
            type: "span", class: "issue-board-updated",
            children: [{ type: "text", value: subUpdated }],
          });
        }
        return { type: "paragraph", class: "issue-board-subissue", children };
      }),
    });
  }

  return {
    type: "div", class: "issue-board-item",
    children: [{
      type: "details", class: "issue-board-details",
      children: [{ type: "summary", children: summaryChildren }, ...detailsBody],
    }],
  };
}
