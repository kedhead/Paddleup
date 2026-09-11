import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  FieldPath,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  updateDoc,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import * as FileSystem from "expo-file-system/legacy";
import { db, functions } from "./firebase";
import type { DmMessage, DmThread } from "@/models/club";

/**
 * Direct messages.
 *
 * Threads live at the top level rather than inside a club — see the DmThread
 * comment in models/club.ts for why a two-person private channel was the wrong
 * shape. Everything here is participant-only; there is no moderator path.
 */

/** Threads the user is in, most recent first. */
export function subscribeDmThreads(
  uid: string,
  onUpdate: (threads: (DmThread & { id: string })[]) => void,
): () => void {
  const q = query(
    collection(db, "dms"),
    where("participants", "array-contains", uid),
    limit(100),
  );
  return onSnapshot(q, (snap) => {
    const threads = snap.docs.map((d) => ({ ...(d.data() as DmThread), id: d.id }));
    // Sorted client-side: ordering on lastMessageAt would need a composite
    // index, and a brand-new thread has no lastMessageAt at all, so it would
    // drop out of the list until someone spoke.
    threads.sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
    onUpdate(threads);
  });
}

export function subscribeDmMessages(
  threadId: string,
  onUpdate: (msgs: DmMessage[]) => void,
  msgLimit = 60,
): () => void {
  const q = query(
    collection(db, "dms", threadId, "messages"),
    orderBy("createdAt", "desc"),
    limit(msgLimit),
  );
  // Newest-first then reversed, same as club chat: an ascending limit would
  // pin the listener to the oldest messages and never surface new ones.
  return onSnapshot(q, (snap) => {
    const msgs = snap.docs.map((d) => ({ ...(d.data() as Omit<DmMessage, "id">), id: d.id }));
    onUpdate(msgs.reverse());
  });
}

/**
 * Find or create the thread with another user. Server-side because the pairing
 * has to be checked — you may only DM someone you share a club with.
 */
export async function openDmThread(otherUid: string): Promise<string> {
  const fn = httpsCallable<{ otherUid: string }, { threadId: string }>(functions, "openDmThread");
  const { data } = await fn({ otherUid });
  return data.threadId;
}

export async function sendDmMessage(
  threadId: string,
  uid: string,
  displayName: string,
  content: string,
  replyTo?: DmMessage["replyTo"],
  opts: { mediaType?: "photo" } = {},
): Promise<DmMessage> {
  const now = new Date().toISOString();
  const msg: Omit<DmMessage, "id"> = {
    threadId,
    content,
    authorId: uid,
    authorName: displayName,
    ...(replyTo ? { replyTo } : {}),
    ...(opts.mediaType ? { mediaType: opts.mediaType } : {}),
    createdAt: now,
  };
  const ref = await addDoc(collection(db, "dms", threadId, "messages"), msg);
  // Keeps the thread list ordered and previewable without reading messages.
  // A photo with no caption would otherwise leave the thread list blank.
  const preview = content.trim()
    ? content.slice(0, 80)
    : opts.mediaType === "photo"
      ? "📷 Photo"
      : "";
  void updateDoc(doc(db, "dms", threadId), {
    lastMessageAt: now,
    lastMessagePreview: preview,
  }).catch(() => undefined);
  return { ...msg, id: ref.id };
}

/**
 * Attach a photo to a direct message. Goes through a Cloud Function for the
 * same reasons as club chat media: React Native has no Blob, and the Firestore
 * rule lets a participant change nothing but `reactions` on a message, so the
 * media fields have to be written server-side.
 */
export async function uploadDmMedia(
  threadId: string,
  messageId: string,
  localUri: string,
  mimeType: string,
  fileKey: string = "media",
): Promise<string> {
  const base64 = await FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const fn = httpsCallable<
    { threadId: string; messageId: string; base64: string; contentType: string; fileKey?: string },
    { mediaUrl: string }
  >(functions, "uploadDmMedia");
  const { data } = await fn({ threadId, messageId, base64, contentType: mimeType, fileKey });
  return data.mediaUrl;
}

export async function toggleDmReaction(
  threadId: string,
  message: DmMessage,
  emoji: string,
  uid: string,
): Promise<void> {
  const hasReacted = (message.reactions?.[emoji] ?? []).includes(uid);
  await updateDoc(
    doc(db, "dms", threadId, "messages", message.id),
    new FieldPath("reactions", emoji),
    hasReacted ? arrayRemove(uid) : arrayUnion(uid),
  );
}

/** Your own messages only — a private thread has no moderator. */
export async function deleteDmMessage(threadId: string, messageId: string): Promise<void> {
  await deleteDoc(doc(db, "dms", threadId, "messages", messageId));
}

/**
 * Live per-thread unread counts, keyed by threadId. Only threads with unread
 * messages are returned; callers default a missing thread to zero.
 *
 * Filtered server-side for the same reason as subscribeChannelUnread — a
 * listener bills a read per delivered document, so streaming every thread just
 * to drop the zeros in the client is paid-for waste.
 */
export function subscribeDmUnread(
  uid: string,
  onUpdate: (byThread: Record<string, number>) => void,
): () => void {
  const q = query(
    collection(db, "users", uid, "dmThreads"),
    where("unreadCount", ">", 0),
    limit(200),
  );
  return onSnapshot(q, (snap) => {
    const map: Record<string, number> = {};
    for (const d of snap.docs) {
      const count = (d.data() as { unreadCount?: number }).unreadCount ?? 0;
      if (count > 0) map[d.id] = count;
    }
    onUpdate(map);
  });
}

/**
 * Clear a thread's unread count and decrement the global total.
 *
 * Same transaction shape as markChannelRead: subtract this thread's count from
 * unreadTotal rather than recomputing, so the app-icon badge stays consistent
 * with club chat, which shares that counter.
 */
export async function markDmRead(uid: string, threadId: string): Promise<number> {
  const userRef = doc(db, "users", uid);
  const prefRef = doc(db, "users", uid, "dmThreads", threadId);
  return runTransaction(db, async (tx) => {
    const [userSnap, prefSnap] = await Promise.all([tx.get(userRef), tx.get(prefRef)]);
    const threadUnread = (prefSnap.data()?.unreadCount as number | undefined) ?? 0;
    const currentTotal = (userSnap.data()?.unreadTotal as number | undefined) ?? 0;
    const newTotal = Math.max(0, currentTotal - threadUnread);
    tx.set(prefRef, { lastReadAt: new Date().toISOString(), unreadCount: 0 }, { merge: true });
    tx.set(userRef, { unreadTotal: newTotal }, { merge: true });
    return newTotal;
  });
}
