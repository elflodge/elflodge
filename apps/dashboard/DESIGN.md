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

The stylesheets use no cascade layers: a rule wins by its selector.

`src/routes/__root.tsx` links `app.css` and the two faces, which come from the `@fontsource-variable` packages and are served by the hub with the rest of the build. The faces are linked there rather than imported by `app.css` so that the build's third-party notices carry their licences.

Pages are written as semantic HTML in JSX with these classes, and with no inline styles.

## Tokens

Each colour is written once, as `light-dark(light, dark)`. The page follows the system setting; `data-theme="light"` or `"dark"` on `<html>` forces one, and the brand mark in the page follows it. The favicon follows the system setting, since it sits in the browser's tab and not in the page. The dashboard has no theme switch.

- **Brand:** `--brand-ground`, `--brand-shape`, `--brand-lamp`. Nothing replaces them.
- **Neutrals** (rules, bands, edges) are mixes of the ground and the shape, `color-mix(in oklab, …)`, so they stay in the brand's family. The code band (`--c-sunk`) mixes them in light and uses a darker ground in dark, where the mix cannot sink below the page. On the band, `--c-ink` measures 11.40:1 in light and 12.20:1 in dark. A placeholder's `--c-ink-3` outline measures 3.47:1 and 6.54:1 respectively.
- **Inks** are explicit values. `--c-lamp-ink` is the text ink for Running. Text reaches 4.5:1 on every ground it is set on, in both themes.
- **Lines that must be seen** (`--c-ink-3`, `--c-field-edge`, `--c-focus`) reach 3:1 on every ground; the comment beside each gives its measured lowest value. `--c-rule`, the hairline, only separates and is quieter.
- **Status colours.** `--c-running` is the lamp, a shade darker in light so the mark keeps 3:1 on the lamp's own wash and the strip's band (`--c-ground-2`); it is live now. `--c-waiting` (ink-2) is for queued, paused and cancelled, which are not alarms. `--c-unknown` is for a status the hub cannot confirm, and is text-strength.
- **Washes** are grounds for a sentence the reader must not miss: `--c-failed-wash` for a refusal or an invalid field, `--c-lamp-wash` for what is live and for marked text.
- **Type:** sizes from `--text-xs` (12px: units, column heads, notes) through `--text-sm` (13px, the working size), `--text-md` (15px, sentences that explain) and `--text-lg` (17px, section headings) to `--text-2xl` (23px, a page heading). The mono is set at `--mono-size` beside the sans so their x-heights meet.
- **Space** is in steps of 4px: `--space-1` to `--space-4` (4 to 16px) and `--space-7` (48px). The page's side margin is `--gutter`.
- A step that nothing uses is not defined, which is why the type sizes have no `--text-xl` and the spaces no `--space-5` or `--space-6`.
- **Sizes:** `--row`, `--control`, `--control-touch`, `--target`, `--topbar`, `--strip`, `--mark` (a drawn mark), `--radius` (controls and dialogs), and the three rules `--rule`, `--rule-heavy` and `--rule-total`.

In the Jobs list, `--line-sm` keeps mono and sans on the same working line, `--weight-mono-strong` gives the job name its weight, and `--row-day` sets the height of a creation-day heading. The fixed column widths are `--jobs-status`, `--jobs-beside`, `--jobs-batch`, `--submitter`, `--jobs-labels`, `--jobs-runner`, `--jobs-time`, `--jobs-tokens` and `--jobs-cost`. On two lines `--jobs-cost-narrow` holds the cost and its USD unit.

A new token gets a comment saying what it is for. A new colour for text or for a line that must be seen is measured against every ground it will sit on, in both themes, before it is added.

## Plain elements

With no class at all:

- **Text** is the sans at 13px with tabular figures. Headings have fixed sizes: `h1` 23px, `h2` 17px. `code`, `kbd`, `samp` and `pre` are in the mono with ligatures off, so they read as typed. `time` stays on one line.
- **Links** are underlined at rest in a quieter tint of their colour, and at full strength under the pointer or the keyboard. Focus everywhere is a 2px ring.
- **Tables** are ruled: a hairline under each row, a one-line row 30px tall, small quiet column heads, a double rule above a `tfoot`.
- **`dl`** is ruled facts, name and value on one line; below 480px the value goes under its name.
- **Buttons** are paper with an edge. Disabled buttons are greyed. A pending submit button uses `aria-disabled` and keeps its keyboard focus ring. **Fields** (`input`, `select`, `textarea`) match them, show their focus ring inside the edge, and take the failed wash with `aria-invalid="true"`.
- **`details`** has its `summary` in the link colour. **`progress`** is a short bar in the brand's green.
- **`dialog`** and **`[popover]`** are paper with an edge and a shadow.

No page has `progress` yet.

## Parts

### The shell

Every page for a signed-in member is inside it (`src/routes/_signed-in.tsx`).

```tsx
<a class="skip" href="#main">Skip to the page</a>
<header class="topbar">
  <Link to="/" class="brand">
    <BrandMark alt="Elflodge" />
    <span class="brand-name" aria-hidden="true">Elflodge</span>
  </Link>
  <span class="org" title="Harbor & Pine">Harbor & Pine</span>
  <nav class="nav-wide" aria-label="Destinations">
    <Destinations class="nav" />
  </nav>
  <CurrentDestination />
  <div class="topbar-end">
    <button type="button" class="quiet" popovertarget="account" ref={(element) => { opener = element; }}>
      <span class="member-name" title="Robin Hale">Robin Hale</span>
      <span class="mark mark-opens" aria-hidden="true" />
    </button>
    <div id="account" class="menu-pop" popover ref={(element) => { account = element; }}>
      <nav class="pop-nav" aria-label="Destinations">
        <Destinations class="nav-stack" />
      </nav>
      <p class="pop-who"><strong>Robin Hale</strong><br /><span class="mono">robin@example.com</span><br />Harbor & Pine</p>
      <ul class="pop-list">
        <li><Link to="/change-password">Change password</Link></li>
        <li><form onSubmit={signOut}><button type="submit" class="quiet" aria-disabled={pending() ? "true" : undefined}>Sign out</button></form></li>
      </ul>
    </div>
  </div>
</header>
<main id="main" class="page">
  <InShell value={true}><Outlet /></InShell>
</main>
```

