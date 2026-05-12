"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { initSocket, getSocket, disconnectSocket } from "@/lib/socket";
import {
  decryptMessage,
  getKeyPair,
  getPublicKeyFingerprint,
  lockKeyPair,
  openSealedMessage,
  sealMessage,
  unlockKeyPair,
} from "@/lib/crypto";
import { Conversation, Message, User } from "@/types";
import { motion } from "framer-motion";
import { Socket } from "socket.io-client";
import type { Session, User as SupabaseUser } from "@supabase/supabase-js";

type DbUser = {
  id: string;
  email: string;
  public_key: string;
};

type DbConversation = {
  id: string;
  created_at: string;
  participant1: DbUser;
  participant2: DbUser;
};

type DbMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  encrypted_content: string;
  nonce: string;
  encrypted_key_for_sender: string | null;
  encrypted_key_for_recipient: string | null;
  key_nonce_for_sender: string | null;
  key_nonce_for_recipient: string | null;
  timestamp: string;
  read_at: string | null;
};

type ConversationMeta = Conversation & {
  lastMessagePreview?: string;
  lastMessageAt?: string;
  unreadCount: number;
};

type SendAck = {
  ok: boolean;
  message?: Message & { clientId?: string };
  error?: string;
};

type MessagesReadPayload = {
  conversationId: string;
  readerId: string;
  readAt: string;
  messageIds: string[];
};

const mapUser = (dbUser: DbUser): User => ({
  id: dbUser.id,
  email: dbUser.email,
  publicKey: dbUser.public_key,
});

const mapConversation = (dbConversation: DbConversation): ConversationMeta => ({
  id: dbConversation.id,
  participant1: mapUser(dbConversation.participant1),
  participant2: mapUser(dbConversation.participant2),
  createdAt: dbConversation.created_at,
  unreadCount: 0,
});

const mapMessage = (dbMessage: DbMessage): Message => ({
  id: dbMessage.id,
  conversationId: dbMessage.conversation_id,
  senderId: dbMessage.sender_id,
  encryptedContent: dbMessage.encrypted_content,
  nonce: dbMessage.nonce,
  encryptedKeyForSender: dbMessage.encrypted_key_for_sender,
  encryptedKeyForRecipient: dbMessage.encrypted_key_for_recipient,
  keyNonceForSender: dbMessage.key_nonce_for_sender,
  keyNonceForRecipient: dbMessage.key_nonce_for_recipient,
  timestamp: dbMessage.timestamp,
  readAt: dbMessage.read_at,
});

const formatTime = (timestamp?: string) => {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
};

const getOtherParticipant = (
  conversation: Conversation,
  currentUserId?: string,
) =>
  conversation.participant1.id === currentUserId
    ? conversation.participant2
    : conversation.participant1;

const emojiOptions = ["👍", "❤️", "😂", "🔥", "👏", "😎", "🙏", "🎉"];

