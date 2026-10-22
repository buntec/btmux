import { expect, test } from 'bun:test';
import { BASE_LANE_COLOR, layoutGitGraph } from './src/lib/gitGraph';

const commit = (id: string, parents: string[] = []) => ({ id, parents });

test('keeps a straight first-parent lane', () => {
  const layout = layoutGitGraph([commit('c', ['b']), commit('b', ['a']), commit('a')]);

  expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
  expect(layout.maxLanes).toBe(1);
  expect(layout.rows.map((row) => row.laneColors)).toEqual([[BASE_LANE_COLOR], [BASE_LANE_COLOR], [BASE_LANE_COLOR]]);
  expect(layout.rows[1]?.transitions).toEqual([{ fromLane: 0, toLane: 0, colorIndex: BASE_LANE_COLOR }]);
});

test('fans merge parents into separate lanes and folds them back', () => {
  const layout = layoutGitGraph([
    commit('merge', ['main', 'feature']),
    commit('main', ['root']),
    commit('feature', ['root']),
    commit('root'),
  ]);

  expect(layout.maxLanes).toBe(2);
  expect(layout.rows[0]?.nextLaneColors).toEqual([BASE_LANE_COLOR, 1]);
  expect(layout.rows[0]?.transitions).toEqual([
    { fromLane: 0, toLane: 0, colorIndex: BASE_LANE_COLOR },
    { fromLane: 0, toLane: 1, colorIndex: 1 },
  ]);
  expect(layout.rows[2]?.transitions).toContainEqual({ fromLane: 1, toLane: 0, colorIndex: 1 });
  expect(layout.rows[3]?.laneColors).toEqual([BASE_LANE_COLOR]);
});

test('opens a new tip to the right without moving open lanes', () => {
  const layout = layoutGitGraph([
    commit('topic', ['base']),
    commit('merge', ['base', 'feature']),
    commit('feature', ['base']),
    commit('base'),
  ]);

  expect(layout.rows[0]?.nextLanes).toEqual(['base']);
  expect(layout.rows[1]?.lane).toBe(1);
  expect(layout.rows[1]?.lanes).toEqual(['base', 'merge']);
  expect(layout.rows[1]?.transitions).toEqual([
    { fromLane: 0, toLane: 0, colorIndex: BASE_LANE_COLOR },
    { fromLane: 1, toLane: 0, colorIndex: BASE_LANE_COLOR },
    { fromLane: 1, toLane: 1, colorIndex: 1 },
  ]);
  expect(layout.rows[2]?.lane).toBe(1);
});

test('keeps continuing branch colors through a nested merge', () => {
  const layout = layoutGitGraph([
    commit('merge', ['main', 'feature']),
    commit('main', ['first', 'second']),
    commit('first', ['root']),
    commit('second', ['root']),
    commit('feature', ['root']),
    commit('root'),
  ]);

  const merge = layout.rows[1];
  const next = layout.rows[2];
  const featureColor = merge.laneColors[merge.lanes.indexOf('feature')];
  const featureLane = merge.nextLanes.indexOf('feature');
  expect(merge.nextLaneColors[featureLane]).toBe(featureColor);
  expect(merge.nextLaneColors[merge.nextLanes.indexOf('second')]).not.toBe(featureColor);
  expect(merge.transitions).toContainEqual({ fromLane: 1, toLane: featureLane, colorIndex: featureColor });
  expect(next.transitions).toContainEqual({ fromLane: featureLane, toLane: featureLane, colorIndex: featureColor });
});

test('reserves continuing colors before allocating octopus merge branches', () => {
  const layout = layoutGitGraph([
    commit('merge', ['main', 'feature', 'topic']),
    commit('main', ['first', 'second', 'third']),
    commit('first', ['root']),
    commit('second', ['root']),
    commit('third', ['root']),
    commit('feature', ['root']),
    commit('topic', ['root']),
    commit('root'),
  ]);

  const merge = layout.rows[1];
  for (const branch of ['feature', 'topic']) {
    expect(merge.nextLaneColors[merge.nextLanes.indexOf(branch)]).toBe(merge.laneColors[merge.lanes.indexOf(branch)]);
  }
  expect(new Set(merge.nextLaneColors).size).toBe(merge.nextLanes.length);
});

test('keeps a surviving branch color after another branch ends', () => {
  const layout = layoutGitGraph([
    commit('merge', ['first-root', 'second-root']),
    commit('first-root'),
    commit('unrelated-root'),
    commit('second-root'),
  ]);

  const branchColor = layout.rows[0].nextLaneColors[1];
  expect(layout.rows[1].nextLaneColors).toEqual([branchColor]);
  expect(layout.rows[2].transitions).toContainEqual({ fromLane: 0, toLane: 0, colorIndex: branchColor });
  expect(layout.rows[3].laneColors).toEqual([branchColor]);
  expect(layout.rows[3].nextLaneColors).toEqual([]);
});
