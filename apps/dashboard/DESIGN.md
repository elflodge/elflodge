# Dashboard design

How the dashboard looks, and how to build a page so that it looks the same. The stylesheets in `src/styles/` are the system; this file says what they give you and what they expect of the markup.

## The idea

The dashboard is a ruled record. It is set like a ledger: dense, plain, and exact about what each figure is.

- **Ruled, not boxed.** The page is the brand's ground, in light and in dark. Regions are separated by rules: a hairline between rows, a heavy rule under a heading, a double rule above a total. There are no cards. Only what floats over the page (a popover, a dialog) has an edge and a shadow.
- **Two faces.** Instrument Sans for the interface and for sentences. JetBrains Mono for data: anything a person might copy or compare, such as an ID, a figure, an address or a command.
- **Three brand colours.** The ground is the page. The green of the mark's hood carries links, the primary action and the heavy rules. The colour of its lamp marks only what is live now, and where the keyboard is. Nothing else uses the lamp, so it keeps its meaning.
- **Colour never speaks alone.** What failed is red and has a cross and says so in words; what was done has a tick and says so.
- **Compact.** The working size is 13px, a table row is 30px and a control 32px. At 640px and below, or with a coarse pointer, a control and a link standing alone are 44px.
- **Nothing invented is shown as fact.** A figure carries its unit. Words are the glossary's (`CONTEXT.md`), capitals included.

## The files

| File                        | What it holds                                                                  |
| --------------------------- | ------------------------------------------------------------------------------ |
| `src/styles/tokens.css`     | Every design token, as a custom property, and nothing else.                    |
| `src/styles/elements.css`   | Plain elements, so semantic HTML with no class already looks right.            |
| `src/styles/components.css` | Named parts, one section each, opened by a comment that says what the part is. |
| `src/styles/app.css`        | Imports the three, in that order.                                              |

`src/routes/__root.tsx` links `app.css` and the two faces, which come from the `@fontsource-variable` packages and are served by the hub with the rest of the build. The faces are linked there rather than imported by `app.css` so that the build's third-party notices carry their licences.

Pages are written as semantic HTML in JSX with these classes, and with no inline styles.

## Tokens

Each colour is written once, as `light-dark(light, dark)`. The page follows the system setting; `data-theme="light"` or `"dark"` on `<html>` forces one, and the brand mark in the page follows it. The favicon follows the system setting, since it sits in the browser's tab and not in the page. The dashboard has no theme switch.

- **Brand:** `--brand-ground`, `--brand-shape`, `--brand-lamp`. Nothing replaces them.
- **Neutrals** (rules, bands, edges) are mixes of the ground and the shape, `color-mix(in oklab, …)`, so they stay in the brand's family in both themes.
- **Inks** are explicit values. Text reaches 4.5:1 on every ground it is set on, in both themes.
- **Lines that must be seen** (`--c-ink-3`, `--c-field-edge`, `--c-focus`) reach 3:1 on every ground; the comment beside each gives its measured lowest value. `--c-rule`, the hairline, only separates and is quieter.
- **Washes** are grounds for a sentence the reader must not miss: `--c-failed-wash` for a refusal or an invalid field, `--c-lamp-wash` for what is live and for marked text.
- **Type:** sizes from `--text-xs` (12px: units, column heads, notes) through `--text-sm` (13px, the working size) and `--text-md` (15px, sentences that explain) to `--text-2xl` (23px, a page heading). The mono is set at `--mono-size` beside the sans so their x-heights meet.
- **Space** is in steps of 4px: `--space-1` to `--space-4` (4 to 16px) and `--space-7` (48px). The page's side margin is `--gutter`.
- A step that nothing uses is not defined, which is why the type sizes have no `--text-xl` and the spaces no `--space-5` or `--space-6`.
- **Sizes:** `--row`, `--control`, `--control-touch`, `--target`, `--topbar`, and the three rules `--rule`, `--rule-heavy` and `--rule-total`.

A new token gets a comment saying what it is for. A new colour for text or for a line that must be seen is measured against every ground it will sit on, in both themes, before it is added.

## Plain elements

With no class at all:

