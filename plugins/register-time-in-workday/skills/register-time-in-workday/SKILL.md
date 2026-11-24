---
name: register-time-in-workday
description: Register hours on a project for a given day in Workday (Enter My Time), using the Playwright MCP browser tools. Use when the user asks to log, register, enter, book or record time or hours in Workday ("register 7.5 hours today on project X", "log my hours for Monday"), or to add a comment to a time entry. Needs the Playwright MCP server, the user's Workday tenant URL, the project and the hours.
---

# Register time in Workday

Workday is slow, and its menus often ignore the first click. Go **one step at a time**: act, take a
screenshot, read it, then act again.

## Before you start

0. **Private notes.** The plugin's author keeps their tenant URL, project ids, comment conventions
   and the network calls behind each step in `~/dev/claude-perfection/docs/workday.md` and
   `workday-network.md`. If those files exist, read them first and don't ask for what they hold.
1. **Browser.** The Playwright MCP launches its own browser with its own profile. It cannot attach
   to the user's already-open Firefox. Say this if the user expects their own window. If the
   browser fails to launch ("Failed to launch the browser process"), another session's Playwright
   MCP probably holds the profile: ask the user to close that Playwright window, then try again.
2. **What you need from the user:** the tenant URL (`https://<host>.myworkday.com/<tenant>/`), the
   day (turn "today" or "Friday" into an exact date and say it back), the hours, the project
   (a project number is best), and the comment. Many organisations expect a comment on every
   entry, so ask if the user hasn't given one or has no convention you already know. Don't write
   the tenant, project or comment into any file in a public repo.
3. **Output folder.** The Playwright MCP writes snapshots, logs and screenshots to `.playwright-mcp/`
   in the current directory. These hold personal data once the user is logged in. If it's a git
   repo and `git check-ignore .playwright-mcp/` prints nothing, offer to add it to `.gitignore`.

## Steps

1. **Open the tenant URL.** It redirects to the organisation's sign-in. **The user signs in
   themselves, including MFA. Never type credentials.** Wait until they say they're in.
2. **External Links → Enter My Time.** Click `External Links` in the left navigation. If the flyout
   doesn't appear in the next snapshot, click again. `Enter My Time` opens in a **new tab**, so
   switch to it with `browser_tabs` (`select`). Its link is a fixed task URL
   (`…/d/task/<id>.htmld`), so later runs can navigate there directly.
3. **Go to the right week** with `Previous Week` / `Next Week` if the day isn't shown. Read the day
   headers (`fre. 20.11`, `Hours: 0`).
4. **Open the day.** Clicking the day header does nothing, and the day column isn't its own element
   in the snapshot. Click inside the column's empty area by position: take a screenshot, find the
   column's x, and run `page.mouse.click(x, y)` with `browser_run_code_unsafe`. The **Enter Time**
   dialog opens with the date at the top. Check that the date is the one you want.
5. **Time Type = the project.** Click the `Time Type` box. It offers groups (typically Most Recently
   Used, Projects, Project Plan Tasks, Absence). Prefer **typing the project number and pressing
   Enter**: with a single match, Workday selects it straight away. Otherwise pick from the list. Read
   the selected text back to the user.
6. **Hours.** Fill `Hours`, then press Tab so Workday validates it. The field is disabled until a
   Time Type is chosen.
7. **Comment.** Fill `Comment` and press Tab. Leave `Do Not Bill` and any other optional fields
   alone unless the user said otherwise.
8. **OK.** Click `OK`. A "Your changes have been saved" toast appears, and the day shows the entry
   (hatched while **Not Submitted**) with the day's hour total and the Summary panel updated.
9. **Verify.** Click the saved entry to reopen it, read Time Type, Hours and Comment from the
   snapshot, then close it with **Cancel**. Report what you read.
10. **Submitting the week** is a separate step: the `Review` button. Don't click it unless the user
    asks.

To change a saved entry, such as adding a forgotten comment, click it, edit the field, press Tab,
then click OK.

## The network calls behind the clicks

These are recorded for anyone who wants to replay them without a browser. That route is untested.
Every POST is form-encoded, same-origin, and carries the session cookies, `sessionSecureToken` and a
`clientRequestID`. `_flowExecutionKey` and every widget id belong to the open dialog, and they can
change after each step (the Hours widget id changed once a project was picked). Read them from the
previous response's JSON, never from a recording.

| Step | Call | Body fields that matter |
|---|---|---|
| Open the week | `GET /<tenant>/task/<task id>.htmld` | — |
| Click a day | `POST /<tenant>/button/<page context>/<x>/<y>.htmld` | none; the JSON response holds the form, including the Time Type widget (`wd:Time_Type_Prompt_for_Time_Tracking--IS`), its `id` and `contextId` |
| Open the picker | `POST /<tenant>/prompt/<contextId>/<time type id>.htmld` | `_eventId_prompt=<time type id>`; returns the groups |
| Open a group | same | + `prompt=<group id>`; returns `items` with `instanceId` and `text` |
| Search | same | + `q=<search text>`; same `items` shape |
| Pick | `POST /<tenant>/flowController.htmld` | `_eventId_add=<time type id>`, `<time type id>=<instanceId>`, `<instanceId>_DID=<text>`, `<instanceId>_IID=<instanceId>`, `<instanceId>_V=1`, `<instanceId>_PV=1` |
| Hours | same | `<id>/wd:Time_Block_Reported_Quantity=<hours>`, `_eventId_validate=<id>/wd:Time_Block_Reported_Quantity` |
| Comment | same | `<id>/wd:Comment=<text>`, `_eventId_validate=<id>/wd:Comment` |
| OK | same | `_eventId_submit=<id>`, `change-summary=<wml:Change_Summary …><wd:OK Ref="<id>/wd:OK" Replaced=""><V>1</V></wd:OK></wml:Change_Summary>` |

Login is SSO and the session lives in cookies, so a script still needs a browser login first.
Never copy cookies or tokens into files, logs or chat. Delete captured request bodies once you've
read them, because they contain the session token.

## Reading the page

- Workday snapshots are large. Save them to a file and grep for the label you need.
- Hundreds of console errors and CSP report-only warnings are normal on Workday. They don't cause
  a stuck step. When a button greys out with no visible change, check `browser_network_requests`
  for a pending `flowController` call and wait.
