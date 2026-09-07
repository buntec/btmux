/**
 * Registry for the one-shot border-draw effect played on the pane you switch to
 * (`pane-switch-border`). The backend only stores the chosen id and passes it
 * through untouched; the geometry + keyframes live here and in `index.css`, and
 * an unknown id falls back to the first entry (which matches the backend's
 * default style) — same contract as the shader registry in `terminalFxShaders.ts`.
 *
 * - `wipe` — a linear `border-image` gradient slid across the border box on the
 *   -45° diagonal (the default).
 * - `trace` — a counter-clockwise SVG stroke drawn once around the perimeter.
 * - `sweep` — a conic `border-image` gradient rotated clockwise with a bright
 *   leading edge.
 */
export type PaneBorderStyleId = 'trace' | 'sweep' | 'wipe';

export interface PaneBorderStyle {
  id: PaneBorderStyleId;
  label: string;
  /** 'svg' renders a stroked <path>; 'border-image' renders a <div> + CSS class. */
  render: 'svg' | 'border-image';
  /** CSS class applied for the 'border-image' renderer. */
  className?: string;
}

export const PANE_BORDER_STYLES: PaneBorderStyle[] = [
  {
    id: 'wipe',
    label: 'Diagonal wipe',
    render: 'border-image',
    className: 'btm-pane-border--wipe',
  },
  { id: 'trace', label: 'Counter-clockwise trace', render: 'svg' },
  {
    id: 'sweep',
    label: 'Clockwise sweep',
    render: 'border-image',
    className: 'btm-pane-border--sweep',
  },
];

export function findPaneBorderStyle(id: string | null | undefined): PaneBorderStyle {
  return PANE_BORDER_STYLES.find((style) => style.id === id) ?? PANE_BORDER_STYLES[0];
}
