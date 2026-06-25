use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Layout {
    Leaf {
        pane_id: Uuid,
    },
    VSplit {
        id: Uuid,
        ratio: f32,
        left: Box<Layout>,
        right: Box<Layout>,
    },
    HSplit {
        id: Uuid,
        ratio: f32,
        top: Box<Layout>,
        bottom: Box<Layout>,
    },
}

/// The tmux preset arrangements (`select-layout` / `next-layout`). Cycled by
/// `next-layout` in the order of `ALL`, or chosen directly by name. Not
/// serialized — a window's "last applied preset" is transient state (like
/// `prev_pane`), reset to `None` on restore.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayoutPreset {
    EvenHorizontal,
    EvenVertical,
    MainVertical,
    MainHorizontal,
    Tiled,
}

impl LayoutPreset {
    /// Cycle order for `next-layout`, matching tmux's M-1..M-5 / Space order.
    pub const ALL: [LayoutPreset; 5] = [
        LayoutPreset::EvenHorizontal,
        LayoutPreset::EvenVertical,
        LayoutPreset::MainVertical,
        LayoutPreset::MainHorizontal,
        LayoutPreset::Tiled,
    ];

    /// Parse the kebab-case name used in palette command ids / the wire.
    pub fn from_name(name: &str) -> Option<LayoutPreset> {
        match name {
            "even-horizontal" => Some(LayoutPreset::EvenHorizontal),
            "even-vertical" => Some(LayoutPreset::EvenVertical),
            "main-vertical" => Some(LayoutPreset::MainVertical),
            "main-horizontal" => Some(LayoutPreset::MainHorizontal),
            "tiled" => Some(LayoutPreset::Tiled),
            _ => None,
        }
    }

    /// The next preset in cycle order (wraps around).
    pub fn next(self) -> LayoutPreset {
        let idx = LayoutPreset::ALL
            .iter()
            .position(|p| *p == self)
            .unwrap_or(0);
        LayoutPreset::ALL[(idx + 1) % LayoutPreset::ALL.len()]
    }

    /// Build a fresh layout tree placing `pane_ids` (in the given order) into
    /// this preset's arrangement. Returns `None` for an empty pane list. Split
    /// nodes get fresh ids and equal ratios; the caller keeps `window.panes`
    /// untouched, so the existing panes/PTYs are merely re-arranged.
    pub fn build(self, pane_ids: &[Uuid]) -> Option<Layout> {
        if pane_ids.is_empty() {
            return None;
        }
        Some(match self {
            // A single horizontal row, left → right.
            LayoutPreset::EvenHorizontal => even_chain(leaves_of(pane_ids), false),
            // A single vertical column, top → bottom.
            LayoutPreset::EvenVertical => even_chain(leaves_of(pane_ids), true),
            // Big pane on the left; the rest stacked in a column on the right.
            LayoutPreset::MainVertical => main_split(pane_ids, false),
            // Big pane on top; the rest in a row along the bottom.
            LayoutPreset::MainHorizontal => main_split(pane_ids, true),
            LayoutPreset::Tiled => tiled(pane_ids),
        })
    }
}

fn leaves_of(pane_ids: &[Uuid]) -> Vec<Layout> {
    pane_ids
        .iter()
        .map(|id| Layout::Leaf { pane_id: *id })
        .collect()
}

/// Combine `items` into an evenly-sized split chain. `vertical` stacks them with
/// `HSplit` (top → bottom); otherwise they sit side by side with `VSplit`
/// (left → right). Equal sizing falls out of each split taking ratio
/// `1/(remaining count)`: e.g. three items → 1/3, then the remaining pair 1/2.
fn even_chain(mut items: Vec<Layout>, vertical: bool) -> Layout {
    let n = items.len();
    debug_assert!(n >= 1, "even_chain requires at least one item");
    if n == 1 {
        return items.pop().unwrap();
    }
    let first = items.remove(0);
    let rest = even_chain(items, vertical);
    let ratio = 1.0 / n as f32;
    if vertical {
        Layout::HSplit {
            id: Uuid::new_v4(),
            ratio,
            top: Box::new(first),
            bottom: Box::new(rest),
        }
    } else {
        Layout::VSplit {
            id: Uuid::new_v4(),
            ratio,
            left: Box::new(first),
            right: Box::new(rest),
        }
    }
}

