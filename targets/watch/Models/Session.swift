import Foundation

// ── Session model — mirrors src/models/index.ts exactly ──────────────────────
// Field names and JSON keys must stay in sync with the TypeScript schema so
// that the phone app can deserialise files transferred from the watch.

struct WatchSession: Codable {
    let id: String
    let userId: String
    let schemaVersion: Int
    let source: String          // "ios-watch"
    let appVersion: String
    let craftType: String
    let startedAt: String       // ISO-8601
    let endedAt: String
    var totals: WatchTotals
    var hr: WatchHrSummary
    var splits: [WatchSplit]
    let sideSwitches: [WatchSideSwitch]
    var weather: WatchWeatherSummary?
    var trackSummary: [WatchTrackPoint]
    var isPublic: Bool?
}

struct WatchTotals: Codable {
    var distanceMeters: Double
    var durationSec: Double
    var movingDurationSec: Double
    var avgPaceSecPerKm: Double
    var avgSpeedMps: Double
    var maxSpeedMps: Double
    var strokeCount: Int
    var avgStrokeRate: Double
    var calories: Double
    var elevationGainM: Double
}

struct WatchHrSummary: Codable {
    var avg: Int
    var max: Int
    var zones: [WatchHrZone]
}

struct WatchHrZone: Codable {
    let zone: Int
    let minBpm: Int
    let maxBpm: Int
    var timeSec: Double
}

struct WatchSplit: Codable {
    let index: Int
    let distanceM: Double
    let durationSec: Double
    var avgHr: Double
    var avgStrokeRate: Double
    var avgSpeedMps: Double
}

struct WatchSideSwitch: Codable {
    let tSec: Double
    let detectedSide: String
    let confidence: Double
    let source: String
}

struct WatchTrackPoint: Codable, Sendable {
    let t: Double
    let lat: Double
    let lon: Double
    let altM: Double
    let speedMps: Double
    var hr: Int?
    var strokeRate: Double?
    var cadenceConfidence: Double?
}

struct WatchWeatherSummary: Codable {
    let start: WatchWeatherSample
    let samples: [WatchWeatherSample]
}

struct WatchWeatherSample: Codable {
    let tSec: Double
    let windMps: Double
    let windDeg: Double
    let gustMps: Double
    let airTempC: Double
    let pressureHpa: Double
    let conditions: String?
}

// ── Helpers ───────────────────────────────────────────────────────────────────

extension WatchTotals {
    static func empty() -> WatchTotals {
        WatchTotals(distanceMeters: 0, durationSec: 0, movingDurationSec: 0,
                    avgPaceSecPerKm: 0, avgSpeedMps: 0, maxSpeedMps: 0,
                    strokeCount: 0, avgStrokeRate: 0, calories: 0, elevationGainM: 0)
    }
}

extension WatchHrSummary {
    static func empty() -> WatchHrSummary {
        let bounds = [(0,120),(120,140),(140,160),(160,175),(175,220)]
        let zones = bounds.enumerated().map { i, b in
            WatchHrZone(zone: i, minBpm: b.0, maxBpm: b.1, timeSec: 0)
        }
        return WatchHrSummary(avg: 0, max: 0, zones: zones)
    }
}
