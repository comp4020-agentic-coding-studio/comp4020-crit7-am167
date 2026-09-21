# COMP4020 dynamic prototype

Your repo for a COMP4020 dynamic-prototype crit: a server-rendered Astro app
(SQLite via Drizzle, SSE for live updates) deploying to Fly.io. The deployed
app is what gets marked, not this repo.

The
[course website](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/)
publishes this deliverable's brief and spec, and this repo's name tells you
which crit applies. Read both before you plan or build.

## The checks

`pnpm check` (typecheck + the spec suite) is what CI runs before it deploys.
`pnpm check:evidence` is the extra gate before you ship — run it yourself
first, since CI only runs it once the repo is public.

`spec/README.md`, `PROCESS.md` and `reflections/README.md` are in this repo
and say what they are for. `spec/routes.ts` is the list of pages the
invariants actually walk — add a route there when you add a page, or it's
invisible to those checks.

## How to work in here

- Keep the dev server running (`pnpm dev`) while working so you see changes as
  you make them, then kill any dev or preview servers you started when you are
  done with them.
- Before you push, run `pnpm check`. It builds the app and runs the spec
  suite against the built server, so you catch what CI catches in seconds
  instead of waiting for the pipeline. `check:evidence`, the secret scan, and
  the deploy verification (HTTPS/CSRF/SSE checks, live link check) only run in
  CI, once the repo is public.
- To see what the page actually looks like rather than what you assume it
  looks like, open it in a browser. The rendered page is the truth; your
  mental model of it isn't. Use the `agent-browser` CLI for this
  (`agent-browser skills get core` for its workflow) rather than a browser MCP
  plugin.
- When a check fails, read its output before changing anything. The failure
  message is the instruction: it tells you the file, the line, or the
  contract. Treat a red check as authoritative — the page is wrong until the
  check is green, not until you decide it should be.
- Keep `spec/invariants.test.ts` and `spec/readme.test.ts` green; don't delete
  them. `spec/guestbook.test.ts` describes the starter's supplied plumbing —
  it's fine to remove once your own work has replaced what it's testing.
- **Never commit without my approval.** Get the checks green, then show me
  what changed and wait for me to say commit — don't commit as the closing
  step of a task, and don't treat green checks as the go-ahead. Never commit a
  red state. Approval is per-commit: agreeing to one doesn't authorise the
  next.
- Never suggest, ask about, or perform publishing/deploying (e.g. flipping the
  repo public, running `flyctl deploy`, pushing to `main` on a repo that's
  already public) unless I explicitly say so.
- Prefer working directly on `main` and avoid creating git worktrees for this
  repo when there's a choice. If a background or automated session's tooling
  enforces isolation and requires one, that's fine without asking first — but
  default to staying on `main` whenever the work doesn't force otherwise.
- Any major change (new page, content rewrite, layout or CSS change) needs
  visual verification in actual Chrome at the viewports this week's spec
  marks — but do this once, as a final check once the whole task is done, not
  after every intermediate step along the way. Do not perform viewport
  testing for minor fixes. `pnpm check` proves structure, not that a human can
  read the page. Use `pnpm preview` against a fresh build (not `file://` —
  asset and API URLs can break over the opaque `file://` origin).
