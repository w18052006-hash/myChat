"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  generateKeyPair,
  getKeyPair,
  hasLocalKeyMaterial,
  storeKeyPair,
  unlockKeyPair,
} from "@/lib/crypto";

const ensureUserProfile = async (
  user: { id: string; email?: string | null },
  keyPassphrase: string,
) => {
  const { data: existingProfile, error: selectError } = await supabase
    .from("users")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (selectError) throw selectError;
  if (existingProfile) return;

  let keyPair = getKeyPair();
  if (!keyPair) {
    keyPair = await generateKeyPair();
    await storeKeyPair(keyPair.publicKey, keyPair.privateKey, keyPassphrase);
  }

  const { error: profileError } = await supabase.from("users").insert({
    id: user.id,
    email: user.email ?? "",
    public_key: keyPair.publicKey,
  });

  if (profileError) throw profileError;
};

const Auth = ({ onAuth }: { onAuth: () => void }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"error" | "success">("error");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      if (keyPassphrase.length < 8) {
        throw new Error("Use a key passphrase with at least 8 characters.");
      }

      if (isLogin) {
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (error) throw error;
        if (!data.user && !data.session) {
          throw new Error("Unable to sign in. Please check your credentials.");
        }

        const user = data.user ?? data.session?.user;
        if (user) {
          if (hasLocalKeyMaterial()) {
            const unlocked = await unlockKeyPair(keyPassphrase);
            if (!unlocked) {
              throw new Error("Could not unlock your local encryption key.");
            }
          }

          await ensureUserProfile(user, keyPassphrase);
          if (!getKeyPair()) {
            throw new Error(
              "No local encryption key found for this account on this browser.",
            );
          }
        }
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
        });

        if (error) throw error;

        if (!data.session) {
          setMessageType("success");
          setMessage("Sign up succeeded. Check your email to confirm your account, then log in.");
          setIsLogin(true);
          return;
        }

        await ensureUserProfile(data.session.user, keyPassphrase);
      }

      onAuth();
    } catch (error) {
      console.error("Auth error:", error);
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      setMessageType("error");
      setMessage(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
      <form
        onSubmit={handleSubmit}
        className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-md w-96"
      >
        <h2 className="text-2xl mb-4">{isLogin ? "Login" : "Sign Up"}</h2>
        {message && (
          <p
            className={`mb-4 rounded border p-3 text-sm ${
              messageType === "success"
                ? "border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300"
                : "border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300"
            }`}
          >
            {message}
          </p>
        )}
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full p-2 mb-4 border rounded"
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 mb-4 border rounded"
          required
        />
        <input
          type="password"
          placeholder="Encryption passphrase"
          value={keyPassphrase}
          onChange={(e) => setKeyPassphrase(e.target.value)}
          className="w-full p-2 mb-4 border rounded"
          required
        />
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-blue-500 text-white p-2 rounded"
        >
          {loading ? "Loading..." : isLogin ? "Login" : "Sign Up"}
        </button>
        <button
          type="button"
          onClick={() => setIsLogin(!isLogin)}
          className="w-full mt-2 text-blue-500"
        >
          {isLogin ? "Need an account? Sign Up" : "Have an account? Login"}
        </button>
      </form>
    </div>
  );
};

export default Auth;
