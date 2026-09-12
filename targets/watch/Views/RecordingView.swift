import SwiftUI
import MapKit

struct RecordingView: View {
    @EnvironmentObject var workoutManager: WorkoutManager
    @Binding var path: NavigationPath
    @State private var showStopAlert = false
    @State private var selectedPage = 0
    @State private var showSwipeHint = false
    // Discovery aid: once the user has ever swiped between recording pages,
    // stop showing the hint on future sessions.
    @AppStorage("hasSwipedRecordingPages") private var hasSwipedRecordingPages = false

    var body: some View {
        TabView(selection: $selectedPage) {
            // Page 1 — Controls (pause/resume, end) — like the Workout app
            ControlsPage(showStopAlert: $showStopAlert)
                .tag(0)
            // Page 2 — Pace metrics
            MetricsPage1()
                .tag(1)
            // Page 3 — Heart rate & strokes
            MetricsPage2()
                .tag(2)
            // Page 4 — Live map
            LiveMapPage()
                .tag(3)
        }
        // Horizontal paging with the page dots always visible so it's clear
        // there are more screens (stats, map) beside the controls.
        .tabViewStyle(.page(indexDisplayMode: .always))
        .overlay(alignment: .bottom) {
            if showSwipeHint {
                SwipeHintBadge()
                    .padding(.bottom, 14)
                    .transition(.opacity)
            }
        }
        .onChange(of: selectedPage) { _ in
            hasSwipedRecordingPages = true
            withAnimation(.easeOut(duration: 0.3)) { showSwipeHint = false }
        }
        .onAppear {
            guard !hasSwipedRecordingPages else { return }
            showSwipeHint = true
            Task {
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                withAnimation(.easeOut(duration: 0.5)) { showSwipeHint = false }
            }
        }
        .alert("Stop Session?", isPresented: $showStopAlert) {
            Button("Stop & Save", role: .destructive) {
                Task {
                    await workoutManager.stopAndSave()
                    // Replace rather than append: the recording screen is no
                    // longer a route on this path, and a workout started by
                    // Siri may have left the path empty entirely.
                    path = NavigationPath(["summary"])
                }
            }
            Button("Discard", role: .destructive) {
                workoutManager.discard()
                path = NavigationPath()
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

// First-session hint shown over the controls page until the user swipes.
private struct SwipeHintBadge: View {
    var body: some View {
        HStack(spacing: 4) {
            Text("Swipe for stats")
                .font(.system(.caption2, design: .rounded).bold())
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .bold))
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Capsule().fill(.ultraThinMaterial))
    }
}

// ── Page 1: Controls ──────────────────────────────────────────────────────────

private struct ControlsPage: View {
    @EnvironmentObject var wm: WorkoutManager
    @Binding var showStopAlert: Bool

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                ControlButton(
                    icon: wm.isPaused ? "play.fill" : "pause.fill",
                    label: wm.isPaused ? "Resume" : "Pause",
                    color: wm.isPaused ? .imuaSeafoam : .imuaGold
                ) {
                    wm.isPaused ? wm.resume() : wm.pause()
                }
                ControlButton(icon: "stop.fill", label: "End", color: .imuaCoral) {
                    showStopAlert = true
                }
            }
            if wm.isPaused {
                Text("PAUSED")
                    .font(.system(.caption2, design: .rounded).bold())
                    .foregroundStyle(Color.imuaGold)
            } else {
                Text(Fmt.duration(wm.durationSec))
                    .font(.system(.caption2, design: .rounded).bold())
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
    }
}

private struct ControlButton: View {
    let icon: String
    let label: String
    let color: Color
    let action: () -> Void

    var body: some View {
        VStack(spacing: 4) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.title3.bold())
                    .foregroundStyle(color)
                    .frame(width: 56, height: 56)
                    .background(Circle().fill(color.opacity(0.2)))
            }
            .buttonStyle(.plain)
            Text(label)
                .font(.system(.caption2, design: .rounded))
                .foregroundStyle(.secondary)
        }
    }
}

