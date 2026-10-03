# Security Policy

## Supported versions

Only the latest stable release receives security fixes. RC builds are for testing.

## Reporting a vulnerability

Please use this repository's **private vulnerability reporting**
(Settings → Security → Report a vulnerability). Do not open public issues
for security problems.

## Security model notes

ProsaMD is a local-only application: it renders Markdown files from disk and
loads no remote content into the WebView. Two design decisions reviewers
often ask about:

- **CSP is not set.** All application content is bundled locally; nothing is
  fetched from the network at runtime. Remote content appearing in the editor
  would be a bug — please report it.
- **File-system access is deliberately narrow**: plain-text read/write only,
  at paths the user chooses through the open/save dialogs. No shell access,
  no command execution, no directory-listing API is exposed to the web layer.
