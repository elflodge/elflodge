/**
 * A page's document title: its name first, so a narrow tab still shows it, then the product. The
 * root route's own title, the product alone, stands for any page without one.
 */
export function pageHead(name: string) {
  return { meta: [{ title: `${name} · Elflodge` }] };
}

/**
 * The title of a page about the Organization, from its route context. For an account that is no
 * member, `_member` shows "Organization access" in the page's place, while the page's own match
 * still loads and its title, the deepest, would otherwise name the page that is not shown.
 */
export function memberPageHead(context: { member: unknown }, name: string) {
  return pageHead(context.member ? name : "Organization access");
}