const Chat = () => {
  const [user, setUser] = useState<SupabaseUser | null>(null);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [currentConversation, setCurrentConversation] =
    useState<ConversationMeta | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [newChatEmail, setNewChatEmail] = useState("");
  const [unlockPassphrase, setUnlockPassphrase] = useState("");
  const [locked, setLocked] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [typing, setTyping] = useState(false);
  const [contactFingerprint, setContactFingerprint] = useState("");
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const socketRef = useRef<Socket | null>(null);
  const currentConversationRef = useRef<ConversationMeta | null>(null);
  const conversationsRef = useRef<ConversationMeta[]>([]);
  const confirmedClientIdsRef = useRef<Set<string>>(new Set());
  const userRef = useRef<SupabaseUser | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const decryptForDisplay = useCallback(
    async (message: Message, conversation: Conversation) => {
      const keyPair = getKeyPair();
      if (!keyPair) return "Encrypted message";

      try {
        const senderPublicKey =
          conversation.participant1.id === message.senderId
            ? conversation.participant1.publicKey
            : conversation.participant2.publicKey;
        const otherPublicKey = getOtherParticipant(
          conversation,
          userRef.current?.id,
        ).publicKey;

        if (
          message.encryptedKeyForSender &&
          message.encryptedKeyForRecipient &&
          message.keyNonceForSender &&
          message.keyNonceForRecipient
        ) {
          return await openSealedMessage(
            {
              encrypted: message.encryptedContent,
              nonce: message.nonce,
              encryptedKeyForSender: message.encryptedKeyForSender,
              encryptedKeyForRecipient: message.encryptedKeyForRecipient,
              keyNonceForSender: message.keyNonceForSender,
              keyNonceForRecipient: message.keyNonceForRecipient,
            },
            senderPublicKey,
            otherPublicKey,
            keyPair.privateKey,
            message.senderId === userRef.current?.id,
          );
        }

        const publicKey =
          message.senderId === userRef.current?.id
            ? otherPublicKey
            : senderPublicKey;

        return await decryptMessage(
          message.encryptedContent,
          message.nonce,
          publicKey,
          keyPair.privateKey,
        );
      } catch (err) {
        console.error("Failed to decrypt message", err);
        return "Unable to decrypt message";
      }
    },
    [],
  );

  const decryptMessages = useCallback(
    async (encryptedMessages: Message[], conversation: Conversation) =>
      Promise.all(
        encryptedMessages.map(async (message) => ({
          ...message,
          decryptedContent: await decryptForDisplay(message, conversation),
        })),
      ),
    [decryptForDisplay],
  );

  const markConversationRead = useCallback((conversationId: string) => {
    socketRef.current?.emit("mark_read", { conversationId });
  }, []);

  const loadConversations = useCallback(
    async (userId: string) => {
      const { data, error } = await supabase
        .from("conversations")
        .select(
          `
          id,
          created_at,
          participant1:users!conversations_participant1_id_fkey(id,email,public_key),
          participant2:users!conversations_participant2_id_fkey(id,email,public_key)
        `,
        )
        .or(`participant1_id.eq.${userId},participant2_id.eq.${userId}`)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Failed to load conversations", error);
        setStatusMessage(error.message);
        return;
      }

      const mapped = ((data ?? []) as unknown as DbConversation[]).map(mapConversation);
      const conversationIds = mapped.map((conversation) => conversation.id);

      if (conversationIds.length) {
        const { data: latestMessages, error: latestError } = await supabase
          .from("messages")
          .select("id,conversation_id,sender_id,encrypted_content,nonce,encrypted_key_for_sender,encrypted_key_for_recipient,key_nonce_for_sender,key_nonce_for_recipient,timestamp,read_at")
          .in("conversation_id", conversationIds)
          .order("timestamp", { ascending: false });

        if (!latestError) {
          for (const dbMessage of (latestMessages ?? []) as DbMessage[]) {
            const conversation = mapped.find(
              (item) => item.id === dbMessage.conversation_id,
            );
            if (!conversation || conversation.lastMessageAt) continue;

            const message = mapMessage(dbMessage);
            conversation.lastMessageAt = message.timestamp;
            conversation.lastMessagePreview = await decryptForDisplay(
              message,
              conversation,
            );
          }
        }
      }

      const participantIds = Array.from(
        new Set(
          mapped.flatMap((conversation) => [
            conversation.participant1.id,
            conversation.participant2.id,
          ]),
        ),
      ).filter((id) => id !== userId);

      if (participantIds.length) {
        const { data: statuses, error: statusError } = await supabase
          .from("user_status")
          .select("user_id,status")
          .in("user_id", participantIds);

        if (!statusError) {
          const onlineIds = new Set(
            ((statuses ?? []) as { user_id: string; status: string }[])
              .filter((status) => status.status === "online")
              .map((status) => status.user_id),
          );
          setOnlineUsers(onlineIds);
        }
      }

      mapped.sort(
        (a, b) =>
          new Date(b.lastMessageAt ?? b.createdAt).getTime() -
          new Date(a.lastMessageAt ?? a.createdAt).getTime(),
      );
      setConversations(mapped);
      conversationsRef.current = mapped;
      for (const conversation of mapped) {
        socketRef.current?.emit("join_conversation", conversation.id);
      }
    },
    [decryptForDisplay],
  );

  const setupSocketListeners = useCallback(
    (activeSocket: Socket) => {
      activeSocket.off("new_message");
      activeSocket.off("message_sent");
      activeSocket.off("send_error");
      activeSocket.off("messages_read");
      activeSocket.off("connect");
      activeSocket.off("disconnect");
      activeSocket.off("user_online");
      activeSocket.off("user_offline");
      activeSocket.off("user_typing");

      const applyIncomingMessage = async (msg: Message, fromSelf: boolean) => {
        const conversation =
          currentConversationRef.current?.id === msg.conversationId
            ? currentConversationRef.current
            : conversationsRef.current.find(
                (item) => item.id === msg.conversationId,
              );

        if (!conversation) {
          if (userRef.current?.id) await loadConversations(userRef.current.id);
          return;
        }

        const decryptedContent =
          msg.decryptedContent ?? (await decryptForDisplay(msg, conversation));

        setConversations((prev) => {
          const updated = prev.map((item) =>
            item.id === msg.conversationId
              ? {
                  ...item,
                  lastMessagePreview: decryptedContent,
                  lastMessageAt: msg.timestamp,
                  unreadCount:
                    fromSelf || currentConversationRef.current?.id === item.id
                      ? 0
                      : item.unreadCount + 1,
                }
              : item,
          );

          return updated.sort(
            (a, b) =>
              new Date(b.lastMessageAt ?? b.createdAt).getTime() -
              new Date(a.lastMessageAt ?? a.createdAt).getTime(),
          );
        });

        if (currentConversationRef.current?.id === msg.conversationId) {
          setMessages((prev) => {
            if (prev.some((item) => item.id === msg.id)) return prev;
            return [...prev, { ...msg, decryptedContent }];
          });
          if (msg.senderId !== userRef.current?.id) {
            markConversationRead(msg.conversationId);
          }
        }
      };

      activeSocket.on("new_message", (msg: Message) => {
        applyIncomingMessage(msg, false);
      });

      activeSocket.on("messages_read", (payload: MessagesReadPayload) => {
        setMessages((prev) =>
          prev.map((message) =>
            payload.messageIds.includes(message.id)
              ? { ...message, readAt: payload.readAt }
              : message,
          ),
        );
      });

      activeSocket.on(
        "message_sent",
        (msg: Message & { clientId?: string }) => {
          if (msg.clientId) confirmedClientIdsRef.current.add(msg.clientId);
          setStatusMessage("");
          setMessages((prev) =>
            prev.map((message) =>
              message.id === msg.clientId
                ? {
                    ...msg,
                    decryptedContent: message.decryptedContent,
                  }
                : message,
            ),
          );
        },
      );

      activeSocket.on("send_error", (message: string) => {
        setStatusMessage(message);
      });

      activeSocket.on("connect", () => {
        activeSocket.emit("set_online");
        for (const conversation of conversationsRef.current) {
          activeSocket.emit("join_conversation", conversation.id);
        }
      });

      activeSocket.on("disconnect", () => {
        setTyping(false);
      });

      activeSocket.on("user_online", (userId: string) => {
        setOnlineUsers((prev) => new Set(prev).add(userId));
      });

      activeSocket.on("user_offline", (userId: string) => {
        setOnlineUsers((prev) => {
          const newSet = new Set(prev);
          newSet.delete(userId);
          return newSet;
        });
      });

      activeSocket.on("user_typing", (data: { userId: string; isTyping: boolean }) => {
        if (data.userId !== userRef.current?.id) setTyping(data.isTyping);
      });
    },
    [decryptForDisplay, loadConversations, markConversationRead],
  );

  const startChatSession = useCallback(
    async (session: Session) => {
      setLocked(false);
      setUser(session.user);
      userRef.current = session.user;
      const activeSocket = initSocket(session.access_token);
      socketRef.current = activeSocket;
      activeSocket.emit("set_online");
      await loadConversations(session.user.id);
      setupSocketListeners(activeSocket);
    },
    [loadConversations, setupSocketListeners],
  );

  useEffect(() => {
    const init = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session) {
        setUser(session.user);
        userRef.current = session.user;
        if (!getKeyPair()) {
          setLocked(true);
          return;
        }

        await startChatSession(session);
      }
    };

    init();

    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      disconnectSocket();
    };
  }, [startChatSession]);

  useEffect(() => {
    const activeSocket = socketRef.current;
    if (activeSocket) setupSocketListeners(activeSocket);
  }, [setupSocketListeners]);

  const selectConversation = async (conversation: ConversationMeta) => {
    setCurrentConversation(conversation);
    currentConversationRef.current = conversation;
    setMessages([]);
    setTyping(false);
    setStatusMessage("");
    setContactFingerprint("");
    socketRef.current?.emit("join_conversation", conversation.id);
    getPublicKeyFingerprint(
      getOtherParticipant(conversation, userRef.current?.id).publicKey,
    ).then(setContactFingerprint);

    setConversations((prev) => {
      const next = prev.map((item) =>
        item.id === conversation.id ? { ...item, unreadCount: 0 } : item,
      );
      conversationsRef.current = next;
      return next;
    });

    const { data, error } = await supabase
      .from("messages")
      .select("id,conversation_id,sender_id,encrypted_content,nonce,encrypted_key_for_sender,encrypted_key_for_recipient,key_nonce_for_sender,key_nonce_for_recipient,timestamp,read_at")
      .eq("conversation_id", conversation.id)
      .order("timestamp", { ascending: true });

    if (error) {
      console.error("Failed to load messages", error);
      setStatusMessage(error.message);
      return;
    }

    const encryptedMessages = ((data ?? []) as DbMessage[]).map(mapMessage);
    const decryptedMessages = await decryptMessages(encryptedMessages, conversation);
    setMessages(decryptedMessages);
    markConversationRead(conversation.id);
  };

  const createConversation = async () => {
    const trimmedEmail = newChatEmail.trim().toLowerCase();
    if (!trimmedEmail || !user || loadingConversation) return;

    setLoadingConversation(true);
    setStatusMessage("");

    try {
      if (trimmedEmail === user.email?.toLowerCase()) {
        throw new Error("Choose another user's email.");
      }

      const { data: recipient, error: userError } = await supabase
        .from("users")
        .select("id,email,public_key")
        .ilike("email", trimmedEmail)
        .maybeSingle();

      if (userError) throw userError;
      if (!recipient) throw new Error("No registered user found for that email.");

      const participantIds = [user.id, recipient.id].sort();
      const [participant1Id, participant2Id] = participantIds;

      const { data: existing, error: existingError } = await supabase
        .from("conversations")
        .select(
          `
          id,
          created_at,
          participant1:users!conversations_participant1_id_fkey(id,email,public_key),
          participant2:users!conversations_participant2_id_fkey(id,email,public_key)
        `,
        )
        .eq("participant1_id", participant1Id)
        .eq("participant2_id", participant2Id)
        .maybeSingle();

      if (existingError) throw existingError;

      let conversation = existing
        ? mapConversation(existing as unknown as DbConversation)
        : null;

      if (!conversation) {
        const { data: created, error: createError } = await supabase
          .from("conversations")
          .insert({
            participant1_id: participant1Id,
            participant2_id: participant2Id,
          })
          .select(
            `
            id,
            created_at,
            participant1:users!conversations_participant1_id_fkey(id,email,public_key),
            participant2:users!conversations_participant2_id_fkey(id,email,public_key)
          `,
          )
          .single();

        if (createError) throw createError;
        conversation = mapConversation(created as unknown as DbConversation);
      }

      setConversations((prev) => {
        const withoutDuplicate = prev.filter((item) => item.id !== conversation!.id);
        const next = [conversation!, ...withoutDuplicate];
        conversationsRef.current = next;
        return next;
      });
      setNewChatEmail("");
      await selectConversation(conversation);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to create conversation.";
      setStatusMessage(message);
    } finally {
      setLoadingConversation(false);
    }
  };

  const sendMessage = async () => {
    const activeSocket = socketRef.current ?? getSocket();
    if (!newMessage.trim() || !currentConversation || !activeSocket || !user) return;

    if (!activeSocket.connected) {
      setStatusMessage("Chat server is reconnecting. Try again in a moment.");
      return;
    }

    const keyPair = getKeyPair();
    if (!keyPair) {
      setStatusMessage("Missing local encryption keys. Log in again on this browser.");
      return;
    }

    const recipient = getOtherParticipant(currentConversation, user.id);
    const messageText = newMessage.trim();
    const sealed = await sealMessage(
      messageText,
      keyPair.publicKey,
      keyPair.privateKey,
      recipient.publicKey,
    );

    const clientId = `local-${crypto.randomUUID()}`;
    const optimisticMessage: Message = {
      id: clientId,
      conversationId: currentConversation.id,
      senderId: user.id,
      encryptedContent: sealed.encrypted,
      nonce: sealed.nonce,
      encryptedKeyForSender: sealed.encryptedKeyForSender,
      encryptedKeyForRecipient: sealed.encryptedKeyForRecipient,
      keyNonceForSender: sealed.keyNonceForSender,
      keyNonceForRecipient: sealed.keyNonceForRecipient,
      timestamp: new Date().toISOString(),
      readAt: null,
      decryptedContent: messageText,
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    setConversations((prev) => {
      const updated = prev.map((conversation) =>
        conversation.id === currentConversation.id
          ? {
              ...conversation,
              lastMessagePreview: messageText,
              lastMessageAt: optimisticMessage.timestamp,
              unreadCount: 0,
            }
          : conversation,
      );
      const next = updated.sort(
        (a, b) =>
          new Date(b.lastMessageAt ?? b.createdAt).getTime() -
          new Date(a.lastMessageAt ?? a.createdAt).getTime(),
      );
      conversationsRef.current = next;
      return next;
    });

    activeSocket
      .timeout(8000)
      .emit(
        "send_message",
        {
          conversationId: currentConversation.id,
          encryptedContent: sealed.encrypted,
          nonce: sealed.nonce,
          encryptedKeyForSender: sealed.encryptedKeyForSender,
          encryptedKeyForRecipient: sealed.encryptedKeyForRecipient,
          keyNonceForSender: sealed.keyNonceForSender,
          keyNonceForRecipient: sealed.keyNonceForRecipient,
          clientId,
        },
        (err: Error | null, response?: SendAck) => {
          if (confirmedClientIdsRef.current.has(clientId)) return;

          if (err || !response?.ok || !response.message) {
            setMessages((prev) =>
              prev.filter((message) => message.id !== optimisticMessage.id),
            );
            setStatusMessage(
              response?.error ??
                err?.message ??
                "Message was not sent. Please try again.",
            );
            return;
          }

          setStatusMessage("");
          confirmedClientIdsRef.current.add(clientId);
          setMessages((prev) =>
            prev.map((message) =>
              message.id === optimisticMessage.id
                ? {
                    ...response.message!,
                    decryptedContent: messageText,
                  }
                : message,
            ),
          );
        },
      );
    activeSocket.emit("typing", {
      conversationId: currentConversation.id,
      isTyping: false,
    });
    setNewMessage("");
  };

  const handleMessageChange = (value: string) => {
    setNewMessage(value);

    if (!currentConversation) return;

    socketRef.current?.emit("typing", {
      conversationId: currentConversation.id,
      isTyping: value.trim().length > 0,
    });

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current?.emit("typing", {
        conversationId: currentConversation.id,
        isTyping: false,
      });
    }, 1200);
  };

  const addEmoji = (emoji: string) => {
    handleMessageChange(`${newMessage}${emoji}`);
  };

  const handleLogout = async () => {
    disconnectSocket();
    lockKeyPair();
    await supabase.auth.signOut();
    setUser(null);
    userRef.current = null;
    setConversations([]);
    setCurrentConversation(null);
    setMessages([]);
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage("");

    try {
      const unlocked = await unlockKeyPair(unlockPassphrase);
      if (!unlocked) throw new Error("Could not unlock your encryption key.");

      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Your login session expired.");

      setUnlockPassphrase("");
      await startChatSession(session);
    } catch (err) {
      setStatusMessage(
        err instanceof Error ? err.message : "Could not unlock your key.",
      );
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [messages]);

  if (locked) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-100 text-gray-950 dark:bg-gray-900 dark:text-white">
        <form
          onSubmit={handleUnlock}
          className="w-96 rounded-lg bg-white p-8 shadow-md dark:bg-gray-800"
        >
          <h2 className="text-2xl font-bold">Unlock myChat</h2>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Enter your encryption passphrase to unlock local private keys.
          </p>
          {statusMessage && (
            <p className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              {statusMessage}
            </p>
          )}
          <input
            type="password"
            value={unlockPassphrase}
            onChange={(e) => setUnlockPassphrase(e.target.value)}
            className="mt-4 w-full rounded border p-3 text-gray-900"
            placeholder="Encryption passphrase"
            required
          />
          <button className="mt-4 w-full rounded bg-blue-500 p-3 text-white">
            Unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-100 text-gray-950 dark:bg-gray-900 dark:text-white">
      <div className="w-80 border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="flex h-full flex-col p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-bold">Conversations</h2>
              <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">
                {user?.email}
              </p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              Logout
            </button>
          </div>

          <div className="mt-4 flex gap-2">
            <input
              type="email"
              value={newChatEmail}
              onChange={(e) => setNewChatEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createConversation()}
              className="min-w-0 flex-1 rounded border border-gray-300 bg-white p-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              placeholder="user@example.com"
            />
            <button
              type="button"
              onClick={createConversation}
              disabled={loadingConversation}
              className="rounded bg-blue-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              New
            </button>
          </div>

          {statusMessage && (
            <p className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              {statusMessage}
            </p>
          )}

          <div className="mt-4 flex-1 overflow-y-auto">
            {conversations.map((conversation) => {
              const participant = getOtherParticipant(conversation, user?.id);
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => selectConversation(conversation)}
                  className={`mb-2 w-full rounded p-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700 ${
                    currentConversation?.id === conversation.id
                      ? "bg-gray-100 dark:bg-gray-700"
                      : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{participant.email}</span>
                    {conversation.lastMessageAt && (
                      <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                        {formatTime(conversation.lastMessageAt)}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-gray-500 dark:text-gray-400">
                      {conversation.lastMessagePreview ?? "No messages yet"}
                    </span>
                    {conversation.unreadCount > 0 && (
                      <span className="rounded-full bg-blue-500 px-2 py-0.5 text-xs font-semibold text-white">
                        {conversation.unreadCount}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {currentConversation ? (
          <>
            <div className="border-b border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <h3 className="text-lg">
                Chat with {getOtherParticipant(currentConversation, user?.id).email}
                {onlineUsers.has(getOtherParticipant(currentConversation, user?.id).id) && (
                  <span className="ml-2 text-green-500">Online</span>
                )}
              </h3>
              {contactFingerprint && (
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Safety number {contactFingerprint}
                </p>
              )}
              {typing && <p className="text-sm text-gray-500">Typing...</p>}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {messages.map((message) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className={`mb-3 ${
                    message.senderId === user?.id ? "text-right" : "text-left"
                  }`}
                >
                  <div
                    className={`inline-block max-w-[70%] rounded-lg p-3 text-left ${
                      message.senderId === user?.id
                        ? "bg-blue-500 text-white"
                        : "bg-gray-200 dark:bg-gray-700"
                    }`}
                  >
                    {message.decryptedContent || "Decrypting..."}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {formatTime(message.timestamp)}
                    {message.senderId === user?.id && (
                      <span className="ml-2">
                        {message.id.startsWith("local-")
                          ? "Sending"
                          : message.readAt
                            ? "Read"
                            : "Sent"}
                      </span>
                    )}
                  </div>
                </motion.div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="border-t border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <div className="mb-3 flex gap-2">
                {emojiOptions.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => addEmoji(emoji)}
                    className="rounded border border-gray-300 px-3 py-2 text-lg hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-700"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <div className="flex">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => handleMessageChange(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                  className="min-w-0 flex-1 rounded-l border border-gray-300 bg-white p-3 text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                  placeholder="Type a message..."
                />
                <button
                  onClick={sendMessage}
                  className="rounded-r bg-blue-500 px-4 py-3 text-white"
                >
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p>Select a conversation to start chatting</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Chat;