/// `main-vertical` / `main-horizontal`: the first pane is the "main" pane taking
/// half the window, the rest share the other half. `horizontal` true puts the
/// main pane on top with the rest in a row below (main-horizontal); false puts
/// it on the left with the rest in a column to the right (main-vertical).
fn main_split(pane_ids: &[Uuid], horizontal: bool) -> Layout {
    if pane_ids.len() == 1 {
        return Layout::Leaf {
            pane_id: pane_ids[0],
        };
    }
    let main = Box::new(Layout::Leaf {
        pane_id: pane_ids[0],
    });
    // Rest fill their half: stacked beside a vertical main, in a row below a
    // horizontal main.
    let rest = Box::new(even_chain(leaves_of(&pane_ids[1..]), !horizontal));
    if horizontal {
        Layout::HSplit {
            id: Uuid::new_v4(),
            ratio: 0.5,
            top: main,
            bottom: rest,
        }
    } else {
        Layout::VSplit {
            id: Uuid::new_v4(),
            ratio: 0.5,
            left: main,
            right: rest,
        }
    }
}

/// `tiled`: a balanced grid. Row/column counts grow alternately (preferring
/// columns) until they cover every pane, matching tmux's arrangement — e.g. 5
/// panes → 2 rows of 3 then 2. Panes fill row by row in order.
fn tiled(pane_ids: &[Uuid]) -> Layout {
    let n = pane_ids.len();
    if n == 1 {
        return Layout::Leaf {
            pane_id: pane_ids[0],
        };
    }
    let (mut rows, mut columns) = (1usize, 1usize);
    while rows * columns < n {
        if columns <= rows {
            columns += 1;
        } else {
            rows += 1;
        }
    }

    // Slice the panes into `rows` rows, each a side-by-side chain, then stack
    // the rows. Distribute as evenly as possible (earlier rows get the extra).
    let mut row_subtrees: Vec<Layout> = Vec::with_capacity(rows);
    let mut start = 0;
    for r in 0..rows {
        let remaining = n - start;
        let rows_left = rows - r;
        let count = remaining.div_ceil(rows_left);
        let slice = &pane_ids[start..start + count];
        start += count;
        row_subtrees.push(even_chain(leaves_of(slice), false));
    }
    even_chain(row_subtrees, true)
}

impl Layout {
    pub fn find_and_split(
        &mut self,
        target_pane_id: Uuid,
        new_pane_id: Uuid,
        direction: &str,
    ) -> bool {
        match self {
            Layout::Leaf { pane_id } => {
                if *pane_id == target_pane_id {
                    let old_leaf = Box::new(Layout::Leaf { pane_id: *pane_id });
                    let new_leaf = Box::new(Layout::Leaf {
                        pane_id: new_pane_id,
                    });
                    *self = match direction {
                        "v" => Layout::VSplit {
                            id: Uuid::new_v4(),
                            ratio: 0.5,
                            left: old_leaf,
                            right: new_leaf,
                        },
                        _ => Layout::HSplit {
                            id: Uuid::new_v4(),
                            ratio: 0.5,
                            top: old_leaf,
                            bottom: new_leaf,
                        },
                    };
                    true
                } else {
                    false
                }
            }
            Layout::VSplit { left, right, .. } => {
                left.find_and_split(target_pane_id, new_pane_id, direction)
                    || right.find_and_split(target_pane_id, new_pane_id, direction)
            }
            Layout::HSplit { top, bottom, .. } => {
                top.find_and_split(target_pane_id, new_pane_id, direction)
                    || bottom.find_and_split(target_pane_id, new_pane_id, direction)
            }
        }
    }