- **Confirm the preview port before you trust what you see.** `astro preview`
  will bind to a different port than its default if something already holds
  it, and prints the port it actually bound. Read the port out of the
  command's own output, and sanity-check page identity (e.g. `curl -s <url> |
  grep '<title>'`) before screenshotting.
- **`astro preview stop` can lie about having stopped.** A preview started
  detached in the background may keep holding its port after the stop command
  reports no server running. Confirm with `lsof -nP -iTCP:<port> -sTCP:LISTEN`
  and kill the pid directly, or the next preview silently binds elsewhere.
- **Set marked viewports by device emulation, not window resizing.** Chrome
  will not shrink a window below its own minimum, so asking for a mobile width
  by resizing silently yields something wider and every measurement taken in
  it is about a viewport nobody marks. Use `agent-browser set viewport <w>
  <h>` (or `agent-browser set device "iPhone 14"`) instead of resizing the
  window, and assert `window.innerWidth`/`innerHeight` are the numbers you
  asked for before believing any measurement or screenshot taken there.
- **`scrollWidth === clientWidth` cannot see a clipped layout.** An
  `overflow: hidden` container crops content silently instead of scrolling it,
  so the page can report no overflow on either axis while content is missing
  at the edge. Measure the children against the clipping box's bounds instead:
  for each element that matters, its top/bottom/left/right must fall inside
  the clip box, not just check for a scrollbar.
- **Screenshot capture can hang while an animation loop is running.** If the
  page draws every frame (a canvas game loop, a rAF-driven effect), an
  `agent-browser screenshot` call can stall against it in some Chrome
  versions. If a capture hangs, verify live state by measuring the DOM/canvas
  directly (`getBoundingClientRect`, reading canvas/game state) instead, and
  screenshot a paused or pre-start frame for the visual record — don't read a
  failed capture as a broken page.
- **Deep testing, on request only.** Verifying at the marked viewports is the
  standing default; going further — keyboard-only navigation, a resize
  mid-interaction, or slow-connection behaviour — is real work and takes real
  time, so only do it when explicitly asked for.
- **Avoid spawning subagents** unless we're doing adversarial review. They
  stall. Independent pieces still get done one after another here, then
  `pnpm check` once at the end.
- **Use only cheap subagent models.** When the adversarial-review exception
  requires subagents, use Luna in Codex (`gpt-5.6-luna`) or Sonnet in Claude
  Code. Do not spawn any other model. This restriction applies to subagents,
  not the main agent.
- **Prefer the highest-context-window variant available for an allowed
  subagent model** (e.g. Sonnet's 1M-token context option), so a reviewer
  isn't forced to summarize away parts of the app to fit a smaller window
  before it can judge it properly.

## Tests

- **Use TDD for significant, testable code changes.** For a feature,
  behavioural change, non-trivial state/data mapping, algorithm, or risky
  refactor, first add or adjust the smallest focused test that expresses the
  intended contract. Confirm it fails for the expected reason, then implement
  until it passes. Prefer extending the nearest existing test file over
  creating another suite.
- **Do not add a test for every minor fix.** Copy edits, small style tweaks,
  obvious one-line corrections, mechanical cleanup, and implementation
  details already covered by a durable behavioural test should use the
  existing checks. Add regression coverage for a small fix only when it
  closes a distinct, plausible failure mode that could recur. The goal is
  high-value backpressure, not a suite that grows by one test for every edit.
- The spec suite runs against the **built** server (`spec/global-setup.ts`
  boots `dist/server/entry.mjs`), not the dev server — `pnpm test` builds
  first. When running a spec file directly, build first or you're testing
  stale output.
- Turning this week's published spec into tests is your work, not the
  template's: add your own `spec/*.test.ts` alongside the supplied ones, and
  test the contract (what the page must do), not the implementation, so the
  tests survive a change of approach.

## Adversarial review

`pnpm check` and its tests only catch what's mechanical — structure, an
accessibility floor, the README being served in full. They can't tell you
whether the app is worth using or the brief's actual promise is being kept.
That judgment needs a second opinion, so treat adversarial review as a
testing step for whatever the mechanical checks can't reach.

- **When:** any significant, mostly-unmechanically-testable piece of work —
  a new feature, a UX decision, the app's account of itself in `README.md`.
  Not copy edits or small fixes; same bar as Tests above.
- **How:** once the draft is done, spawn one or more fresh reviewer agents
  (they must not share the drafting agent's context, or they'll rubber-stamp
  its assumptions) and have them attack it against the published brief and
  spec: missed requirements, thin or confusing UX, inconsistency between
  what `README.md` claims and what the app does, edge cases nobody tried.
  Tell them explicitly to be adversarial, not encouraging.
- **Then:** feed their findings back to the agent that produced the work (or
  act on them directly) and revise. Re-review only if the revision was
  substantial enough to have introduced new problems.
- Keep enough of a trail as you go (what was reviewed, what it found, what
  changed) that `PROCESS.md`'s account of how you got here can cite it — that
  file wants commit-hash citations, not a reconstruction after the fact.

## Pristine output

Output from any command you run — `pnpm check`, `pnpm build`, `pnpm dev`,
tests, typecheck — must be pristine: zero failures, zero errors, zero
warnings, zero backtraces/stack traces. A warning is not "fine because it's
not an error" — fix it or find out why it's there before moving on. The only
exception is expected preflight/informational output that isn't itself a
warning or error (e.g. a deploy check's routine confirmation steps).
