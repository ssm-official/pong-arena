// ===========================================
// Wallet.js — Phantom wallet connection & signing
// ===========================================
// Uses Phantom's injected provider directly (no React adapter needed).

const WalletManager = (() => {
  let provider = null;
  let publicKey = null;
  let connected = false;

  function getProvider() {
    if (window.phantom?.solana?.isPhantom) {
      return window.phantom.solana;
    }
    return null;
  }

  async function connect() {
    provider = getProvider();
    if (!provider) {
      window.open('https://phantom.app/', '_blank');
      throw new Error('Phantom wallet not found. Please install it.');
    }

    const resp = await provider.connect();
    publicKey = resp.publicKey.toString();
    connected = true;
    return publicKey;
  }

  async function disconnect() {
    if (provider) {
      await provider.disconnect();
    }
    publicKey = null;
    connected = false;
  }

  /**
   * Sign a message for authentication.
   * Returns { wallet, signature, timestamp } for server verification.
   */
  async function signAuthMessage() {
    if (!provider || !publicKey) throw new Error('Wallet not connected');

    const timestamp = Date.now().toString();
    const message = `PongArena:${publicKey}:${timestamp}`;
    const encodedMessage = new TextEncoder().encode(message);
    const { signature } = await provider.signMessage(encodedMessage, 'utf8');

    // Convert Uint8Array to base58
    const signatureBase58 = base58Encode(signature);

    return { wallet: publicKey, signature: signatureBase58, timestamp };
  }

  /**
   * Sign and send a serialized transaction (for escrow/purchases).
   * Decodes base64 → bytes → base58, then uses Phantom's request API.
   * Returns the transaction signature string.
   */
  async function signAndSendTransaction(serializedTxBase64) {
    if (!provider) throw new Error('Wallet not connected');

    // Decode base64 to Uint8Array
    const txBytes = Uint8Array.from(atob(serializedTxBase64), c => c.charCodeAt(0));

    // Phantom's request API expects base58-encoded transaction
    const txBase58 = base58Encode(txBytes);

    const { signature } = await provider.request({
      method: 'signAndSendTransaction',
      params: {
        message: txBase58,
      }
    });

    return signature;
  }

  function getPublicKey() { return publicKey; }
  function isConnected() { return connected; }

  /**
   * Get auth header for API calls: "wallet:signature:timestamp"
   */
  async function getAuthHeader() {
    const { wallet, signature, timestamp } = await signAuthMessage();
    return `${wallet}:${signature}:${timestamp}`;
  }

  function getWallet() { return publicKey; }

  return {
    connect, disconnect, signAuthMessage,
    signAndSendTransaction,
    getPublicKey, isConnected, getAuthHeader, getWallet,
  };
})();

// ---- Base58 Encoder (lightweight, no dependency) ----
function base58Encode(buffer) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let carry, digits = [0];

  for (let i = 0; i < buffer.length; i++) {
    carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let output = '';
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    output += ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    output += ALPHABET[digits[i]];
  }
  return output;
}