- The bar holds the brand, the Organization's name, the destinations and, at its end, the member's name. Its links are not underlined: the bar is a known place.
- The destinations are the pages the bar leads to, listed once in `src/components/Destinations.tsx`; a page the bar leads to adds its line there. The router marks the current one `aria-current="page"`, which draws it as a tab standing on the bar's rule. An entry is current at its page and at every page under it, unless its `activeOptions` say otherwise. A search string does not change the current destination.
- The member's name opens the account menu, a native popover: who is signed in, then the account's links. The menu is at most 20rem wide, and a longer name or address wraps in it. The chevron after the name says it opens something. A button in the menu is drawn as its links are.
- A long name is cut at its end in the bar, with the whole name in its `title` and in the menu. The destinations are never cut; the names beside them are.
- The bar folds as it narrows. Below 60rem the Organization's name is only in the menu. At 52rem and below the destinations fold into the menu too, above who is signed in (`nav.pop-nav` with `ul.nav-stack`), the current one marked by a rule at its start. Its name stays in the bar as `span.here` while the menu is closed, whole at every width: it does not shrink, and the member's name beside it is cut instead, down to its chevron if it must be. At 320px the two share 178px, so a destination's name of up to 120px leaves the member's name at least 58px. At 390px they share 248px, leaving at least 128px. A longer destination is measured again. The stages hold six destinations of ordinary length beside a member's name at its full width; a bar that holds more is measured again. At 26rem and below the brand is its mark alone, which is why the mark's `alt` names it.
- The browser closes the menu on Escape or a press elsewhere. The shell closes it in three cases the browser leaves open:
  - the router resolves a navigation in this tab, including one to the current page;
  - the focus arrives anywhere in the page but the menu and its button, which the shell watches for on the document;
  - signing out fails, when the notice is in the page under the menu. The focus then goes to the member's name, unless the member has moved on to something else meanwhile.
- `InShell` around the outlet tells a page that failed or was not found that the bar and `main` are already there.

### The hub strip

The strip is part of the shell: it is on every page inside it, an account page such as Change password included, so a page begins at the same height everywhere.

Under the bar, for a member, a band says what the hub says now of the Organization's Runners and unfinished jobs (`src/components/HubStrip.tsx`): how many Runners are connected, how many agents are running, how many jobs are queued, and, when there are any, how many are paused and how many have a status the hub cannot confirm ("status unknown"). It reads `GET /runners` and `GET /jobs/counts` again at the shared `REFRESH_INTERVAL_MS` interval in `src/query.ts` while the page is visible.

```tsx
<section class="hubstrip" aria-label="The hub now">
  <ul class="hubstate">
    <li>
      <span class="mark mark-connected" aria-hidden="true" />
      Runners 4 of 5 connected
    </li>
    <li>
      <Link to="/jobs" search={{ status: ["running"] }}>
        <span class="mark mark-running" aria-hidden="true" />
        45 agents running
      </Link>
    </li>
    <li>
      <Link to="/jobs" search={{ status: ["queued"] }}>
        <span class="mark mark-queued" aria-hidden="true" />
        303 queued
      </Link>
    </li>
    <li>
      <Link to="/jobs" search={{ status: ["paused"] }}>
        <span class="mark mark-paused" aria-hidden="true" />3 paused
      </Link>
    </li>
    <li class="hub-unknown">
      <Link to="/jobs" search={{ statusUnknown: true }}>
        <span class="mark mark-unknown" aria-hidden="true" />4 status unknown
      </Link>
    </li>
  </ul>
</section>
```

- Each item is a mark and its words, small. An item may hold a link, such as to the list it counts, in the item's colour and at least 24px tall. The Runners item leads to the Runners page. Each job count opens the Jobs list filtered to what it counts.
- The running mark takes the lamp's colour only while the hub can confirm that at least one job is running. At zero it is plain, as queued and paused are. When every job counted as running has its status unknown, nothing is known to be live: the item is `li.hub-unknown`, with `mark-unknown` in place of the running mark, and says so: "3 agents running, status unknown". The count stays the hub's, which counts such a job under the last status the hub recorded. What the hub cannot confirm is in `--c-unknown`, words and mark: jobs whose status is unknown, and Runners there are none of which is connected (`li.hub-unknown`). "No Runners" is plain.
- A read's items show only while its last answer is less than 15 seconds old, so an earlier answer is never shown as current. When they give way, one line in their place says why. While the browser reports that it is offline, no read is made, and one line replaces every item at once, whatever their age: "The hub cannot be read: this browser is offline." It carries no time, being true for as long as it shows. Otherwise, if the latest read to finish failed, the line says what could not be read and when, drawn like the offline line in the failed colour: "The job counts could not be read at 15:41 CET." The time is the latest failure's, and the line stays while the reads go on failing. If none has failed, as when the hub is slow to answer or the page has just come back into view, the line gives the time of the last answer, in `--c-unknown` with the unknown mark (`li.hub-unknown`): "The job counts have not been read since 15:41 CET." Until a read's first answer there is no time to give, and its items are not there. If the items cannot be drawn, the strip says they could not be shown. The bar and the page stay.
- At 640px and below the items wrap from the start, so the first stays put whether it reads counts or a failure; there, or with a coarse pointer, a link in it is 44px tall.

### A page

`main#main.page` is the full width of the window with the page's margins. A page begins with its heading in `div.head`, which rules a heavy line under it:

```tsx
<div class="head">
  <h1>Change password</h1>
</div>
```

A page's controls, such as the one action it exists for, go at the heading's end in `div.controls`; when the line is too narrow for both, they go under it.

```tsx
<div class="head">
  <h1>Runners</h1>
  <div class="controls">
    <button type="button" class="primary">
      Add Runner
    </button>
  </div>
</div>
```

Sentences that explain are `p.prose`: 15px, at most 72 characters a line. `p.note` is a small line that explains the part it stands under. Text and times flow together so punctuation sits against the preceding word or time. A note with a mark spaces it beside the sentence. `p.note.is-unknown` says, with the unknown mark, that what is beside it cannot be confirmed.

`ul.plain` lists items one under another, without bullets, as several values of one fact.

### Empty

A list with nothing in it says what belongs there and the way to it: `div.empty` holds an `h2` naming what is missing, a `p` that says how it comes, and a `p.empty-act` with the way on only where the head does not already have it.

```tsx
<div class="empty">
  <h2>No jobs yet</h2>
  <p>A Runner runs the jobs submitted to this hub.</p>
  <p class="empty-act">
    <Link class="stands-alone" to="/runners">
      View Runners
    </Link>
  </p>
</div>
```

### A page without the shell

