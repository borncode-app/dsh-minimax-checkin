> **This repository has moved into one monorepo.**
>
> The whole MiniMax set — the credit proxy, the daily check-in, the model-list
> sync, the composer quota chip, the MiniMax Code bridge, and the shared grant
> reader — now lives in
> **[`borncode-app/dsh-minimax-kit`](https://github.com/borncode-app/dsh-minimax-kit)**,
> one repository with one Plugins entry.
>
> | this repo | new home |
> |---|---|
> | `dsh-minimax-auth` | `packages/dsh-minimax-auth` |
> | `dsh-minimax-credit` | `packages/dsh-minimax-credit` |
> | `dsh-minimax-checkin` | `packages/dsh-minimax-checkin` |
> | `dsh-minimax-model-sync` | `packages/dsh-minimax-model-sync` |
> | `dsh-minimax-bridge` | `packages/dsh-minimax-bridge` |
> | `dsh-model-quota` | `packages/dsh-model-quota` |
>
> The code and its history are unchanged; only the repository is shared. Install
> `dsh-minimax-kit` instead of the individual bundles. This repository stays
> open so the old links keep working.
<div align="center">
  <img src="icon.svg" alt="" width="72" height="72">
  <h1>dsh-minimax-checkin</h1>
  <p><b>Claims the MiniMax daily check-in reward from inside DeepSeek Harness.</b></p>
  <p>
    <a href="https://github.com/borncode-app/dsh-minimax-checkin/releases"><img alt="release" src="https://img.shields.io/github/v/release/borncode-app/dsh-minimax-checkin?style=flat-square&color=6C4BF6"></a>
    <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square"></a>
    <img alt="plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-6C4BF6?style=flat-square">
    <img alt="reward" src="https://img.shields.io/badge/reward-daily%20credits-8957e5?style=flat-square">
  </p>
</div>

---

## Where the one-entry kit lives

This plugin, `dsh-minimax-credit`, `dsh-minimax-model-sync`, `dsh-model-quota`
and `dsh-minimax-bridge` are also published as one bundle:
**[`dsh-minimax-kit`](https://github.com/borncode-app/dsh-minimax-kit)**.

Install the kit instead if you want the whole MiniMax set from a single
**Plugins** entry. It ships these same packages as separate rows, so the code
here is unchanged and each part keeps its own switch â€” this repository stays
the home of the check-in client, the panel, the tool, and the routes.

## Where the sign-in code lives now

The MiniMax Code grant reader â€” reading `~/.minimax/auth`, refreshing it under
the app's own `auth.lock`, and the token/generation bookkeeping â€” moved to
**[`dsh-minimax-auth`](https://github.com/borncode-app/dsh-minimax-auth)**.

This plugin and `dsh-minimax-credit` both import it, so one refresh path writes
the grant instead of two. The dependency is pinned to a commit; bump
`@local/dsh-minimax-auth` in `package.json` to take a newer one.

Nothing else moved: this repository still owns the check-in client, the request
signature, the panel, the tool, the routes, and the schedule. The `MinimaxAuth`
export remains here as a subclass that supplies this plugin's error class and
`MINIMAX_CHECKIN_*` codes.

## What it does

MiniMax Code shows a **Daily Check-in** card in its own account menu â€” seven days, 400 credits each, 1,000 on
the fourth and the seventh. The reward belongs to the account, not to the app, so there is no reason to open
MiniMax Code for it.

This plugin reads and presses the same reward through MiniMax's API:

- it borrows the sign-in MiniMax Code already stored on this machine (`~/.minimax/auth`),
- reads the panel from `GET /minimax-cloud/api/v1/signin/status`,
- claims it with `POST /minimax-cloud/api/v1/signin/claim`,
- and signs both requests with the same OAuth bearer, `x-timestamp`, `x-signature`, and `yy` headers the
  desktop client sends.

The credit lands in the same account, so the MiniMax route in the Harness keeps working with it.

## Features

- **A tool** â€” `minimax_daily_checkin` with `action: "status"` (read the panel) or `action: "claim"`.
- **A composer chip** â€” the current streak, the days left in this cycle, and a **Check in for N** button.
- **Two routes** â€” `GET /plugins/minimax-checkin/status` and `POST /plugins/minimax-checkin/claim`, on the
  Web GUI's own origin.
- **A daily schedule** â€” `autoCheckIn` claims at `autoCheckInHour` local time; the plugin skips the run when
  today's reward was already taken.
- **Never signs in on its own** â€” it reuses the grant MiniMax Code wrote, and refreshes it in place when it is
  about to expire, taking the same `auth.lock` the app uses so the two never fight over one token.
- **Honest failures** â€” a rejected sign-in, a second claim, and an unreachable service each get their own
  message instead of a generic error.

## Requirements

| | |
|---|---|
| DeepSeek Harness | 0.2.x (Web GUI) |
| Runtime | Node 24, supplied by the Harness runtime |
| MiniMax Code | Signed in on **this machine** â€” the plugin borrows that sign-in and never opens a browser |
| Account | MiniMax Code account (the reward belongs to it) |
| Peer | [`dsh-minimax-auth`](../dsh-minimax-auth) â€” the shared grant reader (a `link:` dependency, not a bundle) |

## Install

```bash
git clone https://github.com/borncode-app/dsh-minimax-checkin.git dsh-minimax-checkin
git clone https://github.com/borncode-app/dsh-minimax-auth.git dsh-minimax-auth
cd dsh-minimax-checkin && pnpm install
```

Then in DSH: **Plugins** â†’ install the bundle from that directory, or:

```
plugin_manager install_bundle target=C:\path\to\dsh-minimax-checkin
```

Restart once. The chip appears next to the composer.

## Configuration

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | Registers the tool, the routes, and the schedule |
| `minimaxHome` | `''` | MiniMax Code home; empty means `$MINIMAX_HOME` or `~/.minimax` |
| `buildEnv` | `prod` | OAuth build environment directory under the MiniMax home |
| `region` | `en` | OAuth region directory under the MiniMax home |
| `apiBaseURL` | `https://agent.minimax.io` | Origin that serves the MiniMax Code API |
| `oauthTokenURL` | `''` | OAuth token endpoint; empty derives it from the region |
| `appVersion` | `3.1.14` | MiniMax Code version reported to the API |
| `refreshSkewMs` | `600000` | Refresh the OAuth token this long before it expires |
| `timeoutMs` | `20000` | Milliseconds one API request may take |
| `statusPath` | `/plugins/minimax-checkin/status` | Same-origin Web GUI path that reports the panel |
| `claimPath` | `/plugins/minimax-checkin/claim` | Same-origin Web GUI path that claims the reward |
| `autoCheckIn` | `false` | Claim the reward on a schedule |
| `autoCheckInHour` | `9` | Local hour of the day the scheduled claim runs |

> `appVersion` tells MiniMax which client the request claims to come from. If MiniMax Code updates and the API
> starts refusing the request, this is the first value to raise.

## How it works

```
tool call / composer chip / daily timer
              â”‚
              â–¼
     read the grant under ~/.minimax/auth  â”€â”€â–º  refresh in place when it is close to expiry
              â”‚  (same auth.lock the app uses)
              â–¼
   GET /minimax-cloud/api/v1/signin/status   â”€â”€â–º  the panel: days, points, streak
              â”‚
              â–¼
   POST /minimax-cloud/api/v1/signin/claim   â”€â”€â–º  day number and points granted
```

Both requests carry the OAuth bearer and the signature headers the desktop client sends, so the API sees the
same shape of request it sees from MiniMax Code.

## Files

| file | role |
|---|---|
| `index.js` | Host row: panel reading, claiming, the tool, the routes, the schedule; the grant reader comes from `dsh-minimax-auth` |
| `client.js` | the composer chip |
| `cordis.patch.yml` | the bundle patch that inserts the row |
| `locale/{en,th,zh}.json` | UI strings |
| `icon.svg` | plugin icon |
| `test/checkin.test.mjs` | the checks used while building it (no network) |
| `scripts/checkin-live.mjs` | a live call against the real API: `node scripts/checkin-live.mjs status` |
| `scripts/verify-tool.mjs` | runs the tool against the live API and passes the result through the Harness's own lossless-JSON validator |

## Limitations

- The account must already be signed in to MiniMax Code on this machine. A rejected refresh token needs
  MiniMax Code's own sign-in; the plugin does not open a browser.
- MiniMax allows one claim per day. A second claim returns `AlreadyClaimed` and grants nothing.
- The API group and its signature scheme are MiniMax's own; a future change to them can stop this plugin from
  reading the panel until it is updated.

## à¸ à¸²à¸©à¸²à¹„à¸—à¸¢

Plugin à¸™à¸µà¹‰ **à¸à¸”à¹€à¸„à¸£à¸”à¸´à¸•à¸£à¸²à¸¢à¸§à¸±à¸™à¹ƒà¸«à¹‰à¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´** à¹‚à¸”à¸¢à¹„à¸¡à¹ˆà¸•à¹‰à¸­à¸‡à¹€à¸›à¸´à¸” MiniMax Code â€” à¸à¸”à¹ƒà¸«à¹‰à¸‚à¸­à¸‡à¸‚à¸§à¸±à¸à¸Šà¸¸à¸”à¹€à¸”à¸µà¸¢à¸§à¸à¸±à¸šà¸—à¸µà¹ˆ MiniMax Code
à¹à¸ªà¸”à¸‡à¹ƒà¸™à¹€à¸¡à¸™à¸¹à¸šà¸±à¸à¸Šà¸µ (7 à¸§à¸±à¸™, à¸§à¸±à¸™à¸¥à¸° 400 à¹€à¸„à¸£à¸”à¸´à¸•, à¸§à¸±à¸™à¸—à¸µà¹ˆ 4 à¹à¸¥à¸° 7 à¹„à¸”à¹‰ 1,000)

- à¸¢à¸·à¸¡ **à¸à¸²à¸£ login à¸—à¸µà¹ˆ MiniMax Code à¹€à¸à¹‡à¸šà¹„à¸§à¹‰** à¹ƒà¸™ `~/.minimax/auth` à¸¡à¸²à¹ƒà¸Šà¹‰ (à¹„à¸¡à¹ˆà¸•à¹‰à¸­à¸‡ login à¹ƒà¸«à¸¡à¹ˆ à¹„à¸¡à¹ˆà¹€à¸›à¸´à¸”à¹€à¸šà¸£à¸²à¸§à¹Œà¹€à¸‹à¸­à¸£à¹Œ)
- à¸•à¹ˆà¸­ API à¸‚à¸­à¸‡ MiniMax à¸”à¹‰à¸§à¸¢ header à¹€à¸”à¸µà¸¢à¸§à¸à¸±à¸šà¸—à¸µà¹ˆà¹à¸­à¸›à¹€à¸”à¸ªà¸à¹Œà¸—à¹‡à¸­à¸›à¸ªà¹ˆà¸‡ (`x-timestamp`, `x-signature`, `yy`)
- à¸¡à¸µ **tool** `minimax_daily_checkin` (`action: "status" | "claim"`) à¹à¸¥à¸° **à¸›à¹‰à¸²à¸¢à¹ƒà¸•à¹‰à¸Šà¹ˆà¸­à¸‡à¸žà¸´à¸¡à¸žà¹Œ** à¸—à¸µà¹ˆà¸¡à¸µà¸›à¸¸à¹ˆà¸¡ "Check in for N"
- à¸•à¸±à¹‰à¸‡ `autoCheckIn: true` à¹ƒà¸«à¹‰à¸à¸”à¸‚à¸­à¸‡à¸‚à¸§à¸±à¸à¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´à¸—à¸¸à¸à¸§à¸±à¸™à¹€à¸§à¸¥à¸² `autoCheckInHour` (à¸›à¸à¸•à¸´ 9 à¹‚à¸¡à¸‡) â€” à¸–à¹‰à¸²à¸à¸”à¹„à¸›à¹à¸¥à¹‰à¸§à¸§à¸±à¸™à¸™à¸±à¹‰à¸™à¸¡à¸±à¸™à¸ˆà¸°à¸‚à¹‰à¸²à¸¡
- à¸•à¸­à¸™ token à¹ƒà¸à¸¥à¹‰à¸«à¸¡à¸”à¸­à¸²à¸¢à¸¸ à¸¡à¸±à¸™ refresh à¹€à¸­à¸‡ **à¹ƒà¸™à¹„à¸Ÿà¸¥à¹Œà¹€à¸”à¸´à¸¡à¸‚à¸­à¸‡ MiniMax Code** à¸žà¸£à¹‰à¸­à¸¡ lock à¹€à¸”à¸µà¸¢à¸§à¸à¸±à¸™ â†’ à¹„à¸¡à¹ˆà¹à¸¢à¹ˆà¸‡ token à¸à¸±à¸™

âš ï¸ à¸‚à¹‰à¸­à¸ˆà¸³à¸à¸±à¸”: à¸•à¹‰à¸­à¸‡à¸¥à¹‡à¸­à¸à¸­à¸´à¸™ MiniMax Code à¹„à¸§à¹‰à¸šà¸™à¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸™à¸µà¹‰, MiniMax à¹ƒà¸«à¹‰à¸à¸”à¹„à¸”à¹‰à¸§à¸±à¸™à¸¥à¸°à¸„à¸£à¸±à¹‰à¸‡ (à¸„à¸£à¸±à¹‰à¸‡à¸—à¸µà¹ˆà¸ªà¸­à¸‡à¹„à¸”à¹‰ `AlreadyClaimed`),
à¹à¸¥à¸° `appVersion` à¸•à¹‰à¸­à¸‡à¸•à¸£à¸‡à¸à¸±à¸šà¹€à¸§à¸­à¸£à¹Œà¸Šà¸±à¸™ MiniMax Code à¸—à¸µà¹ˆà¹ƒà¸Šà¹‰à¸­à¸¢à¸¹à¹ˆ â€” à¸–à¹‰à¸²à¹à¸­à¸›à¸­à¸±à¸›à¹€à¸”à¸•à¹à¸¥à¹‰à¸§à¹€à¸£à¸´à¹ˆà¸¡à¸–à¸¹à¸à¸›à¸à¸´à¹€à¸ªà¸˜ à¹ƒà¸«à¹‰à¹à¸à¹‰à¸„à¹ˆà¸²à¸™à¸µà¹‰à¸à¹ˆà¸­à¸™

## License

[MIT](LICENSE) Â© 2026 BornCode
