// Club-related types. Kept separate from session models to avoid bloating the core.

export type ClubId = string;
export type MemberRole = "owner" | "admin" | "coach" | "member";
// "free" is the default for a newly created club: no plan, ads shown, Pro
// features locked. Clubs are NOT put on an automatic trial — a trial is now
// opt-in. "trial"/"active" grant ad-free + Pro; "expired" is a lapsed
// trial/plan (same access as "free", but labeled so the owner sees it ended).
export type SubscriptionStatus = "free" | "trial" | "active" | "expired";
export type SubscriptionTier = "basic" | "pro";
export type EventType = "practice" | "race" | "social";
/**
 * "photo" is the club gallery. It shares the posts collection so likes,
 * comments, deletion and moderation all work unchanged — but unlike the other
 * types any member may create one, and it renders in the gallery grid rather
 * than the Team Updates feed.
 */
export type PostType = "announcement" | "post" | "poll" | "photo";

export interface PollOption {
  text: string;
}
export type RsvpStatus = "going" | "maybe" | "not_going";

export interface Club {
  id: ClubId;
  name: string;
  slug: string;
  description: string;
  logoUrl?: string;
  websiteUrl?: string;
  sport: "outrigger";
  location: { city: string; country: string };
  ownerId: string;
  subscriptionStatus: SubscriptionStatus;
  subscriptionTier: SubscriptionTier;
  trialEndsAt?: string;
  /** Set once, server-side, when an owner opts into the one-time free trial.
   *  Its presence is the durable proof a club has already used its trial. */
  trialStartedAt?: string;
  subscriptionRenewsAt?: string;
  /** Set by the syncClubPlan/revenuecatWebhook Cloud Functions when an
   *  owner/admin's in-app club plan is keeping this club active. */
  clubPlan?: { payerUid: string; productId?: string | null; activatedAt?: string };
  memberCount: number;
  /**
   * Delete chat messages older than this many days. Absent or 0 keeps
   * everything, which is the default — a club has to opt in before anything
   * is deleted. Pinned messages are never swept.
   */
  chatRetentionDays?: number;
  createdAt: string;
}

/** Retention choices offered in club settings. 0 means keep everything. */
export const CHAT_RETENTION_OPTIONS: { days: number; label: string }[] = [
  { days: 0, label: "Keep all" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
];

/**
 * Whether a club's subscription grants its members ad-free access right now.
 *
 * A "trial" only counts while trialEndsAt is still in the future — the
 * scheduled expireClubTrials Cloud Function flips overdue trials to "expired"
 * at most once a day, so the status string alone can lag reality. All club
 * timestamps are ISO-8601 UTC strings, so plain string comparison is safe.
 */
export function clubGrantsAdFree(
  club: Pick<Club, "subscriptionStatus" | "trialEndsAt"> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!club) return false;
  if (club.subscriptionStatus === "active") return true;
  return (
    club.subscriptionStatus === "trial" &&
    typeof club.trialEndsAt === "string" &&
    club.trialEndsAt > now.toISOString()
  );
}

/**
 * Whether a club is on a paid (or still-valid trial) plan, which unlocks the
 * Pro-tier features — the photo gallery and additional chat channels — on top
 * of ad-free access. Same condition as clubGrantsAdFree today; named separately
 * so feature-gating call sites read clearly and the two can diverge later
 * (e.g. a cheaper ad-free-only tier) without hunting every reference.
 */
export function clubIsPro(
  club: Pick<Club, "subscriptionStatus" | "trialEndsAt"> | null | undefined,
  now: Date = new Date(),
): boolean {
  return clubGrantsAdFree(club, now);
}

/** Chat channels a free (basic) club may have — the default "general" only.
 *  Additional channels require the Pro club plan. */
export const FREE_CHANNEL_LIMIT = 1;

/** A paddler's preferred rigging side, so coaches can seat them correctly. */
export type PaddleSide = "left" | "right" | "either";

export interface ClubMember {
  uid: string;
  role: MemberRole;
  displayName: string;
  avatarUrl?: string;
  joinedAt: string;
  invitedBy?: string;
  /** Birthday as "MM-DD" (no year — only month/day is needed to celebrate it,
   *  and it keeps the paddler's age private). */
  birthday?: string;
  /** Preferred paddling side. Absent means not set. */
  paddleSide?: PaddleSide;
}

/** Short label for a paddling side, or null when unset. */
export function paddleSideLabel(side: PaddleSide | undefined): string | null {
  switch (side) {
    case "left": return "Left";
    case "right": return "Right";
    case "either": return "Either";
    default: return null;
  }
}

/** True when the "MM-DD" birthday falls on `now`'s month/day. */
export function isBirthdayToday(birthday: string | undefined, now: Date = new Date()): boolean {
  if (!birthday) return false;
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return birthday === `${mm}-${dd}`;
}

