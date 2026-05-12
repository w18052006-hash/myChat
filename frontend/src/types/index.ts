export interface User {
  id: string;
  email: string;
  publicKey: string;
}

export interface Conversation {
  id: string;
  participant1: User;
  participant2: User;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  encryptedContent: string;
  nonce: string;
  encryptedKeyForSender?: string | null;
  encryptedKeyForRecipient?: string | null;
  keyNonceForSender?: string | null;
  keyNonceForRecipient?: string | null;
  timestamp: string;
  readAt?: string | null;
  decryptedContent?: string; // for display
}

export interface UserStatus {
  userId: string;
  status: "online" | "offline";
  lastSeen: string;
}
