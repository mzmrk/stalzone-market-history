---
name: maintain-project-documentation
description: Maintain compact, source-linked project memory under docs/. Use before and after changes to code, configuration, schemas, data, tooling, deployment, or workflows; when durable decisions, invariants, failure modes, or recurring traps are discovered; or when project documentation needs review, consolidation, or correction. Read the complete core memory in a fresh context, map structural changes to existing architecture, update affected knowledge, verify it against authoritative source and tests, and report when documentation impact is none.
---

# Maintain Project Documentation

Keep a small, accurate memory bank that lets a future agent understand the project, avoid known mistakes, and find
authoritative source without repeating investigation.

## Boundaries

- During project-memory maintenance, read any repository file needed as evidence but write only under `docs/`. This
  boundary does not restrict files that the user's primary task explicitly requires changing.
- Keep the root `README.md` outside project memory, authority, and validator scope; do not update it automatically. When
  durable externally visible behavior changes—such as features, setup, deployment, data sources, security, or privacy—
  read it only to detect contradictions. Edit it only when the primary task authorizes human-facing documentation;
  otherwise report stale claims.
- Do not modify code, tests, configuration, repository policy, generated artifacts, or other files as a documentation
  safeguard. Report the needed change separately.
- Maintain Markdown in English. Preserve exact identifiers or non-English source text when translation would be wrong.

## Workflow

### 1. Load the complete core

1. Inspect `git status --short`, relevant staged and unstaged diffs, and relevant untracked files. Preserve unrelated
   user changes.
2. List every `docs/**/*.md` file except Markdown under `docs/references/` or `docs/evidence/`, and record its line and
   word counts.
3. Read every listed core document to confirmed EOF. `docs/README.md` is the index and ownership map, not a substitute
   for the complete read.
4. Treat that read as the baseline for the current context. Reload the complete core after context compaction, an
   inventory or ownership change, a cross-topic change, or external edits that make the baseline uncertain. Otherwise
   re-read only documents changed or implicated by contradiction checks.
5. Read a reference only when its index entry gives a condition relevant to the task, or when auditing references.
   Inspect evidence only when investigating the claim that links to it.

From the repository root, inventory the core with:

```bash
find docs -type f -name '*.md' ! -path 'docs/references/*' ! -path 'docs/evidence/*' -print | sort
find docs -type f -name '*.md' ! -path 'docs/references/*' ! -path 'docs/evidence/*' -print0 | sort -z | xargs -0 -r wc -l -w
```

Read every core document of at most 240 lines concurrently in one bounded orchestration call: issue one labeled
`sed -n '1,240p' -- <path>` command per qualifying document and request an output budget of at least twice their aggregate
word count. Read each longer document in its own tool results, paging it in 240-line ranges; one long document must not
serialize the qualifying reads. Inspect every result and exit status independently. Confirm the last requested range
reaches each measured line count; if output is missing or truncated, resume sequentially from the last confirmed line.
Every document's full content must enter agent context; an index, summary, hash, search result, or redirected output is
not a substitute.

### 2. Map architecture before structural changes

Before implementing a structural primary-task change, map the requirement to existing owners, contracts, state and data
flow, dependency direction, lifecycle or persistence, and test seams. Prefer the current boundary when its responsibility
already fits. Add or split a module, component, type, or service only for a distinct responsibility, lifecycle, dependency
boundary, or independently testable contract. Check affected producers and consumers, and avoid expanding a coordinator
that already owns unrelated concerns.

### 3. Trace authoritative behavior

Inspect the active implementation, callers, schemas, configuration, scripts, persistence, tests, and generated
contracts affected by the task. Confirm that plausible-looking files are active through imports, registration, or
references.

Resolve conflicts in this order:

1. Executable code, schemas, migrations, configuration, and package scripts.
2. Tests and validators that demonstrate supported behavior.
3. Generated contracts for inspection only.
4. Existing documentation.

Tests are evidence, not automatic documentation requirements. Update memory when a test establishes or changes a
durable behavior, invariant, boundary, failure mode, or supported workflow. Ignore test refactors, fixture cleanup, and
coverage-only changes with no semantic impact.

Separate implemented behavior from intended policy, and current limitations from deliberate design. Do not describe
something as intentional without evidence.

### 4. Decide documentation impact

Record knowledge only when it is durable, project-specific, non-obvious, and useful to future work. Prefer:

- Product behavior, domain invariants, component ownership, runtime flows, and persistence boundaries.
- Contracts across components, clients, services, data, generated artifacts, and deployment.
- Security, privacy, authorization, migration, backup, and recovery constraints.
- Active versus inactive paths, material failure modes, operational requirements, and costly recurring traps.
- Decisions and rationale that maintainers may reasonably revisit.

Exclude repository inventories, exhaustive fields or endpoints, dependency lists, obvious mechanics, temporary state,
debugging history, resolved incidents, speculation, and secrets. If source expresses a detail clearly, link to it
instead of copying it.

When no durable knowledge changed, leave `docs/` untouched and report `Documentation impact: none` after verification.

### 5. Prevent repeated mistakes

