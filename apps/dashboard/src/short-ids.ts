/** The fewest characters of an ID that a person reads as its short ID. */
const SHORTEST = 8;

/**
 * Each ID's short ID: its first eight characters, or as many more as tell it from every other ID in
 * `ids` that starts the same way, as Git shortens commit names. A short ID never ends in the
 * hyphen of a UUID.
 */
export function shortIds(ids: readonly string[]): Map<string, string> {
  return new Map(
    ids.map((id) => {
      let length = SHORTEST;
      for (const other of ids) {
        if (other === id) continue;
        let shared = 0;
        while (shared < id.length && id[shared] === other[shared]) shared++;
        length = Math.max(length, shared + 1);
      }
      if (id[length - 1] === "-") length++;
      return [id, id.slice(0, length)];
    }),
  );
}
