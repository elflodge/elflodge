# A dashboard document shows one member for its whole life

Tabs share the hub's session cookie. A member can sign out or sign in as someone else in one tab while another still shows the previous member's name, reads and controls. A new session for the same member, such as after changing a password, can keep that page and its confirmation.

The first signed-in shell records its member's user ID. If a later session read names someone else or finds no one signed in, the browser reloads the current page. An explicit sign-out takes the browser to the plain sign-in page instead. Only the first such observation starts a document navigation. The replacement document gets its own router, Query client and forms.

## Alternatives considered

- A Query client per session isolates cached answers, but also requires switching clients and disposing of the right subscriptions. The shell and pending form actions have lifetimes of their own. Replacing the document ends them together.
- Clearing one client's cache discards stored data, but a mounted view can retain the previous answer and a mutation callback can write into the cleared cache later.
- Keying the shell on the member remounts those views. It still leaves the router's loaders and callbacks outside the shell to handle the change separately.
- Ignoring a preload or a cancelled navigation would leave a page visible after its session read had established a change of member. The answer applies to the open document whichever navigation requested it. A document that has yet to show a member can follow its first session read without reloading.

## When to reconsider

The reload happens when the dashboard learns who is signed in. Between a change of cookie and that read, a control on the old page can send a request as the new member. The hub checks the member making each request. If it must also establish that the member matches the one shown on the page, for example on a shared machine or across Organizations, send the expected member with the request and check it at the hub before acting.
