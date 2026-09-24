import { expect, test } from 'bun:test';
import { BASE_LANE_COLOR, layoutGitGraph } from './src/lib/gitGraph';

const commit = (id: string, parents: string[] = []) => ({ id, parents });

test('keeps a straight first-parent lane', () => {
  const layout = layoutGitGraph([commit('c', ['b']), commit('b', ['a']), commit('a')]);

  expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
  expect(layout.maxLanes).toBe(1);
  expect(layout.rows.map((row) => row.laneColors)).toEqual([[BASE_LANE_COLOR], [BASE_LANE_COLOR], [BASE_LANE_COLOR]]);
  expect(layout.rows[1]?.transitions).toEqual([
    { fromLane: 0, toLane: 0, colorIndex: BASE_LANE_COLOR },
  ]);
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
