# ImuaTrak Apple Watch app

SwiftUI watchOS app (single-target, watchOS 10+) that records paddle
sessions — HKWorkoutSession (`.paddleSports`) + GPS + 50 Hz accelerometer
stroke detection — and ships finished sessions to the iPhone over
WatchConnectivity.

## How it's built

The target is embedded **automatically** by
[`@bacons/apple-targets`](https://github.com/EvanBacon/expo-apple-targets)
on every `expo prebuild` / EAS build — no manual Xcode setup. The pieces:

- `expo-target.config.js` — target definition (bundle ID
  `app.imuatrak.watchkitapp`, watchOS 10.0, HealthKit entitlement, frameworks).
- `Info.plist` — `WKApplication`, `WKBackgroundModes`, and the
  HealthKit/location/motion usage strings (the watch app crashes at HealthKit
  authorization without those strings). **`WKBackgroundModes` must contain
  `workout-processing`**: an `HKWorkoutSession` does not by itself grant
  background runtime, so without that key watchOS suspends the app the moment
  it leaves the foreground — GPS, the accelerometer and the duration timer all
  stop — and terminates it under memory pressure. Used verbatim by
  `@bacons/apple-targets`; it is not regenerated at prebuild.
- `plugins/withWatchVersionSync.js` — keeps the watch `MARKETING_VERSION`
  equal to the phone app version (App Store validation requires a match).
- `plugins/withWatchBridge.js` — injects `EXPO_PUBLIC_FIREBASE_PROJECT_ID`
  into `Services/WeatherService.swift` at prebuild, and adds the phone-side
  WatchBridge receiver pod.
- `app.config.js` `ios.appleTeamId` (from `APPLE_TEAM_ID` env) — required
  for signing the second target.

## One-time credentials setup (before the first CI build)

EAS must create a provisioning profile for `app.imuatrak.watchkitapp` (with
the HealthKit capability). The GitHub Actions build runs `--non-interactive`
and cannot do this. Run once from a terminal:

```bash
eas credentials -p ios        # or: eas build -p ios --profile preview
```

and let EAS register the watch bundle ID + profile. If the build later fails
on a missing HealthKit capability, enable it manually on the
`app.imuatrak.watchkitapp` identifier at developer.apple.com.

## Data flow

Sessions are saved on the watch at `Documents/sessions/{id}/session.json` +
`track.json` (same JSON schema as `src/models`), then queued via
`WCSession.transferFile`. The phone's WatchBridge pod (see
`modules/watch-bridge/`) writes them into the app's session store and emits
`sessionReceived`; the Home tab listener syncs them to Firebase.

## Staying alive for a whole paddle

A watch session runs for an hour or more with the screen mostly off, so two
rules keep watchOS from killing the app mid-paddle (it has, twice):

1. **`workout-processing` in `WKBackgroundModes`** — see above. Without it the
   app is only alive while it's on screen.
2. **Nothing slow on the main actor, and nothing at all that grows with the
   track.** watchOS's watchdog kills an app that stalls the main thread, so a
   cost that creeps up as the session gets longer shows up as "it dies around
   4 km" rather than as an obvious hang. Two things were doing exactly that and
   are now off-main: the 50 Hz accelerometer stream (`motionQueue` — it hops to
   the main actor only when a stroke lands) and the recovery snapshot, which
   JSON-encodes the entire track (`snapshotQueue`).

If the app is killed anyway, `WorkoutManager.recoverIfNeeded()` re-attaches to
the HKWorkoutSession HealthKit kept alive and restores the track from the
snapshot.

Separately, **`ContentView` derives the live screen from `isRecording` and does
not put it in a `NavigationStack`.** As a pushed route it could be popped — by
a scene rebuild, or simply by over-swiping left past the Controls page of its
paging `TabView` — and because the push was driven by `onChange(of:)`, which
only fires on a transition, nothing ever put it back. The result was the craft
picker on screen with a workout still running and no End button anywhere, which
is what forced users to quit the app. Keep it derived from state.

## Known limitations

- Weather fetch from the watch always returns nil today: the `fetchWeather`
  Cloud Function requires Firebase auth and the watch is unauthenticated.
  Harmless (weather is optional); fix later by relaying via the phone.
- The live map shows only the current-position marker; there is no route
  polyline (watchOS SwiftUI Map has no polyline API at this deployment target,
  and the placeholder overlay that rendered nothing was removed).
- `distancePaddleSports` HealthKit samples require watchOS 11+; on watchOS
  10 the workout still records without that quantity type.