Sign-in, setup and invitation links can be opened before signing in. They have no bar. Such a page is `main#main.page.is-alone`: one narrow column under the mark. An invitation can name the Organization in its heading and its button. Long names and email addresses wrap within the column.

```tsx
<main id="main" class="page is-alone">
  <BrandMark alt="" />
  <h1>Sign in to Elflodge</h1>
  <form class="fields">…</form>
</main>
```

The mark's `alt` is empty here because the heading names the product.

### A page that failed or was not found

The router shows `DefaultCatchBoundary` in place of a page that failed and `NotFound` in place of one that does not exist (`src/components/`). An address no page has is a page inside the shell (`src/routes/_signed-in/$.tsx`), so a member keeps the bar there, and someone signed out signs in first, as at any other page. Both are a `FallbackPage`, which takes a heading and what goes under it. Inside the shell it is a page like any other, its heading in `div.head`. Outside the shell, as when the session could not be read, it is a page without the shell.

```tsx
<FallbackPage heading="This page could not be shown">
  <Notice role="alert">{asError(props.error).message}</Notice>
  <p>
    <button type="button" class="primary" onClick={() => void router.invalidate()}>
      Try again
    </button>
  </p>
</FallbackPage>
```

What failed is said in an alert notice above "Try again". A read that fails says what could not be read, then the hub's words where it gave any: "The session could not be read: …". `readFromHub` (`src/api-client.ts`) names the failed read for both Better Auth and oRPC.

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

When the hub refuses what one field holds, say so under that field, as a `FieldError` (`src/components/FieldError.tsx`): the field takes `aria-invalid="true"` and names the error with `aria-describedby`, and takes focus unless the member moved focus to something else visible while the hub answered. A refusal that is about no one field is the form's notice. The submit button stays focusable through navigation and the form ignores further submissions while pending. If disabling a fieldset moved focus to the body, the form returns focus to the field when the action settles, unless a field was refused or focus has moved elsewhere.

```tsx
<div class="field">
  <label for="current-password">Current password</label>
  <input
    id="current-password"
    type="password"
    aria-invalid="true"
    aria-describedby="current-password-error"
  />
  <FieldError id="current-password-error">That is not your current password.</FieldError>
</div>
```

which draws `p.field-error`: the error mark and the words, small, in the failed colour.

Checkboxes of one kind, such as one resource's permissions, are a `fieldset.check-group`: its `legend`, then the `label.check`s on a line that wraps.

A read-only field shows a given value on a transparent ground with a quiet border. It remains available for selection and password managers.

Use the browser's own validation (`required`, `type`, `minlength`, `pattern`, `min`, `max`) to refuse early what the hub would refuse. A field must not refuse what the hub accepts. Where it accepts more, as `type="email"` does, the hub's refusal comes back as the form's notice. Do not use `maxlength` because it cuts what is typed or pasted. A limit the contract states may be checked at submit with native validation, and a limit it does not state is the hub's to refuse. `src/form.ts` holds what more than one field takes: `NEW_PASSWORD`, the shortest password that can be set, and `GIVEN_NAME`, which refuses a name of white space alone.

### Notices

One sentence the reader must not miss, as a mark and its words on a wash (`src/components/Notice.tsx`). An `alert` says what failed or was refused; a `status` says that something was done. A form's answer is a notice above its button. When an action removes its focused control, the notice can take focus: pass `focusRef` to focus its element after rendering. This gives it `tabindex="-1"` so it stays outside the tab order.

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

A plain `button` is the default. `.primary` is the one action a page or form exists for; a page has at most one. `.quiet` is words alone, for a control in the bar or in a menu. `.danger` is a destructive control, its words and edge in the failed colour; `.danger.is-fill`, filled, is the button in a dialog that confirms it.

### Dialogs

A destructive control opens a modal `dialog` that says what it ends and whether that is final, and acts only on its confirming button, which names what it acts on (`ConfirmAction`, `src/components/ConfirmAction.tsx`). The keeping button comes first and has the focus. It reads "Keep it", "Keep them" or "Stay". The confirming button starts the request and is disabled while the hub answers. Success closes the dialog. Escape or Close can dismiss it while the request is running. A refusal appears in the open dialog, which restores lost focus to the confirming button. If the member already dismissed the dialog, the page shows the refusal as an alert. If a fresh roster removes the action, as when the reader becomes the only owner during Leave, the page closes the dialog and shows the alert beside the roster. The `close` callback returns true if it closed an open dialog still on the page. In that case the alert takes focus. Otherwise the page moves focus to the alert only if focus was lost.

The heading is `h2.dialog-h` under a heavy rule, the body uses `.dialog-b`, and the buttons are in `.dialog-f`. A long name in the heading or a button wraps inside the dialog. `dialog.is-wide` has room for the Runner command or the Create key form. A form dialog has its primary submit button in `.dialog-f`. Create key groups its fields in `div.dialog-b`. The Organization forms use `fieldset.dialog-b` to disable the submitted fields while the hub answers and keep Close available.

```tsx
<dialog aria-labelledby="remove-h">
  <form method="dialog">
    <h2 class="dialog-h" id="remove-h">
      Remove <span class="mono">lodge-01</span> <span class="sid">03326db5</span>?
    </h2>
    <div class="dialog-b">
      <p>Its key stops working and its connection is dropped at once.</p>
    </div>
    <div class="dialog-f">
      <button value="keep" autofocus>
        Keep it
      </button>
      <button type="button" class="danger is-fill">
        Remove lodge-01 03326db5
      </button>
    </div>
  </form>
</dialog>
```

### Mono

`.mono` sets in the mono what a person might copy or compare where no element (`code`, `kbd`, `samp`, `pre`) says it is, such as the member's email address in the account menu:

```tsx
<span class="mono">robin@example.com</span>
```

`span.sid` is a short ID, small and quiet in the mono, beside a name that can repeat, such as a Runner's host name. A Runner's short ID is the first eight characters, or as many more as tell it from the others listed (`src/short-ids.ts`). A job's short ID is an ellipsis followed by the last eight characters, such as `…3f9a2c1b`. Jobs created together share their UUIDv7 prefix. The ellipsis tells the reader where to look in the whole ID, given in its title.

An address, a host name or a file name shown as data always goes in the mono; a field where a person types one keeps the sans, as every field does. The sans draws a full stop close into a round letter beside it, which suits the end of a sentence and closes up `pine.example`.

### Times and figures

`src/format.ts` writes them with the platform's `Intl` in British English, for every reader: a date day first, "18 Nov 2026", and a time on the 24-hour clock, "15:41", which no reader takes for another day or hour, and a figure as "12,279". Being fixed, the widths a page is laid out for hold.

