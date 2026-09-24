# FORK.md: how this fork works and is maintained

> **For agents:** read this whole file before making any change to this repository.
> Where it conflicts with `AGENTS.md`, this file wins, but only for branches, remotes, syncing and CI. The style, testing and typecheck rules in `AGENTS.md` still apply.

This repository is a fork of [`anomalyco/opencode`](https://github.com/anomalyco/opencode), called **upstream** below. It follows upstream's **V2 line** (`@opencode/cli`, the `v2` branch and its `v2.X.Y` release tags). It has two goals:

1. Keep our own changes and improvements.
2. Receive every upstream release **automatically**, with as little manual work as possible.

To get there, everything here is designed to **keep our diff against upstream as small and as isolated as possible**. Every line we change in upstream code can become a future conflict.

---

## 0. Variables

These are the configured values for this fork.

| Variable               | Value                                       | Description                                       |
| ---------------------- | ------------------------------------------- | ------------------------------------------------- |
| `FORK_OWNER`           | `nilparra-dev`                              | Owner of the fork                                 |
| `FORK_REPO`            | `opencodenil`                               | Fork repository name                              |
| `UPSTREAM_URL`         | `https://github.com/anomalyco/opencode.git` | Original repository                               |
| `UPSTREAM_TAG_PATTERN` | `^v2\.[0-9]+\.[0-9]+$`                      | Upstream releases we follow (stable V2 tags only) |
| `FORK_BRANCH`          | `custom`                                    | Main fork branch (our code)                       |
| `SYNC_BRANCH`          | `sync-upstream`                             | Branch the bot uses for syncs                     |

---

## 1. Branch and remote model

```
upstream tags  ── v2.0.16 ─────── v2.0.17 ───── v2.0.18 ──►   (anomalyco/opencode; read-only for us)
                      \               \              \
origin/custom  ────────●──○──○─────────●──○───────────●──►    (our main branch and the fork's default branch)
                          ↑  ↑         ↑              ↑
                        our commits  upstream      upstream
                                     release       release
                                     merge         merge
```

- **Remotes:**
  - `origin`: our fork (`github.com/nilparra-dev/opencodenil`).
  - `upstream`: `anomalyco/opencode`. **Never** push to `upstream`.
- **What we follow: release tags, not a branch tip.** The sync merges the newest stable tag matching `UPSTREAM_TAG_PATTERN` (`v2.0.16`, `v2.0.17`…). A tag is exactly what upstream shipped, so `custom` is always "upstream release X plus our changes". Upstream's `v2` branch runs ahead of the latest tag; we never merge it directly.
- **Branches:**
  - `custom`: the fork's main branch and its **default branch on GitHub**. It holds the latest upstream release plus our changes, and only receives changes through Pull Requests.
  - `sync-upstream`: a throwaway bot branch. It holds `custom` with the newest upstream release merged on top.
  - Work branches: branch off `custom` and return to `custom` through a PR. Names are at most three words separated by hyphens, with no slashes (per `AGENTS.md`). Examples: `custom-theme`, `fix-sync-ci`.
  - The fork has no `dev` or `v2` branch of its own.
- **Integration strategy: MERGE, not rebase.** `custom` is public and the bot works on it. Merging never rewrites history, never needs a force-push, resolves each conflict only once (and `rerere` remembers the resolution), and is safe to automate.
- **Critical rule:** sync PRs (`sync-upstream → custom`) are always integrated with a **merge commit**, **never with squash or rebase**. A squash breaks the ancestry link with upstream, and every later sync brings back the same conflicts.

### Note on `AGENTS.md` in this fork

`AGENTS.md` says the default branch is `v2`. **In this fork, read that as:**

- Base branch for work and PRs: `custom` (`origin/custom`).
- Diff for "what have we changed relative to upstream": `git diff <latest v2 tag>...custom`, for example `git diff v2.0.16...custom`. The command in section 7 finds the tag for you.

### History: the move from V1 to V2

Until September 2026 the fork followed `upstream/dev`, the V1 line (`opencode-ai`, `packages/opencode`). V1 went into maintenance while upstream's work moved to `v2`, so the fork moved too: `custom` was rebuilt from the `v2.0.16` tag with the fork changes ported, and the old `custom` history was joined with an `ours` merge so no force-push was needed. The V1-only patches were retired (see the end of section 7).

After moving from a V1 build to a V2 build, **log in to Anthropic again with "Claude Pro/Max"**. V2 imports V1 OAuth logins under a generic `oauth` method that has no refresh and is not recognized as a subscription.

---

## 2. Initial setup (one time)

Steps marked 👤 need a human (browser, credentials or decisions). An agent with authenticated `git` and `gh` can do the rest.

### 2.1 👤 Decision: public fork or private repository

| Option                             | How it is created                     | Pros                                                             | Cons                                                  |
| ---------------------------------- | ------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| **A. Public fork** (_Fork_ button) | GitHub → Fork                         | Visible link to upstream; PRs to upstream can be opened directly | Must be **public**                                    |
| **B. Private repository**          | Create an empty private repo and push | Code stays private                                               | Contributing to upstream needs a separate public fork |

Upstream is MIT-licensed, so both options are valid. The rest of this document works the same for A and B. This fork uses option A.

### 2.2 Create the repository and remotes

Starting from an existing upstream clone:

```bash
# Option A: create the public fork (copy all branches, not only the default one)
gh repo fork anomalyco/opencode --fork-name opencodenil --clone=false --default-branch-only=false
# Option B: create an empty private repository
gh repo create nilparra-dev/opencodenil --private

git remote rename origin upstream          # the current clone points at anomalyco → it becomes upstream
git remote add origin https://github.com/nilparra-dev/opencodenil.git
git remote set-url --push upstream DISABLED # prevents accidental pushes to upstream
git fetch upstream --tags

tag=$(git tag -l 'v2.*' | grep -E '^v2\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
git checkout -b custom "$tag"
git push -u origin custom
gh repo edit nilparra-dev/opencodenil --default-branch custom
# Option A: delete the branches copied by the fork that could trigger upstream workflows
git push origin --delete dev v2
```

### 2.3 Local git configuration (on every machine and every clone)

```bash
git config rerere.enabled true            # remembers how each conflict was resolved
git config rerere.autoupdate true
git config merge.conflictstyle zdiff3     # also shows the common base in conflicts
git config pull.ff only                   # never create implicit merges with a pull
git config fetch.prune true
```

On Windows, the repository may contain symlinks. Enable Developer Mode (Settings → System → For developers) so git can create them, then run `git config core.symlinks true` and `git checkout -- .` on a clean tree. Without this, symlinks are checked out as text files holding the target path and typecheck fails in the packages that use them.

### 2.4 👤 Token for the sync bot

`GITHUB_TOKEN` **does not work** for this, for two reasons:

1. It cannot push commits that modify `.github/workflows/**`, and upstream changes those often. The result is the error `refusing to allow a GitHub App to create or update workflow ... without workflows permission`.
2. PRs created with `GITHUB_TOKEN` **do not trigger** other workflows, so CI would never run on the sync PR.

Create a **fine-grained personal access token** scoped to `nilparra-dev/opencodenil` with these permissions:

| Permission    | Level                                        |
| ------------- | -------------------------------------------- |
| Contents      | Read and write                               |
| Pull requests | Read and write                               |
| Issues        | Read and write                               |
| Workflows     | Read and write                               |
| Actions       | Read and write (needed to disable workflows) |
| Metadata      | Read (required)                              |

Store it as a secret:

```bash
gh secret set FORK_SYNC_TOKEN --repo nilparra-dev/opencodenil   # paste the token when prompted
```

Set a reminder before it expires. Once it expires, `fork-sync` cannot disable workflows, push the sync branch or manage its PR.

Keep this token out of repository code execution. Do not define it at job scope or pass it to checkout when later steps run dependency installation, tests or code generation. Set `persist-credentials: false` on checkout, then expose `GH_TOKEN` only to steps that call `gh` or push.

### 2.5 GitHub repository settings

```bash
# Allow auto-merge and merge commits, both required for the sync PR
gh repo edit nilparra-dev/opencodenil \
  --enable-auto-merge \
  --enable-merge-commit \
  --delete-branch-on-merge=false

# Labels used by the workflows
gh label create fork-sync            --color 0E8A16 --description "Automated upstream sync PR" --repo nilparra-dev/opencodenil
gh label create fork-sync-conflict   --color D93F0B --description "Upstream sync needs conflict resolution" --repo nilparra-dev/opencodenil
gh label create needs-review         --color FBCA04 --description "Resolved by an agent; needs human review" --repo nilparra-dev/opencodenil
```

👤 In the UI (Settings → Branches → Add rule, or Rulesets) for the `custom` branch:

- **Require a pull request before merging** (no required approvals if you work alone; otherwise 1).
- **Require status checks to pass**: select `typecheck` and `test`, the aggregate checks from `fork-ci`. They only show up after `fork-ci` has run once.
- **Block force pushes** and **Restrict deletions**.

👤 In Settings → Actions → General:

- Enable Actions. They are disabled by default on forks.
- Under _Workflow permissions_, keep "Read repository contents" (each workflow requests what it needs).

### 2.6 Disable upstream workflows in the fork

Upstream ships many workflows (`publish.yml`, `deploy.yml`, `triage.yml`, `test.yml`…). They **must not run** in the fork, for three reasons:

- They use `blacksmith-*` runners we don't have, so their jobs sit in the queue until they fail.
- They need upstream's secrets.
- Some of them publish or deploy.

The `fork-sync` workflow automatically disables every workflow whose file name does not start with `fork-`, and does so on every run, so it also covers new workflows that upstream adds later. For the first time, run it by hand:

```bash
gh workflow list --repo nilparra-dev/opencodenil --all --limit 200 --json path,state \
  --jq '.[] | select(.state=="active") | select(.path | startswith(".github/workflows/fork-") | not) | .path' |
  while read -r p; do gh workflow disable "$(basename "$p")" --repo nilparra-dev/opencodenil; done
```

**Convention:** every fork workflow is named `.github/workflows/fork-*.yml`. No upstream file will ever have that prefix, so fork workflows never conflict.

### 2.7 Verify the setup

```bash
gh workflow run fork-sync.yml --repo nilparra-dev/opencodenil
gh run watch --repo nilparra-dev/opencodenil
```

Expected result: the workflow finishes green and one of these three things happens:

- There was no new upstream release.
- A `chore(fork): sync upstream` PR was created with auto-merge enabled.
- A `fork-sync-conflict` issue was opened.

---

## 3. How the automation works

```
every hour / manual
      │
      ▼
fork-sync.yml ──► disables upstream workflows that are not fork-*
      │
      ├─ newest upstream tag matching v2.X.Y (git ls-remote, no clone)
      │
      ├─ does the base already contain that tag and custom? ──► yes: stop (compare API, no clone)
      │     base = the open sync PR branch if there is one, otherwise custom
      ▼
 merge what is missing (custom, then the tag) into sync-upstream, starting from the base
      │
      ├─ no conflicts ──► regenerate client ──► push ──► PR (label fork-sync, auto-merge with merge commit)
      │                                                     │
      │                                                     ▼
      │                                      fork-ci.yml (typecheck + tests + generated)
      │                                                     │
      │                                          green ──► merged into custom automatically ✅
      │                                          red   ──► stays open for an agent or a human ⚠️
      │
      └─ conflicts ──► "fork-sync-conflict" issue listing the files
                            │
                            ├─ (optional) fork-resolve.yml: an agent resolves and opens a "needs-review" PR
                            └─ otherwise a local agent resolves it following section 6
```

- The schedule is hourly. Upstream publishes about one V2 release a day, so most runs find nothing new.
- The newest release is found with `git ls-remote` on upstream's tags; when the base already contains it, the workflow answers from the GitHub compare API without cloning and finishes in seconds.
- While a sync PR is open, the run builds on `sync-upstream` instead of rebuilding it from `custom`, so fixes pushed to the sync branch (section 6) are kept. It merges new `custom` commits into it (branch protection requires PRs to be up to date with `custom`, so otherwise auto-merge would stall) and then a newer release, if one appeared. A sync PR that already contains both is left alone.
- An open `fork-sync-conflict` issue is kept current by editing its body, not by adding a comment on every run.
- The sync PR is updated by pushing `sync-upstream`, which is a bot branch. `custom` is **never** force-pushed.
- Checkouts that only need history (`fork-sync`, the `publish` jobs) are blobless (`filter: blob:none`); `fork-resolve` keeps a full clone because the agent reads history.

---

## 4. Fork files

All of these files are **fork-only**: upstream does not have them, so they never conflict. The files themselves are the source of truth; this section explains what they do and why.

| File                                                        | Purpose                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `FORK.md`                                                   | This document: rules and patch ledger                                          |
| `CLAUDE.md`                                                 | Makes Claude Code load `AGENTS.md` and `FORK.md` (`@AGENTS.md` and `@FORK.md`) |
| `.github/workflows/fork-sync.yml`                           | Automatic sync with upstream releases (section 3)                              |
| `.github/workflows/fork-ci.yml`                             | Fork CI on standard GitHub runners (4.2)                                       |
| `.github/workflows/fork-resolve.yml`                        | (Optional) Conflict resolution by an agent (4.3)                               |
| `.github/actions/fork-setup-bun/action.yml`                 | Bun setup for fork workflows, caching `node_modules` by lockfile (4.4)         |
| `packages/core/src/plugin/provider/fork-anthropic-oauth.ts` | Claude Pro/Max login (ledger F-002)                                            |
| `packages/core/test/plugin/fork-anthropic-oauth.test.ts`    | Tests for it                                                                   |

The only changes to upstream files are the ones in the ledger (section 7).

### 4.1 `fork-sync.yml`

Described in section 3. Security notes that must stay true when editing it:

- `FORK_SYNC_TOKEN` is only exposed to steps that call `gh` or push, never to steps that run repository code (`bun install`, `bun run generate`).
- The job that runs repository code has read-only permissions. It hands the merged branch to a separate `publish` job as a Git bundle, and only `publish` pushes.

### 4.2 `fork-ci.yml`

This is a reduced fork CI gate on standard GitHub runners (`ubuntu-latest`), not a replacement for all upstream checks. It runs typecheck, Linux unit tests and the generated-client check, split across parallel jobs:

- `changes` decides what the PR needs. A PR that only touches `*.md` files runs nothing. A PR that touches any other file outside `packages/` (lockfile, patches, workflows, `services/`, root config; every sync PR) runs everything. Otherwise only the packages that `turbo ls --affected` reports run, which includes every package depending on a changed one. Skipped jobs count as passing for branch protection; if `changes` itself fails, `test` fails.
- `typecheck (heavy)` (the slowest packages, listed in `HEAVY` in the `changes` job), `typecheck (rest)` (every other affected package, plus the generated-client check), `unit` (affected packages except `@opencode/core`) and eight `core (N/8)` shards (`bun test --shard`) run in parallel. Packages upstream adds later fall into `rest` automatically; `HEAVY` only needs revisiting if one group becomes much slower than the other. `packages/core` holds most of the test time, so it is the only package that is sharded. `bun test --shard` splits by file count, not by duration, so shards are uneven; more shards keep the slowest one short.
- `typecheck` and `test` aggregate those jobs so branch protection can keep requiring the `typecheck` and `test` checks. Both fail if `changes` fails.
- It runs on PRs and on demand. Pushes to `custom` run only the `cache` job, and only when the lockfile, patches or a workspace `package.json` change, to save the `node_modules` cache where every PR can read it (caches saved by a PR are private to that PR).
- Every job installs dependencies through `fork-setup-bun` (4.4), which restores `node_modules` instead of Bun's download cache.

The workflow does not run Windows unit tests, E2E tests, the compiled-service smoke test or the generated-documentation check that upstream's `test.yml` runs. Add those jobs and require their checks in branch protection if sync PRs must pass them before auto-merge.

If upstream tests fail for reasons unrelated to our changes (flaky or environment-dependent tests), **do not disable them wholesale**. Record the specific test in section 8 and exclude it explicitly.

### 4.3 `fork-resolve.yml` (optional, maximum automation)

When a `fork-sync-conflict` issue is opened, this workflow has an opencode agent try to resolve the conflict in CI. **It never auto-merges**: it opens a PR labeled `needs-review` for a human to check. Resolution runs in a read-only job; a separate clean job publishes the resolved merge from a Git bundle. The agent still needs a provider credential, so use a dedicated key with a low spend limit and keep this workflow disabled unless you accept that the agent process can access that key.

To enable it:

- `gh variable set FORK_AGENT_RESOLVE --body true`
- `gh variable set FORK_AGENT_MODEL --body "<provider/model>"`
- Add the provider's API key as a secret, for example `gh secret set ANTHROPIC_API_KEY`.

### 4.4 `fork-setup-bun/action.yml`

Fork workflows use this action instead of upstream's `.github/actions/setup-bun`, which we do not edit. It installs the same Bun version, but caches the installed `node_modules` trees (`packages/*`, `packages/*/*` and `services/*` workspaces) keyed by `bun.lock`, `patches/**` and the workspace `package.json` files. An exact hit skips `bun install`; a partial hit runs it to complete the tree. With `install: "false"` it only puts Bun on `PATH`. It saves the cache only outside pull requests: `fork-sync` saves it for each merged lockfile, and `fork-ci` does so on pushes to `custom` that change those inputs.

---

## 5. Rules for agents changing the fork

### 5.1 Before changing code: extension hierarchy

Use **the first option that solves the problem**. The further down the list, the higher the maintenance cost.

1. **User configuration** (`~/.config/opencode/`, global `opencode.jsonc`): does not touch the repo.
2. **Project extension points** in new files: plugins, agents, commands, tools, skills, themes and MCP servers under `.opencode/`. **Create new files with a `fork-` prefix** and do not edit the existing ones.
3. **Published or local plugin** using the `@opencode/plugin` API (integration methods, `session.hook(...)` for `context`, `model.request`, `http.request`, `retry` and others): the behavior lives outside the core.
4. **New `fork-` file inside a package** that the core imports from **a single point**, such as the `ProviderPlugins` list in `packages/core/src/plugin/provider.ts`: any possible conflict shrinks to that one line. The Claude Pro/Max login (F-002) is built this way.
5. **Modifying existing upstream code**: last resort. It must be recorded in the ledger (section 7).

Plugin hooks run in registration order, and config and user plugins register after the internal ones. A fork plugin that must see the final request (for example the final system prompt) should work in `http.request` on the wire request rather than in `context`.

### 5.2 If upstream code must change

- **Keep changes minimal and local.** Do not reformat, rename, reorder imports or make drive-by "improvements" to code you don't own.
- **Add rather than modify:** a new `if` branch, a new array entry or a new file is better than rewriting a function.
- Mark the block with a `// fork: <short reason>` comment so it stands out in conflicts.
- **Avoid files that change a lot upstream.** To check: `git log --since="30 days ago" --oneline upstream/v2 -- <file> | wc -l`. If it returns more than 10, look for a different hook point.
- **Do not edit** generated files (`packages/client/src/promise/generated`, `packages/client/src/effect/generated`, `packages/client/src/effect/api`, `*.gen.ts`). Regenerate them instead (see `AGENTS.md`).
- **Avoid** changing migrations or the database schema, and **avoid** adding dependencies to upstream `package.json` files. These are the most expensive conflicts (`bun.lock`). If there is no alternative, record it in the ledger.
- If the change would help anyone, **propose it upstream** (section 9). Once accepted, the fork's diff shrinks.

### 5.3 Workflow

```bash
git fetch origin
git fetch upstream --tags
git checkout -b <short-branch> origin/custom
# ... changes ...
cd packages/<package> && bun typecheck          # never tsc, never from the root
cd packages/<package> && bun test <files>       # tests never run from the root
git commit -m "feat(<scope>): ..."              # conventional commits (AGENTS.md)
git push -u origin <short-branch>
gh pr create --base custom --fill
```

- Feature PRs may be squashed. **Sync PRs may not** (section 1).
- If a PR touches upstream code, **update section 7 in the same PR**.
- If a sync lands on `custom` while your branch is open, run `git merge origin/custom` on your branch. Do not rebase branches that have already been shared.

### 5.4 What an agent NEVER does

- Push or open a PR to `upstream` unless a human explicitly asks.
- Force-push `custom`.
- Rebase `custom`, or integrate a sync PR with squash or rebase.
- Commit directly to `custom` (always go through a PR).
- Merge upstream's `v2` or `dev` branch tip into `custom`; only release tags are merged.
- Re-enable upstream workflows, or edit `.github/workflows/*.yml` files that do not start with `fork-`.
- Delete or disable upstream tests to make CI pass.
- Resolve a conflict by dropping a fork change recorded in section 7 without saying so in the PR.

---

## 6. Conflict resolution procedure (for agents)

Use this when a `fork-sync-conflict` issue exists, when CI fails on a `fork-sync` PR, or when `fork-resolve` runs.

### 6.1 Prepare

```bash
git fetch origin
git fetch upstream --tags
tag=$(git tag -l 'v2.*' | grep -E '^v2\.[0-9]+\.[0-9]+$' | sort -V | tail -1)   # the release named in the issue
git checkout -B sync-upstream origin/custom
git merge --no-ff "$tag" -m "chore(fork): merge upstream $tag"   # rerere reapplies known resolutions
git diff --name-only --diff-filter=U  # remaining conflicts
```

### 6.2 Resolve each file by type

| File type                                                                                                                                                      | Action                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated (`packages/client/src/promise/generated`, `packages/client/src/effect/generated`, `packages/client/src/effect/api`, `*.gen.ts`, migration snapshots) | `git checkout --theirs -- <file>`, then regenerate (6.3)                                                                                                                          |
| `bun.lock`                                                                                                                                                     | `git checkout --theirs -- bun.lock`, then `bun install` (reapplies our dependencies, if any) and `git add bun.lock`                                                               |
| `package.json`                                                                                                                                                 | Union: upstream versions plus our entries recorded in section 7                                                                                                                   |
| `.github/workflows/*` that are not `fork-*`                                                                                                                    | `git checkout --theirs -- <file>` (they are disabled; their content doesn't matter)                                                                                               |
| File **recorded in section 7**                                                                                                                                 | Start from the upstream version (`--theirs`) and **reapply the intent** described in the ledger, adapted to the new API. Don't try to keep the old code if upstream refactored it |
| File **not recorded** in section 7                                                                                                                             | We had no intentional change there: `git checkout --theirs -- <file>`                                                                                                             |
| `AGENTS.md`                                                                                                                                                    | Upstream version plus the pointer line as the first line (F-001)                                                                                                                  |
| `FORK.md`, `CLAUDE.md`, `fork-*`                                                                                                                               | Should never conflict. If they do, keep ours (`--ours`)                                                                                                                           |

Notes:

- During a merge into `custom`, `--ours` is the fork and `--theirs` is upstream.
- If upstream **implemented on its own** something the fork carried as a patch, adopt the upstream version and **remove the entry** from the ledger.
- If upstream **deleted** a file we modified (modify/delete conflict), find where the logic moved (`git log --follow --diff-filter=R "$tag" -- <path>`, or `grep` for the symbols) and reapply the intent there.
- A fork-only file can also break without a textual conflict when upstream changes an API it uses. `fork-ci` catches that as a typecheck or test failure on the sync PR; fix it on `sync-upstream` like any other failure.

### 6.3 Regenerate and verify

```bash
bun install
(cd packages/client && bun run generate)
git add -A

# Required checks before committing
git diff --name-only --diff-filter=U        # must be empty
git grep -nE '^(<<<<<<<|>>>>>>>)( |$)' -- . ':!*.md'   # must be empty
(cd packages/core && bun typecheck)         # plus every package touched by the ledger
(cd packages/core && bun test test/plugin/fork-anthropic-oauth.test.ts)
```

### 6.4 Finish

```bash
git commit --no-edit        # keeps the merge message
git push --force origin sync-upstream
gh pr create --base custom --head sync-upstream --title "chore(fork): sync upstream" --label fork-sync \
  --body "Resolves #<issue>. Upstream <tag>. Conflicts: <list>. Ledger changes: <if any>."
gh pr merge sync-upstream --auto --merge
```

- In the PR body, explain how the intent was reapplied for each section 7 file that conflicted.
- Close the `fork-sync-conflict` issue when the PR merges (`Resolves #N` does it automatically).
- If a conflict **cannot be resolved safely** (the ledger intent no longer makes sense with upstream's new architecture), do not guess: comment on the issue with what changed, propose options, and leave the PR as a draft.

---

## 7. Ledger of fork changes to upstream code

> Every change to a file that exists upstream **must** be listed here. This is the source of truth for resolving conflicts: it describes the **intent**, not the lines.
> Fork-only files (`fork-` prefix, `.opencode/**/fork-*`, `FORK.md`, `CLAUDE.md`) do not need entries, but the behavior they carry is described here when an upstream file registers them.

| ID    | Upstream file(s)                                                                    | Intent (what must stay true)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Reason                                                                                                                                 | Propose upstream?                   |
| ----- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| F-001 | `AGENTS.md` (line 1)                                                                | Agents know this is a fork and read `FORK.md` first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fork infrastructure                                                                                                                    | No                                  |
| F-002 | `packages/core/src/plugin/provider.ts` (one import and one `ProviderPlugins` entry) | `ForkAnthropicOAuthPlugin` from the fork-only `fork-anthropic-oauth.ts` is registered. It (1) adds a "Claude Pro/Max" OAuth method with refresh to the `anthropic` integration, keeping method ID `claude-pro-max`; (2) with that credential active, rewrites every Anthropic HTTP request so the system field is exactly the Claude Code identity, opencode's system prompt becomes the first user turn, and the Claude Code headers are sent (`anthropic-beta` appended to existing betas, `User-Agent`, `x-app`); (3) stops retries on subscription-window exhaustion; (4) makes concurrent refreshes of one rotating refresh token share a single token request. API-key auth and other providers are untouched. Upstream already sends OAuth credentials to Anthropic as a bearer token | Claude Pro/Max login; Anthropic rejects consumer OAuth requests that do not look like Claude Code, and rejects replayed refresh tokens | No (upstream removed it on purpose) |

To check that the ledger is complete, list the upstream files the fork modifies (fork-only files excluded):

```bash
tag=$(git tag -l 'v2.*' | grep -E '^v2\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
git diff --name-only "$tag"...custom
```

This includes modified, added and deleted paths. Every upstream file in that list must appear in the table.

### Retired entries

Entries from the V1 era, kept so their IDs are not reused:

| ID                 | What it was                                                                                       | Why it is gone                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-002 (V1) … F-005 | Claude Pro/Max login in `packages/opencode`, provider picker hints and `providers.mdx` docs       | `packages/opencode` does not exist in V2. The V2 pickers list integration methods by label, and the fork does not publish the docs site. The login lives in the new F-002 |
| F-006              | Terminal subscription-window exhaustion in `packages/opencode/src/session/retry.ts`               | Moved into the F-002 plugin as a `retry` hook. Upstream V2 also classifies "usage limit" 429s as quota errors and caps Retry-After at 15 minutes                          |
| F-007              | TUI display for the `TodoWrite` wire alias                                                        | V2 has no `todowrite` tool                                                                                                                                                |
| F-008              | Anthropic OAuth in the V2 runner (`model.ts`, `llm.ts`, `compaction.ts`, provider `anthropic.ts`) | Upstream's runner was rewritten and now sends OAuth as a bearer token. The rest is done by the F-002 plugin through hooks, with no edits to upstream files                |
| F-009              | Refresh lock in `packages/core/src/integration.ts`                                                | Replaced by refresh sharing inside the F-002 plugin                                                                                                                       |
| F-010              | Spy cleanup in `packages/opencode/test/cli/tui/editor-context.test.tsx`                           | File does not exist in V2                                                                                                                                                 |

---

## 8. Known exceptions

Upstream tests or checks that fail in `fork-ci` because of the environment, not because of our changes. Review them from time to time in case upstream has fixed them.

| Test / check | Reason | Since |
| ------------ | ------ | ----- |
| _(none)_     |        |       |

---

## 9. Contributing upstream

Best for generic improvements: every change upstream accepts is one less to maintain.

```bash
git fetch upstream
git checkout -b <short-branch> upstream/v2         # from upstream, NOT from custom
git cherry-pick <commits>                          # or redo the change cleanly
# Option A: git push origin <short-branch> && gh pr create --repo anomalyco/opencode --base v2
# Option B: push to a separate public fork
```

- Follow `AGENTS.md` to the letter: conventional commits and the project's style.
- Once upstream accepts it and it ships in a release, the next sync brings it in. At that point **remove the entry** from section 7 and, if it conflicts, keep the upstream version.

---

## 10. Using the fork build

```bash
bun install
bun run dev                                            # development, from the root (runs packages/cli)
cd packages/cli && bun run build --single              # binary for the current platform only → packages/cli/dist/<platform>/bin/
```

To avoid clashing with an official install, run the fork binary under an alias (for example `opencodenil`) instead of replacing the official one. The fork build shares configuration, logins and the database with the official `opencode`.

---

## 11. Quick troubleshooting

| Symptom                                                           | Likely cause                                                 | Fix                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `fork-sync` fails at checkout or push with 401/403                | `FORK_SYNC_TOKEN` expired or missing permissions             | Regenerate the token (2.4)                                                   |
| `refusing to allow ... workflow ... without workflows permission` | Token lacks the _Workflows_ permission                       | Add _Workflows: write_                                                       |
| `fork-sync` fails with "no upstream release tag matches"          | Upstream changed its tag scheme or moved to a new major line | Update `UPSTREAM_TAG_PATTERN` in `fork-sync.yml` and `fork-resolve.yml`      |
| The `fork-sync` PR doesn't run `fork-ci`                          | PR was created with `GITHUB_TOKEN`                           | Use `FORK_SYNC_TOKEN` for `gh`                                               |
| Jobs stuck in the queue waiting for a `blacksmith-*` runner       | An upstream workflow is active                               | Run the command from 2.6                                                     |
| The same conflicts come back on every sync                        | A sync PR was squashed or rebased                            | Merge the upstream tag into `custom` again with a merge commit; never squash |
| Auto-merge doesn't turn on                                        | Auto-merge disabled or no required checks                    | Section 2.5                                                                  |
| `check:generated` fails                                           | The client was not regenerated after the merge               | `cd packages/client && bun run generate`                                     |
| The `pre-push` hook fails on the Bun version                      | Local Bun differs from `packageManager`                      | Install the version in `package.json` → `packageManager`                     |
| A green sync PR does not auto-merge                               | `custom` advanced and the PR is out of date                  | The next hourly `fork-sync` merges `custom` into it; or run it by hand       |
| Claude Pro/Max requests fail with 401/429 after moving from V1    | The V1 login was imported without refresh                    | Log in again and pick "Claude Pro/Max" (section 1)                           |
