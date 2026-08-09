# Design QA — topbar utility navigation

## Evidence

- Source visual: `.audit/notelet-header/01-editor-toolbar.png`
- Desktop implementation: `.audit/notelet-header/06-editor-toolbar-menu-final.png`
- Mobile implementation: `.audit/notelet-header/05-editor-toolbar-mobile-menu-fixed.png`
- Focused comparison: `.audit/notelet-header/07-reference-vs-final.png`
- Desktop viewport: 1440 × 900 CSS px at 1×; screenshot: 1440 × 900 px
- Mobile viewport: 390 × 844 CSS px at 1×; screenshot: 390 × 844 px
- Verified state: editor toolbar with the utility menu open

## Surface review

- Typography: existing SF/PingFang system stack retained; utility labels use compact 13 px text and 12 px secondary values.
- Spacing and hierarchy: editing and publishing remain primary; language and status moved into one trailing utility control.
- Colors and depth: neutral paper palette retained; the popover uses a light material, restrained border, and two-layer shadow.
- Icon fidelity: official Phosphor vector web components are used for more, language, status, and disclosure icons.
- Copy: language uses a full label plus target language; status remains explicit instead of relying on an ambiguous icon.
- Accessibility: menu semantics, expanded state, focus restoration, arrow-key traversal, Home/End, and Escape are covered.

## Comparison history

1. Initial implementation exposed a 38 px mobile trigger and inherited a malformed mobile shell width rule. This caused an undersized touch target and collapsed editor content.
2. The trigger was increased to 44 × 44 px. The mobile shell expression was corrected to `min(760px, calc(100% - 36px))`.
3. The drag overlay was constrained to the shell on mobile, eliminating the remaining 2 px horizontal overflow.
4. Final desktop and mobile captures show no overlap, clipping, horizontal overflow, or hierarchy regression.

## Severity check

- P0: none
- P1: none
- P2: none

## Final result

passed
