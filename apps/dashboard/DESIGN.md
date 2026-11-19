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
- **Inks** are explicit values. Text reaches 4.5:1 on every ground it is set on, in both themes.
- **Lines that must be seen** (`--c-ink-3`, `--c-field-edge`, `--c-focus`) reach 3:1 on every ground; the comment beside each gives its measured lowest value. `--c-rule`, the hairline, only separates and is quieter.
- **Status colours.** `--c-running` is the lamp, a shade darker in light so the mark keeps 3:1 on the lamp's own wash and the strip's band (`--c-ground-2`); it is live now. `--c-waiting` (ink-2) is for queued and paused, which are not alarms. `--c-unknown` is for a status the hub cannot confirm, and is text-strength.
- **Washes** are grounds for a sentence the reader must not miss: `--c-failed-wash` for a refusal or an invalid field, `--c-lamp-wash` for what is live and for marked text.
- **Type:** sizes from `--text-xs` (12px: units, column heads, notes) through `--text-sm` (13px, the working size), `--text-md` (15px, sentences that explain) and `--text-lg` (17px, section headings) to `--text-2xl` (23px, a page heading). The mono is set at `--mono-size` beside the sans so their x-heights meet.
- **Space** is in steps of 4px: `--space-1` to `--space-4` (4 to 16px) and `--space-7` (48px). The page's side margin is `--gutter`.
- A step that nothing uses is not defined, which is why the type sizes have no `--text-xl` and the spaces no `--space-5` or `--space-6`.
- **Sizes:** `--row`, `--control`, `--control-touch`, `--target`, `--topbar`, `--strip`, `--mark` (a drawn mark), `--radius` (controls and dialogs), and the three rules `--rule`, `--rule-heavy` and `--rule-total`.

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
        <li><form onSubmit={signOut}><button type="submit" class="quiet" disabled={pending()}>Sign out</button></form></li>
      </ul>
    </div>
  </div>
</header>
<main id="main" class="page">
  <InShell value={true}><Outlet /></InShell>
</main>
```

- The bar holds the brand, the Organization's name, the destinations and, at its end, the member's name. Its links are not underlined: the bar is a known place.
- The destinations are the pages the bar leads to, listed once in `src/components/Destinations.tsx`; a page the bar leads to adds its line there. The router marks the current one `aria-current="page"`, which draws it as a tab standing on the bar's rule. An entry is current at its page and at every page under it, unless its `activeOptions` say otherwise, as Home's exact path match does. A search string does not change the current destination.
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
      <span class="mark mark-running" aria-hidden="true" />
      45 agents running
    </li>
    <li>
      <span class="mark mark-queued" aria-hidden="true" />
      303 queued
    </li>
    <li>
      <span class="mark mark-paused" aria-hidden="true" />3 paused
    </li>
    <li class="hub-unknown">
      <span class="mark mark-unknown" aria-hidden="true" />4 status unknown
    </li>
  </ul>
</section>
```

- Each item is a mark and its words, small. An item may hold a link, such as to the list it counts, in the item's colour and at least 24px tall. The Runners item leads to the Runners page.
- The running mark takes the lamp's colour only while the hub can confirm that at least one job is running. At zero it is plain, as queued and paused are. When every job counted as running has its status unknown, nothing is known to be live: the item is `li.hub-unknown`, with `mark-unknown` in place of the running mark, and says so: "3 agents running, status unknown". The count stays the hub's, which counts such a job under the last status its Runner confirmed. What the hub cannot confirm is in `--c-unknown`, words and mark: jobs whose status is unknown, and Runners there are none of which is connected (`li.hub-unknown`). "No Runners" is plain.
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

Sentences that explain are `p.prose`: 15px, at most 72 characters a line. `p.note` is a small line that explains the part it stands under; `p.note.is-unknown` says, with the unknown mark, that what is beside it cannot be confirmed.

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

When the hub refuses what one field holds, say so under that field, as a `FieldError` (`src/components/FieldError.tsx`): the field takes `aria-invalid="true"` and names the error with `aria-describedby`, and the focus goes to it. A refusal that is about no one field is the form's notice. The submit button stays disabled through navigation. If disabling it moved focus to the body and focus is still there when the action settles, the form returns focus to the button.

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

A destructive control opens a modal `dialog` that says what it ends and whether that is final, and acts only on its confirming button, which names what it acts on (`ConfirmAction`, `src/components/ConfirmAction.tsx`). "Keep it" comes first and has the focus. The confirming button starts the request and is disabled while the hub answers. Success closes the dialog. Escape or Close can dismiss it while the request is running. A refusal appears in the open dialog, which restores lost focus to the confirming button. If the member already dismissed the dialog, the page shows the refusal as an alert. The heading is `h2.dialog-h` under a heavy rule, the body `div.dialog-b`, the buttons `div.dialog-f`; a long name in the heading or a button wraps, so it stays inside the dialog. `dialog.is-wide` has room for the Runner command or the Create key form. A dialog may also hold a form, as creating an API key does: its fields in `div.dialog-b`, its submit button the primary one in `div.dialog-f`.

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

`span.sid` is a short ID, small and quiet in the mono, beside a name that can repeat, such as a Runner's host name. It is the ID's first eight characters, or as many more as tell it from the others listed (`src/short-ids.ts`).

An address, a host name or a file name shown as data always goes in the mono; a field where a person types one keeps the sans, as every field does. The sans draws a full stop close into a round letter beside it, which suits the end of a sentence and closes up `pine.example`.

### Times and figures

