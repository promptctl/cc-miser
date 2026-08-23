<!-- BEGIN LIT INTEGRATION -->
## lit Agent-Native Workflow

This repository uses `lit` for agent-native issue tracking.

Start by running `lit quickstart` to load the workflow instructions. It prints how tickets are found, created, updated, and closed here, so running it first means the rest of your work follows the conventions this repo expects. It's a quick, read-only command — no need to check in before running it.

<!-- END LIT INTEGRATION -->

## Changes reach the default branch by pull request

Pushing to the default branch is rejected by a GitHub ruleset, for everyone, with no
bypass. So the answer to "directly to master or via a PR, as fits the repo" is: via a PR,
every time. Branch, push the branch, open the PR, merge it.

This file does not restate what the ruleset enforces — the ruleset is the authority, and a
copy of its settings here would be a second one, free to drift the first time either
changes. Read the live rule with:

    gh api repos/promptctl/cc-miser/rulesets --jq '.[].name'
    gh ruleset view --repo promptctl/cc-miser

A rejected push is the rule working, not a problem to route around. Do not disable the
ruleset to land a change.
