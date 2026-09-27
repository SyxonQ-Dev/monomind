const QUALITY_ANTIPATTERNS = [
  // ── Quality: general design and accessibility issues ──
  {
    id: 'gray-on-color',
    category: 'quality',
    name: 'Gray text on colored background',
    description:
      'Gray text looks washed out on colored backgrounds. Use a darker shade of the background color instead, or white/near-white for contrast.',
    skillSection: 'Color & Contrast',
    skillGuideline: 'gray text on colored backgrounds',
  },
  {
    id: 'low-contrast',
    category: 'quality',
    name: 'Low contrast text',
    description:
      'Text does not meet WCAG AA contrast requirements (4.5:1 for body, 3:1 for large text). Increase the contrast between text and background.',
  },
  {
    id: 'layout-transition',
    category: 'quality',
    name: 'Layout property animation',
    description:
      'Animating width, height, padding, or margin causes layout thrash and janky performance. Use transform and opacity instead, or grid-template-rows for height animations.',
    skillSection: 'Motion',
    skillGuideline: 'Animate layout properties',
  },
  {
    id: 'line-length',
    category: 'quality',
    scopes: ['type', 'layout'],
    name: 'Line length too long',
    description:
      'Text lines wider than ~80 characters are hard to read. The eye loses its place tracking back to the start of the next line. Add a max-width (65ch to 75ch) to text containers.',
    skillSection: 'Layout & Space',
    skillGuideline: 'wrap beyond ~80 characters',
  },
  {
    id: 'cramped-padding',
    category: 'quality',
    scopes: ['layout'],
    name: 'Cramped padding',
    description:
      'Text is too close to the edge of its container. Two shapes: (1) an element with its own text where the padding is too low for the font size, and (2) a wrapper with text-bearing children and near-zero padding against a visible boundary (border, outline, or non-transparent background) — children land flush against the boundary line. Add at least 8px (ideally 12–16px) of padding inside bordered, outlined, or colored containers.',
    skillSection: 'Layout & Space',
    skillGuideline: 'inside bordered or colored containers',
  },
  {
    id: 'body-text-viewport-edge',
    category: 'quality',
    scopes: ['layout'],
    name: 'Body text touching viewport edge',
    description:
      'Body paragraphs render flush against the left or right viewport edge with no container providing horizontal padding. Wrap content in a container with at least 16px (ideally 24-32px) of horizontal padding, or apply max-width with mx-auto.',
  },
  {
    id: 'tight-leading',
    category: 'quality',
    scopes: ['type'],
    name: 'Tight line height',
    description:
      'Line height below 1.3x the font size makes multi-line text hard to read. Use 1.5 to 1.7 for body text so lines have room to breathe.',
  },
  {
    id: 'skipped-heading',
    category: 'quality',
    scopes: ['type'],
    name: 'Skipped heading level',
    description:
      'Heading levels should not skip (e.g. h1 then h3 with no h2). Screen readers use heading hierarchy for navigation. Skipping levels breaks the document outline.',
  },
  {
    id: 'justified-text',
    category: 'quality',
    scopes: ['type'],
    name: 'Justified text',
    description:
      'Justified text without hyphenation creates uneven word spacing ("rivers of white"). Use text-align: left for body text, or enable hyphens: auto if you must justify.',
  },
  {
    id: 'tiny-text',
    category: 'quality',
    scopes: ['type'],
    name: 'Tiny body text',
    description:
      'Body text below 12px is hard to read, especially on high-DPI screens. Use at least 14px for body content, 16px is ideal.',
  },
  {
    id: 'all-caps-body',
    category: 'quality',
    scopes: ['type'],
    name: 'All-caps body text',
    description:
      'Long passages in uppercase are hard to read. We recognize words by shape (ascenders and descenders), which all-caps removes. Reserve uppercase for short labels and headings.',
    skillSection: 'Typography',
    skillGuideline: 'long body passages in uppercase',
  },
  {
    id: 'wide-tracking',
    category: 'quality',
    scopes: ['type'],
    name: 'Wide letter spacing on body text',
    description:
      'Letter spacing above 0.05em on body text disrupts natural character groupings and slows reading. Reserve wide tracking for short uppercase labels only.',
  },
  {
    id: 'text-overflow',
    category: 'quality',
    scopes: ['layout'],
    name: 'Content overflowing its container',
    description:
      'Content renders wider than its container, spilling out or forcing a horizontal scrollbar. Let text wrap, constrain widths, or give the region a deliberate scroll affordance.',
    skillSection: 'Layout & Space',
    skillGuideline: 'content wider than its container',
  },
  {
    id: 'clipped-overflow-container',
    category: 'quality',
    scopes: ['layout'],
    name: 'Positioned child clipped by overflow container',
    description:
      'A clipping container (overflow hidden or clip) wrapping an absolutely-positioned child cuts off tooltips, menus, and popovers that need to escape. Let the overflow be visible, or move the positioned layer out of the clip.',
    skillSection: 'Layout & Space',
    skillGuideline: 'overflow container clipping positioned children',
  },
  {
    id: 'design-system-font',
    category: 'quality',
    scopes: ['type'],
    name: 'Font outside DESIGN.md',
    description:
      'A font is used that is not declared in DESIGN.md typography. Use the documented type system or update DESIGN.md if this is an intentional brand addition.',
    skillSection: 'Typography',
    skillGuideline: 'font family outside the project design system',
  },
  {
    id: 'design-system-color',
    category: 'quality',
    severity: 'advisory',
    name: 'Color outside DESIGN.md',
    description:
      'A literal color is outside the DESIGN.md palette and sidecar tonal ramps. This may be legitimate, but it should be an intentional design-system addition rather than drift.',
    skillSection: 'Color & Contrast',
    skillGuideline: 'literal color outside the project design system',
  },
  {
    id: 'design-system-radius',
    category: 'quality',
    severity: 'advisory',
    name: 'Radius outside DESIGN.md',
    description:
      'A border-radius value is outside the DESIGN.md rounded scale. Use a documented radius token or update the design system if the new shape is intentional.',
    skillSection: 'Visual Details',
    skillGuideline: 'border radius outside the project design system',
  },
  {
    id: 'design-system-font-size',
    category: 'quality',
    severity: 'advisory',
    scopes: ['type'],
    name: 'Font size outside DESIGN.md',
    description:
      'A literal font-size is off the type ramp documented in DESIGN.md typography. Use a documented size step or update the design system if the new step is intentional.',
    skillSection: 'Typography',
    skillGuideline: 'font size outside the project design system',
  },

  {
    id: 'missing-focus-visible',
    category: 'quality',
    name: 'Suppressed focus outline with no replacement',
    description:
      'An interactive element (link, button, input) removes its focus outline (outline: none / 0) but the stylesheet never provides a :focus-visible or :focus replacement. Keyboard users lose all sense of where they are. Remove the suppression, or pair it with a visible :focus-visible ring (outline, box-shadow, or border).',
    skillSection: 'Interaction',
    skillGuideline: 'outline removed without a focus-visible replacement',
  },
  {
    id: 'small-touch-target',
    category: 'quality',
    scopes: ['layout'],
    name: 'Touch target below 44px',
    description:
      'A clickable control (button, link, input, [role=button]) renders smaller than 44×44px on one or both axes. Fingers miss small targets and mis-tap neighbors. Give standalone controls at least 44×44px of hit area via padding or min-width/height. Inline text links inside prose are exempt.',
    skillSection: 'Layout & Space',
    skillGuideline: 'touch target smaller than 44px',
  },
  {
    id: 'hover-only-affordance',
    category: 'quality',
    name: 'Functionality gated behind hover only',
    description:
      'An element is hidden by default and revealed only on :hover, with no :focus, :focus-within, or :active equivalent. Keyboard and touch users can never reach it. Mirror every hover reveal with a focus-within (or active) rule so the affordance is reachable without a pointer.',
    skillSection: 'Interaction',
    skillGuideline: 'affordance revealed on hover with no focus equivalent',
  },
  {
    id: 'image-missing-dimensions',
    category: 'quality',
    scopes: ['layout'],
    name: 'Image without reserved dimensions',
    description:
      'An <img> ships without width and height attributes and without a CSS aspect-ratio or explicit height. The browser cannot reserve space before the image loads, so surrounding content jumps (cumulative layout shift). Set width and height attributes, or give the image a CSS aspect-ratio.',
    skillSection: 'Imagery',
    skillGuideline: 'image with no reserved dimensions',
  },
  {
    id: 'dark-scheme-contrast-blindspot',
    category: 'quality',
    severity: 'advisory',
    name: 'Dark-scheme contrast blindspot',
    description:
      'The page ships dark styling (a prefers-color-scheme: dark block or a .dark / [data-theme=dark] scope), but for some selector the dark override changes the background without changing the paired text color (or the reverse). The half-updated pair often collapses to unreadable contrast in dark mode. Override text and background together, or verify the inherited half still contrasts.',
    skillSection: 'Color & Contrast',
    skillGuideline: 'dark scheme overrides one of a color pair but not the other',
  },
];

export { QUALITY_ANTIPATTERNS };