- **An instant** is an `Instant` (`src/components/Instant.tsx`): a `time` element whose `datetime` is the exact instant in UTC, showing it in the reader's own time zone, by default its day and time (`DATE_TIME`). Its `title` gives it in full, to the second and with the zone (`FULL`). A zone's abbreviation or offset is true of one instant only, so it is never said for more than one. A page that lists instants names the reader's zone once, in a note line above the list, by the name that holds all year: "Times are in United Kingdom Time." `timeZoneNote()` in `src/format.ts` writes that sentence with Intl's `longGeneric` name; where that name is an offset, as for UTC, it uses the short name: "Times are in UTC." Column heads and folded labels name no zone: "Created", "Expires", "Time". An instant alone, with no note on its page or in a part the shell shows everywhere, carries its own short zone, `format={TIME_ZONED}`: "15:41 GMT" in January, "15:41 BST" in July. An invitation shows its expiry date and zoned time with `DATE_TIME_ZONED`, for example "22 Nov, 15:42 UTC". The year is omitted because the invitation lasts 48 hours. An instant alone on a page that has the note carries none.
- **Last contact** gives the elapsed time in one unit at the read that reported it, then the instant to the second. On the same local day it reads "41 sec ago, at 03:49:02" (`TIME_SECONDS`), and on another day "3 days ago, 16 Nov 2026, 03:42:10" (`DATE_TIME_SECONDS`). A failed read and the last successful read also use `TIME_SECONDS` when the page names the zone.
- **A count**, of tokens or of jobs, is written with `formatCount`. The unit is not part of the figure: it goes in the column head, or after the figure in `span.unit`.
- **An amount in US dollars** is written with `formatUsd`, to four decimal places or at most two significant digits, whichever gives more precision. Its budget uses `USD_BUDGET` with the same rounding and a minimum of two decimal places.

```tsx
<p class="note">{timeZoneNote()}</p>
<Instant value={job.createdAt} />
```

`.num` sets a figure in the mono and aligns it right. In a column head it stays in the sans, and a `span.unit` in the head goes on its own line under the name.

A Runner's model has its thinking level beside it in `span.unit`, such as "thinking low".

### Records table

Records that each have a page of their own, such as a list of Batches, are a `table.records`: one ruled line a record, its identifier first. The identifier's cell is `td.is-id` holding an `a.cut` to its page; the identifier column takes what the others leave and cuts its value at its end, the whole value in the link's `title`. Every other cell carries `data-l`, the name of its column and, where the head has one, its unit, such as `data-l="Cost, USD"`. Above 640px the cell keeps its value whole, except for lists of permissions, which can wrap. The identifier's link is a target of its own: 24px tall, and 44px at 640px and below or with a coarse pointer. The caption names the list; where the page heading already does, it is `.vh`, hidden but read.

```tsx
<table class="records" role="table">
  <caption class="vh">Batches</caption>
  <thead role="rowgroup">
    <tr role="row">
      <th scope="col" role="columnheader">
        Batch
      </th>
      <th scope="col" role="columnheader" class="num">
        Jobs
      </th>
    </tr>
  </thead>
  <tbody role="rowgroup">
    <tr role="row">
      <td role="cell" class="is-id">
        <Link to="/batches/$id" params={{ id }} class="cut mono" title={id}>
          {id}
        </Link>
      </td>
      <td role="cell" class="num" data-l="Jobs">
        {formatCount(jobs)}
      </td>
    </tr>
  </tbody>
</table>
```

A record with no page of its own, such as an API key, has its identifier as a `span.cut`, and may end with its one action, such as Revoke, in `td.is-act`, whose column head is `.vh`. A table of short values such as API keys uses `.records.is-narrow` to keep the name near its values, up to 64rem wide. Its name column takes a fifth of the table, leaving room for the permissions. An absent name reads "Unnamed" in the secondary sans (`.unnamed`).

At 640px and below a record is a block: its identifier on a line of its own, then one value per line. Its name and unit, from `data-l`, take the first 7rem. A long value wraps in the space beside its name. The folded cell label has an empty text alternative because the column head already names the value. The column heads are hidden but still read by the declarations `.vh` has, repeated in the table's rule, since a class cannot apply at one width only. That layout drops a table's implicit roles, so the table states them.

### Jobs list

`div.job-list-frame > table.job-list` gives each column a fixed width and the Job column the space left. Headers and cells share these classes in column order: `c-status`, `c-beside`, `c-job`, `c-batch`, `c-submitter`, `c-labels`, `c-runner`, `c-time`, `c-tokens` and `c-cost`. The last two headings give Tokens (so far) and Cost of budget (so far, USD, est.). The table, rows and cells have explicit roles because the narrow layout changes how they are displayed.

Each tier allows 15.375rem for the Job column and adds the fixed widths of its visible columns. These widths include 12px of end padding except on the last column. At the rendered mono size a 24-character Batch ID takes 176px of its 188px cell, and “1,402,118” takes 66px of its 80px cell. Larger token counts wrap. The frame's width sets the tier. Below 97.375rem Submitter gives way, below 86.875rem Tokens, and below 81.875rem Labels. Below 73.625rem each job takes two lines. The first holds the status and name. The second holds what stands beside the status, the Batch, the time and the cost in USD. The Batch takes the space left and gives way below 30rem when something stands beside the status. This follows the 480px breakpoint for ruled definition lists. At a 390px viewport the condition, time, cost and gaps can already fill the second line. Cost keeps its width even when empty. At 640px and below or with a coarse pointer, both lines are at least 44px tall and tapping either line opens the job. The Batch link opens its Batch.

Each job occupies a `tr.job-row`. Its name is its custom ID, set in the strong mono as `a.cut.mono.job-name`. Its title gives the whole name, and it opens the job. The Batch beside it distinguishes it on a wide list. On two lines the Batch may be cut, so a `span.sid` follows the custom ID in `span.cell-line`.

The Batch is a cut mono link to its page. On a touch screen its target is at least 44px tall. A Batch that gave way to the condition becomes visible on keyboard focus. A submitter's name wraps across the full column. Its kind follows inline in `span.unit`. A member's name is in the sans, a named key's in the mono, and an unnamed key reads "Unnamed" in the secondary sans.

`ul.labels.is-line` shows the first Label as a key, an equals sign and a value, cut to fit. The key (`span.lk`) and sign (`span.leq`) use the secondary ink. When more follow, `li.labels-more` gives their count, " more Labels" for assistive technology, and every Label in its title.