// ── Page 2: Distance hero / Time / Pace ──────────────────────────────────────

private struct MetricsPage1: View {
    @EnvironmentObject var wm: WorkoutManager

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Hero distance
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(Fmt.distanceValue(wm.distanceM))
                        .font(.system(size: 40, weight: .heavy, design: .rounded))
                        .foregroundStyle(Color.imuaAqua)
                        .monospacedDigit()
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                    Text(Fmt.distanceUnit)
                        .font(.system(.footnote, design: .rounded).bold())
                        .foregroundStyle(.secondary)
                }
                RecordingDot(craft: wm.currentCraft)
            }

            Divider()
            MetricRow(icon: "timer", label: "TIME",
                      value: Fmt.duration(wm.durationSec), color: .white)
            Divider()
            MetricRow(icon: "speedometer", label: "PACE",
                      value: Fmt.pace(distanceM: wm.distanceM, durationSec: wm.durationSec),
                      color: .imuaSeafoam)
        }
        .padding(.horizontal)
    }
}

// Small "recording"/"paused" indicator with the craft badge under the hero number.
private struct RecordingDot: View {
    @EnvironmentObject var wm: WorkoutManager
    let craft: String
    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(wm.isPaused ? Color.imuaGold : Color.imuaCoral)
                .frame(width: 6, height: 6)
            Text(wm.isPaused ? "PAUSED · \(craft)" : craft)
                .font(.system(.caption2, design: .rounded).bold())
                .foregroundStyle(wm.isPaused ? Color.imuaGold : craftColor(craft))
        }
    }
}

// ── Page 2: Heart Rate / Stroke Rate / Strokes ───────────────────────────────

private struct MetricsPage2: View {
    @EnvironmentObject var wm: WorkoutManager
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MetricRow(icon: "heart.fill", label: "HEART RATE",
                      value: wm.heartRate > 0 ? "\(wm.heartRate) bpm" : "—",
                      color: .imuaCoral)
            Divider()
            MetricRow(icon: "water.waves", label: "STROKE RATE",
                      value: wm.strokeRate > 0 ? String(format: "%.0f spm", wm.strokeRate) : "—",
                      color: .imuaAqua)
            Divider()
            MetricRow(icon: "repeat", label: "STROKES",
                      value: "\(wm.strokeCount)", color: .imuaGold)
        }
        .padding(.horizontal)
    }
}

// ── Page 3: Live map ──────────────────────────────────────────────────────────

private struct LiveMapPage: View {
    @EnvironmentObject var wm: WorkoutManager
    @State private var region = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 21.3, longitude: -157.8),
        span: MKCoordinateSpan(latitudeDelta: 0.02, longitudeDelta: 0.02)
    )

    var body: some View {
        Map(coordinateRegion: $region, annotationItems: wm.coordinates.last.map { [MapPin(coord: $0)] } ?? []) { pin in
            MapMarker(coordinate: pin.coord, tint: .imuaAqua)
        }
        // CLLocationCoordinate2D isn't Equatable, so observe the array count
        // and re-center on the latest fix whenever a new point lands.
        .onChange(of: wm.coordinates.count) { _ in
            guard let coord = wm.coordinates.last else { return }
            region.center = coord
        }
    }
}

// The id is derived from the coordinate, not a fresh UUID per init: the
// annotation array is rebuilt on every render, and a new identity each time
// made MapKit tear the marker down and re-add it many times a second.
struct MapPin: Identifiable {
    let coord: CLLocationCoordinate2D
    var id: String { "\(coord.latitude),\(coord.longitude)" }
}

// ── Shared metric row ─────────────────────────────────────────────────────────

private struct MetricRow: View {
    let icon: String
    let label: String
    let value: String
    var color: Color = .white

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(color.opacity(0.8))
                .frame(width: 16)
            Text(label)
                .font(.system(.caption2, design: .rounded))
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.system(.title3, design: .rounded).bold())
                .foregroundStyle(color)
                .monospacedDigit()
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
    }
}