/** Format a "MM-DD" birthday as e.g. "Aug 20", or null when unset/invalid. */
export function formatBirthday(birthday: string | undefined): string | null {
  if (!birthday) return null;
  const [mm, dd] = birthday.split("-").map(Number);
  if (!mm || !dd) return null;
  return new Date(2000, mm - 1, dd).toLocaleDateString([], { month: "short", day: "numeric" });
}

export interface EventRsvp {
  uid: string;
  status: RsvpStatus;
  updatedAt: string;
  /** Names of guest paddlers this member is bringing. Guests count toward
   *  attendance and capacity while the member's status is "going". */
  guests?: string[];
}

/** Going headcount including guests brought by going members. */
export function eventGoingCount(rsvps: EventRsvp[]): number {
  return rsvps.reduce(
    (n, r) => (r.status === "going" ? n + 1 + (r.guests?.length ?? 0) : n),
    0,
  );
}

/**
 * A guest paddler occupying a seat.
 *
 * Guests have no account and no uid — they exist only as names inside the
 * host member's `EventRsvp.guests`. So a seat identifies one by the member who
 * registered them plus the name that member gave, which stays stable when the
 * host adds or removes other guests (an index would not).
 */
export interface SeatGuest {
  hostUid: string;
  name: string;
}

export interface SeatAssignment {
  seatNumber: number;
  uid: string | null;
  /**
   * Set when a guest holds this seat instead of a member; `uid` is null then.
   * Absent on every lineup saved before guests could be seated, so read it as
   * optional and always WRITE an explicit null rather than undefined — the
   * Firestore instance in services/firebase.ts does not set
   * ignoreUndefinedProperties, so an undefined field throws on write.
   */
  guest?: SeatGuest | null;
}

/**
 * Every guest that can be given a seat: those registered by members who are
 * actually going. A guest whose host is "maybe" or "not going" is not on the
 * water, so they are not offered.
 */
export function seatableGuests(rsvps: EventRsvp[]): SeatGuest[] {
  return rsvps
    .filter((r) => r.status === "going")
    .flatMap((r) => (r.guests ?? []).map((name) => ({ hostUid: r.uid, name })));
}

/** Whether two seat references point at the same registered guest. */
export function isSameGuest(a?: SeatGuest | null, b?: SeatGuest | null): boolean {
  return !!a && !!b && a.hostUid === b.hostUid && a.name === b.name;
}

/**
 * Whether a seated guest is still registered for the event.
 *
 * A host can remove a guest, or drop to "not going", after the coach has
 * seated them. The seat is NOT auto-cleared when that happens: Firestore rules
 * let a plain member write only `rsvps`, so a member removing their own guest
 * cannot touch `boatAssignments` — attempting it would fail the whole removal
 * on a permission error. The lineup instead marks the seat as stale so staff,
 * who can write it, notice and clear it.
 */
export function isGuestStillGoing(guest: SeatGuest, rsvps: EventRsvp[]): boolean {
  return seatableGuests(rsvps).some((g) => isSameGuest(g, guest));
}

/** Whoever can hold a seat: a club member, or a registered guest. */
export type SeatOccupant = { uid: string } | { guest: SeatGuest };

/** Whether this seat is currently held by that exact person. */
export function seatHolds(seat: SeatAssignment, occupant: SeatOccupant): boolean {
  if ("uid" in occupant) return seat.uid === occupant.uid;
  return seat.uid == null && isSameGuest(seat.guest, occupant.guest);
}

/** Which seat a person currently occupies, if any. */
export function findSeatOf(
  boats: BoatAssignment[],
  occupant: SeatOccupant,
): { boatIdx: number; seatIdx: number } | null {
  for (let b = 0; b < boats.length; b++) {
    const seats = boats[b]!.seats;
    for (let s = 0; s < seats.length; s++) {
      if (seatHolds(seats[s]!, occupant)) return { boatIdx: b, seatIdx: s };
    }
  }
  return null;
}

/**
 * Put someone in a seat, or clear it, returning a new set of boats.
 *
 * Nobody can sit in two places at once, so this MOVES rather than copies:
 * assigning a person who already holds a seat vacates that one first, across
 * every boat and not just the one being edited. The picker offers everyone who
 * is going regardless of whether they are already seated, so without this a
 * coach could seat the same paddler twice and the lineup would claim more crew
 * than actually turned up.
 *
 * Occupant fields are always written as an explicit pair — Firestore has no
 * ignoreUndefinedProperties here, and writing only one of them would leave the
 * previous occupant behind when swapping a member for a guest.
 */