Each local creation day has a `tbody` headed by `tr.day-line`, with one `th scope="rowgroup"` spanning all ten columns. In the two-line tier the headings of the visible columns remain available to assistive technology, and each row keeps its cell positions. It reads "Created today, 19 Nov" or "Created 18 Nov", with the year only outside the current year. The heading’s `time` carries the local calendar date. The Time cell gives the latest event ("created", "started" or "ended") and its time. An unfinished job adds its age as of the last read in `span.age`. An event on a different day from the creation day gives its date and time, without an age. Tokens and cost stay empty until the job starts. The budget follows the cost in secondary ink in `span.of`, using the amount formats above. A larger cost or budget wraps within its column. On two lines the cost carries “USD, est.” in `span.unit-inline` and the budget gives way.

```html
<tr class="day-line" role="row">
  <th colspan="10" scope="rowgroup" role="rowheader">
    Created <time datetime="2026-11-18">18 Nov</time>
  </th>
</tr>
```

### Job page

`h1.subject` gives the kind in `span.kind` above the whole custom ID in the strong mono, wrapping at any character. On a missing job, `code.job-address` wraps the identifier from the address the same way. Whitespace in the custom ID is preserved. A deleted job or a name made entirely of whitespace uses the full job ID for its heading. The zone note applies to all times on the page.

`div.record-with-aside` puts the working record in `div.record-sections` and a ruled `dl` in `aside.facts-aside`. At 62.5rem and below the facts follow the working record. In the facts, `.selectable` selects the whole ID, Labels occupy one line each, and `span.sub` gives a second line. The Batch ID links to its page. The “its jobs” link follows on the same line, wrapping below a long ID, and applies the ID as a Jobs filter. A Runner’s name links to its record by fragment.

`div.job-status[role=status][tabindex="-1"]` holds the large status word (`.status-lg`), every condition in full, and the reason a failed or cancelled job cannot resume. Only applicable controls show. The buttons share a row in `.job-controls`. Below the row, each `p.note` names its control, flush left in button order. The button names its note through `aria-describedby`. A pending request disables the visible buttons and the status says “Working…”. A successful control focuses the status or the deletion notice. A spent budget opens a dialog for the new amount in USD. The budget field is read-only during its request. It describes a refused amount and receives focus if submission lost it. A member who moved focus to Close keeps it there. A conflict appears in the dialog notice. Resume’s note explains a spent budget or a lost journal. A Batch that is cancelled or being cancelled hides Resume. The status explains why, using the last successful Batch read. Polling can withdraw a trigger while its dialog is open. The dialog keeps the entered value, explains whether the action is still available, and returns focus to the status if the trigger is gone. A confirmed deletion shows the bare record until the hub gives 404.

`section.activity` on the lamp wash belongs only to a running job whose status is known. Group its model call, tools and compactions by conversation. A paused, failed or expired read cannot establish that the job is still running. The job read supplies the status, usage and available controls together. A different status in a tail answer asks the hub for the whole job again. An ascending history page that reaches the end counts as a tail answer, even when the follower is already finished. A change in tail status during that job read starts a replacement read because the pending one can already hold an older snapshot. Until the job read answers, the status is last recorded and the lamp, live line and activity panel are withdrawn, as when the job read expires. The heading is “Latest activity”. Each activity line gives the time the Runner observed its change. A report can omit activity, so the last recorded report time and the Runner’s last contact belong in the job facts.

`.limits` sets each `.limit` beside the other or stacks them on a phone. A `.limit-value` gives the limit with its unit. A native, named `meter` in `.scale` measures cost against the lifetime budget. Its accessible value text carries the full cost even above budget. `.is-over` strikes the end tick when the limit is reached. For a running job with known status, the timeout meter estimates the seconds from the latest start, resume or Recovery through the last report. Mark both the count and the deadline as approximate. Show them only when the arrival read or a live arrival establishes when the current timeout began. A job that failed for exceeding its timeout keeps a full scale. The record uses the same amount formats as the Jobs list. The Resume dialog gives the exact cost a new budget must exceed. Cost, tokens and meters appear only after the job starts. “So far” applies while the job is unfinished or Resume is offered. Before the job starts, the heading is “Limits”. Deleting it then removes the section. A job deleted after it starts keeps its cost and tokens under “Usage”.

`section.output-or-failure` shows Output as indented JSON, or a wrapping failure message. Its `.output-or-failure-head` holds the heading and Output’s copy button. A `div.preview` holds the complete text in one `pre.code.text-preview` with its disclosure button. When the rendered text exceeds `--job-preview-lines` (eight lines), a button with `aria-expanded` and `aria-controls="output-or-failure-text"` switches between the preview and full height. Limit the text inside its padding to eight whole lines. The button says “Show all N lines” when there are more logical lines than the preview holds. Text that wraps past the limit uses “Show the whole text”, or “Show the whole message” for a failure. The button stands under the text in both states, where a reader reaches the end of what is shown. After it shortens the text, the page keeps the button in view.

### A job’s Events

The member reads from top to bottom. The first page holds up to the latest hundred Events. Earlier and later pages add to the loaded Events without gaps. Place `section.tl` below the working record in its column. On a narrow screen the facts precede it. The section stays on the page if its read fails and keeps the Events read successfully.

