import * as crypto from "crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { setGlobalOptions } from "firebase-functions/v2";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentDeleted } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";

initializeApp();

// ---------------------------------------------------------------------------
// Spend ceilings.
//
// Without this, every function inherits the project default of 1000 concurrent
// instances. On the Blaze plan that is unbounded pay-as-you-go: one runaway
// trigger, one scraper, or one unexpectedly popular day scales straight into a
// bill with nothing standing in the way. maxInstances is the only hard ceiling
// available, so it is set globally and tightened per-function below.
//
// The tradeoff is explicit: past 10 concurrent instances requests queue and
// eventually fail rather than autoscaling. That is the intended behaviour —
// degrade under load instead of billing without limit. Raise this after
// watching real traffic, not preemptively.
//
// NOTE: region is deliberately NOT set here. These functions are already
// deployed, and changing a function's region deletes and recreates it, which
// breaks live clients mid-flight. Pin it only during a planned migration.
// ---------------------------------------------------------------------------
setGlobalOptions({
  maxInstances: 10,
  memory: "256MiB",
  timeoutSeconds: 60,
});

// ---------------------------------------------------------------------------
// Push-notification fan-out helpers.
//
// Recipients are processed in chunks because a Firestore WriteBatch caps at 500
// operations and each recipient costs two (unread total + per-thread count).
// ---------------------------------------------------------------------------
const FANOUT_CHUNK = 250;

/**
 * Expo push tokens denormalized onto the user document.
 *
 * Returns null when the field is absent, which means "unknown, look in the
 * legacy users/{uid}/fcmTokens subcollection" — distinct from an empty array,
 * which means "known, and this user has no sendable tokens". Keeping those two
 * cases apart is what lets the subcollection read be skipped for everyone who
 * has already migrated.
 */
function expoTokensFrom(userData: FirebaseFirestore.DocumentData | undefined): string[] | null {
  const raw = userData?.expoTokens;
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (t): t is string => typeof t === "string" && t.startsWith("ExponentPushToken"),
  );
}

/**
 * Read sendable push tokens from the legacy subcollection.
 *
 * Only Expo tokens are sendable. Legacy docs also hold raw APNs hex tokens
 * (from getDevicePushTokenAsync) which FCM silently rejected — the reason
 * pushes never arrived; those are filtered out here.
 */
async function legacyExpoTokens(
  db: FirebaseFirestore.Firestore,
  userId: string,
): Promise<string[]> {
  const snap = await db.collection(`users/${userId}/fcmTokens`).get();
  return snap.docs
    .map((d) => (d.data() as { token?: string }).token)
    .filter((t): t is string => typeof t === "string" && t.startsWith("ExponentPushToken"));
}

// ---------------------------------------------------------------------------
// renderSessionCard — produces a PNG share card (map snapshot + stats overlay)
// for a finished session and stores it at users/{uid}/cards/{sessionId}.png.
// Stub implementation; concrete rendering uses @napi-rs/canvas + a static
// map tile provider, wired up in Phase 4.
// ---------------------------------------------------------------------------
export const renderSessionCard = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { sessionId } = request.data ?? {};
  if (typeof sessionId !== "string" || !sessionId) {
    throw new HttpsError("invalid-argument", "sessionId is required");
  }

  const snap = await getFirestore()
    .doc(`users/${uid}/sessions/${sessionId}`)
    .get();
  if (!snap.exists) throw new HttpsError("not-found", "Session not found");

  // TODO(phase-4): render PNG, upload to Storage, return signed URL.
  const path = `users/${uid}/cards/${sessionId}.png`;
  await getStorage().bucket().file(path).save(Buffer.from([]), {
    contentType: "image/png",
  });

  return { path, status: "stub" };
});

// ---------------------------------------------------------------------------
// uploadChannelMedia — receives a base64 image/video from a club member and
// writes it to Storage with the Admin SDK. This sidesteps the React Native
// Storage-upload minefield entirely: the JS SDK can't build its multipart body
// (RN can't make a Blob from an ArrayBuffer), and the raw REST endpoint kept
// hitting auth/rules/bucket 403s. Admin writes bypass Storage rules and target
// the real default bucket, so uploads just work. Membership is enforced here.
// ---------------------------------------------------------------------------
export const uploadChannelMedia = onCall({ memory: "512MiB" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { clubId, channelId, messageId, base64, contentType, fileKey } = request.data ?? {};
  if (
    typeof clubId !== "string" ||
    typeof channelId !== "string" ||
    typeof messageId !== "string" ||
    typeof base64 !== "string" ||
    typeof contentType !== "string"
  ) {
    throw new HttpsError("invalid-argument", "Missing upload fields");
  }
  if (!/^(image|video)\//.test(contentType)) {
    throw new HttpsError("invalid-argument", "Only image or video uploads are allowed");
  }
  // "media" = single attachment (legacy mediaUrl field); "media-N" = one image
  // of a multi-image message, appended to mediaUrls[] in send order.
  const key: string = typeof fileKey === "string" ? fileKey : "media";
  if (!/^media(-\d{1,2})?$/.test(key)) {
    throw new HttpsError("invalid-argument", "Bad fileKey");
  }

  // Must be a member of the club to post media.
  const memberSnap = await getFirestore().doc(`clubs/${clubId}/members/${uid}`).get();
  if (!memberSnap.exists) throw new HttpsError("permission-denied", "Not a club member");

  const buffer = Buffer.from(base64, "base64");
  // Callable request payloads are capped (~10 MB); base64 inflates ~33%, so
  // hold the decoded file to 7 MB. Covers phone photos; large videos need the
  // signed-URL path (follow-up).
  if (buffer.length > 7 * 1024 * 1024) {
    throw new HttpsError("invalid-argument", "File too large (max ~7 MB for now)");
  }

  const ext = contentType.split("/")[1] || "bin";
  const path = `clubs/${clubId}/channels/${channelId}/messages/${messageId}/${key}.${ext}`;
  const token = crypto.randomUUID();
  const bucket = getStorage().bucket();

  await bucket.file(path).save(buffer, {
    contentType,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });

  const mediaUrl =
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(path)}?alt=media&token=${token}`;

  const msgRef = getFirestore()
    .doc(`clubs/${clubId}/channels/${channelId}/messages/${messageId}`);
  if (key === "media") {
    await msgRef.update({ mediaUrl, mediaStoragePath: `gs://${bucket.name}/${path}` });
  } else {
    await msgRef.update({ mediaUrls: FieldValue.arrayUnion(mediaUrl) });
  }

  return { mediaUrl };
});

// ---------------------------------------------------------------------------
// createChannelUploadUrl + finalizeChannelMedia — the large-file (video) path.
//
// uploadChannelMedia carries the file inside the callable payload, which caps
// at ~7 MB after base64 — fine for photos, but real videos never fit, so the
// picker offered video that always failed. This pair lets the app upload
// straight to Storage with no size ceiling:
//   1. createChannelUploadUrl checks membership and returns a short-lived
//      signed PUT URL for the object path.
//   2. the client streams the file directly to that URL (expo-file-system
//      uploadAsync — no base64, no memory blowup).
//   3. finalizeChannelMedia confirms the object landed, stamps it with a
//      download token + content type, and records the URL on the message.
//
// Deploy note: createChannelUploadUrl calls getSignedUrl, which needs the
// functions runtime service account to hold "Service Account Token Creator"
// (roles/iam.serviceAccountTokenCreator) so it can sign. If uploads fail with
// an iam.serviceAccounts.signBlob error, grant that role to the functions SA.
// ---------------------------------------------------------------------------

function channelMediaPath(
  clubId: string,
  channelId: string,
  messageId: string,
  key: string,
  contentType: string,
): string {
  const ext = contentType.split("/")[1] || "bin";
  return `clubs/${clubId}/channels/${channelId}/messages/${messageId}/${key}.${ext}`;
}

export const createChannelUploadUrl = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { clubId, channelId, messageId, contentType, fileKey } = request.data ?? {};
  if (
    typeof clubId !== "string" ||
    typeof channelId !== "string" ||
    typeof messageId !== "string" ||
    typeof contentType !== "string"
  ) {
    throw new HttpsError("invalid-argument", "Missing upload fields");
  }
  if (!/^(image|video)\//.test(contentType)) {
    throw new HttpsError("invalid-argument", "Only image or video uploads are allowed");
  }
  const key: string = typeof fileKey === "string" ? fileKey : "media";
  if (!/^media(-\d{1,2})?$/.test(key)) {
    throw new HttpsError("invalid-argument", "Bad fileKey");
  }

  const memberSnap = await getFirestore().doc(`clubs/${clubId}/members/${uid}`).get();
  if (!memberSnap.exists) throw new HttpsError("permission-denied", "Not a club member");

  const path = channelMediaPath(clubId, channelId, messageId, key, contentType);
  const [uploadUrl] = await getStorage()
    .bucket()
    .file(path)
    .getSignedUrl({ version: "v4", action: "write", expires: Date.now() + 15 * 60 * 1000 });

  return { uploadUrl };
});