    /// Update the ratio of a split node identified by `split_id`.
    pub fn update_split_ratio(&mut self, split_id: Uuid, new_ratio: f32) -> bool {
        match self {
            Layout::Leaf { .. } => false,
            Layout::VSplit {
                id,
                ratio,
                left,
                right,
            } => {
                if *id == split_id {
                    *ratio = new_ratio.clamp(0.05, 0.95);
                    true
                } else {
                    left.update_split_ratio(split_id, new_ratio)
                        || right.update_split_ratio(split_id, new_ratio)
                }
            }
            Layout::HSplit {
                id,
                ratio,
                top,
                bottom,
            } => {
                if *id == split_id {
                    *ratio = new_ratio.clamp(0.05, 0.95);
                    true
                } else {
                    top.update_split_ratio(split_id, new_ratio)
                        || bottom.update_split_ratio(split_id, new_ratio)
                }
            }
        }
    }

    /// Remove `target_pane_id` from this layout, collapsing the now-orphaned
    /// split into its surviving child. Returns `Some(new_layout)` when the pane
    /// was found and removed, or `None` if it wasn't present or *was* the entire
    /// layout (a single matching leaf — the caller then drops the whole window).
    pub fn remove_pane(&self, target_pane_id: Uuid) -> Option<Layout> {
        match self.remove(target_pane_id) {
            Some(Some(layout)) => Some(layout),
            _ => None,
        }
    }

    /// Three-state recursive removal:
    /// - `None` → target not in this subtree (leave it unchanged).
    /// - `Some(None)` → this whole node *was* the target leaf; the parent should
    ///   collapse to the sibling.
    /// - `Some(Some(layout))` → target found deeper; replace this node with `layout`.
    fn remove(&self, target: Uuid) -> Option<Option<Layout>> {
        match self {
            Layout::Leaf { pane_id } => (*pane_id == target).then_some(None),
            Layout::VSplit {
                id,
                ratio,
                left,
                right,
            } => {
                if let Some(res) = left.remove(target) {
                    return Some(Some(match res {
                        // Left child was the bare target leaf → collapse to right.
                        None => (**right).clone(),
                        // Target was deeper in the left subtree → keep the split.
                        Some(new_left) => Layout::VSplit {
                            id: *id,
                            ratio: *ratio,
                            left: Box::new(new_left),
                            right: right.clone(),
                        },
                    }));
                }
                if let Some(res) = right.remove(target) {
                    return Some(Some(match res {
                        None => (**left).clone(),
                        Some(new_right) => Layout::VSplit {
                            id: *id,
                            ratio: *ratio,
                            left: left.clone(),
                            right: Box::new(new_right),
                        },
                    }));
                }
                None
            }
            Layout::HSplit {
                id,
                ratio,
                top,
                bottom,
            } => {
                if let Some(res) = top.remove(target) {
                    return Some(Some(match res {
                        None => (**bottom).clone(),
                        Some(new_top) => Layout::HSplit {
                            id: *id,
                            ratio: *ratio,
                            top: Box::new(new_top),
                            bottom: bottom.clone(),
                        },
                    }));
                }
                if let Some(res) = bottom.remove(target) {
                    return Some(Some(match res {
                        None => (**top).clone(),
                        Some(new_bottom) => Layout::HSplit {
                            id: *id,
                            ratio: *ratio,
                            top: top.clone(),
                            bottom: Box::new(new_bottom),
                        },
                    }));
                }
                None
            }
        }
    }

    /// Swap two pane_ids in the layout tree. Returns true if both were found and swapped.
    pub fn swap_panes(&mut self, a: Uuid, b: Uuid) -> bool {
        self.replace_pane_id(a, Uuid::nil());
        self.replace_pane_id(b, a);
        self.replace_pane_id(Uuid::nil(), b)
    }

    fn replace_pane_id(&mut self, from: Uuid, to: Uuid) -> bool {
        match self {
            Layout::Leaf { pane_id } => {
                if *pane_id == from {
                    *pane_id = to;
                    true
                } else {
                    false
                }
            }
            Layout::VSplit { left, right, .. } => {
                left.replace_pane_id(from, to) || right.replace_pane_id(from, to)
            }
            Layout::HSplit { top, bottom, .. } => {
                top.replace_pane_id(from, to) || bottom.replace_pane_id(from, to)
            }
        }
    }

