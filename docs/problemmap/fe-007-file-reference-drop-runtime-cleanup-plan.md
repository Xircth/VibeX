# FE-007 File Reference Drop Runtime Cleanup Plan

Scope: `frontend/src/components/ui/wysiwyg.tsx` and a new drop-runtime hook under `frontend/src/components/ui/wysiwyg/`.

## Smell

`WYSIWYGEditor` still owns file-reference drag/drop runtime wiring: React dragover/drop event handling, app-managed current-drag fallback, custom DOM event listening, drop-zone ref ownership, insertion callback invocation, and drag-state clearing. The pure intake policy is already extracted, so the remaining runtime layer should move behind a hook.

## Behavior Locks

- Dragover always stops propagation, and accepted file-reference drags prevent default plus set `dropEffect = "copy"`.
- Disabled dragover/drop/custom-drop paths do not insert.
- Drop prefers serialized `FILE_REFERENCE_DRAG_MIME` payloads and clears the current dragged reference after insertion.
- Custom `vibe-file-reference-drop` events insert valid details and clear the current dragged reference.
- The custom event listener is removed on unmount.

## Cleanup Pass

1. Add `use-file-reference-drop-handlers.test.tsx` before implementation.
2. Extract `useFileReferenceDropHandlers({ disabled, onInsertFileReference })`.
3. Replace `fileReferenceDropZoneRef`, `handleDragOver`, `handleDrop`, and custom-drop effect in `wysiwyg.tsx` with the hook.
4. Remove direct drag/drop policy and drag-state imports from `wysiwyg.tsx`.

## Non-Goals

- Do not change pure drop payload policy.
- Do not change file-reference insertion mutation behavior.
- Do not change native drag event capture stops on `ContentEditable`.

## Verification

- Red/green targeted Vitest for the drop-runtime hook and existing FE-007 policy/group tests.
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
