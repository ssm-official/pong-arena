// ===========================================
// Solana Utilities — Token transfers, escrow, burn
// ===========================================

const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
} = require('@solana/web3.js');
const {
  createTransferInstruction,
  createBurnInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
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

// Stake tiers: amounts in $PONG base units (6 decimals for pump.fun tokens)
const PONG_DECIMALS = 6;
const STAKE_TIERS = {
  low:    10000  * (10 ** PONG_DECIMALS),
  medium: 50000  * (10 ** PONG_DECIMALS),
  high:   200000 * (10 ** PONG_DECIMALS),
};

/**
 * Check if a token account exists on-chain.
 */
async function tokenAccountExists(address) {
  try {
    const info = await connection.getAccountInfo(new PublicKey(address));
    return info !== null;
  } catch {
    return false;
  }
}

/**
 * Build a transaction for a player to transfer $PONG to treasury (escrow).
 * Returns serialized transaction for the client to sign.
 * If the treasury ATA doesn't exist, the player pays to create it.
 */
async function buildEscrowTransaction(playerWallet, tier) {
  const amount = STAKE_TIERS[tier];
  if (!amount) throw new Error('Invalid tier');

  const player = new PublicKey(playerWallet);
  const treasury = getTreasuryKeypair();
  const mint = PONG_MINT();

  // Compute ATA addresses locally (no RPC call)
  const playerATA = await getAssociatedTokenAddress(mint, player);
  const treasuryATA = await getAssociatedTokenAddress(mint, treasury.publicKey);

  const tx = new Transaction();

  // If treasury ATA doesn't exist yet, add instruction to create it (player pays)
  const treasuryExists = await tokenAccountExists(treasuryATA);
  if (!treasuryExists) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        player,              // payer
        treasuryATA,         // ATA to create
        treasury.publicKey,  // owner of the ATA
        mint
      )
    );
  }

  // Transfer $PONG from player to treasury
  tx.add(
    createTransferInstruction(
      playerATA,
      treasuryATA,
      player,        // signer = player
      amount,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  tx.feePayer = player;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  return {
    transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    amount
  };
}

/**
 * Verify an escrow transaction was confirmed on-chain.
 */
async function verifyEscrowTx(txSignature, expectedAmount, playerWallet) {
  // The transaction may not be confirmed yet — retry up to 12 times (30s total)
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const tx = await connection.getTransaction(txSignature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
      if (tx) {
        return !tx.meta.err;
      }
    } catch {
      // RPC error, retry
    }
    // Wait 2.5 seconds before next attempt
    await new Promise(r => setTimeout(r, 2500));
  }
  return false;
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

  const treasuryATA = await getAssociatedTokenAddress(mint, treasury.publicKey);
  const winnerATA = await getAssociatedTokenAddress(mint, winner);

  const tx = new Transaction();

  // Create winner's ATA if it doesn't exist (treasury pays)
  const winnerATAExists = await tokenAccountExists(winnerATA);
  if (!winnerATAExists) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        treasury.publicKey, // payer
        winnerATA,
        winner,
        mint
      )
    );
  }

  // Transfer winnings to winner
  tx.add(createTransferInstruction(
    treasuryATA,
    winnerATA,
    treasury.publicKey,
    winnerShare,
    [],
    TOKEN_PROGRAM_ID
  ));

  // Burn 5%
  tx.add(createBurnInstruction(
    treasuryATA,
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
 * Build skin purchase transaction (player -> treasury).
 */
async function buildSkinPurchaseTransaction(playerWallet, price) {
  const player = new PublicKey(playerWallet);
  const treasury = getTreasuryKeypair();
  const mint = PONG_MINT();

  const playerATA = await getAssociatedTokenAddress(mint, player);
  const treasuryATA = await getAssociatedTokenAddress(mint, treasury.publicKey);

  const tx = new Transaction();

  const treasuryExists = await tokenAccountExists(treasuryATA);
  if (!treasuryExists) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        player, treasuryATA, treasury.publicKey, mint
      )
    );
  }

  tx.add(
    createTransferInstruction(
      playerATA, treasuryATA, player, price, [], TOKEN_PROGRAM_ID
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

  const treasuryATA = await getAssociatedTokenAddress(mint, treasury.publicKey);

  const tx = new Transaction().add(
    createBurnInstruction(
      treasuryATA, mint, treasury.publicKey, burnAmount, [], TOKEN_PROGRAM_ID
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
  PONG_DECIMALS,
  buildEscrowTransaction,
  verifyEscrowTx,
  payoutWinner,
  buildSkinPurchaseTransaction,
  burnSkinRevenue,
};
