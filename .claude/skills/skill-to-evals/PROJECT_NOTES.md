# Skill To Evals Project Notes

## Purpose

This document records how the `skill-to-evals` work evolved, which inputs shaped it, and what we learned from building `v1` and `v2`.

## Sources

### Repos and local references

- `data-connect`
  - `.agents/skills/skill-to-evals/SKILL.md`
  - `.agents/skills/skill-to-evals-v2/SKILL.md`
  - `.agents/skills/skill-creator-anthropic/SKILL.md`
  - `.agents/skills/skill-creator-anthropic/references/schemas.md`
  - `.agents/skills/skill-creator-anthropic/agents/grader.md`
  - `.agents/skills/skill-creator-anthropic/eval-viewer/generate_review.py`
- system skill creator
  - `/Users/cflack/.codex/skills/.system/skill-creator/SKILL.md`
  - `/Users/cflack/.codex/skills/.system/skill-creator/scripts/quick_validate.py`
- external repo
  - `https://github.com/ehmo/platform-design-skills`
  - especially `skills/web/SKILL.md`, `skills/web/AGENTS.md`, and `skills/web/rules/_sections.md`

### Notes and links provided in conversation

- the eval-first notes starting from:
  - `Started: plan -> implement -> review -> fix`
  - `Now: evals -> prod spec -> ...`
- the follow-up notes about:
  - letting models draft the eval outline
  - turning evals into hooks when possible
  - collecting guides and papers, then converting them into skills and evals
  - using autoresearch when a predictable outcome exists
  - revisiting older projects after improving evals
- the example references to Russ Cox:
  - `https://swtch.com/~rsc/worknotes/`
  - `https://research.swtch.com/names`
- the Notion page:
  - `https://www.notion.so/callum/I-now-essentially-spend-90-of-time-working-on-evals-32dc1b8a6eed8024b714fc7649db6a19?source=copy_link`

## How We Approached It

### 1. Initial framing

The starting task was to create a skill that takes an existing skill document and compiles it into executable evals.

The first useful framing choice was:

- treat the output as eval artifacts, not as a rewritten skill
- convert each rule into a testable check
- split hard constraints from soft quality signals
- include hook-style enforcement ideas for hard constraints
- require at least one concrete failing example for each strong emitted eval

This produced the first draft of `skill-to-evals`.

### 2. Correction on source of truth

An important course correction happened early:

- use the system `skill-creator` as the main authoring skill
- do not treat the repo-local `skill-creator` as the canonical creation workflow for this task

That tightened the skill structure and reduced accidental drift.

### 3. Learning from the Anthropic skill-creator

The repo-local Anthropic variant added an important idea:

- evals are part of a system, not just a list

The key pieces were:

- `evals/evals.json`
- explicit expectations/assertions
- grader evidence
- benchmark aggregation
- viewer-based review

That changed the project in a meaningful way. The skill needed to produce checks that a grader could actually verify with evidence, not just checks that looked neat in YAML.

This pushed `v1` toward:

- binary checks
- evidence-friendly `pass_if` and `fail_if`
- omission of untestable guidance
- stronger rejection of shallow compliance

### 4. Learning from the eval-first notes

The conversation notes shifted the mental model again.

The strongest ideas were:

- evals come before product specs
- stronger guardrails produce clearer specs and better outputs
- good evals often become hooks
- evals should be revised continuously and backtested on old projects

This implied that `skill-to-evals` should not merely emit checks. It should compile guidance into something closer to a guardrail layer.

### 5. Learning from `platform-design-skills`

The `ehmo/platform-design-skills` repo showed a useful structure for that compiler model:

- long-form guidance exists, but the important unit is the atomic rule
- sectioning matters
- priority labels matter
- "never do" rules are naturally hook-ready
- a flat list loses too much information

The most useful file for this was `skills/web/rules/_sections.md`, because it looks more like compilation-ready source material than like prose.

That led to `skill-to-evals-v2`.

## What Changed Between V1 and V2

### V1

`v1` focuses on converting rules into concise machine-checkable evals.

Core ideas:

- hard vs soft classification
- explicit `pass_if` / `fail_if`
- hook suggestion for hard constraints
- omit non-testable source material
- prefer discriminating checks over shallow ones

This is a good rule-to-check compiler.

### V2

`v2` treats the task more like guardrail compilation.

New ideas added in `v2`:

- stable IDs instead of simple sequence numbers
- preserved `section`
- preserved `priority`
- preserved `source_order`
- explicit `source_ref`
- explicit `evidence_target`
- stronger emphasis on repo-hook and harness-gate compatibility
- explicit source spans when available
- concrete counterexamples
- first-class hookability

This is closer to a practical eval system compiler.

## Main Learnings So Far

### 1. A skill is not automatically an eval source

A large `SKILL.md` is usually too mixed:

- explanation
- examples
- rationale
- norms
- actual rules

The first job is normalization, not direct conversion.

### 2. Atomic rules are the real input

The best source material for eval generation looks like:

- sectioned
- prioritized
- imperative
- independently testable

This is why the `platform-design-skills` rule files were so informative.

The next improvement on top of this is to make the normalized rule IR explicit:

- source guidance is not the same thing as a compiled rule
- evals should be emitted from normalized rules, not directly from prose
- that IR is the stable layer for regeneration, auditing, and diffing

### 3. Hard constraints should be hook-first

If a hard rule cannot plausibly become:

- a repo hook
- a harness gate
- a lint-style rejection
- a deterministic test gate

then it is probably too weak, too vague, or misclassified.

The important refinement is to separate:

- hookability: can this realistically be enforced, and where
- hook suggestion: what is the narrowest concrete mechanism

### 4. Good evals are discriminating

A weak check passes when the output is superficially compliant.

A useful check fails:

- wrong structure
- wrong behavior
- wrong content
- coincidental matches

This came directly from the Anthropic grader model and from the eval-first notes.

A simple way to raise the discrimination bar is to require one explicit counterexample for each emitted eval.

### 5. Evidence matters as much as the rule

An eval without a clear evidence target is hard to grade and hard to trust.

Useful evidence targets include:

- output
- diff
- transcript
- AST
- DOM
- deterministic tests

This is why `v2` carries `evidence_target` explicitly.

The same logic applies to provenance:

- exact source spans are better than vague section references
- exact spans make regeneration and source-diff review much easier

### 6. Flattening loses too much information

A flat list of anonymous checks throws away:

- where the rule came from
- how important it is
- what section it belongs to
- whether it should block or merely score

That makes regeneration, auditing, and backtesting harder.

### 7. The destination is a guardrail system, not a YAML file

The most important lesson from the notes is that the output artifact matters less than the enforcement model.

The path is:

- collect rules
- normalize them
- compile them into evals
- turn the strong ones into hooks
- benchmark and review the rest
- revise and backtest

Backtesting should be treated as a first-class system component, not a later nice-to-have:

- each eval compiler should have a small pass/fail corpus
- strong hard constraints should be checked against old examples
- regressions in the compiler are easier to spot when the corpus is stable

## Working Model Emerging From This Project

The emerging compiler pipeline is:

1. ingest source guidance
2. normalize into atomic rules
3. preserve section, priority, provenance, and exact source spans
4. classify each rule as hard or soft
5. choose the strongest observable evidence target
6. attach a concrete counterexample
7. record hookability and then attach the narrowest viable hook suggestion
8. emit guardrail-ready evals
9. promote strong hard constraints into hooks where possible
10. backtest and benchmark the remainder over time

## Current Open Questions

- Should the next version emit both guardrails and benchmark assertions as separate outputs?
- Should the normalized-rule IR be optionally emitted for auditability, or remain internal by default?
- Should backtest corpus management live beside the skill, or in a separate eval package?

## Current Artifacts

- v1: `.agents/skills/skill-to-evals/SKILL.md`
- v2: `.agents/skills/skill-to-evals-v2/SKILL.md`

## Summary

The project started as "convert rules into checks."

It has moved toward:

- compile rule systems, not prose
- preserve structure and provenance
- make normalized rules the true compiler input
- optimize for enforcement, evidence, and backtesting
- treat hooks as the strongest form of eval when possible

That shift is the main thing learned so far.