- In `.tl-head`, place the “Events” heading, the count in `span.read[role=status]`, and `.tl-choices`. Each `fieldset.seg` has a visually hidden legend and two labelled native radios with one initially checked. The checked `.view-line` shows summaries. The checked `.view-records` shows Runner records and errors. Both choices work together and stay set when paging or jumping.
- The `.events-edge-note` for earlier Events follows `.tl-head`; `nav.jump-row` follows it and stands directly above `ol.timeline`. A walk back changes nothing above its button: the head sentence and the timeout count use the Events of the arrival read and live arrivals only.
- Each edge box says whether earlier or later Events are missing. The hub pages by journal number. Event timestamps can fall out of order. Align the button to the top so a wrapping refusal grows downward. Show a paging or jump failure in a Notice at the edge it tried to read. Name the failed command and let the member retry it there. End the notice with a full stop when the hub gives no words. Keep paging and jump buttons disabled during a requested read and available during background polls. At the first Event the box keeps its height, says “There are no earlier Events.” and takes focus only if its button had it. The lower box also keeps its space when its button goes.
- The timeline reads forwards. The visible edge box anchors paging so “Show earlier Events” keeps its place and focus as earlier Events open below it. The labelled jump row reaches Start and Latest, plus moments and numbered Events on the loaded pages. Its `.jump-content` groups follow the kind filter. On touch screens the jump links and buttons have a 44px target in both directions and the wrapped lines have no extra row gap.
- Focus stays at the place on the screen where the reader pressed. If “Show later Events” had focus, it goes to the first added item the selected view shows. A date line, gap line or run heading takes focus itself. An Event takes focus on its number. If the view hides every addition, restore focus to the button, or to the list when the button goes. Paging leaves scrolling to the browser. The count says how many Events were added until the Events next change. Only a successful read can confirm the end. If following fails, the count describes the Events held and Latest retries from the last held Event. Keep Latest beside the failure when the journal is empty.
- In `ol.timeline`, each opening gets a `li.run-h` with its heading, recorded time, run ID and known models. A `li.run-gap` between a closing and a resume gives the previous recorded ending and the resume, each with its date and time. The hub can cancel a paused job without a Runner Event. A `li.day-line` separates local days.
- Each `li.ev` carries a linked journal number (`.ev-id`), time when recorded (`.ev-time`), summary (`.ev-line`) and full content (`.ev-body`). For example, `<a class="ev-id stands-alone" id="event-27" href="#event-27" aria-label="Event 27">27</a>`. Use `.rec` for Runner details, `.say` for message text, `.call` for tool arguments and `.result` for their answers. On phones the number and time share a line with a 44px hit target extended around the number. In the compact view on a phone, the number, time and summary occupy one 44px line. The agent step’s `.ev-rail` gives its USD cost, tokens and model. Use the job’s amount formatter. A provider-billed cost says “USD”, and other step costs say “USD, est.”. The rail moves below the body on a phone. Long Event bodies use the Output preview. Messages keep the wrapping sans and code keeps the mono. Thinking and write contents show in full when their native disclosures open.
- Mark a Runner record `.is-runner` and a failed Event `.is-error`, with words and the cross mark. Indent a known sub-agent conversation with `.conv-sub` and name it in both views.
- Only `li.ev.is-live#latest` takes the lamp in the timeline. When the activity panel is shown and the loaded stretch reaches the live end, a single “Still running” line links back to the “Latest activity” heading. Both view filters keep this line. A router link lets Back restore the reader’s place at the end. Keep `div.new-events[role=status]` mounted. While the timeline is in view, the notice sticks to its lower edge as a ground-coloured band across its column, with a rule above. A focusable marker named “End of Events” immediately after the list provides a destination when the live line is absent. Its visibility confirms that the reader has reached the end before arrivals are marked seen. Give the count and, when it carries a timestamp, the last arriving Event’s number and recorded time. The button reaches the first visible new number or the end when the filter hides every arrival.
- Above the record, `p.head-sentence` dates the current run and any Recovery seen since arrival. A Recovery can establish when the timeout restarted even if the run opening predates the arrival read.

The two view choices share the same fieldset structure. Within the jump row, anchors reach loaded Events and buttons can request another page.

```html
<fieldset class="seg">
  <legend class="vh">Show each Event</legend>
  <label><input class="vh" type="radio" name="event-view" checked />In full</label>
  <label><input class="vh view-line" type="radio" name="event-view" />One line each</label>
</fieldset>
<div class="events-edge-note">
  <div>
    <p>Earlier Events are not shown.</p>
    <button type="button">Show earlier Events</button>
  </div>
</div>
<nav class="jump-row" aria-label="Go to a moment of the job">
  <span>Go to</span>
  <button type="button">Start</button>
  <a class="stands-alone" href="#event-27"
    >Paused <time datetime="2026-11-19T12:30:00Z">12:30:00</time></a
  >
  <button type="button">Latest</button>
</nav>
```

The run heading is a list item. The arrivals band follows the list inside the section.

```html
<ol class="timeline">
  <li class="run-h" tabindex="-1">
    <h3>Run resumed <time datetime="2026-11-19T13:15:00Z">19 Nov 2026, 13:15:00</time></h3>
    <span>still running</span>
    <span class="sid">run 6a2e0371</span>
  </li>
</ol>
<div class="timeline-end" role="group" aria-label="End of Events" tabindex="-1"></div>
<div class="new-events" role="status" aria-atomic="true">
  <span><strong>3 new Events</strong> below.</span>
  <button type="button">Go to them</button>
</div>
```

### A job's status

The first cell holds the strong `span.status-word`. Its `s-*` class names the recorded status. Running takes the lamp text colour and its mark the running colour. When the status is unknown, both use the secondary ink and the word includes "(last recorded)" for assistive technology.

The next cell holds each condition in its own `span.beside`. "Status unknown" has the unknown mark and colour. The reason appears below the words in secondary ink in `span.condition-detail`. The title adds the full instant since which the status has been unknown. A pending control reads "Pause asked", "Cancel asked" or "Delete asked", with the request date and time in the same secondary text. Both details stay visible on the second line of a narrow row. A blocked job names its Batch pause or failure breaker, or says "Waiting for Canary". A failure reason appears as code in the failed colour.

```html
<td class="c-status" role="cell">
  <span class="status-word s-running"
    ><span class="mark mark-running" aria-hidden="true"></span>Running</span
  >
</td>
```

### Runner reference

`span.runner-ref` holds the Runner name as a cut identifier, its short ID, and the connection mark with "connected" or "not connected" for assistive technology. The abbreviation takes account of both the Runners list and the Runners on the page. The cell is empty before the job is placed or after its Runner is removed.

```html
<span class="runner-ref">
  <span class="cut mono" title="cedar">cedar</span>
  <span class="sid" title="a81b275d-965c-43b4-8328-b8b49ea83b64">a81b275d</span>
  <span class="mark mark-connected" aria-hidden="true"></span><span class="vh">connected</span>
</span>
```

### Filters

Jobs and Batches keep their applied filters in the address. Both use `ListFilters`. The first `div.filters-row` holds the status checks in `fieldset.check-group.is-inline`. Jobs also shows Status unknown there, then Batch and Runner in the second row. Runner options with the same name include distinguishing short IDs. If an applied or drafted Runner is absent from the list, the option says “Runner ID” followed by its full ID. Batches uses the second row for Label key and Label value. A key with an empty value matches that exact Label. Typing a value requires a key.

Each `div.filter-field` pairs a label and its control. The second row ends with `span.filter-act` containing Apply and, when a filter applies, Clear. Edits survive list reads and paging. When navigation changes the applied filters, the fields reset to those values. Status selections use enum order so a different order in the address reads the same list.