When work exposes a recurring trap, first identify the smallest enforceable safeguard: a type or schema constraint,
focused test, validator, fail-fast check, or clearer code boundary. During memory maintenance, implement it only when the
primary task authorizes that file change; otherwise report the exact safeguard separately. Document only the remaining
project-specific invariant, limitation, or action in its canonical owner—not incident chronology or blame. Remove or
rewrite the warning once the safeguard makes it obsolete. If a cheap existing documentation validator is absent from
relevant existing CI while reviewing the documentation workflow, report the enforcement gap; change CI only when the
primary task authorizes it.

### 6. Update the canonical owner

- Give each substantive claim one canonical owner. Other documents may provide a short contextual link to that owner,
  but must not restate or maintain the claim independently. Replace stale text instead of appending corrections or
  chronology.
- Update current behavior, reasoning, workflows, limitations, and source links in the same logical change.
- Remove obsolete claims, resolved warnings, and duplication encountered in affected topics.
- Add a document only when no existing owner can remain clear. Link every core document from `docs/README.md`; list
  references there under their required read conditions. Update ownership or impact mapping when responsibilities change.
- Use relative links. Use kebab-case for new filenames, but do not rename existing files solely for style.

## Keep mandatory memory compact

Core memory is every Markdown file under `docs/` except files under `docs/references/` and `docs/evidence/`. Keep it at
or below 6,000 words; treat 5,500 as a warning to consolidate. Before adding words, remove duplication, stale claims,
recoverable mechanics, and detail that source links can replace.

Use `docs/references/` only when necessary knowledge still cannot fit after consolidation and current authoritative
sources exist against which it can be verified. Move the narrowest specialist detail first. Core must retain the
actionable conclusion, why it matters, and the exact condition for reading more. Never move product scope, active
behavior, ownership, security or privacy boundaries, routine operations, or costly recurring traps merely to satisfy
the limit.

References are non-authoritative research aids. Keep them one level below `docs/references/`, prevent
reference-to-reference dependencies, and list each under `## Specialized references` in `docs/README.md` with a concrete
read condition. Begin each reference with:

```markdown
> Non-authoritative reference.
> Core owner: [Document](../owning-document.md)
> Verify against:
> - `path/to/authoritative-source`
> Review when:
> - Concrete invalidation condition
```

Before relying on a reference, verify every relevant claim against its declared current sources. Update or remove stale
material in the same task; if verification is impossible, treat it as uncertain. Inspect a reference when its core
owner or declared source changes. Adding, removing, or renaming a reference requires a complete core and reference
audit.

Use `docs/evidence/` only to preserve small raw artifacts whose original form matters, such as images, captures, exact
responses, or binary samples. Evidence is never mandatory reading or authority. Link every evidence file from the core
or reference document that explains what it supports and when to inspect it; bare inventories do not establish
ownership. Prefer reference Markdown when the explanation matters more than exact form. Verify evidence-derived claims
against current authoritative source, or label them as observations. Remove orphaned or superseded evidence, and never
store secrets, dependencies, build output, large reproducible downloads, or temporary debugging artifacts there.

## Verify and finish

1. Re-read every changed document to confirmed EOF.
2. Search `docs/` for contradictions, duplicate ownership, stale terminology, and references to changed paths or
   behavior. Derive renamed or removed terms, routes, commands, data sources, and contracts from the diff and search the
   core and index for their old forms. Re-read affected surrounding documents.
3. When externally visible behavior changed, compare relevant root `README.md` claims with the verified core and source;
   update them only when authorized, otherwise report the contradiction.
4. Re-check changed claims against active source and tests. Run relevant safe tests or documented verification commands
   when practical; report important checks not run.
5. Ensure documented commands state their working directory and prerequisites. Give risky procedures verification and
   recovery guidance; do not execute destructive, production, or expensive commands merely to check prose.
6. Never manually edit generated files such as contracts, schemas, declarations, or documentation. Inspect them and
   their generators only.
7. With the host repository root as the working directory, run Node on `scripts/validate-docs.mjs` inside the directory
   containing this `SKILL.md`; do not assume the validator is under the host repository's `./scripts/`. Then run
   `git diff --check` and review the final diff for unrelated churn, secrets, stale warnings, and unjustified growth.
8. Do not stage or commit unrelated changes. Include documentation in the related primary-task commit, then commit each
   discrete change after it is completed and verified. Keep the message concise and use
   `area[,area2,area3]: intention of change and why it was done (what changed)`. Use at most three areas. Areas identify
   the primary product or system concerns changed, not every file category touched. Do not add `docs`, `tests`, or a
   generated-output area when those files only support another change; use `docs` only for documentation-only commits
   and `tests` only when testing behavior or infrastructure is itself the change.
9. Report documents added, updated, consolidated, moved, or removed and why. Actively report skill feedback when an
   instruction is observed to be contradictory, incorrect, ambiguous, unnecessarily restrictive, poorly matched to
   the task, repetitive, or materially costly in time, context, or correctness. Report it even when the task succeeds;
   name the rule or behavior, its concrete impact, and a specific improvement. Do not invent hypothetical criticism or
   add a placeholder when no such issue was observed.
