/**
 * Registry for the one-shot border-draw effect played on the pane you switch to
 * (`pane-switch-border`). The backend only stores the chosen id and passes it
 * through untouched; the geometry + keyframes live here and in `index.css`, and
 * an unknown id falls back to the first entry (which matches the backend's
 * default style).
 *
 * Each style is a copy of the focus ring (same box, width, and color) revealed
 * by an animated mask in `index.css`. The static ring is hidden while it plays,
 * so the border grows from nothing and hands over without a seam.
 *
 * - `wipe` — a linear mask slid across the border box on the -45° diagonal
 *   (the default).
 * - `trace` — the ring drawn counter-clockwise from the top-left corner.
 * - `sweep` — a conic mask rotated clockwise with a bright leading edge.
 */
export type PaneBorderStyleId = 'trace' | 'sweep' | 'wipe';

export interface PaneBorderStyle {
  id: PaneBorderStyleId;
  label: string;
  /** CSS class selecting the reveal mask. */
  className: string;
}

export const PANE_BORDER_STYLES: PaneBorderStyle[] = [
  { id: 'wipe', label: 'Diagonal wipe', className: 'btm-pane-border--wipe' },
  { id: 'trace', label: 'Counter-clockwise trace', className: 'btm-pane-border--trace' },
  { id: 'sweep', label: 'Clockwise sweep', className: 'btm-pane-border--sweep' },
];

export function findPaneBorderStyle(id: string | null | undefined): PaneBorderStyle {
  return PANE_BORDER_STYLES.find((style) => style.id === id) ?? PANE_BORDER_STYLES[0];
}
