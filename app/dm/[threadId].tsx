import { Ionicons } from "@expo/vector-icons";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library/legacy";
import * as Sharing from "expo-sharing";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { doc, getDoc } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { currentUser } from "@/services/auth";
import {
  deleteDmMessage,
  markDmRead,
  sendDmMessage,
  subscribeDmMessages,
  toggleDmReaction,
  uploadDmMedia,
} from "@/services/dmService";
import { setAppBadge } from "@/services/badge";
import { db } from "@/services/firebase";
import type { DmMessage, DmThread } from "@/models/club";
import { Avatar } from "@/ui/Avatar";
import { LinkifiedText } from "@/ui/LinkifiedText";
import { colors, radii, shadow, spacing, type } from "@/ui/theme";

const SCREEN_W = Dimensions.get("window").width;
const REACTION_EMOJI = ["👍", "❤️", "😂", "🤙", "🔥", "😮"];

/** The photos on a message: the multi-image grid, or the single legacy field. */
function photosOf(m: DmMessage): string[] {
  if (m.mediaUrls && m.mediaUrls.length > 0) return m.mediaUrls;
  return m.mediaUrl ? [m.mediaUrl] : [];
}

export default function DmThreadScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const user = currentUser();

  const [thread, setThread] = useState<DmThread | null>(null);
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [actionTarget, setActionTarget] = useState<DmMessage | null>(null);
  // Photos picked but not yet sent — staged in the caption preview sheet.
  const [pendingMedia, setPendingMedia] = useState<
    { assets: ImagePicker.ImagePickerAsset[]; caption: string } | null
  >(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  // Full-screen viewer, the page it's showing, its long-press menu, and a
  // guard so a save/share can't fire twice mid-download.
  const [viewer, setViewer] = useState<{ urls: string[]; index: number } | null>(null);
  const [viewerPage, setViewerPage] = useState(0);
  const [viewerMenu, setViewerMenu] = useState(false);
  const [savingImage, setSavingImage] = useState(false);

  useEffect(() => {
    if (!threadId) return;
    void getDoc(doc(db, "dms", threadId)).then((snap) => {
      if (snap.exists()) setThread(snap.data() as DmThread);
    });
  }, [threadId]);

  const otherUid = useMemo(
    () => thread?.participants.find((p) => p !== user?.uid),
    [thread, user?.uid],
  );
  const otherName = otherUid ? (thread?.participantNames?.[otherUid] ?? "Member") : "";

  useEffect(() => {
    if (otherName) navigation.setOptions({ title: otherName });
  }, [otherName, navigation]);

  useEffect(() => {
    if (!threadId) return;
    return subscribeDmMessages(threadId, setMessages);
  }, [threadId]);

  // Clear this thread's unread count on open, and sync the app-icon badge to
  // the new global total. Re-runs when messages arrive so a thread read while
  // it's on screen doesn't stay counted.
  useEffect(() => {
    if (!user || !threadId) return;
    void markDmRead(user.uid, threadId).then(setAppBadge).catch(() => undefined);
  }, [user?.uid, threadId, messages.length]);

  const reversed = useMemo(() => [...messages].reverse(), [messages]);

  const onSend = async () => {
    const content = text.trim();
    if (!content || !threadId || !user) return;
    setText("");
    setSending(true);
    try {
      await sendDmMessage(threadId, user.uid, user.displayName ?? "Member", content);
    } catch (e) {
      // Surface the real error rather than a generic string: the failure that
      // matters here is a rules denial (permission-denied), and hiding its
      // code makes an undeployed firestore.rules look like a code bug.
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert("Couldn't send", msg);
    } finally {
      setSending(false);
    }
  };

  // Pick photos, then stage them in a preview so the sender can add a caption
  // before anything posts. Any text already in the composer pre-fills it.
  //
  // Images only: DM media goes up as base64 through a callable, and a video
  // would blow past that payload cap. Club chat has the signed-URL path for
  // video; a private thread doesn't need it.
  const onPickMedia = async () => {
    if (!threadId || !user) return;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Allow photo library access to share photos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
      allowsMultipleSelection: true,
      selectionLimit: 8,
    });
    if (result.canceled || result.assets.length === 0) return;
    setPendingMedia({ assets: result.assets, caption: text.trim() });
    if (text.trim()) setText("");
  };

  const sendPendingMedia = async () => {
    if (!threadId || !user || !pendingMedia) return;
    const { assets, caption } = pendingMedia;
    setPendingMedia(null);

    const name = user.displayName ?? "Member";
    try {
      // One message carries the whole batch — a single photo lands on
      // mediaUrl, several render as a grid, same as club chat.
      const msg = await sendDmMessage(threadId, user.uid, name, caption.trim(), undefined, {
        mediaType: "photo",
      });
      const localUris = assets.map((a) => a.uri);
      // Show the local files immediately so the send feels instant; each is
      // swapped for its remote URL as the upload lands.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? assets.length === 1
              ? { ...m, mediaUrl: localUris[0] }
              : { ...m, mediaUrls: localUris }
            : m,
        ),
      );
      setUploadingId(msg.id);

      if (assets.length === 1) {
        const img = assets[0]!;
        const url = await uploadDmMedia(
          threadId, msg.id, img.uri, img.mimeType ?? "image/jpeg",
        );
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, mediaUrl: url } : m)));
      } else {
        const uploaded: string[] = [];
        for (let i = 0; i < assets.length; i++) {
          const img = assets[i]!;
          const url = await uploadDmMedia(
            threadId, msg.id, img.uri, img.mimeType ?? "image/jpeg", `media-${i}`,
          );
          uploaded.push(url);
          const merged = [...uploaded, ...localUris.slice(uploaded.length)];
          setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, mediaUrls: merged } : m)));
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : "Unknown error";
      Alert.alert("Upload failed", err);
    } finally {
      setUploadingId(null);
    }
  };

  // Chat photos are remote URLs; both saving and sharing need a local file
  // first. Download to the cache with a .jpg name so Photos and the share
  // sheet recognize the type.
  const downloadOne = async (url: string) => {
    const rand = Math.random().toString(36).slice(2, 7);
    const target = `${FileSystem.cacheDirectory}imuatrak-dm-${Date.now()}-${rand}.jpg`;
    const { uri } = await FileSystem.downloadAsync(url, target);
    return uri;
  };

  const saveUrlsToPhotos = async (rawUrls: (string | undefined)[]) => {
    const urls = rawUrls.filter((u): u is string => !!u);
    if (!urls.length || savingImage) return;
    setSavingImage(true);
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) {
        Alert.alert("Permission needed", "Allow photo access in Settings to save to your library.");
        return;
      }
      for (const url of urls) {
        const uri = await downloadOne(url);
        await MediaLibrary.saveToLibraryAsync(uri);
      }
      setViewerMenu(false);
      Alert.alert("Saved", `${urls.length > 1 ? `${urls.length} photos` : "Photo"} saved to your library.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert("Couldn't save", msg);
    } finally {
      setSavingImage(false);
    }
  };

  const shareOne = async (url: string | undefined) => {
    if (!url || savingImage) return;
    setSavingImage(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Sharing unavailable", "This device can't share files.");
        return;
      }
      const uri = await downloadOne(url);
      setViewerMenu(false);
      await Sharing.shareAsync(uri, { mimeType: "image/jpeg", UTI: "public.jpeg" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert("Couldn't share", msg);
    } finally {
      setSavingImage(false);
    }
  };

  const onToggleReaction = (message: DmMessage, emoji: string) => {
    if (!threadId || !user) return;
    const uid = user.uid;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== message.id) return m;
        const uids = m.reactions?.[emoji] ?? [];
        const next = uids.includes(uid) ? uids.filter((u) => u !== uid) : [...uids, uid];
        return { ...m, reactions: { ...(m.reactions ?? {}), [emoji]: next } };
      }),
    );
    void toggleDmReaction(threadId, message, emoji, uid).catch(() => undefined);
  };

  const onDelete = (message: DmMessage) => {
    if (!threadId) return;
    Alert.alert("Delete message?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setMessages((prev) => prev.filter((m) => m.id !== message.id));
          void deleteDmMessage(threadId, message.id).catch(() => {
            Alert.alert("Couldn't delete", "Please try again.");
          });
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior="padding"
        keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}
      >
        <FlatList
          data={reversed}
          keyExtractor={(m) => m.id}
          inverted
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Bubble
              message={item}
              isMe={item.authorId === user?.uid}
              myUid={user?.uid}
              uploading={uploadingId === item.id}
              avatarUrl={
                item.authorId === otherUid ? thread?.participantAvatars?.[item.authorId] : undefined
              }
              onLongPress={() => setActionTarget(item)}
              onToggleReaction={(e) => onToggleReaction(item, e)}
              onPressImage={(urls, index) => {
                setViewerPage(index);
                setViewerMenu(false);
                setViewer({ urls, index });
              }}
            />
          )}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>
                No messages yet. Say hi to {otherName || "them"}.
              </Text>
            </View>
          }
        />

        <View style={styles.composer}>
          <Pressable onPress={onPickMedia} hitSlop={8} style={styles.mediaBtn}>
            <Ionicons name="image-outline" size={26} color={colors.ocean} />
          </Pressable>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Message..."
            placeholderTextColor={colors.muted}
            multiline
            maxLength={1000}
          />
          <Pressable
            onPress={onSend}
            disabled={sending || !text.trim()}
            hitSlop={8}
            style={[styles.sendBtn, (!text.trim() || sending) && styles.sendBtnDisabled]}
          >
            {sending ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Ionicons name="send" size={18} color={colors.white} />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      {actionTarget && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setActionTarget(null)}>
          <Pressable style={styles.sheetBackdrop} onPress={() => setActionTarget(null)}>
            <View style={styles.sheetCard}>
              <View style={styles.emojiRow}>
                {REACTION_EMOJI.map((e) => (
                  <Pressable
                    key={e}
                    style={styles.emojiBtn}
                    onPress={() => {
                      onToggleReaction(actionTarget, e);
                      setActionTarget(null);
                    }}
                  >
                    <Text style={styles.emojiTxt}>{e}</Text>
                  </Pressable>
                ))}
              </View>
              {photosOf(actionTarget).length > 0 && (
                <>
                  <Pressable
                    style={styles.sheetRow}
                    disabled={savingImage}
                    onPress={() => {
                      const urls = photosOf(actionTarget);
                      setActionTarget(null);
                      void saveUrlsToPhotos(urls);
                    }}
                  >
                    <Ionicons name="download-outline" size={20} color={colors.ink} />
                    <Text style={styles.sheetRowText}>Save to Photos</Text>
                  </Pressable>
                  <Pressable
                    style={styles.sheetRow}
                    disabled={savingImage}
                    onPress={() => {
                      const urls = photosOf(actionTarget);
                      setActionTarget(null);
                      void shareOne(urls[0]);
                    }}
                  >
                    <Ionicons name="share-outline" size={20} color={colors.ink} />
                    <Text style={styles.sheetRowText}>Share</Text>
                  </Pressable>
                </>
              )}
              {actionTarget.authorId === user?.uid && (
                <Pressable
                  style={styles.sheetRow}
                  onPress={() => {
                    const target = actionTarget;
                    setActionTarget(null);
                    onDelete(target);
                  }}
                >
                  <Ionicons name="trash-outline" size={20} color={colors.danger} />
                  <Text style={[styles.sheetRowText, { color: colors.danger }]}>Delete</Text>
                </Pressable>
              )}
            </View>
          </Pressable>
        </Modal>
      )}

      {/* Full-screen photo viewer with horizontal paging */}
      {viewer && (
        <Modal visible animationType="fade" onRequestClose={() => setViewer(null)} statusBarTranslucent>
          <View style={styles.viewerBg}>
            <FlatList
              horizontal
              pagingEnabled
              data={viewer.urls}
              initialScrollIndex={viewer.index}
              getItemLayout={(_, i) => ({ length: SCREEN_W, offset: SCREEN_W * i, index: i })}
              keyExtractor={(_, i) => String(i)}
              onMomentumScrollEnd={(e) =>
                setViewerPage(Math.round(e.nativeEvent.contentOffset.x / SCREEN_W))
              }
              renderItem={({ item }) => (
                <Pressable
                  style={styles.viewerPage}
                  onPress={() => setViewer(null)}
                  onLongPress={() => setViewerMenu(true)}
                  delayLongPress={300}
                >
                  <Image source={{ uri: item }} style={styles.viewerImage} resizeMode="contain" />
                </Pressable>
              )}
            />
            <Pressable
              style={[styles.viewerClose, { top: Math.max(insets.top, spacing.sm) }]}
              onPress={() => setViewer(null)}
              hitSlop={16}
            >
              <Ionicons name="close" size={30} color={colors.white} />
            </Pressable>

            {viewerMenu && (
              <Pressable style={styles.viewerMenuBackdrop} onPress={() => setViewerMenu(false)}>
                <Pressable style={styles.viewerMenuSheet} onPress={(e) => e.stopPropagation()}>
                  <Pressable
                    style={styles.sheetRow}
                    onPress={() => saveUrlsToPhotos([viewer.urls[viewerPage]])}
                    disabled={savingImage}
                  >
                    {savingImage ? (
                      <ActivityIndicator size="small" color={colors.ink} />
                    ) : (
                      <Ionicons name="download-outline" size={22} color={colors.ink} />
                    )}
                    <Text style={styles.sheetRowText}>Save to Photos</Text>
                  </Pressable>
                  <Pressable
                    style={styles.sheetRow}
                    onPress={() => shareOne(viewer.urls[viewerPage])}
                    disabled={savingImage}
                  >
                    <Ionicons name="share-outline" size={22} color={colors.ink} />
                    <Text style={styles.sheetRowText}>Share</Text>
                  </Pressable>
                  <Pressable style={styles.sheetRow} onPress={() => setViewerMenu(false)}>
                    <Ionicons name="close-outline" size={22} color={colors.muted} />
                    <Text style={[styles.sheetRowText, { color: colors.muted }]}>Cancel</Text>
                  </Pressable>
                </Pressable>
              </Pressable>
            )}
          </View>
        </Modal>
      )}

      {/* Photo caption preview — pick, add a caption, then send. */}
      {pendingMedia && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPendingMedia(null)}>
          <KeyboardAvoidingView style={styles.previewFill} behavior="padding">
            <Pressable style={styles.previewBackdrop} onPress={() => setPendingMedia(null)}>
              <Pressable style={styles.previewSheet} onPress={(e) => e.stopPropagation()}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.previewThumbs}
                >
                  {pendingMedia.assets.map((a, i) => (
                    <Image
                      key={`${a.uri}-${i}`}
                      source={{ uri: a.uri }}
                      style={styles.previewThumb}
                      resizeMode="cover"
                    />
                  ))}
                </ScrollView>
                <View style={styles.previewInputRow}>
                  <TextInput
                    style={styles.previewInput}
                    value={pendingMedia.caption}
                    onChangeText={(t) => setPendingMedia((p) => (p ? { ...p, caption: t } : p))}
                    placeholder="Add a caption…"
                    placeholderTextColor={colors.muted}
                    multiline
                    maxLength={1000}
                    autoFocus
                  />
                  <Pressable style={styles.previewSend} onPress={sendPendingMedia} hitSlop={8}>
                    <Ionicons name="send" size={20} color={colors.white} />
                  </Pressable>
                </View>
              </Pressable>
            </Pressable>
          </KeyboardAvoidingView>
        </Modal>
      )}
    </SafeAreaView>
  );
}

function Bubble({
  message,
  isMe,
  myUid,
  uploading,
  avatarUrl,
  onLongPress,
  onToggleReaction,
  onPressImage,
}: {
  message: DmMessage;
  isMe: boolean;
  myUid?: string;
  uploading: boolean;
  avatarUrl?: string;
  onLongPress: () => void;
  onToggleReaction: (emoji: string) => void;
  onPressImage: (urls: string[], index: number) => void;
}) {
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const reactionEntries = Object.entries(message.reactions ?? {}).filter(([, u]) => u.length > 0);
  const photoUrls = photosOf(message);

  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={300}
      style={[styles.row, isMe ? styles.rowMe : styles.rowThem]}
    >
      {!isMe && (
        <Avatar uri={avatarUrl} name={message.authorName} uid={message.authorId} size={28} />
      )}
      <View style={[styles.bubbleWrap, { alignItems: isMe ? "flex-end" : "flex-start" }]}>
        <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubbleThem]}>
          {photoUrls.length > 0 && (
            <MediaGrid
              urls={photoUrls}
              uploading={uploading}
              onPressImage={(i) => onPressImage(photoUrls, i)}
              onLongPress={onLongPress}
            />
          )}
          {message.content.length > 0 && (
            <LinkifiedText
              text={message.content}
              style={[styles.messageText, isMe && { color: colors.white }]}
              linkStyle={{ color: isMe ? colors.seafoam : colors.ocean }}
            />
          )}
          <Text style={[styles.time, isMe && { color: "rgba(255,255,255,0.7)" }]}>{time}</Text>
        </View>

        {reactionEntries.length > 0 && (
          <View style={[styles.reactionRow, isMe && { justifyContent: "flex-end" }]}>
            {reactionEntries.map(([emoji, uids]) => (
              <Pressable
                key={emoji}
                onPress={() => onToggleReaction(emoji)}
                style={[
                  styles.reactionChip,
                  !!myUid && uids.includes(myUid) && styles.reactionChipMine,
                ]}
              >
                <Text style={styles.reactionText}>
                  {emoji} {uids.length}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </Pressable>
  );
}

/**
 * Same layout as club chat: one photo full width; 2+ in a 2-column grid capped
 * at 4 tiles with a "+N" overlay on the last. Tap opens the viewer.
 */
function MediaGrid({
  urls,
  uploading,
  onPressImage,
  onLongPress,
}: {
  urls: string[];
  uploading: boolean;
  onPressImage: (index: number) => void;
  onLongPress: () => void;
}) {
  if (urls.length === 1) {
    return (
      <Pressable
        style={styles.mediaWrap}
        onPress={() => onPressImage(0)}
        onLongPress={onLongPress}
        delayLongPress={300}
      >
        <Image source={{ uri: urls[0] }} style={styles.mediaImage} resizeMode="cover" />
        {uploading && (
          <View style={styles.uploadingOverlay}>
            <ActivityIndicator color={colors.white} />
          </View>
        )}
      </Pressable>
    );
  }

  const shown = urls.slice(0, 4);
  const extra = urls.length - shown.length;
  return (
    <View style={styles.mediaWrap}>
      <View style={styles.gridWrap}>
        {shown.map((u, i) => (
          <Pressable
            key={`${u}-${i}`}
            style={styles.gridTile}
            onPress={() => onPressImage(i)}
            onLongPress={onLongPress}
            delayLongPress={300}
          >
            <Image source={{ uri: u }} style={styles.gridImage} resizeMode="cover" />
            {i === shown.length - 1 && extra > 0 && (
              <View style={styles.gridMore}>
                <Text style={styles.gridMoreText}>+{extra}</Text>
              </View>
            )}
          </Pressable>
        ))}
      </View>
      {uploading && (
        <View style={styles.uploadingOverlay}>
          <ActivityIndicator color={colors.white} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  list: { padding: spacing.md, paddingBottom: spacing.lg },
  row: { marginVertical: 3, flexDirection: "row", alignItems: "flex-end", gap: spacing.xs },
  rowMe: { justifyContent: "flex-end" },
  rowThem: { justifyContent: "flex-start" },
  // The width cap lives here, on the direct child of the row, not on the bubble
  // inside it. A percentage maxWidth resolves against the parent's width — and
  // when that parent is sized by its own child, the constraint is circular and
  // Yoga collapses it, which squeezed bubbles down to a few characters and
  // broke words mid-token. alignItems lets the bubble hug its content within
  // the cap instead of stretching to it.
  bubbleWrap: { flexShrink: 1, maxWidth: "80%" },
  bubble: {
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...shadow.sm,
  },
  bubbleMe: { backgroundColor: colors.ocean },
  bubbleThem: { backgroundColor: colors.white },
  messageText: { fontSize: type.size.md, color: colors.ink, lineHeight: 20 },
  time: { fontSize: 10, color: colors.muted, marginTop: 3, textAlign: "right" },
  mediaWrap: { position: "relative", marginBottom: spacing.xs },
  mediaImage: { width: 220, height: 160, borderRadius: radii.md },
  gridWrap: { width: 220, flexDirection: "row", flexWrap: "wrap", gap: 4 },
  gridTile: { width: 108, height: 108, borderRadius: radii.sm, overflow: "hidden", position: "relative" },
  gridImage: { width: "100%", height: "100%" },
  gridMore: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
  },
  gridMoreText: { color: colors.white, fontSize: type.size.xl, fontWeight: type.weight.heavy },
  uploadingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.4)",
    borderRadius: radii.md,
    justifyContent: "center",
    alignItems: "center",
  },
  reactionRow: { flexDirection: "row", gap: 4, marginTop: 3, flexWrap: "wrap" },
  reactionChip: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.white,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  reactionChipMine: { borderColor: colors.ocean },
  reactionText: { fontSize: 12, color: colors.ink },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.white,
  },
  mediaBtn: { paddingBottom: spacing.xs + 2 },
  input: {
    flex: 1,
    maxHeight: 110,
    backgroundColor: colors.bg,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: type.size.md,
    color: colors.ink,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.ocean,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { backgroundColor: colors.line },
  emptyWrap: { padding: spacing.xl, alignItems: "center", transform: [{ scaleY: -1 }] },
  emptyText: { color: colors.muted, fontSize: type.size.sm, textAlign: "center" },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheetCard: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    padding: spacing.lg,
  },
  emojiRow: { flexDirection: "row", justifyContent: "space-around", marginBottom: spacing.md },
  emojiBtn: { padding: spacing.xs },
  emojiTxt: { fontSize: 26 },
  sheetRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.md },
  sheetRowText: { fontSize: type.size.md, color: colors.ink },
  viewerBg: { flex: 1, backgroundColor: "#000" },
  viewerPage: { width: SCREEN_W, height: "100%", justifyContent: "center" },
  viewerImage: { width: "100%", height: "100%" },
  // `top` is set inline from the safe-area inset — a Modal is its own native
  // window, so SafeAreaView measures nothing inside it.
  viewerClose: {
    position: "absolute",
    right: spacing.md,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  viewerMenuBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
    padding: spacing.lg,
  },
  viewerMenuSheet: {
    backgroundColor: colors.white,
    borderRadius: radii.xl,
    padding: spacing.md,
    gap: spacing.xs,
    marginBottom: spacing.xl,
    ...shadow.sm,
  },
  previewFill: { flex: 1 },
  previewBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  previewSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    padding: spacing.md,
    gap: spacing.md,
  },
  previewThumbs: { gap: spacing.sm, paddingVertical: spacing.xs },
  previewThumb: { width: 96, height: 96, borderRadius: radii.md, backgroundColor: colors.bg },
  previewInputRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  previewInput: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === "ios" ? spacing.sm : spacing.xs,
    fontSize: type.size.md,
    color: colors.ink,
    maxHeight: 120,
  },
  previewSend: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.ocean,
    justifyContent: "center",
    alignItems: "center",
  },
});
