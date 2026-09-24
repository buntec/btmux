export interface GitGraphCommit {
  id: string;
  parents: readonly string[];
}

export interface GitGraphTransition {
  fromLane: number;
  toLane: number;
  colorIndex: number;
}

export interface GitGraphRow<T extends GitGraphCommit> {
  commit: T;
  lane: number;
  lanes: string[];
  laneColors: number[];
  nextLanes: string[];
  nextLaneColors: number[];
  transitions: GitGraphTransition[];
}

export interface GitGraphLayout<T extends GitGraphCommit> {
  rows: GitGraphRow<T>[];
  maxLanes: number;
}

export const BASE_LANE_COLOR = 0;
const LANE_COLOR_COUNT = 8;

function nextLaneColor(usedColors: readonly number[]): number {
  for (let colorIndex = 1; colorIndex < LANE_COLOR_COUNT; colorIndex += 1) {
    if (!usedColors.includes(colorIndex)) return colorIndex;
  }
  return 1 + (usedColors.length % (LANE_COLOR_COUNT - 1));
}

function normalizeLaneColors(rawColors: readonly number[], laneCount: number): number[] {
  if (laneCount <= 1) return [BASE_LANE_COLOR];

  const colors: number[] = [];
  for (let lane = 0; lane < laneCount; lane += 1) {
    const preferred = rawColors[lane] ?? BASE_LANE_COLOR;
    colors.push(colors.includes(preferred) ? nextLaneColor(colors) : preferred);
  }
  return colors;
}

/** Assigns lanes using the same first-parent/merge-parent shape as git log --graph. */
export function layoutGitGraph<T extends GitGraphCommit>(commits: readonly T[]): GitGraphLayout<T> {
  let lanes: string[] = [];
  let laneColors: number[] = [];
  let maxLanes = 1;
  const rows: GitGraphRow<T>[] = [];

  for (const commit of commits) {
    const before = lanes.slice();
    const beforeColors = laneColors.slice();
    let lane = before.indexOf(commit.id);
    if (lane === -1) {
      lane = 0;
      before.unshift(commit.id);
      beforeColors.unshift(beforeColors.length === 0 ? BASE_LANE_COLOR : nextLaneColor(beforeColors));
    }

    const rawNext: string[] = [];
    const rawNextColors: number[] = [];
    for (let index = 0; index < lane; index += 1) {
      rawNext.push(before[index]);
      rawNextColors.push(beforeColors[index] ?? BASE_LANE_COLOR);
    }
    for (let parentIndex = 0; parentIndex < commit.parents.length; parentIndex += 1) {
      const parent = commit.parents[parentIndex];
      const existingLane = before.indexOf(parent);
      rawNext.push(parent);
      rawNextColors.push(
        existingLane === -1
          ? parentIndex === 0
            ? (beforeColors[lane] ?? BASE_LANE_COLOR)
            : BASE_LANE_COLOR
          : (beforeColors[existingLane] ?? BASE_LANE_COLOR),
      );
    }
    for (let index = lane + 1; index < before.length; index += 1) {
      rawNext.push(before[index]);
      rawNextColors.push(beforeColors[index] ?? BASE_LANE_COLOR);
    }

    const nextLanes: string[] = [];
    const deduplicatedColors: number[] = [];
    for (let index = 0; index < rawNext.length; index += 1) {
      const laneId = rawNext[index];
      if (!nextLanes.includes(laneId)) {
        nextLanes.push(laneId);
        deduplicatedColors.push(rawNextColors[index]);
      }
    }
    const nextLaneColors = normalizeLaneColors(deduplicatedColors, nextLanes.length);

    const transitions: GitGraphTransition[] = [];
    for (let fromLane = 0; fromLane < before.length; fromLane += 1) {
      const laneId = before[fromLane];
      if (laneId === commit.id) {
        for (let parentIndex = 0; parentIndex < commit.parents.length; parentIndex += 1) {
          const parent = commit.parents[parentIndex];
          const toLane = nextLanes.indexOf(parent);
          if (toLane !== -1) {
            transitions.push({
              fromLane,
              toLane,
              colorIndex:
                commit.parents.length > 1 && nextLanes.length > 1
                  ? (nextLaneColors[toLane] ?? BASE_LANE_COLOR)
                  : (beforeColors[fromLane] ?? BASE_LANE_COLOR),
            });
          }
        }
      } else {
        const toLane = nextLanes.indexOf(laneId);
        if (toLane !== -1) {
          transitions.push({ fromLane, toLane, colorIndex: beforeColors[fromLane] ?? BASE_LANE_COLOR });
        }
      }
    }

    rows.push({
      commit,
      lane,
      lanes: before,
      laneColors: beforeColors,
      nextLanes,
      nextLaneColors,
      transitions,
    });
    lanes = nextLanes;
    laneColors = nextLaneColors;
    maxLanes = Math.max(maxLanes, before.length, nextLanes.length);
  }

  return { rows, maxLanes };
}
