/**
 * The member palette.
 *
 * The properties worth testing are the ones a hand-check would not notice: an
 * assignment that is stable *this* load and different the next, or one that
 * quietly repaints half the team when somebody joins, both look completely
 * correct in a screenshot.
 */

import { describe, expect, it } from 'vitest';

import type { Enrollee } from './colors.js';
import { SLOT_COUNT, assignSlots, memberColor, slotVar } from './colors.js';

/** A roster of `count` members, joining a day apart. */
function roster(count: number, prefix = 'member'): Enrollee[] {
  return Array.from({ length: count }, (_unused, index) => ({
    member_id: `${prefix}-${String(index)}`,
    created_at: 1_700_000_000_000 + index * 86_400_000,
  }));
}

describe('assignSlots', () => {
  it('gives the same roster the same slots every time', () => {
    const members = roster(6);
    const first = assignSlots(members);
    const second = assignSlots(members);

    for (const member of members) {
      expect(second.get(member.member_id)).toBe(first.get(member.member_id));
    }
  });

  it('does not depend on the order the roster arrives in', () => {
    const members = roster(6);
    const forwards = assignSlots(members);
    const backwards = assignSlots([...members].reverse());

    for (const member of members) {
      expect(backwards.get(member.member_id)).toBe(forwards.get(member.member_id));
    }
  });

  it('gives a team that fits the palette a colour each', () => {
    const slots = assignSlots(roster(SLOT_COUNT));
    expect(new Set(slots.values()).size).toBe(SLOT_COUNT);
  });

  it('keeps every existing member on their colour when someone joins', () => {
    const existing = roster(5);
    const before = assignSlots(existing);

    // Sorts before every existing id alphabetically and after all of them by
    // join time, which is the case a name-ordered walk would get wrong.
    const joiner: Enrollee = { member_id: 'aaa-newcomer', created_at: 1_800_000_000_000 };
    const after = assignSlots([...existing, joiner]);

    for (const member of existing) {
      expect(after.get(member.member_id)).toBe(before.get(member.member_id));
    }
    expect(after.get('aaa-newcomer')).toBeTypeOf('number');
  });

  it('spreads a roster larger than the palette instead of clumping it', () => {
    const slots = assignSlots(roster(SLOT_COUNT * 2));
    const used = new Map<number, number>();
    for (const slot of slots.values()) used.set(slot, (used.get(slot) ?? 0) + 1);

    expect(used.size).toBe(SLOT_COUNT);
    // Two full passes of the palette, so every hue is used exactly twice.
    for (const count of used.values()) expect(count).toBe(2);
  });

  it('ignores a duplicated member rather than assigning them twice', () => {
    const members = roster(3);
    const first = members[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    const slots = assignSlots([...members, first]);
    expect(slots.size).toBe(3);
  });

  it('is empty for an empty roster', () => {
    expect(assignSlots([]).size).toBe(0);
  });
});

describe('slotVar', () => {
  it('names the custom property the stylesheet defines', () => {
    expect(slotVar(0)).toBe('var(--series-1)');
    expect(slotVar(SLOT_COUNT - 1)).toBe(`var(--series-${String(SLOT_COUNT)})`);
  });

  it('wraps rather than naming a property that does not exist', () => {
    expect(slotVar(SLOT_COUNT)).toBe('var(--series-1)');
    expect(slotVar(-1)).toBe(`var(--series-${String(SLOT_COUNT)})`);
  });
});

describe('memberColor', () => {
  it('reads the assignment when the member is in it', () => {
    const slots = assignSlots(roster(3));
    expect(memberColor('member-1', slots)).toBe(slotVar(slots.get('member-1') ?? -1));
  });

  it('falls back to a stable hash for a member the roster does not hold', () => {
    const slots = assignSlots(roster(3));
    const colour = memberColor('stranger', slots);

    expect(colour).toMatch(/^var\(--series-[1-8]\)$/);
    expect(memberColor('stranger', slots)).toBe(colour);
  });
});
