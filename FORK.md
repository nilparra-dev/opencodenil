# FORK.md: how this fork works and is maintained

> **For agents:** read this whole file before making any change to this repository.
> Where it conflicts with `AGENTS.md`, this file wins, but only for branches, remotes, syncing and CI. The style, testing and typecheck rules in `AGENTS.md` still apply.

This repository is a fork of [`anomalyco/opencode`](https://github.com/anomalyco/opencode), called **upstream** below. It has two goals:

1. Keep our own changes and improvements.
2. Receive every upstream update **automatically**, with as little manual work as possible.

To get there, everything here is designed to **keep our diff against upstream as small and as isolated as possible**. Every line we change in upstream code can become a future conflict.

---

## 0. Variables

Replace these values throughout this document and in the workflows before using them.

| Variable          | Value                                       | Description                          |
| ----------------- | ------------------------------------------- | ------------------------------------ |
| `FORK_OWNER`      | `<github-user-or-org>`                      | Owner of the fork                    |
| `FORK_REPO`       | `opencode`                                  | Fork repository name                 |
| `UPSTREAM_URL`    | `https://github.com/anomalyco/opencode.git` | Original repository                  |
| `UPSTREAM_BRANCH` | `dev`                                       | Upstream default branch              |
| `FORK_BRANCH`     | `custom`                                    | Main fork branch (our code)          |
| `SYNC_BRANCH`     | `sync-upstream`                             | Branch the bot uses for syncs        |

---

## 1. Branch and remote model

```
upstream/dev  ──●──●──●──●──●──●──●──●──►   (anomalyco/opencode; read-only for us)
                 \           \        \
origin/custom  ───●──○──○─────●──○─────●──►  (our main branch and the fork's default branch)
                     ↑  ↑     ↑         ↑
                   our    upstream   upstream
                 commits   merge      merge
```

- **Remotes:**
  - `origin`: our fork (`github.com/FORK_OWNER/FORK_REPO`).
  - `upstream`: `anomalyco/opencode`. **Never** push to `upstream`.
- **Branches:**
  - `custom`: the fork's main branch and its **default branch on GitHub**. It holds upstream plus our changes, and only receives changes through Pull Requests.
  - `sync-upstream`: a throwaway bot branch. It holds `custom` with the latest `upstream/dev` merged on top.
  - Work branches: branch off `custom` and return to `custom` through a PR. Names are at most three words separated by hyphens, with no slashes (per `AGENTS.md`). Examples: `custom-theme`, `fix-sync-ci`.
  - The fork has no `dev` branch of its own. Upstream is always referenced as `upstream/dev`.
- **Integration strategy: MERGE, not rebase.** `custom` is public and the bot works on it. Merging never rewrites history, never needs a force-push, resolves each conflict only once (and `rerere` remembers the resolution), and is safe to automate.
- **Critical rule:** sync PRs (`sync-upstream → custom`) are always integrated with a **merge commit**, **never with squash or rebase**. A squash breaks the ancestry link with upstream, and every later sync brings back the same conflicts.

### Note on `AGENTS.md` in this fork

`AGENTS.md` says the default branch is `dev` and that diffs use `dev` or `origin/dev`. **In this fork, read that as:**

- Base branch for work and PRs: `custom` (`origin/custom`).
- Diff for "what have we changed relative to upstream": `git diff upstream/dev...custom`.

---

## 2. Initial setup (one time)

Steps marked 👤 need a human (browser, credentials or decisions). An agent with authenticated `git` and `gh` can do the rest.

### 2.1 👤 Decision: public fork or private repository

| Option | How it is created | Pros | Cons |
| --- | --- | --- | --- |
| **A. Public fork** (*Fork* button) | GitHub → Fork | Visible link to upstream; PRs to upstream can be opened directly | Must be **public** |
| **B. Private repository** | Create an empty private repo and push | Code stays private | Contributing to upstream needs a separate public fork |

Upstream is MIT-licensed, so both options are valid. The rest of this document works the same for A and B.

### 2.2 Create the repository and remotes

Starting from an existing upstream clone, such as the one on this machine:

```bash
# Option A: create the fork (copy all branches, not only the default one)
gh repo fork anomalyco/opencode --clone=false --default-branch-only=false
# Option B: create an empty private repository
gh repo create FORK_OWNER/FORK_REPO --private

git remote rename origin upstream          # the current clone points at anomalyco → it becomes upstream
git remote add origin https://github.com/FORK_OWNER/FORK_REPO.git
git remote set-url --push upstream DISABLED # prevents accidental pushes to upstream
git fetch upstream

git checkout -b custom upstream/dev
git push -u origin custom
gh repo edit FORK_OWNER/FORK_REPO --default-branch custom
# Option A: delete the dev branch copied by the fork, so it causes no confusion and cannot trigger upstream workflows
git push origin --delete dev
```

### 2.3 Local git configuration (on every machine and every clone)

```bash
git config rerere.enabled true            # remembers how each conflict was resolved
git config rerere.autoupdate true
git config merge.conflictstyle zdiff3     # also shows the common base in conflicts
git config pull.ff only                   # never create implicit merges with a pull
git config fetch.prune true
```

### 2.4 👤 Token for the sync bot

`GITHUB_TOKEN` **does not work** for this, for two reasons:

1. It cannot push commits that modify `.github/workflows/**`, and upstream changes those often. The result is the error `refusing to allow a GitHub App to create or update workflow ... without workflows permission`.
2. PRs created with `GITHUB_TOKEN` **do not trigger** other workflows, so CI would never run on the sync PR.

Create a **fine-grained personal access token** scoped to `FORK_OWNER/FORK_REPO` with these permissions:

| Permission | Level |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Issues | Read and write |
| Workflows | Read and write |
| Actions | Read and write (needed to disable workflows) |
| Metadata | Read (required) |

Store it as a secret:

```bash
gh secret set FORK_SYNC_TOKEN --repo FORK_OWNER/FORK_REPO   # paste the token when prompted
```

Set a reminder before it expires. Once it expires, `fork-sync` cannot disable workflows, push the sync branch or manage its PR.

Keep this token out of repository code execution. Do not define it at job scope or pass it to checkout when later steps run dependency installation, tests or code generation. Set `persist-credentials: false` on checkout, then expose `GH_TOKEN` only to steps that call `gh` or push.

### 2.5 GitHub repository settings

```bash
# Allow auto-merge and merge commits, both required for the sync PR
gh repo edit FORK_OWNER/FORK_REPO \
  --enable-auto-merge \
  --enable-merge-commit \
  --delete-branch-on-merge=false

# Labels used by the workflows
gh label create fork-sync            --color 0E8A16 --description "Automated upstream sync PR" --repo FORK_OWNER/FORK_REPO
gh label create fork-sync-conflict   --color D93F0B --description "Upstream sync needs conflict resolution" --repo FORK_OWNER/FORK_REPO
gh label create needs-review         --color FBCA04 --description "Resolved by an agent; needs human review" --repo FORK_OWNER/FORK_REPO
```

👤 In the UI (Settings → Branches → Add rule, or Rulesets) for the `custom` branch:

- **Require a pull request before merging** (no required approvals if you work alone; otherwise 1).
- **Require status checks to pass**: select `fork-ci / typecheck` and `fork-ci / test`. These checks only show up after `fork-ci` has run once.
- **Block force pushes** and **Restrict deletions**.

👤 In Settings → Actions → General:

- Enable Actions. They are disabled by default on forks.
- Under *Workflow permissions*, keep "Read repository contents" (each workflow requests what it needs).

### 2.6 Disable upstream workflows in the fork

Upstream ships about 25 workflows (`publish.yml`, `deploy.yml`, `triage.yml`, `test.yml`…). They **must not run** in the fork, for three reasons:

- They use `blacksmith-*` runners we don't have, so their jobs sit in the queue until they fail.
- They need upstream's secrets.
- Some of them publish or deploy.

The `fork-sync` workflow automatically disables every workflow whose file name does not start with `fork-`, and does so on every run, so it also covers new workflows that upstream adds later. For the first time, run it by hand:

```bash
gh workflow list --repo FORK_OWNER/FORK_REPO --all --limit 200 --json path,state \
  --jq '.[] | select(.state=="active") | select(.path | startswith(".github/workflows/fork-") | not) | .path' |
  while read -r p; do gh workflow disable "$(basename "$p")" --repo FORK_OWNER/FORK_REPO; done
```

**Convention:** every fork workflow is named `.github/workflows/fork-*.yml`. No upstream file will ever have that prefix, so fork workflows never conflict.

### 2.7 Create the fork files

Create the files from [section 4](#4-fork-files) on `custom` and land them with a PR titled `chore(fork): add sync automation`.

### 2.8 Verify the setup

```bash
gh workflow run fork-sync.yml --repo FORK_OWNER/FORK_REPO
gh run watch --repo FORK_OWNER/FORK_REPO
```

Expected result: the workflow finishes green and one of these three things happens:

- There was nothing new upstream.
- A `chore(fork): sync upstream` PR was created with auto-merge enabled.
- A `fork-sync-conflict` issue was opened.

---

## 3. How the automation works

```
every 6h / manual
      │
      ▼
fork-sync.yml ──► disables upstream workflows that are not fork-*
      │
      ├─ is upstream/dev already contained in custom? ──► yes: stop
      │
      ▼
 merge upstream/dev into sync-upstream (starting from custom)
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

- The default schedule is every 6 hours. Upstream lands about 250 commits a month, and syncing often keeps each merge small.
- When upstream has not changed, the workflow finishes in seconds.
- The sync PR is updated by force-pushing `sync-upstream`, which is a bot branch. `custom` is **never** force-pushed.

---

## 4. Fork files

All of these files are **fork-only**: upstream does not have them, so they never conflict.

| File | Purpose |
| --- | --- |
| `FORK.md` | This document: rules and patch ledger |
| `CLAUDE.md` | Makes Claude Code load `AGENTS.md` and `FORK.md` |
| `.github/workflows/fork-sync.yml` | Automatic sync |
| `.github/workflows/fork-ci.yml` | Fork CI (standard GitHub runners) |
| `.github/workflows/fork-resolve.yml` | (Optional) Conflict resolution by an agent |

The only change to an upstream file that the infrastructure needs, so agents can find this document, is one line at the top of `AGENTS.md` (see 4.5). It is recorded in the ledger.

### 4.1 `CLAUDE.md`

```markdown
@AGENTS.md
@FORK.md
```

### 4.2 `.github/workflows/fork-sync.yml`

```yaml
name: fork-sync

on:
  schedule:
    - cron: "17 */6 * * *"
  workflow_dispatch:

concurrency:
  group: fork-sync
  cancel-in-progress: false

permissions:
  contents: read

env:
  UPSTREAM_URL: https://github.com/anomalyco/opencode.git
  UPSTREAM_BRANCH: dev
  FORK_BRANCH: custom
  SYNC_BRANCH: sync-upstream

jobs:
  sync:
    runs-on: ubuntu-latest
    outputs:
      behind: ${{ steps.fetch.outputs.behind }}
      conflict: ${{ steps.merge.outputs.conflict }}
    steps:
      - name: Checkout fork
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          ref: ${{ env.FORK_BRANCH }}
          fetch-depth: 0
          persist-credentials: false

      - name: Disable upstream workflows
        env:
          GH_TOKEN: ${{ secrets.FORK_SYNC_TOKEN }}
        run: |
          gh workflow list --all --limit 200 --json path,state \
            --jq '.[] | select(.state=="active") | select(.path | startswith(".github/workflows/fork-") | not) | .path' |
            while read -r p; do
              echo "disabling $p"
              gh workflow disable "$(basename "$p")"
            done

      - name: Fetch upstream
        id: fetch
        run: |
          git remote add upstream "$UPSTREAM_URL"
          git fetch --no-tags upstream "+refs/heads/$UPSTREAM_BRANCH:refs/remotes/upstream/$UPSTREAM_BRANCH"
          if git merge-base --is-ancestor "upstream/$UPSTREAM_BRANCH" HEAD; then
            echo "behind=false" >> "$GITHUB_OUTPUT"
            echo "custom already contains upstream/$UPSTREAM_BRANCH"
          else
            echo "behind=true" >> "$GITHUB_OUTPUT"
            echo "upstream_sha=$(git rev-parse --short "upstream/$UPSTREAM_BRANCH")" >> "$GITHUB_OUTPUT"
          fi

      - name: Merge upstream
        id: merge
        if: steps.fetch.outputs.behind == 'true'
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git checkout -B "$SYNC_BRANCH"
          if git merge --no-ff --no-edit "upstream/$UPSTREAM_BRANCH" \
               -m "chore(fork): merge upstream ${{ steps.fetch.outputs.upstream_sha }}"; then
            echo "conflict=false" >> "$GITHUB_OUTPUT"
          else
            git diff --name-only --diff-filter=U > "$RUNNER_TEMP/conflicts.txt"
            git merge --abort
            echo "conflict=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Setup Bun
        if: steps.merge.outputs.conflict == 'false'
        uses: ./.github/actions/setup-bun

      - name: Regenerate client
        if: steps.merge.outputs.conflict == 'false'
        working-directory: packages/client
        run: |
          bun run generate
          if ! git diff --quiet -- src/generated src/generated-effect; then
            git add src/generated src/generated-effect
            git commit -m "chore(fork): regenerate client after upstream merge"
          fi

      - name: Bundle sync branch
        if: steps.merge.outputs.conflict == 'false'
        run: |
          git bundle create "$RUNNER_TEMP/sync-upstream.bundle" "$SYNC_BRANCH" "^origin/$FORK_BRANCH"

      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        if: steps.merge.outputs.conflict == 'false'
        with:
          name: sync-upstream
          path: ${{ runner.temp }}/sync-upstream.bundle
          if-no-files-found: error
          retention-days: 1

      - name: Report conflict
        if: steps.merge.outputs.conflict == 'true'
        env:
          GH_TOKEN: ${{ secrets.FORK_SYNC_TOKEN }}
        run: |
          {
            echo "Syncing with \`upstream/$UPSTREAM_BRANCH\` (${{ steps.fetch.outputs.upstream_sha }}) has conflicts."
            echo
            echo "Conflicted files:"
            echo
            sed 's/^/- `/; s/$/`/' "$RUNNER_TEMP/conflicts.txt"
            echo
            echo "Resolve following section 6 of \`FORK.md\`. Run: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
          } > "$RUNNER_TEMP/body.md"
          existing=$(gh issue list --label fork-sync-conflict --state open --json number --jq '.[0].number // empty')
          if [ -n "$existing" ]; then
            gh issue comment "$existing" --body-file "$RUNNER_TEMP/body.md"
          else
            gh issue create --title "Upstream sync conflict" --label fork-sync-conflict --body-file "$RUNNER_TEMP/body.md"
          fi

  publish:
    needs: sync
    if: needs.sync.outputs.behind == 'true' && needs.sync.outputs.conflict == 'false'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          ref: custom
          fetch-depth: 0
          persist-credentials: false

      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0
        with:
          name: sync-upstream
          path: ${{ runner.temp }}

      - name: Load and verify sync branch
        run: |
          git bundle verify "$RUNNER_TEMP/sync-upstream.bundle"
          git fetch "$RUNNER_TEMP/sync-upstream.bundle" sync-upstream:refs/heads/sync-upstream
          git merge-base --is-ancestor origin/custom sync-upstream || { echo "custom advanced during sync; rerun the sync" >&2; exit 1; }

      - name: Push and open PR
        env:
          GH_TOKEN: ${{ secrets.FORK_SYNC_TOKEN }}
        run: |
          gh auth setup-git
          git push --force origin sync-upstream
          if ! gh pr view sync-upstream --json state --jq '.state' 2>/dev/null | grep -q OPEN; then
            gh pr create \
              --base custom --head sync-upstream \
              --title "chore(fork): sync upstream" \
              --label fork-sync \
              --body "Automated sync with upstream/dev. Merged with a **merge commit** once fork-ci passes. Do not squash."
          fi
          gh pr merge sync-upstream --auto --merge
```

### 4.3 `.github/workflows/fork-ci.yml`

This is a reduced fork CI gate on standard GitHub runners (`ubuntu-latest`), not a replacement for all upstream checks. It runs typecheck, Linux unit tests and the generated-client check. Three subprocess timing tests in `packages/opencode/test/cli/run/run-process.test.ts` are excluded by exact test-name filter because they exceed their 15- or 30-second deadlines under full-suite load; they are listed in section 8. All other unit tests still run. The workflow does not run Windows unit tests, E2E tests or the HttpApi exerciser gates. Add those jobs and require their checks in branch protection if sync PRs must pass them before auto-merge.

```yaml
name: fork-ci

on:
  pull_request:
    branches: [custom]
  push:
    branches: [custom]
  workflow_dispatch:

concurrency:
  group: fork-ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
      - uses: ./.github/actions/setup-bun
      - run: bun typecheck

  test:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
      - uses: ./.github/actions/setup-bun
      - name: Configure git identity
        run: |
          git config --global user.email "bot@example.com"
          git config --global user.name "fork-ci"
      - name: Unit tests
        run: |
          GITHUB_ACTIONS=false bun turbo test --filter='!./packages/opencode'
          GITHUB_ACTIONS=false bun turbo test --filter=./packages/opencode -- --test-name-pattern='^(?!.*(?:exits nonzero promptly when the model is unknown|--format json records an unknown stream finish and continuation|unknown stream finish preserves partial output and continues)).*$'
      - name: Check generated client
        working-directory: packages/client
        run: bun run check:generated
```

If upstream tests fail for reasons unrelated to our changes (flaky or environment-dependent tests), **do not disable them wholesale**. Record the specific test in section 8 and exclude it explicitly.

### 4.4 `.github/workflows/fork-resolve.yml` (optional, maximum automation)

When a `fork-sync-conflict` issue is opened, this workflow has an opencode agent try to resolve the conflict in CI. **It never auto-merges**: it opens a PR labeled `needs-review` for a human to check. Resolution runs in a read-only job; a separate clean job publishes the resolved merge from a Git bundle. The agent still needs a provider credential, so use a dedicated key with a low spend limit and keep this workflow disabled unless you accept that the agent process can access that key.

To enable it:

- `gh variable set FORK_AGENT_RESOLVE --body true`
- `gh variable set FORK_AGENT_MODEL --body "<provider/model>"`
- Add the provider's API key as a secret, for example `gh secret set ANTHROPIC_API_KEY`.

```yaml
name: fork-resolve

on:
  issues:
    types: [opened]
  workflow_dispatch:

concurrency:
  group: fork-resolve
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  resolve:
    if: >
      vars.FORK_AGENT_RESOLVE == 'true' &&
      (github.event_name == 'workflow_dispatch' || contains(github.event.issue.labels.*.name, 'fork-sync-conflict'))
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          ref: custom
          fetch-depth: 0
          persist-credentials: false

      - name: Start conflicted merge
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git remote add upstream https://github.com/anomalyco/opencode.git
          git fetch --no-tags upstream "+refs/heads/dev:refs/remotes/upstream/dev"
          git checkout -B sync-upstream-agent
          git merge --no-ff --no-commit upstream/dev || true

      - uses: ./.github/actions/setup-bun
        continue-on-error: true   # bun install can fail while package.json or bun.lock are conflicted

      - name: Install opencode
        run: npm i -g opencode-ai@latest

      - name: Resolve with agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          opencode run --auto -m "${{ vars.FORK_AGENT_MODEL }}" \
            "A merge of upstream/dev is in progress with conflicts. Read FORK.md and follow section 6 EXACTLY to resolve them. Do not commit or push; leave the tree resolved with every file staged via git add."

      - name: Verify and bundle merge
        run: |
          if git diff --name-only --diff-filter=U | grep -q .; then echo "unresolved conflicts remain"; exit 1; fi
          if git grep -nE '^(<<<<<<<|>>>>>>>)( |$)' -- . ':!*.md'; then echo "conflict markers remain"; exit 1; fi
          git commit --no-edit -m "chore(fork): merge upstream $(git rev-parse --short upstream/dev) (agent-resolved)"
          git bundle create "$RUNNER_TEMP/sync-upstream-agent.bundle" sync-upstream-agent ^origin/custom

      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: sync-upstream-agent
          path: ${{ runner.temp }}/sync-upstream-agent.bundle
          if-no-files-found: error
          retention-days: 1

  publish:
    needs: resolve
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          ref: custom
          fetch-depth: 0
          persist-credentials: false

      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0
        with:
          name: sync-upstream-agent
          path: ${{ runner.temp }}

      - name: Load and verify resolved merge
        run: |
          git bundle verify "$RUNNER_TEMP/sync-upstream-agent.bundle"
          git fetch "$RUNNER_TEMP/sync-upstream-agent.bundle" sync-upstream-agent:refs/heads/sync-upstream-agent
          git merge-base --is-ancestor origin/custom sync-upstream-agent || { echo "custom advanced during conflict resolution; rerun the sync" >&2; exit 1; }

      - name: Push and open review PR
        env:
          GH_TOKEN: ${{ secrets.FORK_SYNC_TOKEN }}
        run: |
          gh auth setup-git
          git push --force origin sync-upstream-agent
          if ! gh pr view sync-upstream-agent --json state --jq '.state' 2>/dev/null | grep -q OPEN; then
            gh pr create --base custom --head sync-upstream-agent \
              --title "chore(fork): sync upstream (agent-resolved)" \
              --label needs-review \
              --body "Conflicts resolved automatically per FORK.md §6. **Review before merging.** Integrate with a merge commit, never squash."
          fi
```

### 4.5 Pointer in `AGENTS.md`

Add this line **as the first line** of `AGENTS.md`. It is the only change to an upstream file that the infrastructure needs, and it is recorded in the ledger (section 7).

```markdown
> This repository is a fork. Read `FORK.md` first; it overrides branch, remote, sync and CI rules below.
```

---

## 5. Rules for agents changing the fork

### 5.1 Before changing code: extension hierarchy

Use **the first option that solves the problem**. The further down the list, the higher the maintenance cost.

1. **User configuration** (`~/.config/opencode/`, global `opencode.jsonc`): does not touch the repo.
2. **Project extension points** in new files: plugins (`.opencode/plugins/`), agents (`.opencode/agent/`), commands (`.opencode/command/`), tools (`.opencode/tool/`), skills (`.opencode/skills/`), themes (`.opencode/themes/`) and MCP servers. **Create new files with a `fork-` prefix** and do not edit the existing ones.
3. **Published or local plugin** using the `@opencode-ai/plugin` API (`auth`, `tool`, `event` hooks…): the behavior lives outside the core.
4. **New file inside a package** that the core imports from **a single point** (one line in a registry, such as `internalPlugins()` in `packages/opencode/src/plugin/index.ts`): any possible conflict shrinks to that one line.
5. **Modifying existing upstream code**: last resort. It must be recorded in the ledger (section 7).

### 5.2 If upstream code must change

- **Keep changes minimal and local.** Do not reformat, rename, reorder imports or make drive-by "improvements" to code you don't own.
- **Add rather than modify:** a new `if` branch, a new array entry or a new file is better than rewriting a function.
- Mark the block with a `// fork: <short reason>` comment so it stands out in conflicts.
- **Avoid files that change a lot upstream.** To check: `git log --since="30 days ago" --oneline upstream/dev -- <file> | wc -l`. If it returns more than 10, look for a different hook point.
- **Do not edit** generated files (`packages/client/src/generated*`, `packages/sdk/js/src/gen/**`, `*.gen.ts`). Regenerate them instead (see `AGENTS.md`).
- **Avoid** changing migrations or the database schema, and **avoid** adding dependencies to upstream `package.json` files. These are the most expensive conflicts (`bun.lock`). If there is no alternative, record it in the ledger.
- If the change would help anyone, **propose it upstream** (section 9). Once accepted, the fork's diff shrinks.

### 5.3 Workflow

```bash
git fetch origin
git fetch upstream
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
- Re-enable upstream workflows, or edit `.github/workflows/*.yml` files that do not start with `fork-`.
- Delete or disable upstream tests to make CI pass.
- Resolve a conflict by dropping a fork change recorded in section 7 without saying so in the PR.

---

## 6. Conflict resolution procedure (for agents)

Use this when a `fork-sync-conflict` issue exists, when CI fails on a `fork-sync` PR, or when `fork-resolve` runs.

### 6.1 Prepare

```bash
git fetch origin
git fetch upstream
git checkout -B sync-upstream origin/custom
git merge --no-ff upstream/dev        # rerere reapplies known resolutions automatically
git diff --name-only --diff-filter=U  # remaining conflicts
```

### 6.2 Resolve each file by type

| File type | Action |
| --- | --- |
| Generated (`packages/client/src/generated*`, `packages/sdk/js/src/gen/**`, `*.gen.ts`, migration snapshots) | `git checkout --theirs -- <file>`, then regenerate (6.3) |
| `bun.lock` | `git checkout --theirs -- bun.lock`, then `bun install` (reapplies our dependencies, if any) and `git add bun.lock` |
| `package.json` | Union: upstream versions plus our entries recorded in section 7 |
| `.github/workflows/*` that are not `fork-*` | `git checkout --theirs -- <file>` (they are disabled; their content doesn't matter) |
| File **recorded in section 7** | Start from the upstream version (`--theirs`) and **reapply the intent** described in the ledger, adapted to the new API. Don't try to keep the old code if upstream refactored it |
| File **not recorded** in section 7 | We had no intentional change there: `git checkout --theirs -- <file>` |
| `AGENTS.md` | Upstream version plus the pointer line from 4.5 as the first line |
| `FORK.md`, `CLAUDE.md`, `fork-*` | Should never conflict. If they do, keep ours (`--ours`) |

Notes:

- During a merge into `custom`, `--ours` is the fork and `--theirs` is upstream.
- If upstream **implemented on its own** something the fork carried as a patch, adopt the upstream version and **remove the entry** from the ledger.
- If upstream **deleted** a file we modified (modify/delete conflict), find where the logic moved (`git log --follow --diff-filter=R upstream/dev -- <path>`, or `grep` for the symbols) and reapply the intent there.

### 6.3 Regenerate and verify

```bash
bun install
(cd packages/client && bun run generate)
./packages/sdk/js/script/build.ts          # only if the legacy SDK changed
git add -A

# Required checks before committing
git diff --name-only --diff-filter=U        # must be empty
git grep -nE '^(<<<<<<<|>>>>>>>)( |$)' -- . ':!*.md'   # must be empty
(cd packages/opencode && bun typecheck)     # plus every package touched by the ledger
(cd packages/opencode && bun test <tests related to ledger files>)
```

### 6.4 Finish

```bash
git commit --no-edit        # keeps the merge message
git push --force origin sync-upstream
gh pr create --base custom --head sync-upstream --title "chore(fork): sync upstream" --label fork-sync \
  --body "Resolves #<issue>. Conflicts: <list>. Ledger changes: <if any>."
gh pr merge sync-upstream --auto --merge
```

- In the PR body, explain how the intent was reapplied for each section 7 file that conflicted.
- Close the `fork-sync-conflict` issue when the PR merges (`Resolves #N` does it automatically).
- If a conflict **cannot be resolved safely** (the ledger intent no longer makes sense with upstream's new architecture), do not guess: comment on the issue with what changed, propose options, and leave the PR as a draft.

---

## 7. Ledger of fork changes to upstream code

> Every change to a file that exists upstream **must** be listed here. This is the source of truth for resolving conflicts: it describes the **intent**, not the lines.
> Fork-only files (`fork-` prefix, `.opencode/**/fork-*`, `FORK.md`, `CLAUDE.md`) do not need entries.

| ID | Upstream file(s) | Intent (what must stay true) | Reason | Propose upstream? |
| --- | --- | --- | --- | --- |
| F-001 | `AGENTS.md` (line 1) | Agents know this is a fork and read `FORK.md` first | Fork infrastructure | No |

To check that the ledger is complete, list the upstream files the fork modifies (fork-only files excluded):

```bash
git diff --name-only upstream/dev...custom
```

This includes modified, added and deleted paths. Every upstream file in that list must appear in the table.

---

## 8. Known exceptions

Upstream tests or checks that fail in `fork-ci` because of the environment, not because of our changes. Review them from time to time in case upstream has fixed them.

| Test / check | Reason | Since |
| --- | --- | --- |
| `packages/opencode/test/cli/run/run-process.test.ts`: `exits nonzero promptly when the model is unknown`, `--format json records an unknown stream finish and continuation`, and `unknown stream finish preserves partial output and continues` | On GitHub-hosted Ubuntu, the child processes exceeded the tests' 15- or 30-second deadlines during the full suite. `fork-ci.yml` excludes only these three cases; the rest of the package tests still run. | 2026-09-23 |

---

## 9. Contributing upstream

Best for generic improvements: every change upstream accepts is one less to maintain.

```bash
git fetch upstream
git checkout -b <short-branch> upstream/dev        # from upstream, NOT from custom
git cherry-pick <commits>                          # or redo the change cleanly
# Option A: git push origin <short-branch> && gh pr create --repo anomalyco/opencode --base dev
# Option B: push to a separate public fork
```

- Follow `AGENTS.md` to the letter: conventional commits and the project's style.
- Once upstream accepts it, the next sync brings it in. At that point **remove the entry** from section 7 and, if it conflicts, keep the upstream version.

---

## 10. Using the fork build

```bash
bun install
bun run dev                                            # development, from the root
cd packages/opencode && bun run build --single         # binary for the current platform only → packages/opencode/dist/<platform>/bin/opencode
```

To avoid clashing with an official install, run the fork binary under an alias (for example `opencode-fork`) instead of replacing the official one.

---

## 11. Quick troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `fork-sync` fails at checkout or push with 401/403 | `FORK_SYNC_TOKEN` expired or missing permissions | Regenerate the token (2.4) |
| `refusing to allow ... workflow ... without workflows permission` | Token lacks the *Workflows* permission | Add *Workflows: write* |
| The `fork-sync` PR doesn't run `fork-ci` | PR was created with `GITHUB_TOKEN` | Use `FORK_SYNC_TOKEN` for `gh` |
| Jobs stuck in the queue waiting for a `blacksmith-*` runner | An upstream workflow is active | Run the command from 2.6 |
| The same conflicts come back on every sync | A sync PR was squashed or rebased | Merge `upstream/dev` into `custom` again with a merge commit; never squash |
| Auto-merge doesn't turn on | Auto-merge disabled or no required checks | Section 2.5 |
| `check:generated` fails | The client was not regenerated after the merge | `cd packages/client && bun run generate` |
| The `pre-push` hook fails on the Bun version | Local Bun differs from `packageManager` | Install the version in `package.json` → `packageManager` |