At intermediate widths each row wraps where its fields need room. Above 760px the form is always visible. Clear returns focus to Apply. Apply keeps focus throughout its read. Applying unchanged filters on the first page reads the list again in place, preserving the address and its history entry. If the hub refuses that refresh, the list stays visible with an inline alert. Focus stays on Apply above 760px and on Filters at 760px and below. If the hub refuses the first read during navigation, the error page focuses its heading, and clearing its filters returns focus to the form’s visible control.

The disclosure starts at 760px to leave room for the six Jobs status checks on one line in the wide form. With the dashboard fonts they use 637px of the 725px available at 761px. At the shared 640px touch breakpoint the gutters leave only 609px. At 760px and below the Filters button reports how many filters apply. Fields stack at full width and checkboxes use the shared touch target.

1. The panel starts closed on arrival, including at a filtered address.
2. Pressing Filters toggles the panel.
3. Pressing Apply or Clear immediately closes the panel and focuses Filters.
4. List links, paging, Back, and the success or failure of a read leave the panel as the reader set it.

```html
<button type="button" class="filter-toggle" aria-expanded="false" aria-controls="jobs-filters">
  Filters (2 applied)
</button>
<form id="jobs-filters" class="filters-form" aria-label="Filter the jobs">
  <!-- Filter rows -->
</form>
```

The time-zone note sits below the filters when the list has records or a read failed. On navigation within the dashboard a slow read keeps the heading and the address's filter values over the loading table. Both lists show eight skeleton rows in table layout. On Jobs, eight compact rows fit within a phone screen (296px at 390px wide). The folded Batches table shows two records. On a direct visit the shell waits for its first read, as on Runners. A failed refresh puts the failed-read notice under the note and keeps the earlier list. A failed first read shows the list’s error page with a way to clear any filters in the address. When Try again recovers a page, its heading receives focus if the member has not moved on.

### The end of a list

Before a populated list, `a.vh.skip-list` leads to the list’s `p.list-end` (`jobs-end` or `batches-end`). The end gives the count on this page. When more follow it reads "50 read; the hub gives no total." The last page reads "11 read; there are no older jobs.", or "2 read; no more match." with filters. Newest and Older links name the list and appear where available. If paging removes the link the member pressed, focus moves to the list end. Clearing filters from an empty result returns focus to the visible filter control.

```html
<a class="vh skip-list" href="#jobs-end">Skip to the end of the list</a>
<!-- Jobs table -->
<p class="list-end" id="jobs-end" tabindex="-1"><span>2 read; no more match.</span></p>
```

### Organization records and role choices

The Organization's name and Rename share a wrapping `div.org-name`. Each list is a
`section.record-section` with its own heading and `table.records.is-fit`, sized to its
content. Plain-text identifiers, addresses and the names of inviters and key creators wrap in full. A row's `td.is-act` holds
`div.controls` when two controls can act there. They sit together after the record on a phone.

A dialog offering roles uses a fieldset and legend. Each `label.role-choice` holds a native
radio and the role name, with a `small.note` on the next line describing what it permits.

### Batches list

