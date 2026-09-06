# Backlog

Planned features that are understood and scoped but deliberately not built yet.
Distinct from `known-issues.md` (bugs) — these are things to build when the
right build/deploy window comes up.

---

## Enable R8 (Android code shrinking) — first change of the 1.0.5 cycle

**Status:** deferred from 1.0.4 (2026-09). Play Console flags the app as not
optimized: https://developer.android.com/topic/performance/app-optimization/enable-app-optimization

Advisory, not a submission blocker — 1.0.4 shipped without it deliberately, so
an already-tested binary wasn't invalidated hours before submission.

### The change

In the `expo-build-properties` android block in `app.config.js`:

```js
android: {
  compileSdkVersion: 36, targetSdkVersion: 36, minSdkVersion: 26,
  enableProguardInReleaseBuilds: true,
  enableShrinkResourcesInReleaseBuilds: true,  // requires proguard enabled
}
```

### Why it needs its own cycle

R8 strips and renames native Java/Kotlin and breaks anything reflection-based
whose ProGuard rules are missing. This app's Android build pulls in Firebase,
RevenueCat, Google Sign-In, AdMob, Google Maps, expo-camera, expo-media-library
and expo-notifications. Most ship consumer rules and survive R8, but the only
proof is building it and exercising each path. Hermes means JS is untouched, so
the win is real but modest — not worth risking a release on.

Do it as the FIRST change of a cycle, promote to **internal testing** (never
straight to production), and smoke-test: Google + Apple sign-in, a subscription
purchase, chat photo/video upload, the invite QR scanner, the map on a saved
paddle, and push notifications. A failure there is a missing `-keep` rule, added
via `expo-build-properties`' `extraProguardRules`.

---

## Birthday push notifications — for the next full build

**Status:** deferred. The in-app version shipped (2026-08); push is the follow-up.

### What exists today (in-app, OTA)

Members set a birthday (month/day) in Settings; it syncs to their member doc in
every club (`syncMemberProfile`). Surfaced in-app only:

- Club home shows a "Happy birthday, {name}!" banner for anyone celebrating today
  (`app/(tabs)/club.tsx`, gated by `isBirthdayToday`).
- The roster shows a cake next to the name that day (`app/club/members.tsx`).

These only appear when a member opens the app.

### What's still wanted

A **push notification** to the club when it's a member's birthday
("It's Jodi's birthday today! 🎉"), so people are told without opening the app.

### Why it needs a build/deploy, not an OTA

It's a **new scheduled Cloud Function**, not client JS:

1. Add a daily scheduled function (see the existing `expireClubTrials` sweep in
   `firebase/functions/src/index.ts` for the `onSchedule` pattern). Run it once
   a day in a sensible timezone.
2. For each club, find members whose `birthday` (`MM-DD`) matches today, and send
   a push to the other members via the existing FCM token infrastructure
   (`FcmToken`, and however new-message/event notifications are sent).
3. Guard against duplicates if the function can fire more than once a day
   (e.g. stamp a `birthdayNotifiedOn` per member/day).

Deploying it is a normal `npm run deploy:functions` — it declares no new secrets,
so it does **not** hit the parked-`revenuecat.ts` secret problem.

### Open product questions

- Notify the whole club, or just staff (owner/admin/coach)?
- Let a member opt out of having their birthday announced?
- Timezone: club-level, or per-user? (A club-level default is simplest.)
