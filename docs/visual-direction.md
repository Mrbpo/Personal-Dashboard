# Visual direction: Study Cabinet

## What went wrong in the previous QQBot interface

The QQBot card renderer is a useful negative reference because its visual defects
were structural, not just a matter of color choice.

1. **It rendered databases as posters.** Mission trees and aggregate-effect cards
   became single images thousands of pixels tall. That format made scanning,
   searching, comparison, and mobile reading needlessly difficult.
2. **Everything competed at the same level.** Repeated navy panels, gold frames,
   icons, labels, and textures gave every row equal visual weight. Important actions
   and urgent exceptions did not stand out.
3. **Decoration reduced information density.** Large headers and ornamental frames
   consumed scarce mobile space without improving navigation or comprehension.
4. **Color was atmospheric rather than semantic.** Gold, blue, green, and red were
   used frequently, but not consistently enough to communicate urgency, status, or
   source at a glance.
5. **The layout was fixed and reactive.** Overflow and title-width problems were
   patched case by case instead of being solved with responsive rules, line limits,
   progressive disclosure, and reusable content hierarchy.
6. **It copied the surface of a game UI.** The cards borrowed frames and textures,
   but not the useful interaction principles: compact overview, strong selection,
   contextual detail, and focused drill-down.

## Rules for this dashboard

- Use the Victoria-era visual language as a restrained frame, not as a skin.
- Default to compact rows and ledgers; reveal evidence and full requirements on demand.
- Reserve dark instrument panels for orientation and analysis, not every section.
- Use parchment surfaces for reading and data entry.
- Use brass as a border/accent, never as body text.
- Use muted per-course hues; use brightness and saturation to reinforce urgency.
- Keep body copy in a Chinese-friendly sans-serif. Use serif only for short headings.
- Avoid giant rounded cards, purple glow, gradient halos, floating pills, and decorative
  sparkles—the most recognizable generic AI-dashboard conventions.
- Every screen must work without horizontal scrolling. Mobile changes the calendar to
  a chronological agenda; desktop keeps the seven-column month view.
- Direct game assets are local-development-only and must be replaced before public
  deployment or repository distribution.