Inside `div.batch-list`, the Records table shows the Batch ID, status, unfinished jobs, failed jobs, all jobs, creator and creation time. The status and its condition share a cell. The creator uses the Jobs submitter measure and can wrap. In table layout the rules end at Created. A `div.batch-id` around each `a.cut.mono.stands-alone` lets the column fit the longest ID up to 30rem and shrink when the other columns need room. A short ID keeps its minimum link target. The whole ID is in its title. This table folds when its frame is 48rem wide or narrower to leave about 12rem for the ID beside the other six columns. The folded record keeps every value. The form follows [Filters](#filters), and the skip link leads to [the end of the list](#the-end-of-a-list).

An active Batch may take jobs even when all of its jobs have ended. Its mark is the filled dot in the hood’s green. A waiting cancel or a pause’s cause appears under the status word in the list.

```tsx
<td role="cell" data-l="Status">
  <span class="batch-status">
    <span class="status-word s-active">
      <span class="mark mark-active" aria-hidden="true" />
      Active
    </span>
    <span class="beside">
      <span class="mark mark-pending" aria-hidden="true" />
      Cancel asked
    </span>
  </span>
</td>
```

### Parent links

Above a record heading, `nav.crumbs` lists its parents in order. The heading names the current record. A Batch has one parent link, Batches. A job has Jobs and its Batch while the job read holds the Batch ID. The list link uses exact route matching so a record does not mark its parent as current. A long ID fits on one line with its whole value in the title.

```tsx
<nav class="crumbs" aria-label="Where this is">
  <ol>
    <li>
      <Link class="stands-alone" to="/jobs" activeOptions={{ exact: true }}>
        Jobs
      </Link>
    </li>
    <li>
      <span aria-hidden="true">/</span>
      <Link class="cut mono stands-alone" to="/batches/$id" params={{ id }} title={id}>
        {id}
      </Link>
    </li>
  </ol>
</nav>
```

### Ledger

A `table.ledger` compares parts of the same total. Give each row a header, an end-aligned count and a native `meter` measuring the count against the total. The Share column allows 8rem for the bar plus its cell padding. The last cell holds the way to the records counted by the row when there are any. In the jobs ledger, the Running mark lights when the read is current, at least one job is running and every status is known. Each row reserves the height of its link even when its count is zero. The total goes under the double rule in `tfoot`.

```tsx
<table class="ledger">
  <caption class="vh">Jobs by status</caption>
  <thead>
    <tr>
      <th scope="col">Status</th>
      <th scope="col" class="num">
        Jobs
      </th>
      <th scope="col">Share</th>
      <th scope="col">
        <span class="vh">Jobs list</span>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row">
        <JobStatus status="queued" lastRecorded={false} />
      </th>
      <td class="num">3</td>
      <td>
        <meter
          min={0}
          max={12}
          value={3}
          aria-label="Share of queued jobs"
          aria-valuetext="3 of 12 jobs"
        />
      </td>
      <td>
        <Link class="stands-alone" to="/jobs" search={{ batchId: id, status: ["queued"] }}>
          See them<span class="vh">: its queued jobs</span>
        </Link>
      </td>
    </tr>
  </tbody>
  <tfoot>
    <tr>
      <th scope="row">
        <Link class="stands-alone" to="/jobs" search={{ batchId: id }}>
          All its jobs
        </Link>
      </th>
      <td class="num">12</td>
      <td colspan={2} />
    </tr>
  </tfoot>
</table>
```

### Batch page

The subject, zone, status, control row and facts use the job page’s parts. Pause holds jobs still to be sent. A pause’s cause explains what Resume releases. Cancel opens the confirmation dialog with the unfinished count and what happens to the Batch. A running job that ends before its Runner stops it keeps its status and output. If another caller cancels while the confirmation is open, it explains the new state and disables confirmation. Closing it returns focus to the status when its trigger has gone. A cancel awaiting its Runners keeps its disabled button and the request time in the status. A cancelled Batch shows the consequence in the status.

Under “Its jobs”, all six ledger rows keep their places when a count reaches zero. Jobs with status unknown are counted under their last recorded status and linked below the ledger. An empty Batch reads “It has no jobs.” Usage appears once the Batch has tokens. Its cost and tokens come from its present jobs. Facts give the full ID, creation time, creator, Labels and the failure breaker settings.

### Command to copy, and a secret shown once

What a person copies to run elsewhere, such as the command that starts a Runner, is a `pre.code.command` in `div.copyable`, with a `CopyButton` (`src/components/CopyButton.tsx`) under it that says when it has copied. `pre.code` is typed text on a band, scrolling in its own block; give it `tabindex="0"` and an `aria-label`. `.code.wraps` wraps it at any character instead, for a command whose lines are long or a key with no space to break at. `.command` selects it whole with one press, for a browser that does not allow copying, as over plain HTTP from another machine. In it, `mark.key` marks a secret and `mark.placeholder`, outlined, what the reader puts in its place. At the end of Add Runner, `p.waiting-line` shows the pending mark until a newly registered Runner appears. The line keeps its `role="status"` from the start. When a Runner registers, the line names it and its short ID beside the succeeded mark. Its contents are empty during a failed read. A secret the hub gives only once, such as a new key, is followed by `p.shown-once`, which says so.

```tsx
<div class="copyable">
  <pre class="code command" tabindex="0" aria-label="The new API key">
    <mark class="key">{key}</mark>
  </pre>
  <CopyButton text={key} label="Copy the key" />
</div>
<p class="shown-once" role="note"><b>Shown this once:</b> copy it now. …</p>
```

### Runner record

The Runners page lists each Runner as `li.runner` in `ul.runners`, with the Runner’s full ID as its fragment target: `div.runner-id` (`h2.runner-name` with the name in the mono and its `span.sid`, `p.conn` or `p.conn.is-off` with the connection's mark and words, and its last contact and when it registered), then what it reported its jobs can do, as a `dl`, then `div.runner-ctl` with its controls. Below 900px the three stand one under another. While visible, the page reads the list again at the hub strip's `REFRESH_INTERVAL_MS` interval from `src/query.ts`.

A direct visit stays blank until the first Runners read finishes because the router awaits the loader before mounting the shell. On navigation from another dashboard page, a slow first read shows three placeholder records in `ul.runners[aria-busy="true"]`, with a hidden status reading "Loading Runners". The records are hidden from assistive technology. Each `span.sk` is a line on `--c-skeleton`; `.is-title` and `.is-short` stand in for the name and connection, and `.is-part` for a shorter fact.

### Marks

A mark is a small drawn shape that stands beside words and takes their colour: `<span class="mark mark-failed" aria-hidden="true"></span>`. It is always hidden from assistive technology, because the words beside it say the same. There are `mark-active`, a filled dot for an active Batch; `mark-failed`, a cross; `mark-succeeded`, a tick; `mark-error`, a triangle beside a field's error; `mark-opens`, a chevron after words that open a menu; and for a job's status and a Runner's connection, `mark-queued`, a ring; `mark-running`, a lit bar; `mark-paused`, two bars; `mark-cancelled`, a ring struck through; `mark-unknown`, a broken ring round a dot, for a status the hub cannot confirm; beside a status, `mark-blocked`, an arrow against a bar, and `mark-pending`, an hourglass, for a control waiting for its Runner or for Add Runner waiting for a connection; `mark-connected`, a filled dot; and `mark-disconnected`, a hollow one. No icon set is used. In forced-colours mode a mark keeps its shape and takes the system's text colour.

## Rules

1. **A link is underlined**, except in the top bar. A button that is words alone shows what it does another way: an underline in a menu, the chevron after the member's name.
2. **Targets:** with a fine pointer, 32px for a control and 24px for a link standing alone; at 640px and below or with a coarse pointer, 44px for both, each way. A link outside a sentence takes `.stands-alone`, which gives it those. A link inside a sentence keeps its line's height. In the ruled `dl` in `.facts-aside`, a link keeps its line’s height and an `::after` centred on the line extends what can be pressed to the target size.
3. **The lamp colour is only for what is live now and for keyboard focus.** The running mark takes the lamp's colour only while the counts establish that at least one job is running. A job whose status is unknown is not known to be live.
4. **Colour is never the only sign:** a mark and words go with it.
5. **A name that may not fit** is cut at its end only where the whole name is one step away, as the bar's names are in the menu, and carries the whole name in its `title`. In the Jobs list the name links to the full job heading. A cut Batch ID has its full value in its title.
6. **No inline styles in a page.** In the stylesheets, every colour and type size is a token.

## Adding a part

A new page is the shell, a heading and the parts above. When it needs something they do not give:

1. Write it as semantic HTML first; a plain element may already be enough. Look at the first use of a plain element that no page has yet as closely as at a new part.
2. Add a section to `components.css`, opened by a one-line comment that says what the part is. Name classes for what a part is, never for the page it is on. Add any new token to `tokens.css`.
3. Describe the part here: its element, its classes, the attributes it needs, and a short example.
4. Look at it in light and in dark at 1440, 1280, 960, 390 and 320px wide, and with the keyboard alone. Nothing may scroll sideways, and text and lines keep the contrast the tokens section gives.

The part, its tokens and its description arrive in the change that builds the page that uses it. When two pages are built side by side and share parts, a change before both may bring those parts.

## Browser floor

Chromium 123, Firefox 125 and Safari 17.5, the first versions with both `light-dark()` and the `popover` attribute. Only Chromium has been run across the dashboard.

Firefox 125–127 shows the folded cell label using `content: attr(data-l)`. These versions may also read the label with the cell value. From Firefox 128 the empty text alternative suppresses the repeated label.

Playwright’s WebKit 27.2 kept the reader’s place when earlier Events arrived. Earlier Safari versions were not run.

Safari on iOS and iPadOS before 18.3 does not close a popover on a tap elsewhere (WebKit bug 267688). The account menu still closes there from the member's name, which opened it, and when one of its links is followed.