export const finalizeChannelMedia = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { clubId, channelId, messageId, contentType, fileKey } = request.data ?? {};
  if (
    typeof clubId !== "string" ||
    typeof channelId !== "string" ||
    typeof messageId !== "string" ||
    typeof contentType !== "string"
  ) {
    throw new HttpsError("invalid-argument", "Missing fields");
  }
  const key: string = typeof fileKey === "string" ? fileKey : "media";
  if (!/^media(-\d{1,2})?$/.test(key)) {
    throw new HttpsError("invalid-argument", "Bad fileKey");
  }

  const memberSnap = await getFirestore().doc(`clubs/${clubId}/members/${uid}`).get();
  if (!memberSnap.exists) throw new HttpsError("permission-denied", "Not a club member");

  const path = channelMediaPath(clubId, channelId, messageId, key, contentType);
  const bucket = getStorage().bucket();
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError("failed-precondition", "Upload not found — try again");

  // Stamp the object so it renders inline and gets a stable download token URL,
  // the same scheme uploadChannelMedia uses for the small-file path.
  const token = crypto.randomUUID();
  await file.setMetadata({ contentType, metadata: { firebaseStorageDownloadTokens: token } });

  const mediaUrl =
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(path)}?alt=media&token=${token}`;

  const msgRef = getFirestore().doc(
    `clubs/${clubId}/channels/${channelId}/messages/${messageId}`,
  );
  if (key === "media") {
    await msgRef.update({ mediaUrl, mediaStoragePath: `gs://${bucket.name}/${path}` });
  } else {
    await msgRef.update({ mediaUrls: FieldValue.arrayUnion(mediaUrl) });
  }

  return { mediaUrl };
});

// ---------------------------------------------------------------------------
// startClubTrial — opt-in, one-time 7-day free trial for a club.
//
// Clubs no longer get an automatic trial; an owner/admin starts it explicitly.
// Billing fields are server-only (clients can't write subscriptionStatus per
// the Firestore rules), so this runs with the Admin SDK. trialStartedAt is the
// durable guard that a club only ever gets one trial.
// ---------------------------------------------------------------------------
const CLUB_TRIAL_DAYS = 7;

export const startClubTrial = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { clubId } = request.data ?? {};
  if (typeof clubId !== "string" || !clubId) {
    throw new HttpsError("invalid-argument", "clubId is required");
  }

  const db = getFirestore();
  const memberSnap = await db.doc(`clubs/${clubId}/members/${uid}`).get();
  const role = memberSnap.exists ? (memberSnap.data()?.role as string | undefined) : undefined;
  if (role !== "owner" && role !== "admin") {
    throw new HttpsError("permission-denied", "Only a club owner or admin can start the trial");
  }

  const clubRef = db.doc(`clubs/${clubId}`);
  const clubSnap = await clubRef.get();
  if (!clubSnap.exists) throw new HttpsError("not-found", "Club not found");
  const club = clubSnap.data() as
    | { subscriptionStatus?: string; trialStartedAt?: string }
    | undefined;

  if (club?.trialStartedAt) {
    throw new HttpsError("failed-precondition", "This club has already used its free trial");
  }
  if (club?.subscriptionStatus === "active") {
    throw new HttpsError("failed-precondition", "This club already has an active subscription");
  }
  if (club?.subscriptionStatus !== "free") {
    throw new HttpsError("failed-precondition", "A trial can only start from the free plan");
  }

  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + CLUB_TRIAL_DAYS * 86400000).toISOString();
  await clubRef.update({
    subscriptionStatus: "trial",
    trialEndsAt,
    trialStartedAt: now.toISOString(),
  });

  return { status: "trial", trialEndsAt };
});

// ---------------------------------------------------------------------------
// clubCalendar — public, read-only feed of a club's events, so an external
// website (or a personal calendar app) can show the schedule and auto-update.
//
//   GET /clubCalendar?club={id-or-slug}              → iCalendar (.ics) feed
//   GET /clubCalendar?club={id-or-slug}&format=json  → JSON array of events
//
// `club` accepts either the club's document ID (the value in an invite link,
// imuatrak.app/join/{id}) or its slug — the ID is what a club owner can
// actually see, so it's tried first.
//
// Runs with the Admin SDK, so it reads events past the member-only Firestore
// rule — the feed is intentionally public (link-accessible by design). No auth.
// CORS is open so a browser page can fetch the JSON.
// ---------------------------------------------------------------------------
interface CalendarEvent {
  title?: string;
  type?: string;
  startAt?: string;
  endAt?: string;
  location?: { name?: string };
  meetTime?: string;
  description?: string;
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
// 2026-08-20T19:30:00.000Z -> 20260820T193000Z
function toIcsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export const clubCalendar = onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET");
    res.status(204).send("");
    return;
  }

  const clubParam = String(req.query.club ?? "").trim();
  const format = String(req.query.format ?? "ics").toLowerCase();
  if (!clubParam) {
    res.status(400).send("Missing ?club=<id-or-slug>");
    return;
  }

  const db = getFirestore();
  // Try the document ID first (what an owner sees in an invite link), then fall
  // back to a slug lookup.
  let clubDoc = (await db.collection("clubs").doc(clubParam).get()) as
    | FirebaseFirestore.DocumentSnapshot
    | undefined;
  if (!clubDoc?.exists) {
    const bySlug = await db
      .collection("clubs")
      .where("slug", "==", clubParam.toLowerCase())
      .limit(1)
      .get();
    clubDoc = bySlug.empty ? undefined : bySlug.docs[0];
  }
  if (!clubDoc?.exists) {
    res.status(404).send("Club not found");
    return;
  }
  const clubName = (clubDoc.data()?.name as string | undefined) ?? "Club";

  // From 60 days ago forward — enough history for a calendar view, bounded.
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const evSnap = await clubDoc.ref
    .collection("events")
    .where("startAt", ">=", since)
    .orderBy("startAt")
    .limit(500)
    .get();
  const events = evSnap.docs.map((d) => ({ id: d.id, ...(d.data() as CalendarEvent) }));

  res.set("Cache-Control", "public, max-age=300");

  if (format === "json") {
    res.set("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      club: clubName,
      events: events.map((e) => ({
        id: e.id,
        title: e.title ?? "Event",
        type: e.type ?? null,
        startAt: e.startAt ?? null,
        endAt: e.endAt ?? null,
        location: e.location?.name ?? null,
        meetTime: e.meetTime ?? null,
        description: e.description ?? null,
      })),
    });
    return;
  }

  const stamp = toIcsDate(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ImuaTrak//Club Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(clubName)} Schedule`,
  ];
  for (const e of events) {
    if (!e.startAt) continue;
    const end = e.endAt ?? new Date(new Date(e.startAt).getTime() + 90 * 60000).toISOString();
    const desc: string[] = [];
    if (e.meetTime) desc.push(`Meet: ${e.meetTime}`);
    if (e.description) desc.push(e.description);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@imuatrak.app`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toIcsDate(e.startAt)}`,
      `DTEND:${toIcsDate(end)}`,
      `SUMMARY:${icsEscape(`${e.title ?? "Event"}${e.type ? ` (${e.type})` : ""}`)}`,
    );
    if (e.location?.name) lines.push(`LOCATION:${icsEscape(e.location.name)}`);
    if (desc.length) lines.push(`DESCRIPTION:${icsEscape(desc.join(" — "))}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");

  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Content-Disposition", `inline; filename="${clubDoc.id}.ics"`);
  res.status(200).send(lines.join("\r\n"));
});

// ---------------------------------------------------------------------------
// uploadPostMedia — attach a photo to a club post (the gallery).
//
// Same shape as uploadChannelMedia: the client can't write to Storage directly
// because React Native has no Blob, and going through here also puts the
// club-membership check server-side.
// ---------------------------------------------------------------------------
export const uploadPostMedia = onCall({ memory: "512MiB" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { clubId, postId, base64, contentType, fileKey } = request.data ?? {};
  if (
    typeof clubId !== "string" ||
    typeof postId !== "string" ||
    typeof base64 !== "string" ||
    typeof contentType !== "string"
  ) {
    throw new HttpsError("invalid-argument", "Missing upload fields");
  }
  // Photos only — the callable payload cap makes video impractical here, and
  // the gallery has no player.
  if (!/^image\//.test(contentType)) {
    throw new HttpsError("invalid-argument", "Gallery posts must be images");
  }
  const key: string = typeof fileKey === "string" ? fileKey : "media";
  if (!/^media(-\d{1,2})?$/.test(key)) {
    throw new HttpsError("invalid-argument", "Bad fileKey");
  }

  const db = getFirestore();
  const memberSnap = await db.doc(`clubs/${clubId}/members/${uid}`).get();
  if (!memberSnap.exists) throw new HttpsError("permission-denied", "Not a club member");

  const postRef = db.doc(`clubs/${clubId}/posts/${postId}`);
  const postSnap = await postRef.get();
  if (!postSnap.exists) throw new HttpsError("not-found", "Post not found");
  // Only the author may attach to a post, so a member can't add photos to
  // someone else's — the create rule already ties authorId to the caller.
  if ((postSnap.data() as { authorId?: string } | undefined)?.authorId !== uid) {
    throw new HttpsError("permission-denied", "Not your post");
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > 7 * 1024 * 1024) {
    throw new HttpsError("invalid-argument", "Photo too large (max ~7 MB)");
  }

  const ext = contentType.split("/")[1] || "jpg";
  const path = `clubs/${clubId}/posts/${postId}/${key}.${ext}`;
  const token = crypto.randomUUID();
  const bucket = getStorage().bucket();

  await bucket.file(path).save(buffer, {
    contentType,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });

  const mediaUrl =
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(path)}?alt=media&token=${token}`;

  await postRef.update({ mediaUrls: FieldValue.arrayUnion(mediaUrl) });
  return { mediaUrl };
});

