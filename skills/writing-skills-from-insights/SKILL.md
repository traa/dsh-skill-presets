---
name: writing-skills-from-insights
description: Turn a durable insight the team keeps re-reading (a workflow rule, a convention, a preference) into a local skill the model can load on demand, and keep the two linked. Use when an insight has high confidence or many reads, or when the same lesson is explained again in a session.
when-to-use: A `recall` result keeps coming back for the same rule; the Skills page's Insights tab lists promotable insights; the user asks to "make this a skill".
---

# From insight to skill

Knowledge captured with `learn` is injected as a compact index the model must
`recall` to read. A rule the model needs *every time it does X* is better as
a **skill**: the catalog names it next to the task, the `skill` tool loads
the full text, and usage is measured. The two are linked, not duplicated.

## Which insights qualify

- kind `workflow`, `convention`, or `preference` (a `gotcha` is usually a
  single fact; keep it as knowledge unless it prescribes a procedure);
- confidence ≥ 2, **or** read ≥ 40 times — either says the team keeps
  needing it;
- not retired, not superseded;
- describes an action or a check, not a one-off value.

## Promote

Prefer the tool: Settings → Skills → Insights → *Promotable insights* →
**Promote**, which writes `library/local/<kebab-title>/SKILL.md` from a
deterministic template and records the link (`promotedFrom` in the lock,
`promotions.json`). Then:

1. Open the new skill in the Library drawer and **edit the body**: turn the
   insight's prose into the checklist a model can follow — when to check,
   what to run, what to do on failure. Keep it under ~80 lines.
2. Sharpen `description` and `when-to-use`: they are what the model matches
   the task against. Name the trigger, not the topic.
3. Add it to the preset(s) where the task occurs (Stages tab → Edit).
4. Leave the insight in knowledge: it still ranks in the index and points at
   the skill. Do not delete it.

## By hand

If the tool is unavailable, write the same file yourself under
`<workbench>/skills/library/local/<name>/SKILL.md` with `name`, `description`,
`when-to-use` frontmatter and the body, then run `dsh-skill-presets install
local`.

## Keep them honest

- When the rule changes, update the **skill** and `learn` the correction
  (superseding the old insight). A skill that contradicts the index confuses
  the model.
- If the promoted skill's load rate stays near zero across many sessions, the
  pruning hint on the Stages tab will say so — remove it from the preset, not
  from the library.
