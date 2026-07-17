# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the GitHub MCP server for issue
reads and writes. Repository scripts only wrap label configuration that GitHub MCP does
not currently expose.

## Conventions

- Create issues with GitHub MCP `issue_write` using `method: "create"`. Pass `owner`,
  `repo`, `title`, `body`, and any `labels` directly to the tool.
- Read, update, comment on, and close issues with GitHub MCP `issue_read`, `issue_write`,
  `search_issues`, `list_issues`, and `add_issue_comment`.
- Ensure a label exists with
  `pnpm github:label:ensure -- --name <name> --color <RRGGBB> --description <text>`.
  The script creates a missing label or updates an existing label to match, then verifies its
  name, color, and description. The color must omit the leading `#`.
- For a label owned by a sibling repository, run the label script from this repository with
  `--repo <owner/repo>`.
- Infer the default repository from `git remote -v`; use `--repo` when the owning repository is not
  the current checkout.
- When a skill says "publish to the issue tracker", create the issue with GitHub MCP
  `issue_write`.
- When a skill says "fetch the relevant ticket", use GitHub MCP `issue_read` with
  `method: "get"` and `method: "get_comments"` as needed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

`/wayfinder` uses a map issue with linked child issues. Child issues declare their
type, blockers, and ownership using GitHub labels, dependencies, and assignees.
Resolve a child by recording its answer, closing it, and linking the result from
the map issue.
