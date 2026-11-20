---
name: remove-absence-from-workday
description: Remove one or more days from an existing absence or time-off request in Workday, using the Playwright MCP browser tools. Use when the user asks to remove, delete, cancel or free up a day of booked absence in Workday ("remove my absence next Friday", "I'm working on the 12th after all, take it out of Workday"), or to edit individual days of a Workday absence. Needs the Playwright MCP server and the user's Workday tenant URL.
---

# Remove a day from a Workday absence

Workday is slow and its absence requests often span many days, so the job is mostly patience and
not deleting the wrong day. Go **one step at a time**: act, take a screenshot, read it, then act
again. Never click twice because nothing seemed to happen.

## Before you start

1. **Browser.** The Playwright MCP launches its own browser with its own profile. It cannot attach
   to the user's already-open Firefox. Chrome and Edge can attach only with the MCP's
   `--extension` mode. Say this if the user expects their own window.
2. **Tenant URL.** Ask for it (`https://<host>.myworkday.com/<tenant>/`) unless the user gave it.
   Don't write it into any file.
3. **Output folder.** The Playwright MCP writes snapshots, console logs and screenshots to
   `.playwright-mcp/` in the current directory. Once the user is logged in, these hold their
   personal data. If the current directory is a git repo and `git check-ignore .playwright-mcp/`
   prints nothing, offer to add `.playwright-mcp/` to `.gitignore`.
4. **The date.** Work out the exact date for relative phrases ("next Friday") from today's date and
   say it back, with the weekday, before you go looking for it.

## Steps

1. **Open the tenant URL** with `browser_navigate`. It redirects to the organisation's sign-in
   (often Microsoft SSO). **The user signs in themselves, including MFA. Never type credentials.**
   Wait until they say they're in. The home page heading greets them by name.
2. **My Stuff → Absence.** Click `My Stuff` in the left navigation. The flyout often doesn't open
   on the first click. If `Absence` isn't in the next snapshot, wait a few seconds and click again.
   Then click the `Absence` link. That opens **Manage Absence**: a month calendar with the booked
   entries.
3. **Find the entry.** In the snapshot, each booking is a button named
   `<status> | <type> | <first day> to <last day>`, with dates in the tenant's locale. Find the
   one whose range covers the target date. If none does, tell the user there's nothing booked that
   day and stop.
4. **Open it.** Click the entry. An **Absence Entries** dialog lists every entry in the request,
   with its total hours. One request can cover months. Tell the user how big it is, because the
   next step edits that whole request.
5. **Edit → Edit Individual Days.** Click `Edit`, then `Edit Individual Days`. Wait for the
   day-by-day list. It can take several seconds to appear after the click.
6. **Select the day.** Click the target day in the list. The right-hand pane shows its type,
   hours and comment, plus a `Delete` button. Screenshot it and read the date heading back to the
   user. If they haven't already said "delete", ask before deleting.
7. **Delete once.** Click `Delete` one time. Then see "Slow server" below, and wait until the day
   is really gone. To remove several days, repeat steps 6–7 per day, waiting each time, and read the
   pane's date heading before every Delete.
8. **Submit.** Nothing is saved until `Submit Request`. Submitting changes an approved request, so
   **click it only when the user has said to**. You may click it straight after the last Delete:
   Workday holds the click until the pending delete has returned, then sends the submit itself.
   Don't click Submit a second time while it is greyed out.
9. **Verify.** When the submit lands, the dialog closes and a "Success! Request Submitted" popup
   appears over the calendar. Take a snapshot and check the day cells. A removed day's cell has no
   status and no "1 event". The neighbouring entries keep their status. Report both to the user.

## Slow server: a greyed-out Delete is not a failure

After a click, Workday sends a `POST` to `.../flowController.htmld` and greys the button until the
server answers. A delete has taken over a minute, and a submit about half a minute. The page shows
no spinner and no error in the meantime.

- Check with `browser_network_requests` (`static: false`). A pending call is listed with no
  `=> [status]` after it. Its request body (`browser_network_request`, part `request-body`) names
  the action. A delete carries an `_eventId_remove` field.
- Wait with `browser_wait_for` (`time`) and look again. You're done when the call shows `[200]`,
  the day is gone from the list, and the total request amount has dropped.
- **Don't click Delete again.** Once the removal lands, Workday selects the *next* day in the list.
  A second click on the now-active Delete removes a day the user wanted to keep.

## The network calls behind the clicks

These are recorded for anyone who wants to replay the calls without a browser. That route is
untested here. Every mutating step is one form-encoded `POST https://<host>/<tenant>/flowController.htmld`
(`content-type: application/x-www-form-urlencoded`, same-origin, the session's cookies). The
response is JSON describing the next page state.

| Click | Body fields |
|---|---|
| `Edit Individual Days` | `_flowExecutionKey`, `_eventId_submit=<widget id>`, `sessionSecureToken`, `change-summary=<wml:Change_Summary …><wd:Edit_Individual_Days …>` |
| `Delete` on a day | `_flowExecutionKey`, `sessionSecureToken`, `<day widget id>=<number>`, `_eventId_remove=<day widget id>` |
| `Submit Request` | `_flowExecutionKey`, `_eventId_submit=<widget id>`, `sessionSecureToken`, `change-summary=<wml:Change_Summary …><wd:Submit Ref="<id>/wd:Submit" Replaced=""><V>1</V></wd:Submit></wml:Change_Summary>` |

- The widget ids and `_flowExecutionKey` belong to the open dialog, and `sessionSecureToken` to
  the login session. Nothing in the URL carries them. Read them from the previous response's JSON,
  not from a recording, because they change between sessions and requests.
- The submit's response JSON contains "Success" and "Submitted". Afterwards the page reloads the
  Manage Absence task and the calendar sidebar.
- Opening an entry and clicking `Edit` are `GET .../rel-task/<task id>.htmld` calls on long
  instance URLs that encode the request.
- Login is SSO, and the session lives in cookies. Replaying calls still needs a browser login
  first. Never copy cookies or tokens into files, logs or chat.

## Reading the page

- Snapshots of Workday are large. Save them to a file (`browser_snapshot` with `filename`, or use
  the file a click result links to) and grep that file for the label or date you need, instead of
  reading the whole tree.
- Screenshots (`browser_take_screenshot`) are the quickest way to see what the user sees, such as
  whether a dialog opened or a button is greyed.
- Hundreds of console errors and CSP report-only warnings are normal on Workday. They are not
  the cause of a stuck step. Check the network instead.
