# Member memory

Every collaboration member keeps its own memory across all of its threads
(group spaces and the private chat with the user).

## What you get automatically

At the start of each turn your prompt carries a `[成员记忆]` block:

- **Recent activity** — the latest 8 one-line summaries of your own turns,
  labelled by where they happened (`群「…」`, `本对话`, `私聊`). Use it to answer
  "what did you do in the other group?" without asking anyone.
- **Relevant facts** — long-term facts ranked against the current request.

## Privacy rules (enforced, not advisory)

- Anything from your private chat with the user is **never** shown, searched or
  returned while you are working in a group thread. Do not repeat private
  details into a group yourself either.
- A fact scoped to one thread is only visible inside that thread.

## Tools

- `memory_search {query, limit?}` — BM25 search over your visible facts and
  activity.
- `memory_write {content, scope?}` — store a durable fact. `scope` is `thread`
  (default), `global`, or `private`. In the private chat every write is stored
  as `private`. Write short, self-contained, stable facts (decisions,
  conventions, preferences); do not store secrets or transient status.

## When you MUST call `memory_write`

Long-term memory is only as good as what you write. Nothing is distilled
automatically yet (an auto-distillation hook exists but is future work), so
call `memory_write` in the same turn whenever you learn:

- **User preferences** — language, tone, formatting, tools they like or refuse.
- **Project conventions** — package manager, branch/commit rules, code style,
  test commands, directory layout.
- **Decisions** — an approach the user or the group agreed on, and why.
- **Recurring corrections** — anything the user had to correct you on, so it
  does not happen twice.
- **Stable facts about people and systems** — who owns what, endpoints,
  environment quirks.

Before writing, `memory_search` for an existing fact and skip duplicates.
Pick the narrowest correct scope: `thread` for this group only, `global` for
things true everywhere, `private` for anything the user told you privately.

The user can list, edit and delete your facts and see your activity.