`src/format.ts` writes them with the platform's `Intl` in British English, for every reader: a date day first, "18 Nov 2026", and a time on the 24-hour clock, "15:41", which no reader takes for another day or hour, and a figure as "12,279". Being fixed, the widths a page is laid out for hold.

- **An instant** is an `Instant` (`src/components/Instant.tsx`): a `time` element whose `datetime` is the exact instant in UTC, showing it in the reader's own time zone, by default its day and time (`DATE_TIME`). Its `title` gives it in full, to the second and with the zone (`FULL`). A zone's abbreviation or offset is true of one instant only, so it is never said for more than one. A page that lists instants names the reader's zone once, in a note line above the list, by the name that holds all year: "Times are in United Kingdom Time." `timeZoneNote()` in `src/format.ts` writes that sentence with Intl's `longGeneric` name; where that name is an offset, as for UTC, it uses the short name: "Times are in UTC." Column heads and folded labels name no zone: "Created", "Expires", "Time". An instant alone, with no note on its page or in a part the shell shows everywhere, carries its own short zone, `format={TIME_ZONED}`: "15:41 GMT" in January, "15:41 BST" in July. An instant alone on a page that has the note carries none.
- **Last contact** gives the elapsed time in one unit at the read that reported it, then the instant to the second. On the same local day it reads "41 sec ago, at 03:49:02" (`TIME_SECONDS`), and on another day "3 days ago, 16 Nov 2026, 03:42:10" (`DATE_TIME_SECONDS`). A failed read and the last successful read also use `TIME_SECONDS` when the page names the zone.
- **A count**, of tokens or of jobs, is written with `formatCount`. The unit is not part of the figure: it goes in the column head, or after the figure in `span.unit`.

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

The Runners page lists each Runner as `li.runner` in `ul.runners`: `div.runner-id` (`h2.runner-name` with the name in the mono and its `span.sid`, `p.conn` or `p.conn.is-off` with the connection's mark and words, and its last contact and when it registered), then what it reported its jobs can do, as a `dl`, then `div.runner-ctl` with its controls. Below 900px the three stand one under another. While visible, the page reads the list again at the hub strip's `REFRESH_INTERVAL_MS` interval from `src/query.ts`.

A direct visit stays blank until the first Runners read finishes because the router awaits the loader before mounting the shell. On navigation from another dashboard page, a slow first read shows three placeholder records in `ul.runners[aria-busy="true"]`, with a hidden status reading "Loading Runners". The records are hidden from assistive technology. Each `span.sk` is a line on `--c-skeleton`; `.is-title` and `.is-short` stand in for the name and connection, and `.is-part` for a shorter fact.

### Marks

A mark is a small drawn shape that stands beside words and takes their colour: `<span class="mark mark-failed" aria-hidden="true"></span>`. It is always hidden from assistive technology, because the words beside it say the same. There are `mark-failed`, a cross; `mark-succeeded`, a tick; `mark-pending`, an hourglass for something awaited; `mark-error`, a triangle beside a field's error; `mark-opens`, a chevron after words that open a menu; and for a job's status and a Runner's connection, `mark-queued`, a ring; `mark-running`, a lit bar; `mark-paused`, two bars; `mark-unknown`, a broken ring round a dot, for a status the hub cannot confirm; `mark-connected`, a filled dot; and `mark-disconnected`, a hollow one. No icon set is used. In forced-colours mode a mark keeps its shape and takes the system's text colour.

## Rules

1. **A link is underlined**, except in the top bar. A button that is words alone shows what it does another way: an underline in a menu, the chevron after the member's name.
2. **Targets:** with a fine pointer, 32px for a control and 24px for a link standing alone; at 640px and below or with a coarse pointer, 44px for both, each way. A link outside a sentence takes `.stands-alone`, which gives it those. A link inside a sentence keeps its line's height.
3. **The lamp colour is only for what is live now and for keyboard focus.** The running mark takes the lamp's colour only while the counts establish that at least one job is running. A job whose status is unknown is not known to be live.
4. **Colour is never the only sign:** a mark and words go with it.
5. **A name that may not fit** is cut at its end only where the whole name is one step away, as the bar's names are in the menu, and carries the whole name in its `title`.
6. **No inline styles in a page.** In the stylesheets, every colour and type size is a token.

## Adding a part

A new page is the shell, a heading and the parts above. When it needs something they do not give:

1. Write it as semantic HTML first; a plain element may already be enough. Look at the first use of a plain element that no page has yet as closely as at a new part.
2. Add a section to `components.css`, opened by a one-line comment that says what the part is. Name classes for what a part is, never for the page it is on. Add any new token to `tokens.css`.
3. Describe the part here: its element, its classes, the attributes it needs, and a short example.
4. Look at it in light and in dark at 1440, 1280, 960, 390 and 320px wide, and with the keyboard alone. Nothing may scroll sideways, and text and lines keep the contrast the tokens section gives.

The part, its tokens and its description arrive in the change that builds the page that uses it. When two pages are built side by side and share parts, a change before both may bring those parts.

## Browser floor

Chromium 123, Firefox 125 and Safari 17.5, the first versions with both `light-dark()` and the `popover` attribute. Only Chromium has been run.

Firefox 125–127 shows the folded cell label using `content: attr(data-l)`. These versions may also read the label with the cell value. From Firefox 128 the empty text alternative suppresses the repeated label.

Safari on iOS and iPadOS before 18.3 does not close a popover on a tap elsewhere (WebKit bug 267688). The account menu still closes there from the member's name, which opened it, and when one of its links is followed.
