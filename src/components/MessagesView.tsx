import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, MessageSquare, Search, Send, Users } from 'lucide-react';
import type {
  ChatConversation,
  ChatMessage,
  PublicUserSummary,
  UserAccount,
} from '../types/media';
import { api } from '../lib/api';
import { syncChatMessageToFirestore } from '../lib/firestoreSync';
import { realtimeClient } from '../lib/realtime';
import {
  buildConversationId,
  formatRelativeTime,
  mergeUniqueById,
  validateMessageBody,
} from '../utils/albumLogic';
import { UserAvatar } from './UserAvatar';

interface MessagesViewProps {
  user: UserAccount | null;
  initialRecipientUid?: string | null;
  onSignIn: () => void;
  onUnreadTotalChange?: (unreadTotal: number) => void;
  onClearInitialRecipient?: () => void;
}

export function MessagesView({
  user,
  initialRecipientUid,
  onSignIn,
  onUnreadTotalChange,
  onClearInitialRecipient,
}: MessagesViewProps) {
  const [directory, setDirectory] = useState<PublicUserSummary[]>([]);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [onlineIds, setOnlineIds] = useState<Set<string>>(
    () => new Set(realtimeClient.getOnlineUserIds())
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingSidebar, setLoadingSidebar] = useState(true);

  const [activePeer, setActivePeer] = useState<PublicUserSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const activePeerRef = useRef<PublicUserSummary | null>(null);
  activePeerRef.current = activePeer;

  const loadSidebar = useCallback(async () => {
    if (!user) return;
    try {
      const [dirRes, convRes] = await Promise.all([
        api.getUserDirectory(),
        api.getConversations(),
      ]);
      setDirectory(dirRes.users);
      setConversations(convRes.conversations);
      onUnreadTotalChange?.(convRes.unreadTotal);
    } catch (err) {
      console.error('Failed to load messages sidebar:', err);
    } finally {
      setLoadingSidebar(false);
    }
  }, [user, onUnreadTotalChange]);

  const openThread = useCallback(
    async (peer: PublicUserSummary) => {
      if (!user) return;
      setActivePeer(peer);
      setError('');
      setLoadingThread(true);
      try {
        const res = await api.getConversationMessages(peer.uid);
        setActivePeer(res.otherUser);
        setMessages(res.messages);
        // Refresh unread counts after marking thread read
        const convRes = await api.getConversations();
        setConversations(convRes.conversations);
        onUnreadTotalChange?.(convRes.unreadTotal);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load conversation.');
      } finally {
        setLoadingThread(false);
      }
    },
    [user, onUnreadTotalChange]
  );

  // Initial load & deep-link recipient support
  useEffect(() => {
    if (!user) return;
    setLoadingSidebar(true);
    void loadSidebar();
  }, [user, loadSidebar]);

  useEffect(() => {
    if (!user || !initialRecipientUid || initialRecipientUid === user.uid) return;
    const match =
      directory.find((u) => u.uid === initialRecipientUid) ||
      conversations.find((c) => c.otherUser.uid === initialRecipientUid)?.otherUser;
    if (match) {
      void openThread(match);
      onClearInitialRecipient?.();
    } else if (!loadingSidebar) {
      // Load directly even if directory hasn't matched yet
      void openThread({
        uid: initialRecipientUid,
        displayName: 'Member',
        handle: 'member',
        bio: '',
        avatarUrl: '',
        isAdmin: false,
      });
      onClearInitialRecipient?.();
    }
  }, [user, initialRecipientUid, directory, conversations, loadingSidebar, openThread, onClearInitialRecipient]);

  // Real-time WebSocket subscription for incoming messages, presence & read receipts
  useEffect(() => {
    if (!user) return;
    return realtimeClient.subscribe((event) => {
      if (event.type === 'presence:update') {
        setOnlineIds(new Set(event.onlineUserIds));
        return;
      }

      if (event.type === 'ws:reconnected') {
        void loadSidebar();
        if (activePeerRef.current) {
          void openThread(activePeerRef.current);
        }
        return;
      }

      if (event.type === 'chat:message') {
        const msg = event.message;
        const currentPeer = activePeerRef.current;
        if (currentPeer) {
          const activeConvId = buildConversationId(user.uid, currentPeer.uid);
          if (msg.conversationId === activeConvId) {
            setMessages((prev) => mergeUniqueById(prev, msg));
            if (msg.recipientId === user.uid) {
              void api.markConversationRead(currentPeer.uid).catch(() => undefined);
            }
          }
        }
        // Keep conversation sidebar and unread totals in sync
        void api
          .getConversations()
          .then((convRes) => {
            setConversations(convRes.conversations);
            onUnreadTotalChange?.(convRes.unreadTotal);
          })
          .catch(() => undefined);
        return;
      }

      if (event.type === 'chat:read') {
        const currentPeer = activePeerRef.current;
        if (currentPeer) {
          const activeConvId = buildConversationId(user.uid, currentPeer.uid);
          if (event.conversationId === activeConvId) {
            setMessages((prev) =>
              prev.map((m) =>
                m.recipientId === event.readerId && !m.readAt ? { ...m, readAt: event.readAt } : m
              )
            );
          }
        }
      }
    });
  }, [user, loadSidebar, openThread, onUnreadTotalChange]);

  // Auto-scroll only the inner chat feed container (never the outer window/header)
  useEffect(() => {
    const el = messageListRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, activePeer?.uid]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !activePeer || sending) return;
    setError('');

    const check = validateMessageBody(draft);
    if (!check.valid) {
      setError(check.error || 'Message cannot be empty.');
      return;
    }

    setSending(true);
    try {
      const { message } = await api.sendMessage(activePeer.uid, check.body);
      setMessages((prev) => mergeUniqueById(prev, message));
      setDraft('');
      void syncChatMessageToFirestore(message).catch(() => undefined);
      const convRes = await api.getConversations();
      setConversations(convRes.conversations);
      onUnreadTotalChange?.(convRes.unreadTotal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message.');
    } finally {
      setSending(false);
    }
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredConversations = useMemo(() => {
    if (!normalizedQuery) return conversations;
    return conversations.filter((c) => {
      const u = c.otherUser;
      return (
        u.displayName.toLowerCase().includes(normalizedQuery) ||
        u.handle.toLowerCase().includes(normalizedQuery) ||
        (c.lastMessage?.body || '').toLowerCase().includes(normalizedQuery)
      );
    });
  }, [conversations, normalizedQuery]);

  const conversationPeerIds = useMemo(
    () => new Set(conversations.map((c) => c.otherUser.uid)),
    [conversations]
  );

  const filteredDirectory = useMemo(() => {
    const candidates = normalizedQuery
      ? directory.filter(
          (u) =>
            u.displayName.toLowerCase().includes(normalizedQuery) ||
            u.handle.toLowerCase().includes(normalizedQuery)
        )
      : directory.filter((u) => !conversationPeerIds.has(u.uid));
    return candidates;
  }, [directory, normalizedQuery, conversationPeerIds]);

  if (!user) {
    return (
      <div className="max-w-[900px] mx-auto px-6 sm:px-8 py-20">
        <div className="bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl p-10 text-center">
          <MessageSquare className="w-8 h-8 text-[#008732] dark:text-[#FCD116] mx-auto" aria-hidden="true" />
          <h1 className="mt-4 font-display text-2xl font-semibold text-[#151811] dark:text-[#F5F3EA]">
            Direct Messages & Live Chat
          </h1>
          <p className="mt-2 text-sm text-[#5A5E52] dark:text-[#A6AA9C] max-w-md mx-auto">
            Sign in or create an account to chat with other creators, share feedback on drops, and
            message album owners in real time.
          </p>
          <button
            type="button"
            onClick={onSignIn}
            style={{ backgroundColor: 'var(--accent)' }}
            className="mt-6 px-5 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-90"
          >
            Sign In to Chat
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1360px] mx-auto px-4 sm:px-8 pt-8 pb-16">
      <header className="pb-6 border-b border-[#E2DCC8] dark:border-[#2A3124] flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-[#008732] dark:text-[#FCD116]">
            Live WebSocket Messaging · Direct User Chat
          </p>
          <h1 className="mt-1.5 font-display text-3xl sm:text-4xl font-semibold tracking-tight text-[#151811] dark:text-[#F5F3EA]">
            Messages
          </h1>
        </div>
        <p className="text-xs text-[#5A5E52] dark:text-[#A6AA9C] inline-flex items-center gap-2">
          <Users className="w-4 h-4 text-[#008732] dark:text-[#FCD116]" aria-hidden="true" />
          <span>
            {directory.length} {directory.length === 1 ? 'member' : 'members'} available to message
          </span>
        </p>
      </header>

      {/* Two-Column Chat Workspace */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-12 bg-white dark:bg-[#151912] border border-[#E2DCC8] dark:border-[#2A3124] rounded-2xl overflow-hidden min-h-[580px] lg:h-[660px]">
        {/* Left Sidebar: Conversations + People Directory */}
        <aside
          className={`lg:col-span-4 border-b lg:border-b-0 lg:border-r border-[#E2DCC8] dark:border-[#2A3124] flex flex-col min-h-0 ${
            activePeer ? 'hidden lg:flex' : 'flex'
          }`}
        >
          <div className="p-4 border-b border-[#ECE8D9] dark:border-[#262C21]">
            <div className="relative">
              <Search
                className="w-4 h-4 text-[#787B6E] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="text"
                role="searchbox"
                aria-label="Search users or conversations"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search members or chats..."
                className="w-full pl-9 pr-3 py-2 text-xs bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-lg text-[#151811] dark:text-[#F5F3EA]"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-[#ECE8D9] dark:divide-[#262C21]">
            {loadingSidebar ? (
              <div className="p-6 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                Loading conversations...
              </div>
            ) : (
              <>
                {filteredConversations.length > 0 && (
                  <div className="py-2">
                    <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#787B6E] dark:text-[#8E9384]">
                      Recent Chats
                    </p>
                    {filteredConversations.map((conv) => {
                      const peer = conv.otherUser;
                      const isOnline = onlineIds.has(peer.uid) || Boolean(peer.online);
                      const isSelected = activePeer?.uid === peer.uid;
                      return (
                        <button
                          key={conv.id}
                          type="button"
                          onClick={() => void openThread(peer)}
                          className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                            isSelected
                              ? 'bg-[#EFEBD9] dark:bg-[#21291B]'
                              : 'hover:bg-[#F8F6EE] dark:hover:bg-[#1B2117]'
                          }`}
                        >
                          <UserAvatar
                            name={peer.displayName}
                            avatarUrl={peer.avatarUrl}
                            size="md"
                            online={isOnline}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-sm font-semibold text-[#151811] dark:text-[#F5F3EA] truncate">
                                {peer.displayName}
                              </span>
                              {conv.lastMessage && (
                                <span className="text-[11px] text-[#787B6E] dark:text-[#8E9384] shrink-0">
                                  {formatRelativeTime(conv.lastMessage.createdAt)}
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center justify-between gap-2">
                              <p className="text-xs text-[#5A5E52] dark:text-[#A6AA9C] truncate">
                                {conv.lastMessage
                                  ? `${conv.lastMessage.senderId === user.uid ? 'You: ' : ''}${conv.lastMessage.body}`
                                  : `@${peer.handle}`}
                              </p>
                              {conv.unreadCount > 0 && (
                                <span className="px-1.5 py-0.5 min-w-[20px] text-center text-[10px] font-bold rounded-full bg-[#FCD116] text-[#151811] shrink-0">
                                  {conv.unreadCount}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="py-2">
                  <p className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#787B6E] dark:text-[#8E9384]">
                    {normalizedQuery ? 'Matching Members' : 'Start a New Chat'}
                  </p>
                  {filteredDirectory.length === 0 ? (
                    <p className="px-4 py-4 text-xs text-[#787B6E] dark:text-[#8E9384]">
                      {normalizedQuery
                        ? 'No members match that search.'
                        : 'You already have active chats with all registered members.'}
                    </p>
                  ) : (
                    filteredDirectory.map((member) => {
                      const isOnline = onlineIds.has(member.uid) || Boolean(member.online);
                      const isSelected = activePeer?.uid === member.uid;
                      return (
                        <button
                          key={member.uid}
                          type="button"
                          onClick={() => void openThread(member)}
                          className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                            isSelected
                              ? 'bg-[#EFEBD9] dark:bg-[#21291B]'
                              : 'hover:bg-[#F8F6EE] dark:hover:bg-[#1B2117]'
                          }`}
                        >
                          <UserAvatar
                            name={member.displayName}
                            avatarUrl={member.avatarUrl}
                            size="md"
                            online={isOnline}
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-[#151811] dark:text-[#F5F3EA] truncate">
                              {member.displayName}
                            </p>
                            <p className="text-xs text-[#5A5E52] dark:text-[#A6AA9C] truncate">
                              @{member.handle}
                              {isOnline ? ' · Online' : ''}
                            </p>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        </aside>

        {/* Right Pane: Active Chat Thread */}
        <section
          aria-label="Conversation thread"
          className={`lg:col-span-8 flex flex-col min-h-0 ${
            activePeer ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {!activePeer ? (
            <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
              <MessageSquare
                className="w-10 h-10 text-[#008732] dark:text-[#FCD116]"
                aria-hidden="true"
              />
              <h2 className="mt-4 font-display text-lg font-semibold text-[#151811] dark:text-[#F5F3EA]">
                Select a member to start chatting
              </h2>
              <p className="mt-1.5 text-xs text-[#5A5E52] dark:text-[#A6AA9C] max-w-sm">
                Pick anyone from your Recent Chats or the member directory on the left to send live
                messages.
              </p>
            </div>
          ) : (
            <>
              {/* Thread Header */}
              <div className="px-4 sm:px-6 py-4 border-b border-[#ECE8D9] dark:border-[#262C21] flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setActivePeer(null)}
                  aria-label="Back to conversations"
                  className="lg:hidden p-2 -ml-2 text-[#5A5E52] dark:text-[#A6AA9C] hover:text-[#151811] dark:hover:text-white rounded-lg"
                >
                  <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                <UserAvatar
                  name={activePeer.displayName}
                  avatarUrl={activePeer.avatarUrl}
                  size="md"
                  online={onlineIds.has(activePeer.uid) || Boolean(activePeer.online)}
                />
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold text-[#151811] dark:text-[#F5F3EA] truncate">
                    {activePeer.displayName}
                  </h2>
                  <p className="text-xs text-[#5A5E52] dark:text-[#A6AA9C] truncate">
                    @{activePeer.handle} ·{' '}
                    {onlineIds.has(activePeer.uid) || activePeer.online ? (
                      <span className="text-[#008732] dark:text-[#4ADE80] font-medium">
                        Online now
                      </span>
                    ) : (
                      'Offline'
                    )}
                  </p>
                </div>
              </div>

              {/* Message Feed */}
              <div
                ref={messageListRef}
                data-testid="chat-message-list"
                className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-3.5 bg-[#FAF8F2] dark:bg-[#0F120C]"
              >
                {loadingThread ? (
                  <p className="text-xs text-[#5A5E52] dark:text-[#A6AA9C] text-center py-8">
                    Loading messages...
                  </p>
                ) : messages.length === 0 ? (
                  <div className="py-12 text-center">
                    <p className="text-sm font-medium text-[#151811] dark:text-[#F5F3EA]">
                      Start the conversation with {activePeer.displayName}
                    </p>
                    <p className="mt-1 text-xs text-[#5A5E52] dark:text-[#A6AA9C]">
                      Messages are delivered in real time and saved to your inbox.
                    </p>
                  </div>
                ) : (
                  messages.map((msg) => {
                    const isMine = msg.senderId === user.uid;
                    return (
                      <div
                        key={msg.id}
                        className={`flex items-end gap-2.5 ${
                          isMine ? 'justify-end' : 'justify-start'
                        }`}
                      >
                        {!isMine && (
                          <UserAvatar
                            name={msg.senderName}
                            avatarUrl={msg.senderAvatarUrl}
                            size="xs"
                          />
                        )}
                        <div
                          className={`max-w-[78%] sm:max-w-[70%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                            isMine
                              ? 'bg-[#008732] text-white rounded-br-sm'
                              : 'bg-white dark:bg-[#1A2016] text-[#151811] dark:text-[#F5F3EA] border border-[#E2DCC8] dark:border-[#2A3124] rounded-bl-sm'
                          }`}
                        >
                          <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                          <p
                            className={`mt-1 text-[10px] ${
                              isMine ? 'text-white/75 text-right' : 'text-[#787B6E] dark:text-[#8E9384]'
                            }`}
                          >
                            {formatRelativeTime(msg.createdAt)}
                            {isMine && msg.readAt ? ' · Read' : ''}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Message Composer */}
              <form
                onSubmit={handleSendMessage}
                className="p-4 border-t border-[#ECE8D9] dark:border-[#262C21] bg-white dark:bg-[#151912]"
              >
                {error && (
                  <p role="alert" className="mb-2 text-xs text-[#CE1126] dark:text-red-400">
                    {error}
                  </p>
                )}
                <div className="flex items-center gap-2.5">
                  <input
                    id="chat-message-input"
                    type="text"
                    aria-label={`Message ${activePeer.displayName}`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={`Message ${activePeer.displayName}...`}
                    maxLength={1000}
                    className="flex-1 px-4 py-2.5 text-sm bg-[#F8F6EE] dark:bg-[#0D0F0B] border border-[#D8D1BC] dark:border-[#2E3627] rounded-xl text-[#151811] dark:text-[#F5F3EA] focus:outline-none focus:border-[#009B3A] dark:focus:border-[#FCD116]"
                  />
                  <button
                    type="submit"
                    disabled={sending || !draft.trim()}
                    style={{ backgroundColor: 'var(--accent)' }}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white rounded-xl hover:opacity-90 disabled:opacity-40 transition-opacity shrink-0"
                  >
                    <Send className="w-4 h-4" aria-hidden="true" />
                    <span className="hidden sm:inline">{sending ? 'Sending...' : 'Send'}</span>
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
