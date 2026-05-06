# Vana Connect Skill Feedback

This note captures what we learned while building the Claude connector in this repo. The goal is not to criticize the skill or docs in the abstract; it is to record where they helped, where they were confusing, and what would make the next connector build smoother for the team.

## Context

We built and validated a new Claude connector that:

- exports full conversation threads
- exports project list and project detail
- runs through the `vana` CLI
- validates against the connector schemas and real exported output

This feedback comes from actually using the current skill/docs to get a real connector over the line.

## What Worked Well

- The overall connector model is good: research first, implement, validate, register.
- The advice to inspect the live login surface instead of guessing was correct and important.
- The page API reference was useful and mostly accurate for writing connector code.
- The extraction patterns doc was directionally helpful once we had real platform evidence.
- The repo’s validation step was valuable. It caught real issues and acted as a quality gate.

## What Was Confusing Or Not Good Enough

### 1. The docs describe more than one workflow as if they are all current

In practice, we found multiple overlapping workflows:

- `vana sources`
- `vana connect`
- `node run-connector.cjs ...`
- `skills/vana-connect/scripts/run-connector.cjs ...`
- references to `~/.dataconnect/...`

That makes it hard to know which path is the real source of truth for someone working inside this repo today.

### 2. Runtime/path documentation appears stale

The skill and some docs still refer to:

- `~/.dataconnect/`

But on this machine, the live runtime state, logs, and results were under:

- `~/.vana/`

This is a high-friction mismatch because it affects setup, validation, log inspection, and debugging.

### 3. Validator command naming is inconsistent

We ran into multiple validator entrypoints:

- `node scripts/validate-connector.cjs ...`
- `node skills/vana-connect/scripts/validate.cjs ...`
- references in docs to `node scripts/validate.cjs ...`

This is confusing for a contributor because the command names are very similar but the repo organization suggests different intended entrypoints.

### 4. Local repo discovery through `vana` is not explained clearly enough

One of the most important practical discoveries was that `vana` can discover connectors from this repo when run from the repo root because it finds `registry.json`.

That behavior mattered a lot, but it was not obvious from the docs. We had to verify it by inspecting behavior and runtime code.

### 5. The standalone runner path was misleading for this repo workflow

Some docs and README content still imply that the standalone runner is a normal local testing path.

In our actual workflow, the reliable path was:

- `vana connect claude --json --no-input`

The older `run-connector` path was not the one that got us through the live connector iteration loop.

### 6. README is behind reality

The root README still reads like an older runner-centric architecture in places. That creates confusion because the skill pushes the CLI-first flow while the README still teaches another mental model.

### 7. Schema validation has at least one surprising behavior that is not documented

We hit a validator gotcha where nullable fields listed as `required` were effectively treated as missing in output validation.

That is important enough to document because it creates avoidable confusion while enriching schemas.

### 8. It is not explicit enough when manual-login-first is acceptable

The docs talk about automated credential flows, env vars, and requestInput patterns, but they do not say strongly enough that:

- manual login is acceptable
- manual login is often the right tradeoff for brittle auth surfaces
- a connector can still be mergeable and useful even without automated login

That would have reduced uncertainty during the Claude build.

## What We Had To Learn Ourselves

- The live Claude app used authenticated APIs that were not discoverable from the skill alone.
- The correct local execution path was the `vana` CLI, not the older standalone runner guidance.
- The runtime state was under `~/.vana`, not `~/.dataconnect`.
- The local repo could act as a source registry for `vana` when run from this checkout.
- The validator had behavior that was stricter or stranger than the docs implied.

These are exactly the kinds of things the skill/docs should surface earlier.

## Improvements I Would Suggest

### 1. Make one workflow canonical

For contributors working in this repo, the docs should state a single primary path such as:

- use `vana sources --json`
- use `vana connect <platform> --json --no-input`
- use `node scripts/validate-connector.cjs ...`
- use `node skills/vana-connect/scripts/register.cjs ...`

Everything else should be described as secondary, legacy, or debugging-only if that is the case.

### 2. Add a short "current architecture" section

This should explain:

- what the current CLI is
- how local repo discovery works
- where runtime state and logs live
- how results are stored
- when the connector is being pulled from the repo versus a cached location

### 3. Unify validator guidance

Pick one validator command to recommend in the main workflow and explain when the others are relevant.

### 4. Document common gotchas

A short "known friction points" section would help a lot:

- nullable + required schema behavior
- need to re-register after connector edits
- browser session reuse can hide auth problems
- manual login is often acceptable
- real-platform inspection beats remembered product knowledge

### 5. Update the README to match the actual contributor path

The README should align with the CLI-first reality if that is now the intended workflow.

### 6. Add a "what good looks like" checklist for connector PRs

For example:

- connector works against a real account
- structure validation passes
- output validation passes
- scopes are meaningful
- PR explains tradeoffs and known follow-ups
- unrelated repo/tooling churn is avoided unless necessary

### 7. Be more explicit about acceptable auth tradeoffs

The docs should say plainly that a connector can still be valid and mergeable if:

- it is manual-login-first
- auth automation is deferred to a follow-up
- the data extraction itself is strong and validated

That would help contributors avoid over-engineering before first review.

## Suggested Next Step For The Team

Discuss whether the current docs should be tightened around a single contributor workflow before adding more connectors.

The biggest opportunity is not adding more reference content. It is reducing ambiguity:

- one canonical way to run
- one canonical way to validate
- one canonical explanation of runtime state and local discovery

That would make the skill feel much more trustworthy in practice.