/** Delete every photo belonging to one post. */
async function purgePostMediaFiles(clubId: string, postId: string): Promise<void> {
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `clubs/${clubId}/posts/${postId}/` })
    .catch(() => undefined);
}

/**
 * Delete a club post and its photos together.
 *
 * Enforces the same permission as the Firestore delete rule — author, or club
 * owner/admin — by reading the doc while it still exists. Deleting the doc
 * client-side would orphan every attached photo in Storage, which is the leak
 * that had to be fixed for chat messages.
 */
export const deleteClubPost = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { clubId, postId } = request.data ?? {};
  if (typeof clubId !== "string" || typeof postId !== "string") {
    throw new HttpsError("invalid-argument", "Missing post reference");
  }

  const db = getFirestore();
  const postRef = db.doc(`clubs/${clubId}/posts/${postId}`);
  const [postSnap, memberSnap] = await Promise.all([
    postRef.get(),
    db.doc(`clubs/${clubId}/members/${uid}`).get(),
  ]);

  if (!memberSnap.exists) throw new HttpsError("permission-denied", "Not a club member");
  // Already gone — clear any media left behind so a retry after a partial
  // failure still tidies up, and report success.
  if (!postSnap.exists) {
    await purgePostMediaFiles(clubId, postId);
    return { success: true };
  }

  const role = (memberSnap.data() as { role?: string } | undefined)?.role;
  const isAuthor = (postSnap.data() as { authorId?: string } | undefined)?.authorId === uid;
  if (!isAuthor && role !== "owner" && role !== "admin") {
    throw new HttpsError("permission-denied", "Can't delete someone else's post");
  }

  await purgePostMediaFiles(clubId, postId);
  await postRef.delete();
  return { success: true };
});

// ---------------------------------------------------------------------------
// purgeMessageMedia — delete every attachment belonging to one message.
//
// Deleting the message doc alone orphans its media forever. The client used to
// delete the single object named by mediaStoragePath, which misses multi-image
// messages entirely: uploadChannelMedia only records a path for the "media"
// key, and each "media-N" image just appends to mediaUrls. Deleting the whole
// message prefix catches every attachment however it was uploaded.
//
// Called after the client deletes the doc, and reused by the retention sweep.
// ---------------------------------------------------------------------------
async function purgeMessageMediaFiles(
  clubId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `clubs/${clubId}/channels/${channelId}/messages/${messageId}/` })
    .catch(() => undefined);
}

/**
 * Delete a message and its attachments together.
 *
 * Enforces the same permission as the Firestore delete rule — author, or club
 * owner/admin — by reading the doc while it still exists. A media-only purge
 * couldn't do that: once the doc is gone there is no authorId left to check,
 * which would let any member strip the photos off anyone else's message.
 */
export const deleteChannelMessage = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { clubId, channelId, messageId } = request.data ?? {};
  if (
    typeof clubId !== "string" ||
    typeof channelId !== "string" ||
    typeof messageId !== "string"
  ) {
    throw new HttpsError("invalid-argument", "Missing message reference");
  }

  const db = getFirestore();
  const msgRef = db.doc(`clubs/${clubId}/channels/${channelId}/messages/${messageId}`);
  const [msgSnap, memberSnap] = await Promise.all([
    msgRef.get(),
    db.doc(`clubs/${clubId}/members/${uid}`).get(),
  ]);

  if (!memberSnap.exists) throw new HttpsError("permission-denied", "Not a club member");
  // Already gone — clear any media left behind and report success so a retry
  // after a partial failure doesn't surface as an error.
  if (!msgSnap.exists) {
    await purgeMessageMediaFiles(clubId, channelId, messageId);
    return { success: true };
  }

  const role = (memberSnap.data() as { role?: string } | undefined)?.role;
  const isAuthor = (msgSnap.data() as { authorId?: string } | undefined)?.authorId === uid;
  if (!isAuthor && role !== "owner" && role !== "admin") {
    throw new HttpsError("permission-denied", "Can't delete someone else's message");
  }

  await purgeMessageMediaFiles(clubId, channelId, messageId);
  await msgRef.delete();
  return { success: true };
});

// ---------------------------------------------------------------------------
// uploadAvatar — stores a profile photo and fans the resulting URL out to the
// caller's member doc in every club they belong to.
//
// Goes through a callable rather than the Storage SDK for the same reason
// uploadChannelMedia does: React Native can't build the Blob the client SDK
// wants. The fan-out is server-side so a user in several clubs can't end up
// with their photo applied to some rosters and not others when a client write
// fails halfway.
//
// Chat resolves avatars by authorId against the member list rather than
// reading a copy denormalized onto each message, so changing your photo
// updates your whole history instead of only messages sent from here on.
// ---------------------------------------------------------------------------
export const uploadAvatar = onCall({ memory: "512MiB" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { base64, contentType } = request.data ?? {};
  if (typeof base64 !== "string" || typeof contentType !== "string") {
    throw new HttpsError("invalid-argument", "Missing upload fields");
  }
  if (!/^image\//.test(contentType)) {
    throw new HttpsError("invalid-argument", "Avatars must be an image");
  }

  const buffer = Buffer.from(base64, "base64");
  // Avatars render at most a few hundred px; 2 MB is generous and keeps the
  // callable well inside its payload cap once base64 inflation is counted.
  if (buffer.length > 2 * 1024 * 1024) {
    throw new HttpsError("invalid-argument", "Image too large (max 2 MB)");
  }

  const ext = contentType.split("/")[1] || "jpg";
  const path = `users/${uid}/avatar.${ext}`;
  const token = crypto.randomUUID();
  const bucket = getStorage().bucket();

  await bucket.file(path).save(buffer, {
    contentType,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });

  // A fresh token each upload doubles as a cache-buster: replacing your photo
  // changes the URL, so clients don't keep showing the previous one.
  const avatarUrl =
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(path)}?alt=media&token=${token}`;

  const db = getFirestore();
  await db.doc(`users/${uid}`).set({ avatarUrl }, { merge: true });

  const userClubsSnap = await db.doc(`userClubs/${uid}`).get();
  const clubIds: string[] =
    (userClubsSnap.data() as { clubIds?: string[] } | undefined)?.clubIds ?? [];
  if (clubIds.length > 0) {
    const batch = db.batch();
    for (const clubId of clubIds) {
      batch.update(db.doc(`clubs/${clubId}/members/${uid}`), { avatarUrl });
    }
    // A stale clubId whose member doc is gone would fail the whole batch.
    await batch.commit().catch(async () => {
      await Promise.all(
        clubIds.map((clubId) =>
          db.doc(`clubs/${clubId}/members/${uid}`).update({ avatarUrl }).catch(() => undefined),
        ),
      );
    });
  }

  return { avatarUrl };
});

// ---------------------------------------------------------------------------
// fetchWeather — server-side proxy to OpenWeather so the API key never ships
// in the Android app. iOS uses WeatherKit directly.
//
// Readings are cached per rounded coordinate per hour; see the note at the
// cache lookup below for why.
// ---------------------------------------------------------------------------
interface WeatherReading {
  windMps: number;
  windDeg: number;
  gustMps: number;
  airTempC: number;
  pressureHpa: number;
  conditions: string;
}

/** How long a cached reading stays fresh. Matches the hourly bucket key. */
const WEATHER_TTL_MS = 60 * 60 * 1000;

export const fetchWeather = onCall(async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign-in required");
    }

    const { lat, lon } = request.data ?? {};
    if (typeof lat !== "number" || typeof lon !== "number") {
      throw new HttpsError("invalid-argument", "lat and lon are required");
    }

    // Cache key: coordinates rounded to ~1km and the current hour.
    //
    // Weather does not vary meaningfully between two paddlers a few hundred
    // metres apart, so without this every user at the same spot burned a
    // separate call against the OpenWeather quota — and the free tier is a
    // hard per-minute and per-day cap, so a busy morning could simply start
    // returning errors to everyone. Rounding collapses a whole launch site
    // onto one entry.
    const db = getFirestore();
    const bucketKey =
      `${lat.toFixed(2)}_${lon.toFixed(2)}_` +
      `${new Date().toISOString().slice(0, 13)}`;
    const cacheRef = db.doc(`weatherCache/${bucketKey}`);

    const cached = await cacheRef.get();
    if (cached.exists) {
      const { fetchedAt, ...weather } = cached.data() as WeatherReading & {
        fetchedAt: string;
      };
      if (Date.now() - Date.parse(fetchedAt) < WEATHER_TTL_MS) return weather;
    }

    const url =
      `https://api.openweathermap.org/data/2.5/weather` +
      `?lat=${lat}&lon=${lon}&units=metric` +
      `&appid=${process.env.OPENWEATHER_API_KEY ?? ""}`;

    const res = await fetch(url);
    if (!res.ok) {
      // Serve a stale reading rather than failing outright. An hour-old wind
      // speed is more useful to someone on the water than an error, and it
      // keeps a quota exhaustion from cascading into a broken feature.
      if (cached.exists) {
        const { fetchedAt: _stale, ...weather } = cached.data() as WeatherReading & {
          fetchedAt: string;
        };
        console.warn(`fetchWeather: upstream ${res.status}, serving stale ${bucketKey}`);
        return weather;
      }
      throw new HttpsError("internal", `Weather upstream: ${res.status}`);
    }
    const j = (await res.json()) as {
      wind?: { speed?: number; deg?: number; gust?: number };
      main?: { temp?: number; pressure?: number };
      weather?: Array<{ main?: string }>;
    };
    const reading: WeatherReading = {
      windMps: j.wind?.speed ?? 0,
      windDeg: j.wind?.deg ?? 0,
      gustMps: j.wind?.gust ?? 0,
      airTempC: j.main?.temp ?? 0,
      pressureHpa: j.main?.pressure ?? 0,
      conditions: j.weather?.[0]?.main ?? "Unknown",
    };

    // Cache write failures are not worth failing the request over — the caller
    // already has its answer, and the next call just misses the cache again.
    await cacheRef
      .set({ ...reading, fetchedAt: new Date().toISOString() })
      .catch((e) => console.error("fetchWeather: cache write failed", e));

    return reading;
  },
);

