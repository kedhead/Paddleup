import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var workoutManager: WorkoutManager
    @Environment(\.scenePhase) private var scenePhase
    @State private var path = NavigationPath()

    var body: some View {
        Group {
            if workoutManager.isRecording {
                // A live paddle OWNS the screen — deliberately NOT inside a
                // NavigationStack.
                //
                // This used to be a route pushed onto the path by an onChange of
                // isRecording. That has one fatal property: onChange only fires
                // on a TRANSITION, so anything that popped or reset the path
                // while isRecording stayed true left the user on the craft
                // picker with a workout still running and no End button
                // anywhere — force-quitting was the only way out.
                //
                // Being pushed also meant the recording screen could be
                // dismissed by a left-edge swipe, and its pages are a paging
                // TabView: over-swiping past the leftmost page (Controls) popped
                // the whole screen. That is the easiest way to hit this by
                // accident mid-paddle, and it can't happen now that there is no
                // stack to pop. A relaunch or a scene rebuild is covered by the
                // same change, since the screen is derived from state rather
                // than from navigation history.
                RecordingView(path: $path)
            } else {
                NavigationStack(path: $path) {
                    CraftPickerView(path: $path)
                        .navigationDestination(for: String.self) { route in
                            switch route {
                            case "pre-record":
                                PreRecordView(path: $path)
                            case "summary":
                                SummaryView(path: $path)
                            default:
                                CraftPickerView(path: $path)
                            }
                        }
                }
            }
        }
        // watchOS can terminate the app mid-paddle; HealthKit keeps the workout
        // alive but this process comes back empty. Re-attach to it, which flips
        // isRecording and puts the live screen back up.
        .task {
            await workoutManager.recoverIfNeeded()
        }
        // The app can also be relaunched into the BACKGROUND, before HealthKit
        // will hand the session over — the .task above then finds nothing. Try
        // again whenever the app becomes active; recoverIfNeeded is a no-op when
        // a session is already attached.
        .onChange(of: scenePhase) { phase in
            guard phase == .active else { return }
            Task { await workoutManager.recoverIfNeeded() }
        }
    }
}
