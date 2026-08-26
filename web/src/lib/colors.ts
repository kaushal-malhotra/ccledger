/**
 * The colour a member wears, everywhere.
 *
 * A member's colour has to be the same in the stacked area, in their sparkline,
 * on their detail page, and on the next load — otherwise the legend has to be
 * re-read every time the page is opened, which is the whole cost the colour was
 * supposed to save. So it is derived, never stored and never assigned by rank.
 *
 * Three properties are load-bearing, and each one rules out a simpler scheme:
 *
 * - **Stable across loads and ranges.** Colouring by position in the response
 *   would repaint everyone whenever the leaderboard changed or a filter dropped
 *   a member out of the range. The assignment therefore looks at nothing but
 *   the enrolment list, which is the same on every request.
 * - **Distinct within a team.** Hashing an id straight onto eight slots reads
 *   as deterministic and is: deterministically bad. Five members collide better
 *   than half the time, and two teammates sharing a band in a stacked area is
 *   the one failure this is meant to prevent. Collisions are probed past.
 * - **Undisturbed when someone joins.** Probing means order matters, so the
 *   walk is in join order — a new teammate is appended after everyone already
 *   assigned and cannot shift them. Sorting by id would let a new `alice`
 *   repaint half the team.
 *
 * The values live in `styles.css` as `--series-1` through `--series-8`, one set
 * per theme, so this module deals only in slot numbers and the swap between
 * light and dark stays where the rest of the palette is. The eight hues are the
 * data-viz reference palette, validated against this dashboard's own two
 * surfaces rather than assumed: worst adjacent CVD deltaE 9.1 light / 8.4 dark
 * against a target of 8.
 */

/** How many categorical slots the palette holds. */
export const SLOT_COUNT = 8;

/** The identity fields the assignment reads. `MemberListEntry` satisfies it. */
export interface Enrollee {
  readonly member_id: string;
  /** Epoch milliseconds. Only the ordering is used. */
  readonly created_at: number;
}

/**
 * FNV-1a over the id's code units, as an unsigned 32-bit integer.
 *
 * The multiply is written as shifted adds because `hash * 16777619` overflows
 * into a float at the third character and stops being a hash of the later ones.
 */
function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Every member's palette slot, keyed by member id.
 *
 * Pass the whole enrolment list — `/api/members`, which is not scoped to the
 * date range — rather than whoever appears in the current response. That is
 * what makes the map identical for every range and every filter on the page.
 *
 * A roster larger than the palette starts the slots over rather than leaving
 * everyone past the eighth on their raw hash, so twelve members come out as two
 * even passes rather than eight spread and four clumped. Colours do repeat at
 * that size; the legend and the table are what tell those members apart, which
 * is why neither is ever optional.
 */
export function assignSlots(members: readonly Enrollee[]): ReadonlyMap<string, number> {
  const ordered = [...members].sort(
    (a, b) => a.created_at - b.created_at || (a.member_id < b.member_id ? -1 : 1),
  );

  const slots = new Map<string, number>();
  const taken = new Set<number>();

  for (const member of ordered) {
    if (slots.has(member.member_id)) continue;

    let slot = hash32(member.member_id) % SLOT_COUNT;
    // Bounded by the slot count, so a full palette falls through to the raw
    // hash rather than looping.
    for (let step = 0; step < SLOT_COUNT && taken.has(slot); step += 1) {
      slot = (slot + 1) % SLOT_COUNT;
    }

    slots.set(member.member_id, slot);
    taken.add(slot);
    if (taken.size === SLOT_COUNT) taken.clear();
  }

  return slots;
}

/**
 * The CSS custom property holding slot `index`, which resolves to that slot's
 * hue in whichever theme is in force. Out-of-range indices wrap.
 */
export function slotVar(index: number): string {
  const slot = ((index % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT;
  return `var(--series-${String(slot + 1)})`;
}

/**
 * The colour for a member, falling back to a hash when the id is not in the
 * map. The fallback is for a member who reported inside the range but is absent
 * from the enrolment list — deleted mid-session, most likely — where drawing
 * them in some colour beats not drawing them.
 */
export function memberColor(memberId: string, slots: ReadonlyMap<string, number>): string {
  return slotVar(slots.get(memberId) ?? hash32(memberId) % SLOT_COUNT);
}

/**
 * The neutral the folded tail wears. Deliberately outside the categorical
 * palette: "everyone else" is not a member and must not look like one.
 */
export const OTHER_COLOR = 'var(--series-other)';