// ---------------------------------------------------------------------------
// onMemberJoin / onMemberLeave — maintain memberCount on the parent club
// document from member-doc lifecycle events. These triggers are the ONLY
// writers of memberCount (clients have no rules carve-out for it), so the
// counter can't be spoofed or double-counted.
// ---------------------------------------------------------------------------
export const onMemberJoin = onDocumentCreated(
  "clubs/{clubId}/members/{uid}",
  async (event) => {
    const { clubId } = event.params;
    await getFirestore()
      .doc(`clubs/${clubId}`)
      .update({ memberCount: FieldValue.increment(1) });
  },
);

export const onMemberLeave = onDocumentDeleted(
  "clubs/{clubId}/members/{uid}",
  async (event) => {
    const { clubId } = event.params;
    // The club doc may already be gone when a club is deleted outright.
    await getFirestore()
      .doc(`clubs/${clubId}`)
      .update({ memberCount: FieldValue.increment(-1) })
      .catch(() => undefined);
  },
);

// ---------------------------------------------------------------------------
// linkSessionsToEvent — when a session is created, checks if it overlaps in
// time with any events in clubs the user belongs to, and appends the sessionId
// to those events' linkedSessionIds arrays.
//
// Session doc shape: { startedAt: string (ISO-8601), endedAt: string (ISO-8601) }
// Overlap condition: event.startAt <= session.endedAt AND
//                   event.endAt   >= session.startedAt
// ---------------------------------------------------------------------------
export const linkSessionsToEvent = onDocumentCreated(
  "users/{uid}/sessions/{sessionId}",
  async (event) => {
    const { uid, sessionId } = event.params;
    const sessionData = event.data?.data() as
      | { startedAt: string; endedAt: string }
      | undefined;

    if (!sessionData?.startedAt || !sessionData?.endedAt) return;

    const { startedAt, endedAt } = sessionData;
    const db = getFirestore();

    // Read the user→club index
    const userClubsSnap = await db.doc(`userClubs/${uid}`).get();
    if (!userClubsSnap.exists) return;

    const clubIds: string[] =
      (userClubsSnap.data() as { clubIds?: string[] } | undefined)?.clubIds ?? [];
    if (clubIds.length === 0) return;

    const updates: Promise<FirebaseFirestore.WriteResult>[] = [];

    for (const clubId of clubIds) {
      // Query events that overlap the session's time window.
      // Overlap: event.startAt <= session.endedAt AND event.endAt >= session.startedAt
      // Firestore permits a range/inequality filter on only ONE field per
      // query, so we cannot filter both startAt and endAt server-side.
      // Constrain on startAt (<= session end), order/limit by the same field,
      // then apply the second overlap bound (endAt >= session start) in memory.
      const eventsSnap = await db
        .collection(`clubs/${clubId}/events`)
        .where("startAt", "<=", endedAt)
        .orderBy("startAt", "desc")
        .limit(20)
        .get();

      for (const eventDoc of eventsSnap.docs) {
        const evEndAt = (eventDoc.data() as { endAt?: string }).endAt;
        if (typeof evEndAt !== "string" || evEndAt < startedAt) continue;
        updates.push(
          eventDoc.ref.update({
            linkedSessionIds: FieldValue.arrayUnion(sessionId),
          }),
        );
      }
    }

    await Promise.all(updates);
  },
);

// ---------------------------------------------------------------------------
// createClubInvite — callable function that generates a secure invite token
// for a club. Only owners and admins may create invites.
// Client-side invite creation is replaced by this function so the token is
// always written via the admin SDK (bypassing Firestore rules).
//
// Request:  { clubId: string }
// Response: { token: string }
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// mobileAppleSignIn — verifies a native iOS Apple ID token (audience = bundle
// ID) and returns a Firebase custom token. This sidesteps the audience mismatch
// that occurs when a web Services ID is also configured in Firebase Console:
// Firebase's signInWithCredential would reject native tokens because it now
// expects Services-ID audience, not bundle-ID audience.
// ---------------------------------------------------------------------------
export const mobileAppleSignIn = onCall(async (request) => {
  const { idToken, rawNonce } = (request.data ?? {}) as {
    idToken?: unknown;
    rawNonce?: unknown;
  };
  if (typeof idToken !== "string" || !idToken) {
    throw new HttpsError("invalid-argument", "idToken is required");
  }
  if (typeof rawNonce !== "string" || !rawNonce) {
    throw new HttpsError("invalid-argument", "rawNonce is required");
  }

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new HttpsError("invalid-argument", "Malformed JWT");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { kid: string; alg: string };
  let payload: {
    iss: string;
    aud: string | string[];
    exp: number;
    sub: string;
    email?: string;
    nonce?: string;
  };
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    throw new HttpsError("invalid-argument", "Failed to decode Apple token");
  }

  // Validate claims
  if (payload.iss !== "https://appleid.apple.com") {
    throw new HttpsError("invalid-argument", "Invalid Apple token issuer");
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes("app.imuatrak")) {
    throw new HttpsError("invalid-argument", "Token audience does not match app bundle ID");
  }
  if (payload.exp < Date.now() / 1000) {
    throw new HttpsError("invalid-argument", "Apple token has expired");
  }
  // Anti-replay: the client hashed rawNonce (SHA-256, lowercase hex) and sent
  // it to Apple, which echoes it back in the token's nonce claim. Requiring
  // the caller to present the matching raw nonce ties this call to the
  // sign-in ceremony that produced the token.
  const expectedNonce = crypto.createHash("sha256").update(rawNonce).digest("hex");
  if (payload.nonce !== expectedNonce) {
    throw new HttpsError("invalid-argument", "Apple token nonce mismatch");
  }

  // Verify signature against Apple's public keys
  try {
    const jwksRes = await fetch("https://appleid.apple.com/auth/keys");
    const jwks = (await jwksRes.json()) as {
      keys: Array<{ kid: string; kty: string; n: string; e: string; alg: string }>;
    };
    const keyData = jwks.keys.find((k) => k.kid === header.kid);
    if (!keyData) throw new Error("Apple public key not found");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pubKey = crypto.createPublicKey({ key: keyData as any, format: "jwk" });
    const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
    const signature = Buffer.from(sigB64, "base64url");
    const valid = crypto.verify(
      "sha256",
      signedData,
      { key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      signature,
    );
    if (!valid) throw new Error("Signature invalid");
  } catch (e) {
    throw new HttpsError("invalid-argument", `Apple token verification failed: ${e instanceof Error ? e.message : e}`);
  }

  const appleSub = payload.sub;
  const adminAuth = getAuth();

  // Reuse the existing Firebase UID if this Apple account has signed in before.
  let uid: string;
  try {
    const existing = await adminAuth.getUserByProviderUid("apple.com", appleSub);
    uid = existing.uid;
    console.log("mobileAppleSignIn: found existing user", uid);
  } catch {
    uid = `apple_${appleSub.replace(/[^a-zA-Z0-9]/g, "_")}`;
    console.log("mobileAppleSignIn: new user, derived uid", uid);
  }

  try {
    const customToken = await adminAuth.createCustomToken(uid);
    return { customToken };
  } catch (e) {
    console.error("mobileAppleSignIn: createCustomToken failed", e);
    throw new HttpsError("internal", `Failed to create token: ${e instanceof Error ? e.message : e}`);
  }
});

