import Foundation
import HealthKit
import CoreLocation
import CoreMotion
import WatchKit

// ── WorkoutManager.swift ──────────────────────────────────────────────────────
// Orchestrates a paddle session on Apple Watch:
//   HKWorkoutSession + HKLiveWorkoutBuilder → keeps GPS + HR sensors powered
//   CLLocationManager → 1 Hz GPS track points
//   CMMotionManager → 50 Hz accelerometer → StrokeDetector
//
// When stopAndSave() is called the manager assembles a WatchSession (same JSON
// schema as the phone model), computes aggregates, and calls TransferManager.

@MainActor
final class WorkoutManager: NSObject, ObservableObject {

    // Single shared instance: the SwiftUI app and the Siri StartPaddlingIntent
    // must drive the same workout state.
    static let shared = WorkoutManager()

    // ── Published state ───────────────────────────────────────────────────────
    @Published var isRecording = false
    @Published var isPaused = false
    @Published var distanceM = 0.0
    @Published var durationSec = 0.0
    @Published var heartRate = 0
    @Published var strokeRate = 0.0
    @Published var strokeCount = 0
    @Published var coordinates: [CLLocationCoordinate2D] = []

    // Remembered across launches so "Hey Siri" starts (without an explicit
    // craft parameter) use the last craft picked in the app.
    var currentCraft = UserDefaults.standard.string(forKey: "lastCraftType") ?? "OC1" {
        didSet { UserDefaults.standard.set(currentCraft, forKey: "lastCraftType") }
    }

    // ── Private ───────────────────────────────────────────────────────────────
    private let healthStore = HKHealthStore()
    private var workoutSession: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?

    private let locationManager = CLLocationManager()
    private let motionManager = CMMotionManager()
    private let strokeDetector = StrokeDetector()

    /// Serial, off-main queue for the 50 Hz accelerometer stream.
    private let motionQueue: OperationQueue = {
        let q = OperationQueue()
        q.name = "app.imuatrak.watch.motion"
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        return q
    }()

    /// Serial queue for writing the recovery snapshot. Serial so a slow write
    /// can never be overtaken by a newer one and leave stale state on disk.
    private static let snapshotQueue = DispatchQueue(label: "app.imuatrak.watch.snapshot",
                                                     qos: .utility)

    private var track: [WatchTrackPoint] = []
    private var sessionStartDate: Date?
    private var sessionId = ""
    private var lastHrValue = 0
    private var currentStrokeRate = 0.0

    private var durationTimer: Timer?
    private var sessionStartEpoch = 0.0
    private var authRequestInFlight = false
    private var lastSnapshotAt = 0.0

    // Pause bookkeeping: track timestamps use ACTIVE time (wall time minus
    // paused time) so paused stretches don't inflate duration, pace, or splits.
    private var pausedAccumSec = 0.0
    private var pauseStartedAt: Date?

    private var activeElapsedSec: Double {
        var elapsed = Date().timeIntervalSince1970 - sessionStartEpoch - pausedAccumSec
        if let pauseStartedAt {
            elapsed -= Date().timeIntervalSince(pauseStartedAt)
        }
        return max(0, elapsed)
    }

    private override init() {
        super.init()
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.activityType = .fitness
        locationManager.distanceFilter = kCLDistanceFilterNone
    }

    // ── Authorization ─────────────────────────────────────────────────────────

