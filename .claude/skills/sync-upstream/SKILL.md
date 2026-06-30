---
name: sync-upstream
description: Fetch new commits from the upstream repo, explain what each commit does, analyze conflicts/overlap against local changes, then apply only what the user approves via full merge / cherry-pick / file-only checkout. Unwanted commits are never pulled. Use for fork sync, reviewing/explaining upstream changes, upstream sync, and requests like "원본이랑 맞춰줘" or "원본에 뭐 올라왔어?".
---

# Sync Upstream — Selectively Pull Upstream Changes Into the Fork

This repo is a fork. Remotes:
- `origin` → my fork (`MumuKim0212/AgentCodeGUI`)
- `upstream` → original (`UnrealFactory/AgentCodeGUI`)

Goal: review upstream's new changes, **explain them**, and pull in **only what the user wants**.
Never merge everything blindly. Always show first and confirm the approach with the user.

**Language: write this document and your reasoning in English, but talk to the user in Korean (한글).** All explanations, summaries, and questions shown to the user should be in Korean.

## Step 1: Fetch + check state (always run first)

```bash
git fetch upstream
```

Then check state:

```bash
# Is the working tree clean? (warn first if there are uncommitted changes)
git status --short

# Current branch
git branch --show-current

# Commits in upstream but not yet in my branch (= candidates to pull)
git log --oneline --no-merges HEAD..upstream/main

# Commits only in my fork (= my edits; used to judge conflict risk)
git log --oneline --no-merges upstream/main..HEAD

# File-level change summary
git diff --stat HEAD..upstream/main
```

- If there are **no** commits to pull, tell the user "이미 최신 상태입니다" and stop.
- If the working tree is dirty (uncommitted changes) or the current branch is not `main`, warn the user and confirm before proceeding.

## Step 2: Explain each commit (so the user can choose)

When there are candidate commits, do not just list hashes/messages — **read the actual changes and explain in plain language what each commit does**. The user decides what to pull based on this explanation.

For each candidate commit:

```bash
# Commit message body + changed files
git show <hash> --stat

# Read the actual code change if needed (to understand the feature)
git show <hash>
```

Then report each commit to the user (in Korean) using this shape:

- **`<short-hash>` <one-line summary>**
  - 무슨 기능인지: (1–3 lines, in your own words, from reading the code)
  - 바뀌는 파일: `path/a.ts`, `path/b.ts` …
  - 내 로컬/fork 수정과 겹치는가: (result from Step 3 — clean / touches same file / conflict risk)

If there are many commits, a table is fine. The point: let the user judge at a glance **what each commit is and how pulling it affects their code.**

## Step 3: Compare against local changes (pre-analyze conflicts/overlap)

Before pulling, check how each candidate commit interacts with my fork's edits.

```bash
# Do the files a commit touches overlap with files my fork changed?
git show <hash> --stat --name-only
git diff --name-only upstream/main...HEAD     # files changed in my fork

# Dry-run whether applying a commit conflicts (no working-tree commit)
git cherry-pick --no-commit <hash>            # trial apply
git status                                     # check for conflicts
git cherry-pick --abort                        # or: git reset --hard HEAD; cancel the trial
```

Fold the result into the Step 2 explanation:
- **No overlap** → safe to pull
- **Touches the same file, different regions** → usually auto-merges
- **Conflict risk** → manual resolution needed if pulled (Step 7). Warn up front.

If I already implemented the same feature locally (duplicate), point that out too and consider recommending "do not pull it."

## Step 4: Choose the approach (ask the user)

Use AskUserQuestion to ask how to apply. **The default is: do not pull commits the user doesn't want.** Options:

| Approach | When | Result |
|----------|------|--------|
| **Full merge** | Want to follow all upstream changes | `git merge upstream/main` |
| **Cherry-pick** | Want only specific commits | Only selected commits applied; the rest are not pulled |
| **File-only** | Overwrite specific files with the upstream version | Only chosen files replaced |
| **Cancel** | Don't pull anything now | Nothing happens |

If they choose cherry-pick / file-only, re-confirm **exactly which commits/files to pull and which to leave out**, based on the Step 2–3 explanation.

## Step 5: Execute

Recommend creating a backup branch at the current position before working, for safety:
```bash
git branch backup/pre-sync-$(date +%Y%m%d-%H%M%S)
```

### A) Full merge
```bash
git merge upstream/main
```

### B) Cherry-pick
```bash
git cherry-pick <hash1> <hash2> ...
```
- Ranges also work: `git cherry-pick A^..B` (A through B)

### C) File-only
```bash
git checkout upstream/main -- <path/file1> <path/file2>
git status        # check staged changes
# commit once the user confirms
git commit -m "Pull <file> from upstream"
```

## Step 6: Handle conflicts

On conflict (a `CONFLICT` message):

```bash
git status        # list conflicted files
```

Open each conflicted file and look at the `<<<<<<<`, `=======`, `>>>>>>>` markers.
- The `HEAD` side = my fork's edits
- The other side = upstream's change

For each conflict, **show the user and confirm** which side to keep (or how to combine both) before resolving. Do not arbitrarily discard one side.

After resolving:
```bash
git add <resolved-file>
# if it was a merge:
git commit
# if it was a cherry-pick:
git cherry-pick --continue
```

To abort and revert:
```bash
git merge --abort          # or
git cherry-pick --abort
```

## Step 7: Wrap up

```bash
git log --oneline -5      # verify the result
```

- Summarize (in Korean) what was pulled, what was deliberately left out (commits/files), and how conflicts were resolved.
- Push only when the user explicitly asks:
  ```bash
  git push origin <branch>
  ```

## Principles
- Before pulling, **read the code and explain what each commit does**. Never just list hashes/messages.
- Never skip the order: review → explain → compare → confirm → execute.
- Do not pull commits the user doesn't want. When in doubt, leave them out.
- Do not resolve conflicts or push without the user's confirmation.
- Suggest a backup branch before destructive operations (reset --hard, etc.).
- Speak to the user in Korean; keep this document and your internal reasoning in English.
