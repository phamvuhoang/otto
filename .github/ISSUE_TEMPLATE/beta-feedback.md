---
name: Beta feedback
about: You tried Otto on a real repo — tell us what helped and what got in the way
title: "beta: "
labels: beta
---

<!--
Thanks for beta-testing Otto on a real repo. This form feeds the beta backlog
(see docs/BETA.md). Fill in what's relevant — skip anything that didn't apply.
Redact paths/secrets before posting.
-->

## What you ran Otto against

- Repo kind (language/stack, size, public/private):
- Bin + flags (`otto-afk` / `otto-ghafk`, env vars):
- Runner (`sandbox` default / `OTTO_RUNNER=host`):
- `otto-afk --print-config` (redacted):

## Setup friction

<!-- Install, auth (claude /login, gh auth login), first successful run.
What stalled you? Where did you get stuck or have to guess? -->

## Confusing docs

<!-- README / CONTRIBUTING / SECURITY / docs that were wrong, missing, or
ambiguous. Quote the line and say what you expected. -->

## Unsafe defaults

<!-- Anything that did (or could) do something surprising or risky out of the
box — sandbox scope, bypassPermissions blast radius, writes outside the
workspace, credential exposure. -->

## Severity & frequency (helps us rank)

- How blocking was this? (blocker / major / minor / nit)
- How often did you hit it? (every run / sometimes / once)

## Anything else

<!-- What worked well, what almost-worked, what you wish existed. -->