export const createClubInvite = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { clubId } = (request.data ?? {}) as { clubId?: unknown };
  if (typeof clubId !== "string" || !clubId) {
    throw new HttpsError("invalid-argument", "clubId is required");
  }

  const db = getFirestore();

  // Verify caller is an owner or admin of the club
  const memberSnap = await db.doc(`clubs/${clubId}/members/${uid}`).get();
  if (!memberSnap.exists) {
    throw new HttpsError("permission-denied", "You are not a member of this club");
  }
  const memberRole = (memberSnap.data() as { role?: string } | undefined)?.role;
  if (memberRole !== "owner" && memberRole !== "admin") {
    throw new HttpsError("permission-denied", "Only owners and admins can create invite links");
  }

  const token = crypto.randomBytes(6).toString("hex"); // 12 hex chars
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await db.doc(`clubInvites/${token}`).set({
    clubId,
    createdBy: uid,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  return { token };
});

// ---------------------------------------------------------------------------
// createChannel — subscription-gated callable that creates a new chat channel.
// Free/expired clubs may only have the General channel; trial/active clubs are
// unlimited. All channel creation goes through this function so billing logic
// stays server-side and security rules can simply deny direct client writes.
//
// Request:  { clubId, name, icon, iconType, description?, isPrivate, memberIds? }
// Response: ClubChannel
// ---------------------------------------------------------------------------
export const createChannel = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const {
    clubId,
    name,
    icon,
    iconType,
    description,
    isPrivate,
    memberIds,
  } = (request.data ?? {}) as {
    clubId?: unknown;
    name?: unknown;
    icon?: unknown;
    iconType?: unknown;
    description?: unknown;
    isPrivate?: unknown;
    memberIds?: unknown;
  };

  if (typeof clubId !== "string" || !clubId) {
    throw new HttpsError("invalid-argument", "clubId is required");
  }
  if (typeof name !== "string" || !name.trim()) {
    throw new HttpsError("invalid-argument", "name is required");
  }
  if (typeof icon !== "string" || !icon) {
    throw new HttpsError("invalid-argument", "icon is required");
  }
  if (iconType !== "emoji" && iconType !== "ionicon") {
    throw new HttpsError("invalid-argument", "iconType must be emoji or ionicon");
  }

  const db = getFirestore();

  const memberSnap = await db.doc(`clubs/${clubId}/members/${uid}`).get();
  if (!memberSnap.exists) {
    throw new HttpsError("permission-denied", "You are not a member of this club");
  }
  const memberRole = (memberSnap.data() as { role?: string } | undefined)?.role;
  if (memberRole !== "owner" && memberRole !== "admin") {
    throw new HttpsError("permission-denied", "Only owners and admins can create channels");
  }

  const clubSnap = await db.doc(`clubs/${clubId}`).get();
  const clubData = clubSnap.data() as { subscriptionStatus?: string } | undefined;
  if (clubData?.subscriptionStatus === "expired") {
    const existingChannels = await db.collection(`clubs/${clubId}/channels`).count().get();
    if (existingChannels.data().count >= 1) {
      throw new HttpsError(
        "permission-denied",
        "Upgrade your subscription to add more channels",
      );
    }
  }

  const existingChannels = await db.collection(`clubs/${clubId}/channels`).get();
  const sortOrder = existingChannels.size;

  const now = new Date().toISOString();
  const channelRef = db.collection(`clubs/${clubId}/channels`).doc();
  const channelData = {
    id: channelRef.id,
    clubId,
    name: (name as string).trim(),
    icon: icon as string,
    iconType: iconType as "emoji" | "ionicon",
    description: typeof description === "string" ? description.trim() : "",
    isPrivate: Boolean(isPrivate),
    memberIds: Array.isArray(memberIds)
      ? (memberIds as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    createdBy: uid,
    createdAt: now,
    sortOrder,
  };
  await channelRef.set(channelData);

  return channelData;
});

// ---------------------------------------------------------------------------
// onChannelMessageCreate — sends FCM push notifications to channel members
// when a new message is created, respecting per-user mute preferences.
// Also updates lastMessageAt on the channel doc for unread indicators.
// ---------------------------------------------------------------------------
export const onChannelMessageCreate = onDocumentCreated(
  {
    document: "clubs/{clubId}/channels/{channelId}/messages/{messageId}",
    // Fans out across the whole club roster, so this is the most expensive
    // trigger in the project per invocation. A tighter ceiling than the global
    // one caps the blast radius if a client ever loops on sending.
    maxInstances: 5,
  },
  async (event) => {
    const { clubId, channelId } = event.params;
    const messageData = event.data?.data() as {
      authorId: string;
      authorName: string;
      content: string;
      mentions?: string[];
    } | undefined;
    if (!messageData) return;

    const db = getFirestore();

    const channelSnap = await db.doc(`clubs/${clubId}/channels/${channelId}`).get();
    if (!channelSnap.exists) return;
    const channel = channelSnap.data() as {
      name: string;
      isPrivate: boolean;
      memberIds: string[];
    };

    let recipientUids: string[];
    if (channel.isPrivate) {
      recipientUids = channel.memberIds;
    } else {
      const membersSnap = await db.collection(`clubs/${clubId}/members`).get();
      recipientUids = membersSnap.docs.map((d) => d.id);
    }

    recipientUids = recipientUids.filter((id) => id !== messageData.authorId);
    if (recipientUids.length === 0) return;

    const body = messageData.content.length > 0
      ? messageData.content.slice(0, 200)
      : "Sent a photo";
    const title = `${messageData.authorName} in #${channel.name}`;
    const mentionTitle = `${messageData.authorName} mentioned you in #${channel.name}`;

    // Who was @-mentioned. Intersected with the recipient list so a mention
    // can never reach someone outside a private channel, and so a client that
    // sent a bogus uid just gets ignored.
    const recipientSet = new Set(recipientUids);
    const mentioned = new Set(
      (Array.isArray(messageData.mentions) ? messageData.mentions : [])
        .filter((uid): uid is string => typeof uid === "string" && recipientSet.has(uid)),
    );

    // Per recipient: atomically bump this channel's unread count and the
    // user's global unread total (drives the app-icon badge), then push with
    // that real total as the badge. Muted recipients are still counted (they
    // have unread) but get no alert — their badge syncs on next app open.
    // The one exception is being @-mentioned: a direct tag is addressed to
    // you personally, so it cuts through a muted channel the way it does in
    // every other chat app.
    interface ExpoPushMessage {
      to: string[];
      title: string;
      body: string;
      sound: string;
      badge: number;
      priority: string;
      data: Record<string, string>;
    }
    const pushMessages: ExpoPushMessage[] = [];

    // Fan-out, batched.
    //
    // This used to run a Firestore transaction plus an fcmTokens collection
    // read per recipient, all in an uncapped Promise.all — roughly 3 reads and
    // 2 writes per member for every single message sent. A busy hundred-member
    // club generated hundreds of thousands of billed operations a day on its
    // own, which made chat by far the most expensive thing in the project.
    //
    // Now each chunk of recipients costs one getAll and one batched commit, and
    // tokens come from the user doc that read already returned. The counters
    // move to FieldValue.increment, which is atomic without needing the
    // transaction to hold a read.
    //
    // The badge number is computed from the pre-increment value, so two
    // messages landing in the same instant can report the same badge. That was
    // already the accepted behaviour here — badges resync when the app next
    // opens — and it is not worth a transaction per recipient to tighten.
    for (let i = 0; i < recipientUids.length; i += FANOUT_CHUNK) {
      const chunk = recipientUids.slice(i, i + FANOUT_CHUNK);
      const userRefs = chunk.map((userId) => db.doc(`users/${userId}`));
      const prefRefs = chunk.map((userId) =>
        db.doc(`users/${userId}/channelPreferences/${channelId}`),
      );

      const snaps = await db.getAll(...userRefs, ...prefRefs);
      const userSnaps = snaps.slice(0, chunk.length);
      const prefSnaps = snaps.slice(chunk.length);

      const batch = db.batch();
      const needsLegacyLookup: { userId: string; badge: number; isMention: boolean }[] = [];

      chunk.forEach((userId, j) => {
        batch.set(userRefs[j]!, { unreadTotal: FieldValue.increment(1) }, { merge: true });
        batch.set(prefRefs[j]!, { unreadCount: FieldValue.increment(1) }, { merge: true });

        const isMention = mentioned.has(userId);
        const muted =
          (prefSnaps[j]?.data()?.muteNotifications as boolean | undefined) === true;
        if (muted && !isMention) return;

        const userData = userSnaps[j]?.data();
        const badge = ((userData?.unreadTotal as number | undefined) ?? 0) + 1;
        const tokens = expoTokensFrom(userData);

        if (tokens === null) {
          // No denormalized field yet — this account has not re-registered
          // since the migration, so fall back to the subcollection below.
          needsLegacyLookup.push({ userId, badge, isMention });
          return;
        }
        if (tokens.length === 0) return;

        pushMessages.push({
          to: tokens,
          title: isMention ? mentionTitle : title,
          body,
          sound: "default",
          badge,
          priority: "high",
          data: {
            clubId,
            channelId,
            screen: "club/chat",
            ...(isMention ? { mention: "1" } : {}),
          },
        });
      });

      await batch.commit();

      // Legacy path: only accounts still missing users/{uid}.expoTokens pay an
      // extra read, and only if they were going to be pushed at all. This
      // shrinks to nothing as clients re-register their tokens.
      for (const { userId, badge, isMention } of needsLegacyLookup) {
        const tokens = await legacyExpoTokens(db, userId);
        if (tokens.length === 0) continue;
        pushMessages.push({
          to: tokens,
          title: isMention ? mentionTitle : title,
          body,
          sound: "default",
          badge,
          priority: "high",
          data: {
            clubId,
            channelId,
            screen: "club/chat",
            ...(isMention ? { mention: "1" } : {}),
          },
        });
      }
    }

    // Deliver via the Expo Push Service (handles APNs + FCM routing). Max 100
    // messages per request.
    for (let i = 0; i < pushMessages.length; i += 100) {
      const chunk = pushMessages.slice(i, i + 100);
      try {
        const res = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(chunk),
        });
        if (!res.ok) {
          console.error("Expo push send failed:", res.status, await res.text());
        }
      } catch (e) {
        console.error("Expo push send error:", e);
      }
    }

    await db.doc(`clubs/${clubId}/channels/${channelId}`).update({
      lastMessageAt: event.data?.createTime?.toDate().toISOString() ?? new Date().toISOString(),
    });
  },
);

