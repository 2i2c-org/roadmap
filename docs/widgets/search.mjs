// Search widget for filtering roadmap items.
// This is very hackily thrown together but seems to work reasonably well!
// It uses {anywidget} API in MyST to render a search input.
// It matches .issue-board-item elements in the table just below
// This is probably not something we're supposed to do given React and DOM and such, but let's give it a shot...

function render({ model, el }) {
  const wrapper = document.createElement("div");
  wrapper.classList.add("search-wrapper");

  const icon = document.createElement("span");
  icon.classList.add("search-icon");
  icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  wrapper.appendChild(icon);

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Filter initiatives...";
  input.classList.add("search-input");
  wrapper.appendChild(input);

  const clear = document.createElement("button");
  clear.classList.add("search-clear");
  clear.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  clear.style.display = "none";
  wrapper.appendChild(clear);

  el.appendChild(wrapper);

  function filter() {
    const query = input.value.trim();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    document.querySelectorAll(".issue-board-item").forEach((item) => {
      const text = item.querySelector("summary")?.textContent.toLowerCase() || "";
      item.style.display = terms.length === 0 || terms.every((t) => text.includes(t)) ? "" : "none";
    });

    clear.style.display = query ? "" : "none";

    // Keep URL in sync so the current filter is shareable
    const url = new URL(window.location);
    query ? url.searchParams.set("q", query) : url.searchParams.delete("q");
    history.replaceState(null, "", url);
  }

  input.addEventListener("input", filter);
  clear.addEventListener("click", () => { input.value = ""; filter(); input.focus(); });

  // On load, populate from URL query parameter
  const initialQuery = new URLSearchParams(window.location.search).get("q");
  if (initialQuery) {
    input.value = initialQuery;
    filter();
  }
}

export default { render };