    pub fn pane_ids(&self) -> Vec<Uuid> {
        match self {
            Layout::Leaf { pane_id } => vec![*pane_id],
            Layout::VSplit { left, right, .. } => {
                let mut ids = left.pane_ids();
                ids.extend(right.pane_ids());
                ids
            }
            Layout::HSplit { top, bottom, .. } => {
                let mut ids = top.pane_ids();
                ids.extend(bottom.pane_ids());
                ids
            }
        }
    }

    /// Collect (pane_id, rect) pairs by walking the layout tree.
    /// Coordinates are fractions of the total area: x/y in [0,1), w/h in (0,1].
    fn pane_rects(&self, x: f32, y: f32, w: f32, h: f32) -> Vec<(Uuid, f32, f32, f32, f32)> {
        match self {
            Layout::Leaf { pane_id } => vec![(*pane_id, x, y, w, h)],
            Layout::VSplit {
                ratio, left, right, ..
            } => {
                let lw = w * ratio;
                let mut rects = left.pane_rects(x, y, lw, h);
                rects.extend(right.pane_rects(x + lw, y, w - lw, h));
                rects
            }
            Layout::HSplit {
                ratio, top, bottom, ..
            } => {
                let th = h * ratio;
                let mut rects = top.pane_rects(x, y, w, th);
                rects.extend(bottom.pane_rects(x, y + th, w, h - th));
                rects
            }
        }
    }

    pub fn navigate_from(&self, current: Uuid, direction: &str) -> Option<Uuid> {
        let rects = self.pane_rects(0.0, 0.0, 1.0, 1.0);
        let &(_, cx, cy, cw, ch) = rects.iter().find(|(id, ..)| *id == current)?;

        // Centre of the current pane.
        let ccx = cx + cw / 2.0;
        let ccy = cy + ch / 2.0;

        // For each candidate pane, compute how well it sits in the requested
        // direction and how far away it is, then pick the best.
        let mut best: Option<(Uuid, f32)> = None;

        for &(id, px, py, pw, ph) in &rects {
            if id == current {
                continue;
            }
            let pcx = px + pw / 2.0;
            let pcy = py + ph / 2.0;
            let dx = pcx - ccx;
            let dy = pcy - ccy;

            // Is the candidate actually in the requested direction?
            // We use edge overlap to prefer panes that share a border.
            let qualifies = match direction {
                "left" => px + pw <= cx + 1e-3,
                "right" => px >= cx + cw - 1e-3,
                "up" => py + ph <= cy + 1e-3,
                "down" => py >= cy + ch - 1e-3,
                _ => return None,
            };
            if !qualifies {
                continue;
            }

            // Primary: overlap of the pane's cross-axis span with the current pane's.
            // Secondary: distance from edge to edge along the navigation axis.
            let score = match direction {
                "left" | "right" => {
                    let overlap = f32::min(py + ph, cy + ch) - f32::max(py, cy);
                    let dist = dx.abs();
                    if overlap <= 0.0 {
                        continue;
                    }
                    dist / overlap // lower is better
                }
                "up" | "down" => {
                    let overlap = f32::min(px + pw, cx + cw) - f32::max(px, cx);
                    let dist = dy.abs();
                    if overlap <= 0.0 {
                        continue;
                    }
                    dist / overlap
                }
                _ => unreachable!(),
            };

            if best.is_none_or(|(_, s)| score < s) {
                best = Some((id, score));
            }
        }

        // If nothing qualifies (e.g. navigating left when already the leftmost pane),
        // fall back to wrap-around in tree order so the key is never a no-op.
        if best.is_none() {
            let ids: Vec<Uuid> = rects.iter().map(|(id, ..)| *id).collect();
            let idx = ids.iter().position(|id| *id == current)?;
            let next = match direction {
                "left" | "up" => {
                    if idx == 0 {
                        ids.len() - 1
                    } else {
                        idx - 1
                    }
                }
                _ => {
                    if idx == ids.len() - 1 {
                        0
                    } else {
                        idx + 1
                    }
                }
            };
            return Some(ids[next]);
        }

        best.map(|(id, _)| id)
    }
}