// ---------------------------------------------------------------------------
// deleteAccount — deletes all user data (sessions, preferences, club memberships)
// and the Firebase Auth account. Uses the Admin SDK so no client re-auth is
// required. Called from the mobile app's account-deletion flow.
// ---------------------------------------------------------------------------
export const deleteAccount = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const db = getFirestore();
  const adminAuth = getAuth();

  // Delete sessions subcollection in 500-doc batches.
  const sessionsRef = db.collection(`users/${uid}/sessions`);
  let sessionsSnap = await sessionsRef.limit(500).get();
  while (!sessionsSnap.empty) {
    const batch = db.batch();
    for (const d of sessionsSnap.docs) batch.delete(d.ref);
    await batch.commit();
    sessionsSnap = await sessionsRef.limit(500).get();
  }

  // Delete public session copies — these are world-readable denormalized
  // docs and MUST NOT survive account deletion.
  const publicRef = db.collection("publicSessions").where("userId", "==", uid);
  let publicSnap = await publicRef.limit(500).get();
  while (!publicSnap.empty) {
    const batch = db.batch();
    for (const d of publicSnap.docs) batch.delete(d.ref);
    await batch.commit();
    publicSnap = await publicRef.limit(500).get();
  }

  // Delete FCM tokens and channel notification preferences subcollections.
  for (const coll of ["fcmTokens", "channelPreferences"]) {
    const snap = await db.collection(`users/${uid}/${coll}`).limit(500).get();
    if (!snap.empty) {
      const batch = db.batch();
      for (const d of snap.docs) batch.delete(d.ref);
      await batch.commit();
    }
  }

  // Delete Storage objects (GPX tracks, share cards). Best-effort — Storage
  // cleanup must not block the auth-account deletion below.
  await getStorage()
    .bucket()
    .deleteFiles({ prefix: `users/${uid}/` })
    .catch(() => undefined);

  // Remove from all clubs the user belongs to.
  const userClubsSnap = await db.doc(`userClubs/${uid}`).get();
  if (userClubsSnap.exists) {
    const clubIds: string[] =
      (userClubsSnap.data() as { clubIds?: string[] } | undefined)?.clubIds ?? [];
    if (clubIds.length > 0) {
      const batch = db.batch();
      for (const clubId of clubIds) {
        batch.delete(db.doc(`clubs/${clubId}/members/${uid}`));
      }
      await batch.commit();
    }
  }

  // Delete top-level user documents.
  await db.doc(`users/${uid}`).delete().catch(() => undefined);
  await db.doc(`userClubs/${uid}`).delete().catch(() => undefined);

  // Delete the Firebase Auth account last so the function stays authenticated
  // throughout the cleanup above.
  await adminAuth.deleteUser(uid);

  return { success: true };
});

// ---------------------------------------------------------------------------
// expireClubTrials — daily sweep that flips clubs whose 30-day trial has
// lapsed from "trial" to "expired". Nothing else ends a trial: clients gate
// ads and channel limits on subscriptionStatus (with a trialEndsAt check as a
// same-day belt-and-braces), and security rules bar clients from writing the
// subscription fields, so this Admin-SDK sweep is the one writer.
// ---------------------------------------------------------------------------
export const expireClubTrials = onSchedule("every day 06:00", async () => {
  const db = getFirestore();
  const now = new Date().toISOString();

  const snap = await db
    .collection("clubs")
    .where("subscriptionStatus", "==", "trial")
    .where("trialEndsAt", "<=", now)
    .get();
  if (snap.empty) {
    console.log("expireClubTrials: no overdue trials");
    return;
  }

  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 500)) {
      batch.update(d.ref, { subscriptionStatus: "expired" });
    }
    await batch.commit();
  }
  console.log(`expireClubTrials: expired ${docs.length} club trial(s)`);
});

// ---------------------------------------------------------------------------
// getAppStats — app-wide usage analytics for the admin page on imuatrak.app.
//
// Gated on an admins/{uid} Firestore doc, created manually in the Firebase
// console (doc ID = the admin's Auth UID). Aggregation runs with the Admin
// SDK, so no security-rules carve-outs are needed for cross-user reads.
//
// Session dates are ISO-8601 strings throughout the app, so day bucketing and
// cutoff comparisons are plain string operations.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// onDmMessageCreate — notify the other participant of a direct message.
//
// Mirrors onChannelMessageCreate: bump the recipient's per-thread unread count
// and their global unreadTotal (which drives the app-icon badge), then push
// with that real total.
//
// The thread doc is read for its participants rather than trusting anything on
// the message, so a client can't address a notification to someone who isn't in
// the conversation.
// ---------------------------------------------------------------------------
export const onDmMessageCreate = onDocumentCreated(
  {
    document: "dms/{threadId}/messages/{messageId}",
    // Same fan-out shape as onChannelMessageCreate, same ceiling.
    maxInstances: 5,
  },
  async (event) => {
    const { threadId } = event.params;
    const message = event.data?.data() as
      | { authorId: string; authorName: string; content: string; mediaType?: string }
      | undefined;
    if (!message) return;

    const db = getFirestore();
    const threadSnap = await db.doc(`dms/${threadId}`).get();
    if (!threadSnap.exists) return;
    const participants =
      (threadSnap.data() as { participants?: string[] } | undefined)?.participants ?? [];

    const recipients = participants.filter((uid) => uid !== message.authorId);
    if (recipients.length === 0) return;

    // A photo sent without a caption has no content at all, so say what it is
    // rather than the generic fallback.
    const body =
      message.content.length > 0
        ? message.content.slice(0, 200)
        : message.mediaType === "photo"
          ? "📷 Sent a photo"
          : "Sent a message";

    for (const userId of recipients) {
      const userRef = db.doc(`users/${userId}`);
      const threadPrefRef = db.doc(`users/${userId}/dmThreads/${threadId}`);

      // One read of the user doc covers both the badge number and the push
      // tokens; the counters then move with atomic increments in a batch. See
      // the note in onChannelMessageCreate for why the transaction went away.
      const userSnap = await userRef.get();
      const newTotal = ((userSnap.data()?.unreadTotal as number | undefined) ?? 0) + 1;

      const batch = db.batch();
      batch.set(userRef, { unreadTotal: FieldValue.increment(1) }, { merge: true });
      batch.set(threadPrefRef, { unreadCount: FieldValue.increment(1) }, { merge: true });
      await batch.commit();

      const denormalized = expoTokensFrom(userSnap.data());
      const tokens = denormalized ?? (await legacyExpoTokens(db, userId));
      if (tokens.length === 0) continue;

      try {
        const res = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify([
            {
              to: tokens,
              // A DM is from a person, not a room — no channel name to qualify it.
              title: message.authorName,
              body,
              sound: "default",
              badge: newTotal,
              priority: "high",
              data: { threadId, screen: "dm" },
            },
          ]),
        });
        if (!res.ok) {
          console.error("DM push send failed:", res.status, await res.text());
        }
      } catch (e) {
        console.error("DM push send error:", e);
      }
    }
  },
);

