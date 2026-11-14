# Mayfly

> **Disclaimer: this project was built by an AI.**
> Mayfly was written almost entirely by Claude (Anthropic's AI model, via Claude Code). I am not a
> software developer, and my own skills would not have been enough to build it. What I did: set the
> goals and the scope, made the decisions, and **tested the app and the server myself**. The code has
> not had a professional review or a security audit. Please read it with that in mind.
>
> **Issues and pull requests are very welcome.** I would be really happy if someone wanted to **take
> over the project**, if you're up for working your way through an AI-built codebase. I'm glad to keep
> helping with what I can do: **server and system administration** (hosting, deployment, the F-Droid
> repo).

Mayfly is a messenger for disappearing photos and videos on Android that puts privacy first. You send photos, short videos and
short texts to friends. Everything is end-to-end encrypted on the phone. The server only ever stores
encrypted blobs and deletes them after 24 hours at the latest. The goal is to send the server as
little information as possible.

## Features

- **End-to-end encryption** (X25519 / XSalsa20-Poly1305 via tweetnacl). This covers moments, captions,
  texts and read receipts.
- **Forward secrecy:** a Double Ratchet (Signal's design, built on tweetnacl) per pair of users. Every
  message gets its own key that is deleted after use, so a key stolen later cannot decrypt older
  messages the server may have kept. Sessions start with a content-free "hello" handshake; friends on
  older versions keep getting the previous format until they update, and a friend who once used the
  ratchet is never downgraded.
- **Sealed sender:** between friends the server does not learn who sent a message or moment. Each user
  gives friends a random delivery token (end-to-end encrypted); senders deliver with that token instead
  of their login, and the sender's id is inside a box only the recipient can open. The server only stores
  the token's hash and sees recipient, time and size. Blocking or removing a friend changes the token.
  The sealed envelope also proves the sender (a MAC from both identity keys), so a friend holding your
  token cannot pretend to be another friend.
  (It still sees the sender's IP address like any server, and senders in group chats and of stories.)
- **Group calls** (2.8): voice and video in group chats, mesh up to 8 people, "Join" banner while a call is running.
- **@mentions** in group chats with suggestions while typing; a mention notifies you even in a muted group.
- **Voice and video calls:** WebRTC, DTLS-SRTP end-to-end encrypted; offer/answer travel end-to-end
  encrypted (sealed) through the relay, so the server cannot get in between. By default calls only use
  the server's TURN relay, so your friend never sees your IP address ("hide my IP" in the profile).
  Incoming calls ring over the lock screen (only the call screen; the rest of the app stays locked);
  no Google push, no ConnectionService.
- **Sender authentication:** every message is bound to sender, recipient, time and a random id (and
  sealed with keys only the two can derive). The server cannot forge, reflect or replay messages.
  A media file that several people can decrypt (a moment to several friends, group media, a story)
  carries its SHA-256 in each recipient's own envelope, so no recipient can swap it with the server's help.
- **Only friends reach you directly:** members of a shared group chat who are not your friends can write
  in that group, but cannot open a 1:1 chat with you or ring your phone.
- **Gone after 24 h:** a moment is deleted on the server once it has been opened, and after 24 h at the
  latest. Text messages disappear after viewing or 6 / 12 / 24 h after sending (set per chat) unless you
  save them.
- **View once, replay once:** each moment can be opened once and replayed exactly once more. The replay
  shows up in the chat, and the rule also applies to saved moments.
- **Save in chat:** saved items stay only on the device, encrypted at rest.
- **Friends via QR code**, plus **chat verification via QR code** (safety number). You get a warning
  when a friend's key changes.
- **Camera:** dual camera (front and back at once on phones with concurrent camera support, one after
  the other otherwise), flash (screen flash for the front camera), self-timer, grid, pinch zoom,
  hands-free video.
- **Moments with colour filters** (swipe in the editor; photos are filtered before sending, videos while
  playing), a time stamp, **drawing, emoji stickers and text** (three styles). The sender picks the view
  time for photos (5 / 10 / 60 s or until closed). Videos can be sent **without sound** (the audio track
  is removed from the file) or at 0.5× / 2× speed; moments can carry a **link** (https only, shown with the
  full address before opening); save your own moment to the phone's gallery before sending. Send from the camera or the gallery, to several
  friends, group chats or a broadcast list at once. Photos are re-encoded without any metadata (EXIF/GPS).
- **Stories** for 24 h, visible only to the friends you pick (or all friends). One encrypted blob; the
  key goes end-to-end encrypted to each picked friend. Replies land in your chat with the owner, and
  you see who watched.
- **Group chats:** shared chat with texts, moments and voice messages. Invited people must accept, every
  member may change name and picture, and saving keeps an item for everyone. Messages are encrypted
  pairwise for every member; membership changes show up in the chat. **Broadcast lists** ("Rundlisten")
  send a moment to every member one by one.
- **Chat:** text and **voice messages**, **replies** (by text or with a moment), **reactions**, **edit**
  (15 min), **unsend** (with a note that the other side may already have seen it). Saved moments are shown
  right in the chat. Pin chats, mute a friend's stories, remove friends, decline friend requests.
- **Per chat:** messages disappear after viewing or 6 / 12 / 24 h after sending (applies to both sides /
  the whole group), mute, nickname (only you see it).
- **Block** people. They can't send you anything or find you again.
- **Best friends:** the 8 people you have the most contact with, counted only on your phone.
- **Screenshots blocked** while a moment or a chat is open.
- **Key changes are never accepted silently:** if the server suddenly has another key for a friend,
  nothing is sent or accepted until you verify or confirm it.
- Themes: pure black (AMOLED, default), dark grey or white.
- **Hands-free video:** hold the shutter and slide it onto the lock.
- **Birthday 🎂** next to your name for your friends — opt-in, day and month only, end-to-end encrypted.
- **Update notice** when a newer version is in the F-Droid repo.
- **Languages:** English and German (follows the phone, can be changed in the profile). More languages: add a dictionary in `mobile/src/i18n/`.
- **Videos up to 30 s**, profile pictures, notifications for new friend requests and group invitations.
- **No Google services:** no Play Services, no Firebase, no ML Kit, no trackers. QR scanning uses ZXing,
  offline.
- **Push via [UnifiedPush](https://unifiedpush.org/)**, e.g. with [ntfy](https://ntfy.sh/). The server
  sends only an empty wake-up and Mayfly shows the notification itself. The distributor never learns
  who wrote to you.

### Not planned

Some well-known features of similar apps will **not** be part of Mayfly, mostly because they
conflict with the focus on privacy and data minimisation:

- a **map** that shows where your friends are (location sharing),
- **memories**, i.e. a cloud archive of your moments on the server,
- a **feed of short videos / public stories** (discover / spotlight style),
- **streaks with flame emojis**, friendship emojis, scores and similar engagement mechanics. They
would need the server to track who talks to whom how often, and they are designed to keep you hooked,
- quick add / contact sync, a public username search,
- an AI chatbot, Bitmoji-style avatars, live location, online status and typing indicators,
- shared stories that several people post into together,
- display names and changing your username (friends know you by your username and your key),
- lenses (face effects) — they would need Google's ML Kit or a large face model,
- a camera night mode — on Android it only exists as vendor-specific camera extensions that differ per
  phone or are missing; not worth the effort,
- cloud translation, sounds / music, sticker libraries (emoji stickers on moments exist), subscriptions,
  games and similar extras,
- moving the chat history to a new phone, and an option to *allow* screenshots,
- several devices per account (your key stays on one phone),
- reporting and moderation — nobody can read along, so nobody can moderate; blocking is the tool.

## What the server can and cannot see

| The server sees | The server never sees |
|---|---|
| Username, profile picture, public key | Content of photos, videos, captions and texts |
| Password, Argon2id hash only | Your chat history (it only exists on your phone) |
| Who is friends with whom, group membership and names, whom you blocked | Whether you saved or replayed something, who watched which story |
| That you posted a story and which friends may open it | What is in the story |
| To whom something goes, when, the approximate size and whether it is a photo, video or voice message. The sender only in group chats, for stories and while a friend still runs an app older than 2.7 | Who sent you something (sealed sender between friends) |
| For calls via the relay: that two devices exchange encrypted packets, their IP addresses, the data volume | What is said or shown in calls; phone number, e-mail, address book (never asked) |
| That a moment was opened (so it can be deleted) | Client IP addresses (not logged) |
| | What reactions, replies and read receipts say; nicknames, mute settings, your best friends |
| Your push distributor's endpoint URL | Your private key |

This metadata is a known limit of the current design. Ideas to reduce it are welcome.

## Repository layout

Each part has its own branch:

| Branch | Contents |
| --- | --- |
| `website` | `server/`: Go API (Echo, PostgreSQL via pgx, Argon2id, JWT) + embedded landing page; `docker-compose.yml`: PostgreSQL + server, hardened (read-only, non-root, no caps) |
| `android-stable` | the Android app as released on F-Droid: React Native 0.74 / Expo SDK 51, bare Android project in `android/` |
| `android-beta` | the next Android version; new versions go to the beta channel (`de.paul42.mayfly.beta`) first |
| `ios` | the iOS app (not started yet) |

Paths below that start with `mobile/` mean the root of an android branch. Checking one out next to
the server gives exactly that layout: `git worktree add mobile android-beta` inside a `website` checkout.

## Running the server

```sh
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
EOF
chmod 600 .env
docker compose up -d --build
```

The server listens on port 8080 and expects to sit behind a TLS reverse proxy. Migrations run
automatically on start. `GET /` shows the landing page, and everything else is the API.

Optional environment variables:

| Variable | Purpose |
|---|---|
| `REGISTRATION_TOKEN` | if set, registration requires this invite code |
| `PUSH_ALLOW_PRIVATE` | `1` allows push endpoints in private networks (off by default, SSRF guard) |
| `SITE_FRIEND_USER` | username whose friend QR code is shown on the landing page (optional) |
| `TRUSTED_PROXIES` | reverse proxy IPs/CIDRs allowed to set `X-Forwarded-For` (default: any private network) |
| `MEDIA_MAX_PENDING_PER_SENDER` / `MEDIA_MAX_PENDING_PER_RECIPIENT` / `MEDIA_MAX_PENDING_PER_GROUP` / `STORY_MAX_MB` / `MEDIA_MIN_FREE_MB` | limits (defaults 100 unopened moments per sender / 200 waiting per recipient / 200 unopened per group chat / 300 MB of stories / keep 1024 MB free). `GET /limits` reports them and the app shows them |
| `FDROID_INDEX_URL` | F-Droid index used by the landing page to find the newest APK (`off` disables) |
| `TURN_URLS` / `TURN_SECRET` | TURN relay for calls (coturn with `use-auth-secret`; the server hands out short-lived credentials). Without them there are no calls |
| `STUN_URLS` / `TURN_TTL_HOURS` | optional extra STUN servers (default none — no third parties) / credential lifetime (8 h) |

## Tests

```sh
cd mobile && npx jest                  # crypto: forgery, reflection, replay
server/scripts/integration-test.sh     # full HTTP API against a throwaway PostgreSQL (needs Docker)
```

## Building the app

```sh
cd mobile && npm ci
cd android && ./gradlew assembleRelease
```

A release build needs your own signing key (`mobile/android/keystore.properties` +
`mobile/android/app/mayfly-release.jks`), and the build refuses to run without them. Never commit
them. The default server URL is set in `mobile/src/config.ts`, and users can change it on the login
screen.

## Installing

Signed builds are published in an F-Droid repository:

- Repo: `https://fdroid.paul42.de/repo`
- Fingerprint: `45AD2945568B96FCBF5DCE87ED36749731B358D0E6E55C06553FF201D195B1DF`

There are setup instructions with QR codes at <https://mayfly.paul42.de>.

Every version is also built by GitHub Actions and published under
[Releases](https://github.com/hush1981/mayfly/releases) as APK and AAB, signed with the same key
(certificate SHA-256 `5c211986f1e92e4d3ea2ee90e737c20a625ee3b64ad293f9b2ffe6fa1bb91cdc`), so they install as
updates of the F-Droid builds and the other way round. `v<version>` is the stable app
(`de.paul42.mayfly`), `v<version>-beta` the beta (`de.paul42.mayfly.beta`).

## Known gaps

- Tested on the emulator and by me, but not yet broadly on many real devices.
- Expo SDK 51 / React Native 0.74 are outdated and need an upgrade.
- One device per account.
- Dual video recording needs concurrent-camera support; it could only be tested in the fallback mode
  (one camera after the other) on the emulator.
- Group calls are a mesh (every phone sends to every other one), so they are limited to 8 people.
- Android only (the code is React Native, so iOS would be possible, but nobody has built or tested it).

## License

Mayfly (server, website and app) is licensed under the
[GNU Affero General Public License v3.0](LICENSE). If you run a modified server for others,
you have to offer them its source code.
