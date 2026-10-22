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
      lane = before.length;
      before.push(commit.id);
      beforeColors.push(beforeColors.length === 0 ? BASE_LANE_COLOR : nextLaneColor(beforeColors));
    }

    const nextLanes = [...new Set([...before.slice(0, lane), ...commit.parents, ...before.slice(lane + 1)])];
    const colorsById = new Map(before.map((id, index) => [id, beforeColors[index]]));
    const firstParent = commit.parents[0];
    if (firstParent !== undefined && !colorsById.has(firstParent)) {
      colorsById.set(firstParent, beforeColors[lane]);
    }

    // Reserve continuing colors before allocating new merge branches.
    const usedColors = nextLanes.flatMap((id) => {
      const color = colorsById.get(id);
      return color === undefined ? [] : [color];
    });
    const nextLaneColors = nextLanes.map((id) => {
      const color = colorsById.get(id);
      if (color !== undefined) return color;
      const nextColor = nextLaneColor(usedColors);
      usedColors.push(nextColor);
      return nextColor;
    });

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

/** Case-insensitive substring match on summary, author, and full/short hash. */
export function filterGitLog<T extends GitGraphCommit & { summary: string; author: string }>(
  commits: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return commits as T[];
  return commits.filter(
    (c) => c.summary.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
  );
}