// ---------------------------------------------------------------------------
// openDmThread — find or create the direct-message thread for two users.
//
// Client can't create threads directly (rules deny it) because the pairing has
// to be checked: you may only DM someone you share a club with. That's the
// contact graph the app already has, and it means nobody can be messaged by a
// stranger without a user directory existing.
//
// The thread id is derived from the sorted uid pair, so both people resolve to
// the same document and a conversation can't fork into two threads.
//
// NOTE ON THE PAYWALL: starting a DM is meant to be a paid feature, but there
// is currently no server-side record of a personal entitlement to check —
// revenuecat.ts is parked and undeployed (see its header), so RevenueCat state
// never reaches Firestore. The gate is enforced in the client for now. When the
// webhook is live and writes an entitlement onto users/{uid}, add the check
// here; this is the only place thread creation can happen, so it is the right
// choke point.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// uploadDmMedia — attach a photo to a direct message.
//
// Same shape and reasoning as uploadChannelMedia: React Native has no Blob, so
// the client can't write to Storage directly, and routing it through here also
// puts the thread-participant check server-side. Images only — the callable
// payload cap (~7 MB after base64 inflation) makes video impractical.
//
// The message doc is updated with the Admin SDK, which is what allows it: the
// Firestore rule deliberately lets participants change nothing but `reactions`
// on a message, so the client could not attach media itself.
// ---------------------------------------------------------------------------
export const uploadDmMedia = onCall({ memory: "512MiB" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { threadId, messageId, base64, contentType, fileKey } = request.data ?? {};
  if (
    typeof threadId !== "string" ||
    typeof messageId !== "string" ||
    typeof base64 !== "string" ||
    typeof contentType !== "string"
  ) {
    throw new HttpsError("invalid-argument", "Missing upload fields");
  }
  if (!/^image\//.test(contentType)) {
    throw new HttpsError("invalid-argument", "Direct messages accept images only");
  }
  const key: string = typeof fileKey === "string" ? fileKey : "media";
  if (!/^media(-\d{1,2})?$/.test(key)) {
    throw new HttpsError("invalid-argument", "Bad fileKey");
  }

  const db = getFirestore();
  const threadSnap = await db.doc(`dms/${threadId}`).get();
  if (!threadSnap.exists) throw new HttpsError("not-found", "Thread not found");
  const participants = (threadSnap.data()?.participants as string[] | undefined) ?? [];
  if (!participants.includes(uid)) {
    throw new HttpsError("permission-denied", "Not a participant in this thread");
  }

  const msgRef = db.doc(`dms/${threadId}/messages/${messageId}`);
  const msgSnap = await msgRef.get();
  if (!msgSnap.exists) throw new HttpsError("not-found", "Message not found");
  if ((msgSnap.data() as { authorId?: string } | undefined)?.authorId !== uid) {
    throw new HttpsError("permission-denied", "Not your message");
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > 7 * 1024 * 1024) {
    throw new HttpsError("invalid-argument", "Photo too large (max ~7 MB)");
  }

  const ext = contentType.split("/")[1] || "jpg";
  const path = `dms/${threadId}/${messageId}/${key}.${ext}`;
  const token = crypto.randomUUID();
  const bucket = getStorage().bucket();

  await bucket.file(path).save(buffer, {
    contentType,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });

  const mediaUrl =
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(path)}?alt=media&token=${token}`;

  if (key === "media") {
    await msgRef.update({ mediaUrl, mediaStoragePath: `gs://${bucket.name}/${path}` });
  } else {
    await msgRef.update({ mediaUrls: FieldValue.arrayUnion(mediaUrl) });
  }

  return { mediaUrl };
});

export const openDmThread = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { otherUid } = request.data ?? {};
  if (typeof otherUid !== "string" || !otherUid) {
    throw new HttpsError("invalid-argument", "otherUid is required");
  }
  if (otherUid === uid) {
    throw new HttpsError("invalid-argument", "Can't message yourself");
  }

  const db = getFirestore();
  const threadId = [uid, otherUid].sort().join("__");
  const threadRef = db.doc(`dms/${threadId}`);

  const existing = await threadRef.get();
  if (existing.exists) return { threadId };

  // Must share at least one club. Compared through each side's userClubs index
  // rather than a collection-group query, so no extra index is needed.
  const [mine, theirs] = await Promise.all([
    db.doc(`userClubs/${uid}`).get(),
    db.doc(`userClubs/${otherUid}`).get(),
  ]);
  const myClubs: string[] = (mine.data() as { clubIds?: string[] } | undefined)?.clubIds ?? [];
  const theirClubs: string[] =
    (theirs.data() as { clubIds?: string[] } | undefined)?.clubIds ?? [];
  const shared = myClubs.find((c) => theirClubs.includes(c));
  if (!shared) {
    throw new HttpsError("permission-denied", "You can only message people in your clubs");
  }

  // Names come from the shared club's roster — the only profile source the
  // caller is entitled to read for another user.
  const [meMember, themMember] = await Promise.all([
    db.doc(`clubs/${shared}/members/${uid}`).get(),
    db.doc(`clubs/${shared}/members/${otherUid}`).get(),
  ]);
  const nameOf = (s: FirebaseFirestore.DocumentSnapshot): string =>
    (s.data() as { displayName?: string } | undefined)?.displayName ?? "Member";
  const avatarOf = (s: FirebaseFirestore.DocumentSnapshot): string | undefined =>
    (s.data() as { avatarUrl?: string } | undefined)?.avatarUrl;

  const participantAvatars: Record<string, string> = {};
  const myAvatar = avatarOf(meMember);
  const theirAvatar = avatarOf(themMember);
  if (myAvatar) participantAvatars[uid] = myAvatar;
  if (theirAvatar) participantAvatars[otherUid] = theirAvatar;

  await threadRef.set({
    participants: [uid, otherUid].sort(),
    participantNames: { [uid]: nameOf(meMember), [otherUid]: nameOf(themMember) },
    ...(Object.keys(participantAvatars).length > 0 ? { participantAvatars } : {}),
    createdAt: new Date().toISOString(),
  });

  return { threadId };
});

// ---------------------------------------------------------------------------
// expireChatMessages — nightly sweep deleting chat past each club's retention.
//
// Opt-in per club: only clubs with chatRetentionDays > 0 are touched, so no
// existing club starts losing history without someone turning it on. Pinned
// messages are skipped — pinning is how a club marks something worth keeping,
// and a sweep that deleted those would defeat the point of the setting.
//
// createdAt is an ISO-8601 string, which sorts chronologically, so the cutoff
// compares directly without a schema change.
// ---------------------------------------------------------------------------
export const expireChatMessages = onSchedule(
  {
    schedule: "every day 04:00",
    // Iterates every club, then every channel, deleting in pages. Under the
    // 60s default a growing project eventually times out part-way through, and
    // a half-finished sweep is silent: the messages and their Storage objects
    // simply stay, billing storage every month. 540s is the maximum here.
    timeoutSeconds: 540,
  },
  async () => {
    const db = getFirestore();

    const clubs = await db.collection("clubs").where("chatRetentionDays", ">", 0).get();
    if (clubs.empty) {
      console.log("expireChatMessages: no clubs with retention set");
      return;
    }

    let deleted = 0;
    for (const clubDoc of clubs.docs) {
      const days = (clubDoc.data() as { chatRetentionDays?: number }).chatRetentionDays ?? 0;
      if (days <= 0) continue;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const channels = await db.collection(`clubs/${clubDoc.id}/channels`).get();
      for (const channelDoc of channels.docs) {
        // Paged with a cursor rather than re-querying from the start each time.
        // Re-querying would stall permanently on a channel whose oldest messages
        // are pinned: they match the cutoff, survive the sweep, and would fill
        // page one forever, hiding every deletable message behind them.
        const PAGE = 200;
        let cursor: QueryDocumentSnapshot | null = null;
        for (;;) {
          let q = db
            .collection(`clubs/${clubDoc.id}/channels/${channelDoc.id}/messages`)
            .where("createdAt", "<", cutoff)
            .orderBy("createdAt")
            .limit(PAGE);
          if (cursor) q = q.startAfter(cursor);

          const stale = await q.get();
          if (stale.empty) break;
          cursor = stale.docs[stale.docs.length - 1]!;

          const doomed = stale.docs.filter((d) => !(d.data() as { pinnedAt?: string }).pinnedAt);
          if (doomed.length > 0) {
            await Promise.all(
              doomed.map((d) => purgeMessageMediaFiles(clubDoc.id, channelDoc.id, d.id)),
            );
            const batch = db.batch();
            for (const d of doomed) batch.delete(d.ref);
            await batch.commit();
            deleted += doomed.length;
          }

          if (stale.size < PAGE) break;
        }
      }
    }

    console.log(`expireChatMessages: deleted ${deleted} message(s)`);
  },
);

