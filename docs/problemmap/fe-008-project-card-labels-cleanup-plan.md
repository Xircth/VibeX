# FE-008 Project Card Label Cleanup Plan

## Scope

- `frontend/src/components/projects/ProjectCard.tsx`
- A focused component test for visible project-card labels.
- ProblemMap documentation for the frontend review.

## Smell

`ProjectCard` renders mojibake strings in visible controls and metadata:
details, open in IDE, edit, delete, and the created-date label. These are not
harmless comments; they are user-facing text.

## Behavior Lock

1. Add a component test that opens the project-card menu and asserts readable
   labels for details, open-in-IDE, edit, and delete.
2. Assert the created-date prefix is readable.
3. Keep hook/API behavior mocked so the test locks presentation only.

## Cleanup Order

1. Add the failing component test around the existing corrupted text.
2. Replace corrupted labels with readable Chinese copy.
3. Run the focused test, frontend check/lint, full check/lint, and diff
   whitespace checks.

## Explicit Non-Goals

- Do not change project navigation targets.
- Do not change delete confirmation behavior.
- Do not change editor-opening behavior.
- Do not restyle the card.
