# Changelog

All notable changes to the Otto monorepo are recorded here. Entries are grouped
by component and, within a release, by Conventional Commit type (Features, Bug
Fixes, Performance Improvements, Dependencies, …). This file is generated and
amended by [release-please](https://github.com/googleapis/release-please); new
release sections are prepended above the baseline below. See `RELEASING.md` for
the release process and commit conventions.

## otto-core 0.1.0 (baseline)

Initial release of the Claude Code AFK orchestration harness library: iteration
loop, native-sandbox runner, template renderer, and stage registry.

## otto 0.1.0 (baseline)

Initial release of the Otto CLI, exposing the `otto-afk` (plan/PRD loop) and
`otto-ghafk` (GitHub-issue loop) bin entries. The CLI is versioned independently
of `otto-core`; its entries always appear under their own `otto` heading.