// ---------------------------------------------------------------------------
// App stats.
//
// The aggregation below is the single most expensive operation in the project:
// it pages every Firebase Auth user and runs a collectionGroup scan over every
// session, and its cost grows with total account age — forever. It used to run
// on every admin page load, so a browser refresh re-scanned the whole project.
//
// It is now computed on a schedule and stored at adminStats/current, and the
// callable is a one-document read. The number an admin sees is up to a day
// stale, which is the correct tradeoff for a dashboard of lifetime totals.
// ---------------------------------------------------------------------------

/** How stale a snapshot may be before an admin is allowed to force a rebuild. */
const STATS_REFRESH_MIN_AGE_MS = 60 * 60 * 1000;

interface AppStats {
  generatedAt: string;
  totalUsers: number;
  newUsers7: number;
  newUsers30: number;
  activeUsers7: number;
  activeUsers30: number;
  totalSessions: number;
  sessions7: number;
  sessions30: number;
  clubs: number;
  publicSessions: number;
  signupsByDay: Record<string, number>;
  sessionsByDay: Record<string, number>;
}

async function computeAppStatsSnapshot(): Promise<AppStats> {
  const db = getFirestore();

  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const cutoff7 = new Date(now - 7 * DAY_MS).toISOString();
  const cutoff30 = new Date(now - 30 * DAY_MS).toISOString();

  // ── Users, from Firebase Auth (the source of truth for signups) ──────────
  const adminAuth = getAuth();
  let totalUsers = 0;
  let newUsers7 = 0;
  let newUsers30 = 0;
  const signupsByDay: Record<string, number> = {};
  let pageToken: string | undefined;
  do {
    const page = await adminAuth.listUsers(1000, pageToken);
    totalUsers += page.users.length;
    for (const u of page.users) {
      const createdAt = new Date(u.metadata.creationTime).toISOString();
      if (createdAt >= cutoff30) {
        newUsers30 += 1;
        const day = createdAt.slice(0, 10);
        signupsByDay[day] = (signupsByDay[day] ?? 0) + 1;
      }
      if (createdAt >= cutoff7) newUsers7 += 1;
    }
    pageToken = page.pageToken;
  } while (pageToken);

  // ── Sessions (collection group over users/*/sessions) ────────────────────
  const sessionsGroup = db.collectionGroup("sessions");
  const [totalSessionsSnap, recentSnap, clubsSnap, publicSnap] =
    await Promise.all([
      sessionsGroup.count().get(),
      sessionsGroup
        .where("startedAt", ">=", cutoff30)
        .select("userId", "startedAt")
        .get(),
      db.collection("clubs").count().get(),
      db.collection("publicSessions").count().get(),
    ]);

  const sessionsByDay: Record<string, number> = {};
  const activeUids7 = new Set<string>();
  const activeUids30 = new Set<string>();
  let sessions7 = 0;
  for (const d of recentSnap.docs) {
    const { userId, startedAt } = d.data() as {
      userId?: string;
      startedAt?: string;
    };
    if (!startedAt) continue;
    // Old session docs may predate the userId field; the owner is always the
    // parent user doc in the path users/{uid}/sessions/{sessionId}.
    const owner = userId ?? d.ref.parent.parent?.id ?? "";
    const day = startedAt.slice(0, 10);
    sessionsByDay[day] = (sessionsByDay[day] ?? 0) + 1;
    if (owner) activeUids30.add(owner);
    if (startedAt >= cutoff7) {
      sessions7 += 1;
      if (owner) activeUids7.add(owner);
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    totalUsers,
    newUsers7,
    newUsers30,
    activeUsers7: activeUids7.size,
    activeUsers30: activeUids30.size,
    totalSessions: totalSessionsSnap.data().count,
    sessions7,
    sessions30: recentSnap.size,
    clubs: clubsSnap.data().count,
    publicSessions: publicSnap.data().count,
    signupsByDay,
    sessionsByDay,
  };
}

// Rebuilds the snapshot once a day. maxInstances 1 because two concurrent
// project-wide scans would double the cost to produce the same answer.
export const computeAppStats = onSchedule(
  {
    schedule: "every day 03:00",
    maxInstances: 1,
    // Nobody is waiting on this, so give it the full 540s rather than the 60s
    // default: it pages every Auth user and holds a 30-day session scan in
    // memory, and both grow with the project. Timing out would leave the
    // snapshot stale with nothing to indicate why.
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const stats = await computeAppStatsSnapshot();
    await getFirestore().doc("adminStats/current").set(stats);
    console.log(`computeAppStats: snapshot written at ${stats.generatedAt}`);
  },
);

export const getAppStats = onCall({ maxInstances: 1 }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const db = getFirestore();
  const adminSnap = await db.doc(`admins/${uid}`).get();
  if (!adminSnap.exists) {
    throw new HttpsError("permission-denied", "Admin only");
  }

  const statsRef = db.doc("adminStats/current");
  const snap = await statsRef.get();
  const cached = snap.exists ? (snap.data() as AppStats) : null;

  // Rebuild only when there is nothing to serve (first run, before the
  // schedule has ever fired) or when an admin explicitly asks and the snapshot
  // is genuinely old. The age check is what stops a refresh button from
  // becoming the same unbounded cost the schedule was introduced to remove.
  const wantsRefresh = request.data?.refresh === true;
  const age = cached ? Date.now() - Date.parse(cached.generatedAt) : Infinity;
  const shouldRebuild = !cached || (wantsRefresh && age >= STATS_REFRESH_MIN_AGE_MS);

  if (!shouldRebuild) return cached;

  const stats = await computeAppStatsSnapshot();
  await statsRef.set(stats);
  return stats;
});

// ---------------------------------------------------------------------------
// migrateMessagesToGeneralChannel — one-time callable (owner only) that copies
// all legacy messages from clubs/{clubId}/messages to the General channel.
// ---------------------------------------------------------------------------
export const migrateMessagesToGeneralChannel = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in required");

  const { clubId } = (request.data ?? {}) as { clubId?: unknown };
  if (typeof clubId !== "string" || !clubId) {
    throw new HttpsError("invalid-argument", "clubId is required");
  }

  const db = getFirestore();

  const memberSnap = await db.doc(`clubs/${clubId}/members/${uid}`).get();
  if ((memberSnap.data() as { role?: string } | undefined)?.role !== "owner") {
    throw new HttpsError("permission-denied", "Owner only");
  }

  // Idempotency guard: this is a destructive one-time copy. A marker doc makes
  // re-invocation a no-op so the migration can't re-run and clobber messages
  // that have since been edited/deleted in the General channel.
  const markerRef = db.doc(`clubs/${clubId}/migrations/messagesToGeneralChannel`);
  if ((await markerRef.get()).exists) {
    return { migrated: 0, alreadyMigrated: true };
  }

  const generalChannelRef = db.doc(`clubs/${clubId}/channels/general`);
  const generalSnap = await generalChannelRef.get();
  if (!generalSnap.exists) {
    await generalChannelRef.set({
      id: "general",
      clubId,
      name: "General",
      icon: "chatbubbles-outline",
      iconType: "ionicon",
      description: "",
      isPrivate: false,
      memberIds: [],
      createdBy: uid,
      createdAt: new Date().toISOString(),
      sortOrder: 0,
    });
  }

  const legacySnap = await db.collection(`clubs/${clubId}/messages`).get();
  if (legacySnap.empty) return { migrated: 0 };

  let migrated = 0;
  const docs = legacySnap.docs;
  for (let i = 0; i < docs.length; i += 499) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 499)) {
      const newRef = db.doc(`clubs/${clubId}/channels/general/messages/${d.id}`);
      batch.set(newRef, { ...d.data(), channelId: "general" });
    }
    await batch.commit();
    migrated += Math.min(499, docs.length - i);
  }

  await markerRef.set({ migratedAt: new Date().toISOString(), by: uid, count: migrated });
  return { migrated };
});

// ---------------------------------------------------------------------------
// Club plan billing (RevenueCat) lives in ./revenuecat and is deliberately NOT
// imported here, which keeps it out of the deployed backend.
//
// Its two defineSecret() declarations are resolved by the Firebase CLI for the
// whole codebase before it decides what to deploy, so with those secrets absent
// from Secret Manager NOTHING deploys — that one gap had blocked every function
// in this file since 2026-08-02. See the header of revenuecat.ts for what to
// create and how to switch it back on.
// ---------------------------------------------------------------------------