- **Text** is the sans at 13px with tabular figures. Headings have fixed sizes: `h1` 23px, `h2` 17px. `code`, `kbd`, `samp` and `pre` are in the mono with ligatures off, so they read as typed. `time` stays on one line.
- **Links** are underlined at rest in a quieter tint of their colour, and at full strength under the pointer or the keyboard. Focus everywhere is a 2px ring.
- **Tables** are ruled: a hairline under each row, a one-line row 30px tall, small quiet column heads, a double rule above a `tfoot`.
- **`dl`** is ruled facts, name and value on one line; below 480px the value goes under its name.
- **Buttons** are paper with an edge; a disabled one is greyed. **Fields** (`input`, `select`, `textarea`) match them, show their focus ring inside the edge, and take the failed wash with `aria-invalid="true"`.
- **`details`** has its `summary` in the link colour. **`progress`** is a short bar in the brand's green.
- **`dialog`** and **`[popover]`** are paper with an edge and a shadow.

No page has a table, a `dl`, `details`, `progress` or a `dialog` yet.

## Parts

### The shell

Every page for a signed-in Member is inside it (`src/routes/_signed-in.tsx`).

```tsx
<a class="skip" href="#main">Skip to the page</a>
<header class="topbar">
  <Link to="/" class="brand">
    <BrandMark alt="Elflodge" />
    <span class="brand-name" aria-hidden="true">Elflodge</span>
  </Link>
  <span class="org" title="Harbor & Pine">Harbor & Pine</span>
  <div class="topbar-end">
    <button type="button" class="quiet" popovertarget="account" ref={(element) => { opener = element; }}>
      <span class="member-name" title="Robin Hale">Robin Hale</span>
      <span class="mark mark-opens" aria-hidden="true" />
    </button>
    <div id="account" class="menu-pop" popover ref={(element) => { account = element; }}>
      <p class="pop-who"><strong>Robin Hale</strong><br /><span class="mono">robin@example.com</span><br />Harbor & Pine</p>
      <ul class="pop-list">
        <li><Link to="/change-password" onClick={closeMenu}>Change password</Link></li>
        <li><a href="/docs">API reference</a></li>
        <li><button type="button" class="quiet">Sign out</button></li>
      </ul>
    </div>
  </div>
</header>
<main id="main" class="page">
  <InShell value={true}><Outlet /></InShell>
</main>
```

- The bar holds the brand, the Organization's name and, at its end, the Member's name. Its links are not underlined: the bar is a known place.
- The Member's name opens the account menu, a native popover: who is signed in, then the account's links. The menu is at most 20rem wide, and a longer name or address wraps in it. The chevron after the name says it opens something. A button in the menu is drawn as its links are.
- A long name is cut at its end in the bar, with the whole name in its `title` and in the menu. At 640px and below the Organization's name is only in the menu; at 26rem and below the brand is its mark alone, which is why the mark's `alt` names it.
- The browser closes the menu on Escape or a press elsewhere. The shell closes it in three cases the browser leaves open:
  - a link in it changes the page through the router;
  - the focus arrives anywhere in the page but the menu and its button, which the shell watches for on the document;
  - signing out fails, when the notice is in the page under the menu. The focus then goes to the Member's name, unless the Member has moved on to something else meanwhile.
- `InShell` around the outlet tells a page that failed or was not found that the bar and `main` are already there.

### A page

`main#main.page` is the full width of the window with the page's margins. A page begins with its heading in `div.head`, which rules a heavy line under it:

```tsx
<div class="head">
  <h1>Change password</h1>
</div>
```

Sentences that explain are `p.prose`: 15px, at most 72 characters a line.

### A page without the shell

Signing in and setting up have no bar, since no one is signed in yet. Such a page is `main#main.page.is-alone`: one narrow column under the mark.

```tsx
<main id="main" class="page is-alone">
  <BrandMark alt="" />
  <h1>Sign in to Elflodge</h1>
  <form class="fields">…</form>
</main>
```

The mark's `alt` is empty here because the heading names the product.

### A page that failed or was not found

The router shows `DefaultCatchBoundary` in place of a page that failed and `NotFound` in place of one that does not exist (`src/components/`). Both are a `FallbackPage`, which takes a heading and what goes under it. Inside the shell it is a page like any other, its heading in `div.head`. Outside the shell, as when the session could not be read, it is a page without the shell.

```tsx
<FallbackPage heading="This page could not be shown">
  <Notice role="alert">{ensureError(props.error).message}</Notice>
  <p>
    <button type="button" class="primary" onClick={() => void router.invalidate()}>
      Try again
    </button>
  </p>
</FallbackPage>
```

What failed is said in an alert notice above "Try again". A read that fails says what could not be read, then the hub's words where it gave any: "The session could not be read: …". `unreadError` (`src/auth-client.ts`) makes that error, and `readApi` (`src/api-client.ts`) throws it for a call of the hub's API.

