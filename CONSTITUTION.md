# Mindset and Behavioral Principles

**1. Think Before Coding**
Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If ambiguity affects behavior, scope, or data contracts, ask.

**2. Simplicity First**
Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

**3. Surgical Changes**
Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.
- The test: Every changed line should trace directly to the user's request.

**4. Goal-Driven Execution**
Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Change and Coding Discipline

### SCOPE & SAFETY (CRITICAL)
- Ask before broad refactors when intent or behavior could change.
- Modify ONLY code directly required. Do NOT refactor/rename unrelated code.
- Stability: Do NOT introduce new dependencies or change config/build tools.
- Preserve: Do NOT rename existing symbols for style preferences.
- Tests: Keep tests aligned with intended behavior. Behavior change → update tests. Do not change tests just to pass them. If test intent is unclear or conflicts with code, ask before proceeding.

### SIMPLICITY PROTOCOL
- Keep diffs focused and purpose-driven; avoid stylistic churn.
- Prefer existing repository conventions over introducing new patterns.
- Match existing code style first.
- No Speculation: Implement current requirements ONLY.
- Do NOT change code only to satisfy type checkers unless it fixes a real runtime, test, or build issue for this task.
- Reuse existing utilities before adding new helpers.
- Structure: Don't extract single-use helpers; extract only when repeated >3 times.
- Control Flow: Use Guard Clauses (`if err: return`). Prefer shallow nesting (≈2 levels when practical)

### ERROR HANDLING
- Boundaries: Catch exceptions ONLY at I/O, Network, or API boundaries.
- Transparency: Never swallow errors.
- Avoid redundant null checks when upstream validation is explicit.

### LANGUAGE STANDARDS
- TS/React: Functional components only. No `any`. Strict ESLint compliance.
- Code comments: Default to concise **Chinese comments** for non-obvious intent, boundaries, and constraints; do not add comments for obvious code.
