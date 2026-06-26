# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on the **`qBraid/opencode`** fork. Use the `gh` CLI for all operations.

> **Fork safety (see `AGENTS.md`):** This is a fork of `sst/opencode` (upstream). NEVER create issues, comments, PRs, or any write against the upstream repo. Always pass `--repo qBraid/opencode` explicitly so `gh` doesn't default to the parent repo.

## Conventions

- **Create an issue**: `gh issue create --repo qBraid/opencode --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo qBraid/opencode --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --repo qBraid/opencode --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo qBraid/opencode --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo qBraid/opencode --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo qBraid/opencode --comment "..."`

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `qBraid/opencode`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo qBraid/opencode --comments`.
