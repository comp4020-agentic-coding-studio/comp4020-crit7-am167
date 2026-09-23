// What a level is called, in one place, so the map, the lists and the
// dialog can't disagree.
//
// Australian buildings number from the ground up: the ground floor is G,
// then level 1, 2, 3. The data keeps storeys as 0, 1, 2 (and room numbers
// as 0.01, 1.01), which is the same convention written as a number; only
// what a person reads changes.

/** "GF", "L1", "L2" — for a tag or a chip */
export function levelTag(level: number): string {
  return level === 0 ? "GF" : `L${level}`;
}

/** "ground floor", "level 1" — for running text */
export function levelName(level: number): string {
  return level === 0 ? "ground floor" : `level ${level}`;
}

/** "Ground floor", "Level 1" — for the start of a sentence or a crumb */
export function levelTitle(level: number): string {
  const name = levelName(level);
  return name[0].toUpperCase() + name.slice(1);
}
