import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

const createUserSupabaseClient = (token: string) =>
  createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

const userConnectionCounts = new Map<string, number>();

const markUserOnline = async (token: string, userId: string) => {
  const userSupabase = createUserSupabaseClient(token);
  await userSupabase.from("user_status").upsert({
    user_id: userId,
    status: "online",
    last_seen: new Date().toISOString(),
  });
  io.emit("user_online", userId);
};

const markUserOfflineIfNeeded = async (token: string, userId: string) => {
  const nextCount = Math.max((userConnectionCounts.get(userId) ?? 1) - 1, 0);

  if (nextCount > 0) {
    userConnectionCounts.set(userId, nextCount);
    return;
  }

  userConnectionCounts.delete(userId);
  const userSupabase = createUserSupabaseClient(token);
  await userSupabase
    .from("user_status")
    .upsert({
      user_id: userId,
      status: "offline",
      last_seen: new Date().toISOString(),
    });
  io.emit("user_offline", userId);
};

// Middleware to parse JSON
app.use(express.json());
app.use(cors());

// Auth middleware for socket
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error("Authentication error"));
  }

  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) {
      return next(new Error("Authentication error"));
    }
    socket.data.user = user;
    socket.data.token = token;
    next();
  } catch (err) {
    next(new Error("Authentication error"));
  }
});

// Socket connection
io.on("connection", (socket) => {
  const user = socket.data.user;
  console.log(`User ${user.id} connected`);

  // Join user's room for personal events
  socket.join(user.id);
  userConnectionCounts.set(
    user.id,
    (userConnectionCounts.get(user.id) ?? 0) + 1,
  );
  markUserOnline(socket.data.token, user.id).catch((err) => {
    console.error("Error setting online status:", err);
  });

  // Handle joining conversation
  socket.on("join_conversation", (conversationId: string) => {
    socket.join(conversationId);
    console.log(`User ${user.id} joined conversation ${conversationId}`);
  });

  // Handle sending message
  socket.on(
    "send_message",
    async (data: {
      conversationId: string;
      encryptedContent: string;
      nonce: string;
      encryptedKeyForSender?: string;
      encryptedKeyForRecipient?: string;
      keyNonceForSender?: string;
      keyNonceForRecipient?: string;
      clientId?: string;
    },
    ack?: (response: {
      ok: boolean;
      message?: {
        id: string;
        clientId?: string;
        conversationId: string;
        senderId: string;
        encryptedContent: string;
        nonce: string;
        encryptedKeyForSender?: string | null;
        encryptedKeyForRecipient?: string | null;
        keyNonceForSender?: string | null;
        keyNonceForRecipient?: string | null;
        timestamp: string;
        readAt: string | null;
      };
      error?: string;
    }) => void) => {
      try {
        const userSupabase = createUserSupabaseClient(socket.data.token);
        const timestamp = new Date().toISOString();

        // Store in database
        const { data: message, error } = await userSupabase
          .from("messages")
          .insert({
            conversation_id: data.conversationId,
            sender_id: user.id,
            encrypted_content: data.encryptedContent,
            nonce: data.nonce,
            encrypted_key_for_sender: data.encryptedKeyForSender ?? null,
            encrypted_key_for_recipient: data.encryptedKeyForRecipient ?? null,
            key_nonce_for_sender: data.keyNonceForSender ?? null,
            key_nonce_for_recipient: data.keyNonceForRecipient ?? null,
            timestamp,
          })
          .select("id, conversation_id, sender_id, encrypted_content, nonce, encrypted_key_for_sender, encrypted_key_for_recipient, key_nonce_for_sender, key_nonce_for_recipient, timestamp, read_at")
          .single();

        if (error) throw error;

        const { data: conversation, error: conversationError } = await userSupabase
          .from("conversations")
          .select("participant1_id, participant2_id")
          .eq("id", data.conversationId)
          .single();

        if (conversationError) throw conversationError;

        const recipientId =
          conversation.participant1_id === user.id
            ? conversation.participant2_id
            : conversation.participant1_id;

        const payload = {
          id: message.id,
          clientId: data.clientId,
          conversationId: message.conversation_id,
          senderId: message.sender_id,
          encryptedContent: message.encrypted_content,
          nonce: message.nonce,
          encryptedKeyForSender: message.encrypted_key_for_sender,
          encryptedKeyForRecipient: message.encrypted_key_for_recipient,
          keyNonceForSender: message.key_nonce_for_sender,
          keyNonceForRecipient: message.key_nonce_for_recipient,
          timestamp: message.timestamp,
          readAt: message.read_at,
        };

        socket.emit("message_sent", payload);
        socket.to([data.conversationId, recipientId]).emit("new_message", payload);
        ack?.({ ok: true, message: payload });
      } catch (err) {
        console.error("Error sending message:", err);
        const message =
          err instanceof Error ? err.message : "Failed to send message";
        socket.emit("send_error", message);
        ack?.({ ok: false, error: message });
      }
    },
  );

  // Handle typing
  socket.on("typing", (data: { conversationId: string; isTyping: boolean }) => {
    socket.to(data.conversationId).emit("user_typing", {
      userId: user.id,
      isTyping: data.isTyping,
    });
  });

  socket.on("mark_read", async (data: { conversationId: string }) => {
    try {
      const userSupabase = createUserSupabaseClient(socket.data.token);
      const readAt = new Date().toISOString();
      const { data: messages, error } = await userSupabase
        .from("messages")
        .update({ read_at: readAt })
        .eq("conversation_id", data.conversationId)
        .neq("sender_id", user.id)
        .is("read_at", null)
        .select("id, sender_id");

      if (error) throw error;
      if (!messages?.length) return;

      const senderIds = Array.from(
        new Set(messages.map((message) => message.sender_id)),
      );
      const payload = {
        conversationId: data.conversationId,
        readerId: user.id,
        readAt,
        messageIds: messages.map((message) => message.id),
      };

      socket.to(data.conversationId).emit("messages_read", payload);
      for (const senderId of senderIds) {
        socket.to(senderId).emit("messages_read", payload);
      }
    } catch (err) {
      console.error("Error marking messages read:", err);
    }
  });

  // Handle online status
  socket.on("set_online", async () => {
    await markUserOnline(socket.data.token, user.id);
  });

  socket.on("disconnect", async () => {
    console.log(`User ${user.id} disconnected`);
    await markUserOfflineIfNeeded(socket.data.token, user.id);
  });
});

// API routes
app.get("/api/conversations", async (req, res) => {
  // Get user's conversations
  // This would require auth middleware
  // For now, placeholder
  res.json([]);
});

app.post("/api/conversations", async (req, res) => {
  // Create conversation
  // Placeholder
  res.json({ id: "temp" });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