    func requestAuthorization() async {
        var types: Set<HKSampleType> = [
            HKQuantityType(.heartRate),
            HKQuantityType(.activeEnergyBurned),
            .workoutType(),
        ]
        // distancePaddleSports is watchOS 11+; older watches still record the
        // workout itself, just without the paddling-distance quantity.
        if #available(watchOS 11.0, *) {
            types.insert(HKQuantityType(.distancePaddleSports))
        }
        // Only prompt while some type is still undetermined. Re-requesting
        // after the user has answered re-suspends on HealthKit for nothing,
        // and overlapping requests are one way the prompt gets wedged and
        // never resumes — which used to leave start() hung forever.
        let needsPrompt = types.contains { healthStore.authorizationStatus(for: $0) == .notDetermined }
        guard needsPrompt, !authRequestInFlight else { return }
        authRequestInFlight = true
        defer { authRequestInFlight = false }
        try? await healthStore.requestAuthorization(toShare: types, read: [HKQuantityType(.heartRate)])
    }

    // ── Session lifecycle ─────────────────────────────────────────────────────

    func start() async {
        // Re-entrancy guard: a double-tap on Start (or Siri racing the UI)
        // must not reset live state mid-session. Nothing below suspends
        // before isRecording flips, so this check is airtight on @MainActor.
        guard !isRecording else { return }

        sessionId = generateId()
        sessionStartDate = Date()
        sessionStartEpoch = Date().timeIntervalSince1970
        track = []
        strokeDetector.reset()
        distanceM = 0
        durationSec = 0
        strokeCount = 0
        strokeRate = 0
        heartRate = 0
        coordinates = []
        isPaused = false
        pausedAccumSec = 0
        pauseStartedAt = nil

        // Flip isRecording BEFORE anything that can suspend: navigation to
        // the recording screen is driven by this flag, and the HealthKit
        // authorization below can stall indefinitely on watchOS. The Start
        // button must never silently do nothing.
        isRecording = true
        WKInterfaceDevice.current().play(.start)

        // GPS, accelerometer, and the duration clock don't need HealthKit.
        locationManager.requestWhenInUseAuthorization()
        locationManager.startUpdatingLocation()
        startAccelerometer()

        startDurationTimer()
        persistSnapshot(force: true)

        // Fetch weather at session start (best-effort, non-blocking)
        Task {
            if let loc = locationManager.location {
                _ = await WeatherService.fetch(lat: loc.coordinate.latitude,
                                               lon: loc.coordinate.longitude)
            }
        }

        // HealthKit last: the one-time permission prompt can suspend for as
        // long as the sheet is up (or forever if it wedges); the workout
        // above records regardless, HealthKit just attaches when ready.
        let startingSessionId = sessionId
        await requestAuthorization()
        // The prompt may outlive the session — the user can end/discard and
        // even start a new one while it's up. Don't attach to a dead run.
        guard isRecording, sessionId == startingSessionId else { return }

        await beginHealthKitSession(startingAt: sessionStartDate!)
    }

    /// Start the HKWorkoutSession that powers the GPS chip and HR sensor — and,
    /// just as importantly, is what keeps the app running in the background
    /// (the `workout-processing` entitlement only applies while a session is
    /// live). Shared with the snapshot-only recovery path.
    private func beginHealthKitSession(startingAt date: Date) async {
        let config = HKWorkoutConfiguration()
        config.activityType = .paddleSports
        config.locationType = .outdoor

        do {
            let session = try HKWorkoutSession(healthStore: healthStore, configuration: config)
            let bldr = session.associatedWorkoutBuilder()
            bldr.dataSource = HKLiveWorkoutDataSource(healthStore: healthStore,
                                                       workoutConfiguration: config)
            bldr.delegate = self
            session.delegate = self
            workoutSession = session
            builder = bldr

            session.startActivity(with: date)
            try await bldr.beginCollection(at: date)
            // The user may have paused while the auth prompt was up.
            if isPaused { session.pause() }
        } catch {
            print("[WorkoutManager] HKWorkoutSession start failed: \(error)")
        }
    }

    /// Suspend the workout: freezes the HK session (rings/calories), GPS,
    /// stroke detection, and the duration clock. distance/pace/splits all
    /// exclude paused time because track timestamps use active time.
    func pause() {
        guard isRecording, !isPaused else { return }
        isPaused = true
        pauseStartedAt = Date()
        WKInterfaceDevice.current().play(.directionDown)
        workoutSession?.pause()
        locationManager.stopUpdatingLocation()
        motionManager.stopAccelerometerUpdates()
        persistSnapshot(force: true)
    }

    func resume() {
        guard isRecording, isPaused else { return }
        if let pauseStartedAt {
            pausedAccumSec += Date().timeIntervalSince(pauseStartedAt)
        }
        pauseStartedAt = nil
        isPaused = false
        WKInterfaceDevice.current().play(.directionUp)
        workoutSession?.resume()
        locationManager.startUpdatingLocation()
        startAccelerometer()
        persistSnapshot(force: true)
    }

    /// Accelerometer sampling runs at 50 Hz for the whole paddle. Delivering
    /// that to `.main` put fifty DSP callbacks a second on the main thread and
    /// left almost no headroom — once anything else on the main actor took real
    /// time, watchOS's watchdog killed the app mid-session. It runs on its own
    /// serial queue now and only hops to the main actor when a stroke actually
    /// lands (about once a second).
    private func startAccelerometer() {
        guard motionManager.isAccelerometerAvailable else { return }
        motionManager.accelerometerUpdateInterval = 1.0 / 50.0
        // Timebase captured by value so the handler never touches main-actor
        // state just to know how far into the session it is. Re-captured on
        // every resume, which is the only time pausedAccumSec changes while
        // sampling is stopped.
        let epoch = sessionStartEpoch + pausedAccumSec
        let detector = strokeDetector
        motionManager.startAccelerometerUpdates(to: motionQueue) { [weak self] data, _ in
            guard let self, let data else { return }
            let a = data.acceleration
            let t = Date().timeIntervalSince1970 - epoch
            // Serial queue, so the detector's filter state is only ever touched
            // from one thread.
            guard let stroke = detector.onSample(tSec: t, ax: a.x, ay: a.y, az: a.z) else { return }
            Task { @MainActor in
                // A sample can still be in flight when the session ends; don't
                // let it land on the next one's counters.
                guard self.isRecording, !self.isPaused else { return }
                self.strokeCount += 1
                self.strokeRate = stroke.rateSpm
                self.currentStrokeRate = stroke.rateSpm
            }
        }
    }

    func stopAndSave() async {
        guard isRecording, let startDate = sessionStartDate else { return }
        // Close out any in-progress pause so post-stop math is consistent.
        if let pauseStartedAt {
            pausedAccumSec += Date().timeIntervalSince(pauseStartedAt)
            self.pauseStartedAt = nil
        }
        isPaused = false
        isRecording = false
        durationTimer?.invalidate()
        durationTimer = nil
        locationManager.stopUpdatingLocation()
        motionManager.stopAccelerometerUpdates()
        // The run is over — nothing left to recover.
        clearSnapshot()

        let endDate = Date()

        // Fetch weather at end (overrides start weather; more accurate)
        var weather: WatchWeatherSummary? = nil
        if let loc = locationManager.location {
            weather = await WeatherService.fetch(lat: loc.coordinate.latitude,
                                                  lon: loc.coordinate.longitude)
        }

        // Compute aggregates
        let totals = Aggregator.totals(track, strokeCount: strokeCount)
        let hr = Aggregator.hrSummary(track)
        let splits = Aggregator.splits(track)
        let trackSummary = Aggregator.downsample(track, maxPoints: 200)

        let session = WatchSession(
            id: sessionId,
            userId: "",   // filled by phone after receiving (phone knows the uid)
            schemaVersion: 1,
            source: "ios-watch",
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0",
            craftType: currentCraft,
            startedAt: ISO8601DateFormatter().string(from: startDate),
            endedAt: ISO8601DateFormatter().string(from: endDate),
            totals: totals,
            hr: hr,
            splits: splits,
            sideSwitches: [],
            weather: weather,
            trackSummary: trackSummary,
            isPublic: false
        )

        // Finish HKWorkoutSession (writes to Health app)
        if let ws = workoutSession, let bldr = builder {
            ws.end()
            try? await bldr.endCollection(at: endDate)
            try? await bldr.finishWorkout()
        }
        workoutSession = nil
        builder = nil

        // Persist + transfer to phone
        await TransferManager.shared.transferSession(session, fullTrack: track)
    }

    func discard() {
        isRecording = false
        isPaused = false
        pauseStartedAt = nil
        pausedAccumSec = 0
        durationTimer?.invalidate()
        durationTimer = nil
        locationManager.stopUpdatingLocation()
        motionManager.stopAccelerometerUpdates()
        workoutSession?.end()
        workoutSession = nil
        builder = nil
        track = []
        clearSnapshot()
    }

    // ── Crash / relaunch recovery ─────────────────────────────────────────────
    //
    // watchOS can suspend and TERMINATE this app mid-paddle (an arriving
    // message, the wrist dropping, memory pressure). HealthKit keeps the
    // HKWorkoutSession alive across that, but WorkoutManager is rebuilt from
    // scratch, so isRecording came back false: the relaunched app landed on the
    // craft picker with a live workout stranded in HealthKit. That also blocked
    // starting a new one — HealthKit refuses a second session — which is what
    // made the watch app appear to lock up. Re-attach instead of orphaning it.

    private struct RecoverySnapshot: Codable, Sendable {
        var sessionId: String
        var startEpoch: Double
        var craft: String
        var pausedAccumSec: Double
        var pauseStartedAtEpoch: Double?
        var strokeCount: Int
        var distanceM: Double
        var track: [WatchTrackPoint]
        /// When this snapshot was written. Optional so a snapshot from a build
        /// that predates the field still decodes — it just reads as unknown,
        /// which is treated as too old to resume.
        var savedAt: Double?
    }

    /// How recently the snapshot must have been written for recovery to pick the
    /// paddle back up rather than close it out. Long enough for someone to
    /// notice the watch died and reopen the app; short enough that a paddle
    /// finished an hour ago never springs back to life.
    private static let resumeWindowSec: Double = 15 * 60

    private static let snapshotURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory,
                                           in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("active-session.json")
    }()

    /// Mirror live state to disk so a relaunch restores the TRACK too, not just
    /// the session. Throttled: points arrive at 1 Hz and rewriting the whole
    /// track every second is pointless I/O on a watch.
    private func persistSnapshot(force: Bool = false) {
        guard isRecording else { return }
        let now = Date().timeIntervalSince1970
        guard force || now - lastSnapshotAt >= 10 else { return }
        lastSnapshotAt = now
        let snap = RecoverySnapshot(
            sessionId: sessionId,
            startEpoch: sessionStartEpoch,
            craft: currentCraft,
            pausedAccumSec: pausedAccumSec,
            pauseStartedAtEpoch: pauseStartedAt?.timeIntervalSince1970,
            strokeCount: strokeCount,
            distanceM: distanceM,
            track: track,
            savedAt: now
        )
        // Encoding the whole track and writing it out is O(track), and the
        // track grows for the entire paddle. Doing that on the main actor cost
        // a little more every ten seconds until, well into a session, the stall
        // was long enough for watchOS to kill the app — which is why it died at
        // a fairly consistent DISTANCE rather than at random. Hand it to a
        // background queue; a snapshot landing a few milliseconds late costs
        // nothing, and the main actor now only pays for the struct init.
        let url = Self.snapshotURL
        Self.snapshotQueue.async {
            guard let data = try? JSONEncoder().encode(snap) else { return }
            try? data.write(to: url, options: .atomic)
        }
    }

    private func clearSnapshot() {
        lastSnapshotAt = 0
        // Same queue as the writes, so a snapshot still in flight can't land
        // after the delete and resurrect a session that has already ended.
        let url = Self.snapshotURL
        Self.snapshotQueue.async {
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func loadSnapshot() -> RecoverySnapshot? {
        guard let data = try? Data(contentsOf: Self.snapshotURL) else { return nil }
        return try? JSONDecoder().decode(RecoverySnapshot.self, from: data)
    }

    /// Call at launch. Re-attaches to a workout that outlived the app so the
    /// UI returns to the live screen and tracking simply carries on.
    func recoverIfNeeded() async {
        guard !isRecording else { return }
        let snap = loadSnapshot()

        if let session = await activeSession() {
            if session.state == .running || session.state == .paused {
                attach(to: session, snapshot: snap)
                return
            }
            // Recovered a session that has already stopped: close it out so it
            // can't block the next start, then deal with the snapshot below —
            // the paddle's own data is in there either way.
            session.end()
        }

        // Nothing live in HealthKit. That does NOT mean there was no paddle:
        // the app can die before the HealthKit session ever starts (the
        // one-time authorization prompt is still up), or HealthKit can end the
        // session without us. The snapshot is the only record of those runs.
        guard let snap else {
            // Nothing to restore, or the file was unreadable — don't leave a
            // corrupt one lying around to be retried forever.
            clearSnapshot()
            return
        }
        let age = Date().timeIntervalSince1970 - (snap.savedAt ?? 0)
        if age <= Self.resumeWindowSec {
            await resumeWithoutHealthKit(snap)
        } else {
            await salvage(snap)
        }
    }

    /// Pick a paddle back up with no HealthKit session behind it.
    ///
    /// A fresh HKWorkoutSession is started for the REMAINDER of the paddle —
    /// not to recreate the lost one, but because it is what keeps the app alive
    /// in the background and powers the HR sensor. The consequence is that the
    /// workout written to Health (and the ring credit) covers only the part
    /// after recovery, while the session that reaches the phone — track,
    /// distance, strokes, splits — is complete.
    private func resumeWithoutHealthKit(_ snap: RecoverySnapshot) async {
        restore(from: snap)
        isRecording = true
        durationSec = activeElapsedSec
        startDurationTimer()
        if !isPaused {
            locationManager.startUpdatingLocation()
            startAccelerometer()
        }
        persistSnapshot(force: true)

        let resumedId = sessionId
        await requestAuthorization()
        // The prompt can outlive the paddle — don't attach to a dead run.
        guard isRecording, sessionId == resumedId else { return }
        await beginHealthKitSession(startingAt: Date())
    }

    /// Too old to resume, but a real paddle happened. Assemble it from the
    /// snapshot and send it to the phone rather than deleting it — losing the
    /// session outright is the worse outcome, and reusing the original id means
    /// a copy that somehow already made it across is replaced, not duplicated.
    private func salvage(_ snap: RecoverySnapshot) async {
        clearSnapshot()
        // Don't resurrect an accidental start that ran for seconds; it would
        // just litter the user's history.
        guard snap.track.count >= 2,
              snap.distanceM >= 100,
              let last = snap.track.last, last.t >= 120 else { return }

        let startDate = Date(timeIntervalSince1970: snap.startEpoch)
        // Derived from the last fix rather than from savedAt, so the end time is
        // when the paddle actually stopped producing data. Track timestamps are
        // ACTIVE seconds, so paused time has to be added back to get wall clock.
        let endDate = Date(timeIntervalSince1970: snap.startEpoch + last.t + snap.pausedAccumSec)

        let session = WatchSession(
            id: snap.sessionId,
            userId: "",
            schemaVersion: 1,
            source: "ios-watch",
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0",
            craftType: snap.craft,
            startedAt: ISO8601DateFormatter().string(from: startDate),
            endedAt: ISO8601DateFormatter().string(from: endDate),
            totals: Aggregator.totals(snap.track, strokeCount: snap.strokeCount),
            hr: Aggregator.hrSummary(snap.track),
            splits: Aggregator.splits(snap.track),
            sideSwitches: [],
            weather: nil,   // the moment has passed; weather is optional anyway
            trackSummary: Aggregator.downsample(snap.track, maxPoints: 200),
            isPublic: false
        )
        await TransferManager.shared.transferSession(session, fullTrack: snap.track)
    }

    private func activeSession() async -> HKWorkoutSession? {
        await withCheckedContinuation { cont in
            healthStore.recoverActiveWorkoutSession { session, _ in
                cont.resume(returning: session)
            }
        }
    }

    private func attach(to session: HKWorkoutSession, snapshot snap: RecoverySnapshot?) {
        let bldr = session.associatedWorkoutBuilder()
        bldr.dataSource = HKLiveWorkoutDataSource(healthStore: healthStore,
                                                   workoutConfiguration: session.workoutConfiguration)
        bldr.delegate = self
        session.delegate = self
        workoutSession = session
        builder = bldr
        // Collection began before the app died; calling beginCollection again
        // would throw, so it is deliberately not repeated here.

        // HealthKit's own start date is authoritative when we have it — it
        // survived the crash, the snapshot may be a few seconds behind.
        restore(from: snap, start: session.startDate, paused: session.state == .paused)

        isRecording = true
        durationSec = activeElapsedSec
        startDurationTimer()
        if !isPaused {
            locationManager.startUpdatingLocation()
            startAccelerometer()
        }
        persistSnapshot(force: true)
    }

    /// Rebuild live state from a snapshot. Shared by both recovery paths: with
    /// a HealthKit session behind it (`attach`) and without one
    /// (`resumeWithoutHealthKit`).
    private func restore(from snap: RecoverySnapshot?,
                         start hkStart: Date? = nil,
                         paused hkPaused: Bool? = nil) {
        let start = hkStart
            ?? Date(timeIntervalSince1970: snap?.startEpoch ?? Date().timeIntervalSince1970)
        sessionId = snap?.sessionId ?? generateId()
        sessionStartDate = start
        sessionStartEpoch = start.timeIntervalSince1970
        pausedAccumSec = snap?.pausedAccumSec ?? 0
        track = snap?.track ?? []
        coordinates = track.map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
        strokeCount = snap?.strokeCount ?? 0
        distanceM = snap?.distanceM ?? 0
        if let craft = snap?.craft { currentCraft = craft }
        // The detector's filter state can't be recovered; the COUNT is restored
        // above, so cadence simply re-converges over the next few strokes.
        strokeDetector.reset()

        // Reconcile a pause that was in progress when the app died. HealthKit
        // knows whether the session is paused; without one, only the snapshot
        // does.
        isPaused = hkPaused ?? (snap?.pauseStartedAtEpoch != nil)
        if let startedAt = snap?.pauseStartedAtEpoch {
            if isPaused {
                pauseStartedAt = Date(timeIntervalSince1970: startedAt)
            } else {
                // HealthKit says running but the snapshot caught a pause: the
                // user resumed during the gap, so bank that paused stretch.
                pausedAccumSec += Date().timeIntervalSince1970 - startedAt
                pauseStartedAt = nil
            }
        } else {
            pauseStartedAt = isPaused ? Date() : nil
        }
    }

    private func startDurationTimer() {
        durationTimer?.invalidate()
        durationTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, !self.isPaused else { return }
            self.durationSec = self.activeElapsedSec
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private func generateId() -> String {
        let chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        return String((0..<21).map { _ in chars.randomElement()! })
    }
}

// ── CLLocationManagerDelegate ─────────────────────────────────────────────────

extension WorkoutManager: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager,
                                     didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        // Reject the junk fixes CoreLocation emits while reacquiring in a
        // marginal or dead-GPS area: invalid accuracy (<0), wildly imprecise
        // fixes, and stale cached points. Feeding these in corrupts distance
        // and makes the live map jump around every second — the likely cause
        // of the watch appearing to hang when signal drops. Dropping them is
        // how tracking survives a dead zone: the duration clock keeps ticking
        // and the track simply resumes when a good fix returns.
        guard loc.horizontalAccuracy >= 0, loc.horizontalAccuracy <= 100 else { return }
        guard -loc.timestamp.timeIntervalSinceNow < 5 else { return }
        Task { @MainActor in
            // Ignore fixes that land while paused (updates are stopped on
            // pause, but one can already be in flight).
            guard self.isRecording, !self.isPaused else { return }
            let t = self.activeElapsedSec
            let pt = WatchTrackPoint(
                t: t,
                lat: loc.coordinate.latitude,
                lon: loc.coordinate.longitude,
                altM: loc.altitude,
                speedMps: max(0, loc.speed),
                hr: self.lastHrValue > 0 ? self.lastHrValue : nil,
                strokeRate: self.currentStrokeRate > 0 ? self.currentStrokeRate : nil
            )
            self.track.append(pt)
            self.coordinates.append(loc.coordinate)

            // Update live distance
            if self.track.count >= 2 {
                let prev = self.track[self.track.count - 2]
                let d = self.haversine(lat1: prev.lat, lon1: prev.lon,
                                       lat2: pt.lat, lon2: pt.lon)
                self.distanceM += d
            }
            // Mirror to disk (throttled) so a relaunch keeps the track.
            self.persistSnapshot()
        }
    }

    /// CoreLocation calls this repeatedly while it can't get a fix (a dead
    /// zone). kCLErrorLocationUnknown is transient — Apple's guidance is to
    /// ignore it and keep going, and a later fix will arrive, so the session
    /// must NOT stop or tear down location updates here. Only a hard denial is
    /// terminal, and that path is handled by the authorization flow. Without
    /// this handler the delegate's default behavior on repeated failures was
    /// one suspect for the watch locking up in no-signal areas.
    nonisolated func locationManager(_ manager: CLLocationManager,
                                     didFailWithError error: Error) {
        // Intentionally a no-op for transient errors — keep recording.
        if let clError = error as? CLError, clError.code == .denied {
            print("[WorkoutManager] Location denied: \(error)")
        }
    }

    private func haversine(lat1: Double, lon1: Double, lat2: Double, lon2: Double) -> Double {
        let R = 6371000.0
        let φ1 = lat1 * .pi/180, φ2 = lat2 * .pi/180
        let Δφ = (lat2-lat1) * .pi/180, Δλ = (lon2-lon1) * .pi/180
        let a = sin(Δφ/2)*sin(Δφ/2) + cos(φ1)*cos(φ2)*sin(Δλ/2)*sin(Δλ/2)
        return R * 2 * atan2(a.squareRoot(), (1-a).squareRoot())
    }
}

// ── HKWorkoutSessionDelegate ──────────────────────────────────────────────────

extension WorkoutManager: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession,
                                    didChangeTo toState: HKWorkoutSessionState,
                                    from fromState: HKWorkoutSessionState, date: Date) {}
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession,
                                    didFailWithError error: Error) {
        print("[WorkoutManager] HKWorkoutSession error: \(error)")
    }
}

// ── HKLiveWorkoutBuilderDelegate ──────────────────────────────────────────────

extension WorkoutManager: HKLiveWorkoutBuilderDelegate {
    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    nonisolated func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder,
                                    didCollectDataOf collectedTypes: Set<HKSampleType>) {
        for type in collectedTypes {
            guard let quantityType = type as? HKQuantityType else { continue }
            if quantityType == HKQuantityType(.heartRate) {
                let stat = workoutBuilder.statistics(for: quantityType)
                let hr = stat?.mostRecentQuantity()?.doubleValue(for: .init(from: "count/min")) ?? 0
                Task { @MainActor in
                    self.heartRate = Int(hr)
                    self.lastHrValue = Int(hr)
                }
            }
        }
    }
}
