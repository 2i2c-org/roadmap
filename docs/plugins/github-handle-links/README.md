# GitHub handle link plugin

A lightweight MyST transform that turns bare `@handle` mentions into links to the
matching GitHub profile. It runs once per document, looks for mentions in text
nodes (excluding code/link content) and unresolved cite nodes that MyST emits for
bare `@` references. When a handle resolves via the GitHub API, the mention is
replaced with a normal Markdown link. Handles that cannot be found are left as
plain text so builds still succeed.
