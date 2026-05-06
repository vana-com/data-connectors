---
name: skill-to-evals-v2
description: Convert a skill document, guide, paper summary, or rule set into guardrail-ready evals with stable IDs, section and priority preservation, explicit provenance, counterexamples, evidence targets, and hookability. Use when the user wants to turn rules into enforceable checks, repo hooks, harness gates, or benchmark assertions rather than prose guidance.
---

# Skill To Evals V2

## Goal

Compile source guidance into eval artifacts that can drive:

- repo hooks
- harness gates
- benchmark assertions
- review checklists

Output evals only.

- Do not restate or summarize the source.
- Do not give advice or remediation.
- Do not emit explanatory prose outside the output block.
- Omit source content that cannot become a discriminating check.

## Compilation model

Treat the source as raw material for a guardrail system, not as prose to paraphrase.

Compile in this order:

1. normalize the source into atomic rules internally
2. preserve source section, priority, and exact span when available
3. split mixed rules into independently testable units
4. classify each unit as hard or soft
5. choose the strongest observable evidence target
6. record one concrete counterexample for each emitted eval
7. attach hookability and the narrowest viable hook strategy

## What to extract

Convert only normative content:

- required actions
- forbidden actions
- exact output contracts
- ordering constraints
- scope boundaries
- safety boundaries
- tool or file restrictions
- measurable thresholds stated by the source

Do not convert:

- introductions
- motivation
- background explanation
- duplicated guidance
- aspirational statements with no observable signal
- requirements that depend on hidden intent
- requirements that cannot be verified from output, diff, transcript, DOM, AST, or deterministic tests

## Rule normalization

Before emitting evals, construct an internal normalized-rule IR.

The IR is not part of the final output unless the user explicitly asks for it.

Each normalized rule should capture:

- atomic rule text
- section
- priority
- source order
- source reference
- exact source span when available
- whether the rule is normative enough to emit

Before emitting evals from that IR:

- keep each rule atomic
- preserve section names
- preserve explicit priority labels such as `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`
- preserve explicit source ordering within each section
- carry enough provenance to regenerate the eval from updated source material
- preserve exact heading and line or span references when available

If the source mixes a hard prohibition with softer advice, split them into separate evals.

## Eval quality bar

Every eval must be:

- atomic
- binary
- observable
- evidence-friendly
- discriminating
- backed by at least one concrete failing counterexample

Reject weak conversions such as:

- filename-only checks when file content matters
- presence-only checks when correctness matters
- text-match checks when structure or behavior matters
- process checks unless the source explicitly requires the process itself

If a shallow or coincidental success would pass the check, tighten it or omit it.

## Classification

Use exactly one classification per eval:

- `hard_constraint`: violation should reject the run
- `soft_score`: violation is a quality signal only

Default `hard_constraint` for:

- `must`, `must not`, `never`, `always`, `only`, `exactly`
- explicit bans
- safety and policy boundaries
- strict formatting or structural contracts
- explicit thresholds
- "never do" style rules

Default `soft_score` for:

- `prefer`, `avoid`, `keep`, `try`, `usually`
- style and quality heuristics
- guidance where multiple outputs could still be acceptable

If ambiguous, use `soft_score`.

## Evidence target

Each eval must declare the strongest primary evidence target:

- `output`
- `diff`
- `transcript`
- `ast`
- `dom`
- `test`
- `manual`

Choose the strongest target that can actually verify the rule.

- Prefer `ast` or `dom` over plain text when structure matters.
- Prefer `test` when runtime behavior is the real requirement.
- Prefer `output` over `transcript` unless the rule is explicitly about process.
- Use `manual` only when no reliable automated target exists.

## Hook strategy

Every eval must include `hookability`.

Every `hard_constraint` must also include a hook suggestion.

Allowed hookability values:

- `repo_hook`
- `harness_gate`
- `manual_only`

Allowed hook kinds:

- `regex`
- `ast`
- `dom_audit`
- `diff_gate`
- `output_gate`
- `test_gate`
- `manual_only`

Choose the narrowest hook that could reject a violation with low ambiguity.

## Output contract

Return exactly one fenced `yaml` block and nothing else.

Use this schema exactly:

```yaml
evals:
  - id: HC-ACCESSIBILITY-001
    section: Accessibility / WCAG
    priority: CRITICAL
    source_order: 1
    source_ref: Accessibility / WCAG > Rule 1
    source_span: lines 12-18
    classification: hard_constraint
    evidence_target: ast
    hookability: repo_hook
    check: Use semantic HTML instead of clickable non-semantic elements when a native control exists.
    pass_if:
      - Interactive controls are implemented with native semantic elements where applicable.
    fail_if:
      - A non-semantic element such as a clickable `div` is used where a native control would satisfy the same behavior.
    counterexample:
      - JSX uses a clickable `div` for button behavior without a valid semantic exception.
    hook_suggestion:
      kind: ast
      reject_if:
        - JSX or HTML contains click handlers on non-interactive elements for button-like behavior when no valid semantic exception is present.
  - id: SS-TYPOGRAPHY-001
    section: Typography
    priority: HIGH
    source_order: 3
    source_ref: Typography > Rule 3
    source_span: lines 41-45
    classification: soft_score
    evidence_target: output
    hookability: manual_only
    check: Keep body typography concise and readable.
    pass_if:
      - Body text style stays consistent and supports easy scanning.
    fail_if:
      - Body text style is inconsistent or clearly harms readability.
    counterexample:
      - Body text uses multiple inconsistent styles that make scanning noticeably harder.
```

## Formatting rules

- Emit `hard_constraint` evals before `soft_score` evals.
- Preserve source order within each classification.
- IDs must be stable and derived from classification, section slug, and source order.
- Use uppercase priority labels exactly as they appear in the source when present.
- If the source has no explicit priority, omit `priority`.
- If the source has no meaningful section, use `General`.
- Include `source_span` when the source exposes exact headings, lines, or ranges.
- Do not include fields outside the schema.
- Do not include empty arrays or empty objects.

## Conversion rules

- Prefer outcome checks over process checks unless process compliance is itself the rule.
- Prefer content correctness over surface presence.
- Prefer structure and behavior over wording when those are the true requirement.
- Encode explicit numeric thresholds exactly as stated by the source.
- Do not invent thresholds, priorities, or policies not present or strongly implied in the source.
- If multiple evidence targets are possible, choose the one most suitable for automated enforcement.
- If the source contains a reusable hard prohibition, phrase it so it can become a repo or harness guardrail.
- If the source contains high-level guidance that cannot support a hard gate, keep it as a soft score or omit it.
- `counterexample` must describe a realistic failing case, not a paraphrase of `fail_if`.
- `hookability` should capture whether the rule is realistically enforceable in a repo hook, a harness gate, or only manual review.
- Prefer exact source spans over vague provenance when the source format allows it.

## Omission rules

Do not emit an eval when:

- the rule is too vague to fail decisively
- the rule cannot produce concrete evidence
- the rule would reward shallow compliance
- the rule duplicates a stronger emitted eval

## Quality test

A good result is:

- compact
- source-faithful
- guardrail-ready
- benchmark-ready
- easy to grade with evidence
- easy to backtest against known pass and fail examples

A bad result is:

- summary disguised as evals
- flattened output that loses section or priority
- checks that pass for coincidental compliance
- hard constraints with no realistic enforcement path
- evals with no concrete failing counterexample
