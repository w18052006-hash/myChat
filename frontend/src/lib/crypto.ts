import sodium from "libsodium-wrappers";

let sodiumReady = false;
let unlockedKeyPair: { publicKey: string; privateKey: string } | null = null;

type EncryptedPrivateKey = {
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

export type SealedMessage = {
  encrypted: string;
  nonce: string;
  encryptedKeyForSender: string;
  encryptedKeyForRecipient: string;
  keyNonceForSender: string;
  keyNonceForRecipient: string;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const initSodium = async () => {
  if (!sodiumReady) {
    await sodium.ready;
    sodiumReady = true;
  }
};

const bytesToBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes));

const base64ToBytes = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const deriveLocalKey = async (
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
) => {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: asArrayBuffer(salt),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

const encryptPrivateKey = async (
  privateKey: string,
  passphrase: string,
): Promise<EncryptedPrivateKey> => {
  const iterations = 310000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveLocalKey(passphrase, salt, iterations);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv) },
    key,
    textEncoder.encode(privateKey),
  );

  return {
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
};

const decryptPrivateKey = async (
  encryptedPrivateKey: EncryptedPrivateKey,
  passphrase: string,
) => {
  const key = await deriveLocalKey(
    passphrase,
    base64ToBytes(encryptedPrivateKey.salt),
    encryptedPrivateKey.iterations,
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(base64ToBytes(encryptedPrivateKey.iv)),
    },
    key,
    base64ToBytes(encryptedPrivateKey.ciphertext),
  );

  return textDecoder.decode(plaintext);
};

export const generateKeyPair = async (): Promise<{
  publicKey: string;
  privateKey: string;
}> => {
  await initSodium();
  const keyPair = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(keyPair.publicKey),
    privateKey: sodium.to_base64(keyPair.privateKey),
  };
};

export const storeKeyPair = async (
  publicKey: string,
  privateKey: string,
  passphrase: string,
) => {
  const encryptedPrivateKey = await encryptPrivateKey(privateKey, passphrase);
  localStorage.setItem("publicKey", publicKey);
  localStorage.setItem("encryptedPrivateKey", JSON.stringify(encryptedPrivateKey));
  localStorage.removeItem("privateKey");
  unlockedKeyPair = { publicKey, privateKey };
};

export const unlockKeyPair = async (passphrase: string) => {
  const publicKey = localStorage.getItem("publicKey");
  const encryptedPrivateKey = localStorage.getItem("encryptedPrivateKey");
  const legacyPrivateKey = localStorage.getItem("privateKey");

  if (!publicKey) return null;

  if (legacyPrivateKey) {
    await storeKeyPair(publicKey, legacyPrivateKey, passphrase);
    return unlockedKeyPair;
  }

  if (!encryptedPrivateKey) return null;

  const privateKey = await decryptPrivateKey(
    JSON.parse(encryptedPrivateKey) as EncryptedPrivateKey,
    passphrase,
  );
  unlockedKeyPair = { publicKey, privateKey };
  return unlockedKeyPair;
};

export const lockKeyPair = () => {
  unlockedKeyPair = null;
};

export const hasLocalKeyMaterial = () =>
  Boolean(
    localStorage.getItem("publicKey") &&
      (localStorage.getItem("encryptedPrivateKey") ||
        localStorage.getItem("privateKey")),
  );

export const getKeyPair = () => unlockedKeyPair;

export const getPublicKeyFingerprint = async (publicKey: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(publicKey),
  );
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .match(/.{1,4}/g)!
    .join(" ");
};

// Legacy long-term-key encryption kept for decrypting existing messages/reactions.
export const encryptMessage = async (
  message: string,
  recipientPublicKey: string,
  senderPrivateKey: string,
): Promise<{ encrypted: string; nonce: string }> => {
  await initSodium();
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const encrypted = sodium.crypto_box_easy(
    sodium.from_string(message),
    nonce,
    sodium.from_base64(recipientPublicKey),
    sodium.from_base64(senderPrivateKey),
  );
  return {
    encrypted: sodium.to_base64(encrypted),
    nonce: sodium.to_base64(nonce),
  };
};

export const decryptMessage = async (
  encrypted: string,
  nonce: string,
  senderPublicKey: string,
  recipientPrivateKey: string,
): Promise<string> => {
  await initSodium();
  const decrypted = sodium.crypto_box_open_easy(
    sodium.from_base64(encrypted),
    sodium.from_base64(nonce),
    sodium.from_base64(senderPublicKey),
    sodium.from_base64(recipientPrivateKey),
  );
  return sodium.to_string(decrypted);
};

export const sealMessage = async (
  message: string,
  senderPublicKey: string,
  senderPrivateKey: string,
  recipientPublicKey: string,
): Promise<SealedMessage> => {
  await initSodium();
  const messageKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = sodium.crypto_secretbox_easy(
    sodium.from_string(message),
    nonce,
    messageKey,
  );
  const keyNonceForSender = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const keyNonceForRecipient = sodium.randombytes_buf(
    sodium.crypto_box_NONCEBYTES,
  );

  return {
    encrypted: sodium.to_base64(encrypted),
    nonce: sodium.to_base64(nonce),
    encryptedKeyForSender: sodium.to_base64(
      sodium.crypto_box_easy(
        messageKey,
        keyNonceForSender,
        sodium.from_base64(senderPublicKey),
        sodium.from_base64(senderPrivateKey),
      ),
    ),
    encryptedKeyForRecipient: sodium.to_base64(
      sodium.crypto_box_easy(
        messageKey,
        keyNonceForRecipient,
        sodium.from_base64(recipientPublicKey),
        sodium.from_base64(senderPrivateKey),
      ),
    ),
    keyNonceForSender: sodium.to_base64(keyNonceForSender),
    keyNonceForRecipient: sodium.to_base64(keyNonceForRecipient),
  };
};

export const openSealedMessage = async (
  sealed: SealedMessage,
  senderPublicKey: string,
  recipientPublicKey: string,
  recipientPrivateKey: string,
  isOwnMessage: boolean,
) => {
  await initSodium();
  const encryptedKey = isOwnMessage
    ? sealed.encryptedKeyForSender
    : sealed.encryptedKeyForRecipient;
  const keyNonce = isOwnMessage
    ? sealed.keyNonceForSender
    : sealed.keyNonceForRecipient;
  const publicKey = isOwnMessage ? recipientPublicKey : senderPublicKey;

  const messageKey = sodium.crypto_box_open_easy(
    sodium.from_base64(encryptedKey),
    sodium.from_base64(keyNonce),
    sodium.from_base64(publicKey),
    sodium.from_base64(recipientPrivateKey),
  );
  const decrypted = sodium.crypto_secretbox_open_easy(
    sodium.from_base64(sealed.encrypted),
    sodium.from_base64(sealed.nonce),
    messageKey,
  );
  return sodium.to_string(decrypted);
};
