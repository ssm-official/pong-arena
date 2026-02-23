// ===========================================
// Solana Utilities — Token transfers, escrow, burn
// ===========================================
// All operations use DEVNET. For mainnet, change RPC and handle real tokens.

const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  createBurnInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58');

// Load env
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// Treasury keypair (loaded from env)
let treasuryKeypair = null;
function getTreasuryKeypair() {
  if (!treasuryKeypair) {
    const secret = bs58.decode(process.env.TREASURY_PRIVATE_KEY);
    treasuryKeypair = Keypair.fromSecretKey(secret);
  }
  return treasuryKeypair;
}

const PONG_MINT = () => new PublicKey(process.env.PONG_MINT_ADDRESS);
const BURN_ADDRESS = () => new PublicKey(process.env.BURN_ADDRESS || '1nc1nerator11111111111111111111111111111111');

// Stake tiers: amounts in $PONG base units (assuming 9 decimals like SOL)
const STAKE_TIERS = {
  low:    10  * 1e9,  // 10 $PONG
  medium: 50  * 1e9,  // 50 $PONG
  high:   200 * 1e9,  // 200 $PONG
};

/**
 * Build a transaction for a player to transfer $PONG to treasury (escrow).
 * Returns serialized transaction for the client to sign.
 */
async function buildEscrowTransaction(playerWallet, tier) {
  const amount = STAKE_TIERS[tier];
  if (!amount) throw new Error('Invalid tier');

  const player = new PublicKey(playerWallet);
  const treasury = getTreasuryKeypair();
  const mint = PONG_MINT();

  // Get/create token accounts
  const playerATA = await getAssociatedTokenAddress(mint, player);
  const treasuryATA = await getOrCreateAssociatedTokenAccount(
    connection, treasury, mint, treasury.publicKey
  );

  const tx = new Transaction().add(
    createTransferInstruction(
      playerATA,
      treasuryATA.address,
      player,               // owner (signer = player)
      amount,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  tx.feePayer = player;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  // Serialize for client to sign (partial sign not needed, player is sole signer)
  return {
    transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    amount
  };
}

/**
 * Verify an escrow transaction was confirmed on-chain.
 */
async function verifyEscrowTx(txSignature, expectedAmount, playerWallet) {
  try {
    const tx = await connection.getTransaction(txSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    if (!tx) return false;
    // Basic check: tx succeeded
    if (tx.meta.err) return false;
    // In production, parse instructions to verify exact amount/destination
    return true;
  } catch {
    return false;
  }
}

/**
 * Pay out the winner from treasury wallet.
 * Winner gets ~90% of total pot. 5% burned, 5% stays in treasury.
 */
async function payoutWinner(winnerWallet, totalPot) {
  const treasury = getTreasuryKeypair();
  const mint = PONG_MINT();
  const winner = new PublicKey(winnerWallet);

  const winnerShare = Math.floor(totalPot * 0.9);
  const burnShare  = Math.floor(totalPot * 0.05);
  // Remaining 5% stays in treasury

  // Get token accounts
  const treasuryATA = await getOrCreateAssociatedTokenAccount(
    connection, treasury, mint, treasury.publicKey
  );
  const winnerATA = await getOrCreateAssociatedTokenAccount(
    connection, treasury, mint, winner
  );

  const tx = new Transaction();

  // Transfer winnings to winner
  tx.add(createTransferInstruction(
    treasuryATA.address,
    winnerATA.address,
    treasury.publicKey,
    winnerShare,
    [],
    TOKEN_PROGRAM_ID
  ));

  // Burn 5% (transfer to burn address or use burn instruction if treasury has authority)
  // MVP: use burn instruction directly from treasury ATA
  tx.add(createBurnInstruction(
    treasuryATA.address,
    mint,
    treasury.publicKey,
    burnShare,
    [],
    TOKEN_PROGRAM_ID
  ));

  tx.feePayer = treasury.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(treasury);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');

  return { payoutTx: sig, winnerShare, burnShare };
}

/**
 * Process a skin purchase: 90% burn, 10% to treasury.
 * The player sends $PONG to treasury, then treasury burns 90%.
 */
async function buildSkinPurchaseTransaction(playerWallet, price) {
  const player = new PublicKey(playerWallet);
  const treasury = getTreasuryKeypair();
  const mint = PONG_MINT();

  const playerATA = await getAssociatedTokenAddress(mint, player);
  const treasuryATA = await getOrCreateAssociatedTokenAccount(
    connection, treasury, mint, treasury.publicKey
  );

  const tx = new Transaction().add(
    createTransferInstruction(
      playerATA,
      treasuryATA.address,
      player,
      price,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  tx.feePayer = player;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  return {
    transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    amount: price
  };
}

/**
 * After skin purchase is confirmed, burn 90% from treasury.
 */
async function burnSkinRevenue(price) {
  const burnAmount = Math.floor(price * 0.9);
  const treasury = getTreasuryKeypair();
  const mint = PONG_MINT();

  const treasuryATA = await getOrCreateAssociatedTokenAccount(
    connection, treasury, mint, treasury.publicKey
  );

  const tx = new Transaction().add(
    createBurnInstruction(
      treasuryATA.address,
      mint,
      treasury.publicKey,
      burnAmount,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  tx.feePayer = treasury.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(treasury);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

module.exports = {
  connection,
  STAKE_TIERS,
  buildEscrowTransaction,
  verifyEscrowTx,
  payoutWinner,
  buildSkinPurchaseTransaction,
  burnSkinRevenue,
};