export function assignSeat(
  boats: BoatAssignment[],
  boatIdx: number,
  seatIdx: number,
  occupant: SeatOccupant | null,
): BoatAssignment[] {
  const next: BoatAssignment[] = JSON.parse(JSON.stringify(boats));
  const target = next[boatIdx]?.seats[seatIdx];
  if (!target) return next;

  if (occupant) {
    for (const boat of next) {
      for (const seat of boat.seats) {
        if (seatHolds(seat, occupant)) {
          seat.uid = null;
          seat.guest = null;
        }
      }
    }
  }

  target.uid = occupant && "uid" in occupant ? occupant.uid : null;
  target.guest = occupant && "guest" in occupant ? occupant.guest : null;
  return next;
}

export type BoatType = "OC1" | "OC2" | "OC4" | "OC6" | "DB10" | "DB20";

/** A non-paddling crew seat, and where it sits in the boat. */
export interface CrewSeat {
  label: string;
  position: "bow" | "stern";
}

export interface BoatSpec {
  /**
   * Seats holding paddlers, numbered 1..n. Dragon boats pair these left/right
   * — odd numbers paddle left, even paddle right, so 1 and 2 share the bow
   * bench.
   */
  paddlerSeats: number;
  paired: boolean;
  /** Appended after the paddler seats, so paddler numbering stays 1..n. */
  crewSeats: CrewSeat[];
}

/**
 * The boats a club can set a lineup for.
 *
 * A dragon boat carries a drummer at the bow and a steer at the stern on top
 * of its paddlers, so a DB20 seats 22 people and a DB10 seats 12 — a DB10
 * halves the paddlers, not the crew. Outrigger hulls are single file and
 * carry no separate crew: an OC6's sixth seat steers while paddling.
 */
export const BOAT_SPECS: Record<BoatType, BoatSpec> = {
  OC1: { paddlerSeats: 1, paired: false, crewSeats: [] },
  OC2: { paddlerSeats: 2, paired: false, crewSeats: [] },
  OC4: { paddlerSeats: 4, paired: false, crewSeats: [] },
  OC6: { paddlerSeats: 6, paired: false, crewSeats: [] },
  DB10: {
    paddlerSeats: 10,
    paired: true,
    crewSeats: [
      { label: "Drummer", position: "bow" },
      { label: "Steer", position: "stern" },
    ],
  },
  DB20: {
    paddlerSeats: 20,
    paired: true,
    crewSeats: [
      { label: "Drummer", position: "bow" },
      { label: "Steer", position: "stern" },
    ],
  },
};

export const BOAT_TYPES = Object.keys(BOAT_SPECS) as BoatType[];

export function boatSeatCount(type: BoatType): number {
  const spec = BOAT_SPECS[type];
  return spec.paddlerSeats + spec.crewSeats.length;
}

/**
 * Best guess at the boat behind a lineup saved before boatType was stored.
 *
 * The dragon-boat sizes accept their pre-crew counts too (10 and 20), since
 * lineups created then had no drummer or steer seat at all.
 */
export function inferBoatType(seatCount: number): BoatType | null {
  switch (seatCount) {
    case 1: return "OC1";
    case 2: return "OC2";
    case 4: return "OC4";
    case 6: return "OC6";
    case 10:
    case 12: return "DB10";
    case 20:
    case 22: return "DB20";
    default: return null;
  }
}

export interface BoatAssignment {
  boatName: string;
  /** Absent on lineups saved before boat types existed — infer when reading. */
  boatType?: BoatType;
  seats: SeatAssignment[];
}

export interface ClubEvent {
  id: string;
  clubId: ClubId;
  title: string;
  description?: string;
  type: EventType;
  startAt: string;
  endAt: string;
  location?: { name: string; lat?: number; lon?: number };
  meetTime?: string;
  meetLocation?: string;
  maxParticipants?: number;
  boatAssignments?: BoatAssignment[];
  createdBy: string;
  rsvps: EventRsvp[];
  linkedSessionIds: string[];
}

