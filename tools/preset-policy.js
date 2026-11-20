// The video preset adds its own tools on top of the shipped standard list; it
// removes nothing and denies nothing. Kept as a plugin row so installations that
// already name it keep activating, and so a future narrowing policy has one
// obvious place to live.
export const inject = ['tools'];

export function apply() {}