### Fields

A plain form is `form.fields`: fields one under another, at most 24rem wide, the button at the start of the last line. Each field is a `div.field` holding its `label` and its control, tied by `for` and `id`. A checkbox with its words is one `label.check`.

```tsx
<form class="fields">
  <div class="field">
    <label for="sign-in-email">Email</label>
    <input id="sign-in-email" name="email" type="email" autocomplete="username" required />
  </div>
  <label class="check">
    <input name="revoke-other-sessions" type="checkbox" checked />
    Sign out of other sessions
  </label>
  <button type="submit" class="primary">
    Sign in
  </button>
</form>
```

Use the browser's own validation (`required`, `type`, `minlength`, `pattern`, `min`, `max`) to refuse early what the hub would refuse. A field must not refuse what the hub accepts. Where it accepts more, as `type="email"` does, the hub's refusal comes back as the form's notice. Do not use `maxlength`: it cuts what is typed or pasted instead of refusing it, so a longest length is the hub's to refuse. `src/form.ts` holds what more than one field takes: `NEW_PASSWORD`, the shortest password that can be set, and `GIVEN_NAME`, which refuses a name of white space alone.

### Notices

One sentence the reader must not miss, as a mark and its words on a wash (`src/components/Notice.tsx`). An `alert` says what failed or was refused; a `status` says that something was done. A form's answer is a notice above its button.

```tsx
<Notice role="alert">The new password and its confirmation differ.</Notice>
<Notice role="status">Your password is changed.</Notice>
```

which draw

```html
<div class="notice notice-failed" role="alert">
  <span class="mark mark-failed" aria-hidden="true"></span>
  <p>The new password and its confirmation differ.</p>
</div>
```

### Buttons

A plain `button` is the default. `.primary` is the one action a page or form exists for; a page has at most one. `.quiet` is words alone, for a control in the bar or in a menu.

### Mono

`.mono` sets in the mono what a person might copy or compare where no element (`code`, `kbd`, `samp`, `pre`) says it is, such as the Member's email address in the account menu:

```tsx
<span class="mono">robin@example.com</span>
```

An address, a host name or a file name always goes in the mono. The sans draws a full stop close into a round letter beside it, which suits the end of a sentence and closes up `pine.example`.

### Marks

A mark is a small drawn shape that stands beside words and takes their colour: `<span class="mark mark-failed" aria-hidden="true"></span>`. It is always hidden from assistive technology, because the words beside it say the same. There are three: `mark-failed`, a cross; `mark-succeeded`, a tick; and `mark-opens`, a chevron after words that open a menu. No icon set is used. In forced-colours mode a mark keeps its shape and takes the system's text colour.

## Rules

1. **A link is underlined**, except in the top bar. A button that is words alone shows what it does another way: an underline in a menu, the chevron after the Member's name.
2. **Targets:** with a fine pointer, 32px for a control and 24px for a link standing alone; at 640px and below or with a coarse pointer, 44px for both, each way. A link outside a sentence takes `.stands-alone`, which gives it those. A link inside a sentence keeps its line's height.
3. **The lamp colour is only for what is live now and for keyboard focus.**
4. **Colour is never the only sign:** a mark and words go with it.
5. **A name that may not fit** is cut at its end only where the whole name is one step away, as the bar's names are in the menu, and carries the whole name in its `title`.
6. **No inline styles in a page.** In the stylesheets, every colour and type size is a token.

## Adding a part

A new page is the shell, a heading and the parts above. When it needs something they do not give:

1. Write it as semantic HTML first; a plain element may already be enough. Look at the first use of a plain element that no page has yet as closely as at a new part.
2. Add a section to `components.css`, opened by a one-line comment that says what the part is. Name classes for what a part is, never for the page it is on. Add any new token to `tokens.css`.
3. Describe the part here: its element, its classes, the attributes it needs, and a short example.
4. Look at it in light and in dark at 1440, 1280, 960, 390 and 320px wide, and with the keyboard alone. Nothing may scroll sideways, and text and lines keep the contrast the tokens section gives.

The part, its tokens and its description arrive in the change that builds the page that uses it.

## Browser floor

Chromium 123, Firefox 125 and Safari 17.5, the first versions with both `light-dark()` and the `popover` attribute. Only Chromium has been run.

One exception is known. Safari on iOS and iPadOS before 18.3 does not close a popover on a tap elsewhere (WebKit bug 267688). The account menu still closes there from the Member's name, which opened it, and when one of its links is followed.