export interface ClubPost {
  id: string;
  clubId: ClubId;
  type: PostType;
  content: string;
  authorId: string;
  authorName: string;
  authorAvatarUrl?: string;
  pinnedUntil?: string;
  linkedSessionId?: string;
  likeCount: number;
  likedBy?: string[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  /** Download URLs in upload order. Gallery posts (type "photo") always have
   *  them; feed posts may too, since announcements can carry a flyer. */
  mediaUrls?: string[];
  /**
   * Hashtags from the caption, normalised by `parseHashtags` — lower-cased and
   * without the leading "#", so "#RaceDay" and "#raceday" filter as one tag.
   */
  tags?: string[];
  /** Uids of members tagged in the photo ("who's in this shot"). */
  taggedUids?: string[];
  // Poll fields — present only when type === "poll"
  pollOptions?: PollOption[];
  pollVotes?: Record<string, string[]>; // key = option index string, value = voter UIDs
  pollMultipleChoice?: boolean;
  pollEndsAt?: string;
}

/** Caps how many tags one photo post carries, so a caption can't become a
 *  filter list of its own. */
export const MAX_POST_TAGS = 10;

/**
 * A fresh hashtag matcher. Returns a new object each call because the `g` flag
 * makes `lastIndex` stateful — a shared instance would skip matches when used
 * for both parsing and rendering.
 */
export function hashtagRegex(): RegExp {
  return /#([\p{L}\p{N}_]{1,30})/gu;
}

/**
 * Pull the hashtags out of a caption, normalised for storage: lower-cased,
 * "#" stripped, de-duplicated, in first-seen order.
 */
export function parseHashtags(caption: string): string[] {
  const seen = new Set<string>();
  for (const m of caption.matchAll(hashtagRegex())) {
    const tag = m[1]!.toLowerCase();
    if (!seen.has(tag)) seen.add(tag);
    if (seen.size >= MAX_POST_TAGS) break;
  }
  return [...seen];
}

export interface ClubComment {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export interface UserClubs {
  clubIds: string[];
  activeClubId: string;
}

export interface ClubMessage {
  id: string;
  clubId: ClubId;
  channelId: string;
  content: string;
  authorId: string;
  authorName: string;
  authorAvatarUrl?: string;
  mediaUrl?: string;
  mediaStoragePath?: string;
  mediaType?: "photo" | "video";
  /** Multi-image messages: download URLs in send order (grid rendering). */
  mediaUrls?: string[];
  /** Emoji reactions: emoji → uids of members who reacted. */
  reactions?: Record<string, string[]>;
  /**
   * Uids of members @-mentioned in `content`. Stored explicitly rather than
   * re-parsed from the text: display names change, and a mention has to keep
   * pointing at the person who was actually tagged. Drives the highlight in
   * the bubble and the push alert that ignores a muted channel.
   */
  mentions?: string[];
  /** Set when this message is a reply to another. */
  replyTo?: { messageId: string; authorName: string; preview: string };
  /**
   * When an owner/admin pinned this message. Pinned messages are exempt from
   * the club's chat retention sweep — pinning is how a club says "keep this",
   * so expiry has to honour it or the setting would quietly delete the very
   * messages someone marked as worth keeping.
   */
  pinnedAt?: string;
  pinnedBy?: string;
  /** Set when the author edited the message, so the bubble can show "edited". */
  editedAt?: string;
  createdAt: string;
}

export type ChannelIconType = "emoji" | "ionicon";

export interface ClubChannel {
  id: string;
  clubId: ClubId;
  name: string;
  icon: string;
  iconType: ChannelIconType;
  description?: string;
  isPrivate: boolean;
  memberIds: string[];
  createdBy: string;
  createdAt: string;
  sortOrder: number;
  lastMessageAt?: string;
}

export interface ChannelPreference {
  muteNotifications: boolean;
  lastReadAt: string;
  // Unread message count for this channel; summed across channels into the
  // user doc's unreadTotal for the app-icon badge. Maintained server-side.
  unreadCount?: number;
}

// ── Direct messages ──────────────────────────────────────────────────────────
//
// DMs live at the top level, NOT under clubs/{clubId}/channels. A two-person
// private channel would have been far less work, but the private-channel rule
// grants owners and admins read access for moderation — applied to DMs that
// would let club admins read their members' private messages, which is not
// what "private message" means to anyone. Living outside clubs also means a
// thread survives either person leaving a club, isn't deleted by a club's chat
// retention sweep, and doesn't count against a club's channel limit.

export interface DmThread {
  /** Exactly two uids, sorted — see dmThreadId. */
  participants: string[];
  /** Denormalized so a thread list can render without reading two rosters. */
  participantNames: Record<string, string>;
  participantAvatars?: Record<string, string>;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  createdAt: string;
}

export interface DmMessage {
  id: string;
  threadId: string;
  content: string;
  authorId: string;
  authorName: string;
  reactions?: Record<string, string[]>;
  replyTo?: { messageId: string; authorName: string; preview: string };
  /** Photo attachments, mirroring ClubMessage: a single photo lands on
   *  mediaUrl, several on mediaUrls (rendered as a grid). Images only — the
   *  callable upload's payload cap makes video impractical here. */
  mediaUrl?: string;
  mediaUrls?: string[];
  mediaStoragePath?: string;
  mediaType?: "photo";
  createdAt: string;
}

/**
 * Deterministic thread id for a pair of users.
 *
 * Sorting means both people compute the same id, so a conversation can't fork
 * into two threads depending on who messaged first.
 */
export function dmThreadId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join("__");
}

export interface FcmToken {
  token: string;
  platform: "ios" | "android";
  updatedAt: string;
}
