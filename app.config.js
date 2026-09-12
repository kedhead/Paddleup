// iOS OAuth client ID (type "iOS", matched by bundle ID) from Google Cloud
// Console → APIs → Credentials. Google's iOS SDK requires the app to handle a
// URL scheme that is the client ID reversed:
//   1234-abc.apps.googleusercontent.com → com.googleusercontent.apps.1234-abc
// The @react-native-google-signin plugin writes that scheme into Info.plist at
// prebuild. Set EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID in EAS env (and .env for
// local prebuilds); when unset the plugin is skipped and the app simply hides
// the Google button on iOS (Android is unaffected — its client is resolved by
// Play Services, no scheme needed).
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
const googleIosUrlScheme = GOOGLE_IOS_CLIENT_ID
  ? `com.googleusercontent.apps.${GOOGLE_IOS_CLIENT_ID.replace(".apps.googleusercontent.com", "")}`
  : undefined;

// ── OTA runtime versions, per platform ──────────────────────────────────────
// The runtime version ties an OTA update to the native binaries that are able
// to run it. It MUST equal the `version` of the binary users actually have
// INSTALLED on that platform — never the version you intend to build next.
//
// iOS and Android ship on independent schedules, so their installed versions
// drift apart, and they have: iOS is on 1.0.2 (built 2026-08-01) while the
// Play Store release is still 1.0.1 (built late July). A single top-level
// runtime cannot serve both. It matched iOS, so every OTA since late July —
// club chat, @mentions, boat lineups, direct messages, the photo gallery —
// landed on iPhones and silently reached nobody on Android, while `eas update`
// reported success each time. Android has been running its build-time bundle
// since launch.
//
// Splitting the runtime per platform fixes that: one `eas update` run now
// publishes an Android bundle at 1.0.1 and an iOS bundle at 1.0.2, and both
// platforms get the same JS.
//
// These are explicit strings rather than the "appVersion" policy on purpose.
// Under that policy the store version below WAS the OTA runtime, so editing it
// in anticipation of a build retargeted live updates at a runtime no device
// had — which is exactly what happened for six days in August (#62). The two
// concerns are now separate knobs that cannot be confused.
//
// ⚠️ When you ship a native build to a store, set that platform's runtime here
// to the version of that build, in the same commit that produces it. Run
// `npm run check:ota` to verify these against the builds EAS actually has.
//
// Both constants are set to 1.0.5 for the build produced from this commit.
// Its headline native change is the watch app: 1.0.4's recovery fix was not
// enough on its own, because the watch app had no `workout-processing` entry in
// WKBackgroundModes at all — an HKWorkoutSession does not grant background
// runtime by itself, so watchOS suspended the app whenever it left the
// foreground and killed it under pressure. That is an Info.plist change, and
// the rest of the watch work (the live screen no longer being a poppable
// navigation route, the 50 Hz accelerometer and the snapshot write moved off
// the main actor) is Swift. None of it can travel over OTA.
//
// ⚠️ Do NOT push an OTA (`eas update --channel production`) until 1.0.5 is
// LIVE and installed on each store: until then these runtimes point at a build
// no device has, and an update would reach nobody — the #62 outage again.
// (1.0.4 users keep the JS they already have; they get the rest by updating.)
const IOS_RUNTIME_VERSION = "1.0.5";
// Both platforms are built and submitted from this commit, so Android moves in
// step with iOS. Android has no native change of its own this cycle — it is
// here to stay in line, and to carry the JS below in its binary.
const ANDROID_RUNTIME_VERSION = "1.0.5";

/** @type {import('expo/config').ExpoConfig} */
const config = {
  name: "ImuaTrak",
  slug: "imuatrak",
  owner: "paintpile",
  scheme: "imuatrak",
  // App Store / Play Store marketing version (CFBundleShortVersionString /
  // versionName). Store versions must strictly INCREASE, compared
  // segment-by-segment: 0.1.10 is LOWER than the live 1.0 (0 < 1), which is
  // why submits were rejected as "not new". The first launch shipped as 1.0,
  // so the next store build must be 1.0.1 or higher.
  //
  // This value is ONLY the store version. It is no longer the OTA runtime —
  // those are IOS_RUNTIME_VERSION / ANDROID_RUNTIME_VERSION above, and editing
  // this field cannot retarget a live update any more. Bumping it early is now
  // harmless; bumping it is in fact required before any store submission.
  //
  // Because it is shared, every native build needs a number no store has seen:
  // 1.0.4 shipped to both stores, so the next one starts at 1.0.5. Set that
  // platform's runtime constant above to whatever number you land on, in the
  // same commit.
  //
  // 1.0.5 is the number for the build produced from this commit. The native
  // reason for it is the watch app — the missing workout-processing background
  // mode, the recording screen no longer being a poppable navigation route, and
  // the main-thread work that was getting the app watchdog-killed partway
  // through a paddle. It also carries the JS accumulated since 1.0.4 (photo
  // attachments in direct messages).
  version: "1.0.5",
  orientation: "portrait",
  icon: "./assets/icon.png",
  // Every screen is styled with hardcoded light colors — there is no dark
  // theme. Declaring "automatic" told iOS the app adapts, so on a phone in
  // dark mode NATIVE components (date/time pickers, alerts, action sheets)
  // rendered dark-on-light and became unreadable. Pinning to "light" keeps
  // system UI consistent with the app's own palette. Revisit if a real dark
  // theme is ever built.
  userInterfaceStyle: "light",
  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#07314F",
  },
  newArchEnabled: true,
  assetBundlePatterns: ["**/*"],

  // EAS Update (over-the-air JS updates). JS-only fixes ship without a rebuild
  // via `eas update`. Builds must be made AFTER this is configured for the app
  // to start checking for updates.
  //
  // There is deliberately NO top-level `runtimeVersion` here: `ios.runtimeVersion`
  // and `android.runtimeVersion` below take precedence over a root value, and
  // leaving the root unset means a stray edit to it can never quietly override
  // one platform. Every build and every update resolves its runtime from the
  // platform block that applies to it.
  updates: {
    url: "https://u.expo.dev/e23de54c-0b38-4c19-b13f-066535bcdd14",
  },

  ios: {
    bundleIdentifier: "app.imuatrak",
    // OTA runtime for iOS — matches the live App Store build (1.0.2).
    runtimeVersion: IOS_RUNTIME_VERSION,
    // Apple Developer Team ID — required by @bacons/apple-targets to sign the
    // watch target. Set APPLE_TEAM_ID in EAS project env (and locally in .env
    // when running prebuild); find it at developer.apple.com → Membership.
    appleTeamId: process.env.APPLE_TEAM_ID,
    supportsTablet: false,
    // Universal links: https://imuatrak.app/join/{club} opens the app
    // directly (no browser hop). Requires the apple-app-site-association
    // file served by the website — see docs/universal-links.md.
    associatedDomains: ["applinks:imuatrak.app"],
    infoPlist: {
      // Required on the companion iOS app because the bundled watch app uses
      // HealthKit (workout session + heart rate). The phone app itself does
      // not read or write HealthKit data.
      NSHealthShareUsageDescription:
        "The ImuaTrak Apple Watch app reads your heart rate during a paddling workout to show live effort and heart-rate zones.",
      NSHealthUpdateUsageDescription:
        "The ImuaTrak Apple Watch app saves your paddling workouts, distance, and calories to Health.",
      NSLocationAlwaysAndWhenInUseUsageDescription:
        "ImuaTrak uses your location to record your route, distance, and pace while you paddle.",
      NSLocationWhenInUseUsageDescription:
        "ImuaTrak uses your location to record your route, distance, and pace while you paddle.",
      NSMotionUsageDescription:
        "ImuaTrak uses motion sensors to count strokes and measure stroke rate.",
      // NSMicrophoneUsageDescription intentionally omitted: the audio "hut"
      // detection feature (Phase 3) is not implemented yet, so declaring the
      // microphone permission would request access for an absent feature
      // (App Store Guideline 5.1.1 / 2.5.1). Restore it when Phase 3 ships.
      // Only "location" is declared — the app records GPS in the background
      // while a session is active. "fetch" was removed: no Background Fetch /
      // BGTaskScheduler feature exists, and declaring it triggered the
      // "no feature requires this background mode" rejection (Guideline 2.1).
      UIBackgroundModes: ["location"],
    },
    entitlements: {
      "com.apple.developer.applesignin": ["Default"],
      "aps-environment": "production",
    },
    config: {
      usesNonExemptEncryption: false,
    },
  },

  android: {
    package: "app.imuatrak",
    // OTA runtime for Android — matches the live Play Store build (1.0.1),
    // which is a version behind iOS. Do not "fix" this by aligning it with
    // the iOS number: it describes what is installed, not what is desired.
    runtimeVersion: ANDROID_RUNTIME_VERSION,
    // Android App Links for invite URLs — verified against the
    // assetlinks.json served by the website (see docs/universal-links.md).
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: "imuatrak.app", pathPrefix: "/join" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#07314F",
    },
    config: {
      googleMaps: {
        apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY,
      },
    },
    permissions: [
      "ACCESS_FINE_LOCATION",
      "ACCESS_COARSE_LOCATION",
      "ACCESS_BACKGROUND_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
      "WAKE_LOCK",
      // BODY_SENSORS, ACTIVITY_RECOGNITION and HIGH_SAMPLING_RATE_SENSORS were
      // removed: the phone does not read them. Stroke rate comes from the raw
      // accelerometer at 50 Hz (expo-sensors, no permission needed), and heart
      // rate arrives from the paired watch over the data layer — never from the
      // phone's body sensors. Declaring them forced a Google "Health apps"
      // permissions review for data the app never touches. They are also blocked
      // below so a dependency can't silently re-add them to the merged manifest.
      // RECORD_AUDIO removed alongside iOS NSMicrophoneUsageDescription — the
      // audio "hut" detection feature (Phase 3) is not built yet. Restore when
      // it ships.
      "POST_NOTIFICATIONS",
      "com.google.android.wearable.permission.RECEIVE_COMPLICATION_DATA",
    ],
    blockedPermissions: [
      "android.permission.BODY_SENSORS",
      "android.permission.ACTIVITY_RECOGNITION",
      "android.permission.HIGH_SAMPLING_RATE_SENSORS",
    ],
  },

  web: {
    bundler: "metro",
    output: "single",
  },

  plugins: [
    "expo-router",
    "expo-notifications",
    [
      "expo-camera",
      {
        // Invite QR scanning only — no video capture anywhere in the app.
        cameraPermission:
          "ImuaTrak uses the camera to scan a club's invite QR code so you can join.",
        // `false` DELETES NSMicrophoneUsageDescription; leaving it undefined
        // makes the plugin add its own default string, which would re-declare
        // the microphone permission the app deliberately dropped (no audio
        // feature exists yet — Guideline 5.1.1 / 2.5.1). Same for Android's
        // RECORD_AUDIO, which is why recordAudioAndroid is off.
        microphonePermission: false,
        recordAudioAndroid: false,
      },
    ],
    [
      "react-native-google-mobile-ads",
      {
        androidAppId: process.env.ADMOB_ANDROID_APP_ID ?? "ca-app-pub-3940256099942544~3347511713",
        iosAppId: process.env.ADMOB_IOS_APP_ID ?? "ca-app-pub-3940256099942544~1458002511",
      },
    ],
    "expo-apple-authentication",
    ...(googleIosUrlScheme
      ? [["@react-native-google-signin/google-signin", { iosUrlScheme: googleIosUrlScheme }]]
      : []),
    "expo-secure-store",
    [
      "expo-media-library",
      {
        // Save-only: members download chat photos to their camera roll. We
        // never read the library, so keep the add-only string front and center.
        photosPermission:
          "ImuaTrak saves photos you download from club chat to your photo library.",
        savePhotosPermission:
          "ImuaTrak saves photos you download from club chat to your photo library.",
        isAccessMediaLocationEnabled: false,
        // Add NO broad read-media permissions on Android. The default would
        // inject READ_MEDIA_IMAGES/VIDEO/AUDIO, which forces Google Play's
        // "Photo and video permissions declaration" and blocked our submit —
        // but we only ever call saveToLibraryAsync (a MediaStore write), so we
        // don't need read access. Saving still works via the retained
        // WRITE_EXTERNAL_STORAGE (<=API 32) and scoped MediaStore on newer OS.
        granularPermissions: [],
      },
    ],
    [
      "expo-tracking-transparency",
      {
        userTrackingPermission:
          "ImuaTrak asks so it can show ads that are more relevant to you. Decline and you'll still see ads — just non-personalized ones.",
      },
    ],
    "./plugins/withFixGradle",
    "./plugins/withWatchBridge",
    // Must stay BEFORE @bacons/apple-targets: mods run in reverse registration
    // order, and the targets plugin registers the pbxproj provider last.
    "./plugins/withWatchVersionSync",
    // Embeds targets/watch (the ImuaTrakWatch watchOS app) into the Xcode
    // project on every prebuild, so EAS builds ship the watch app.
    "@bacons/apple-targets",
    [
      "expo-location",
      {
        locationAlwaysAndWhenInUsePermission:
          "ImuaTrak uses your location to record your route, distance, and pace while you paddle.",
        isIosBackgroundLocationEnabled: true,
        isAndroidBackgroundLocationEnabled: true,
      },
    ],
    [
      "expo-build-properties",
      {
        ios: {
          deploymentTarget: "16.4",
          // GoogleSignIn's AppCheckCore pod is Swift and imports these two
          // Objective-C pods, which don't define module maps — pod install
          // fails as static libraries unless they generate modular headers.
          extraPods: [
            { name: "GoogleUtilities", modular_headers: true },
            { name: "RecaptchaInterop", modular_headers: true },
          ],
        },
        // targetSdkVersion 36 (Android 16): Google Play requires targets within
        // one year of the latest Android release from Aug 30, 2026.
        android: { compileSdkVersion: 36, targetSdkVersion: 36, minSdkVersion: 26 },
      },
    ],
  ],

  extra: {
    eas: {
      projectId: "e23de54c-0b38-4c19-b13f-066535bcdd14",
    },
    firebase: {
      apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
      authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
      storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
      appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
    },
  },

  experiments: {
    typedRoutes: true,
  },
};

module.exports = config;
