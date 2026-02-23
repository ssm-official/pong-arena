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
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58');

// Pump.fun tokens use Token-2022 (Token Extensions), NOT the legacy Token Program
const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID;

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
 * Get ATA address for a Token-2022 mint.
 */
function getATA(mint, owner) {
  return getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID);
}

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
 */
async function buildEscrowTransaction(playerWallet, tier) {
  const amount = STAKE_TIERS[tier];
  if (!amount) throw new Error('Invalid tier');

  const player = new PublicKey(playerWallet);
  const treasury = getTreasuryKeypair();
  const mint = PONG_MINT();

  const playerATA = await getATA(mint, player);
  const treasuryATA = await getATA(mint, treasury.publicKey);

  const tx = new Transaction();

  // If treasury ATA doesn't exist yet, add instruction to create it (player pays)
  const treasuryExists = await tokenAccountExists(treasuryATA);
  if (!treasuryExists) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        player,              // payer
        treasuryATA,         // ATA to create
        treasury.publicKey,  // owner of the ATA
        mint,
        TOKEN_PROGRAM,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Transfer $PONG from player to treasury
  tx.add(
    createTransferInstruction(
      playerATA,
      treasuryATA,
      player,
      amount,
      [],
      TOKEN_PROGRAM
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
  console.log(`Verifying tx: ${txSignature} for ${playerWallet}`);

  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const res = await connection.getSignatureStatus(txSignature, {
        searchTransactionHistory: true,
      });
      const status = res?.value;
      console.log(`  Attempt ${attempt + 1}: ${JSON.stringify(status)}`);

      if (status?.err) {
        console.error('Transaction failed on-chain:', JSON.stringify(status.err));
        return false;
      }

      if (status?.confirmationStatus === 'confirmed' ||
          status?.confirmationStatus === 'finalized' ||
          status?.confirmationStatus === 'processed') {
        console.log('Transaction confirmed!');
        return true;
      }
    } catch (err) {
      console.error(`  Attempt ${attempt + 1} RPC error:`, err.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.error('Transaction not confirmed after 15 attempts (30s)');
  return false;
}

/**
 * Refund a player from treasury (if opponent cancels after they escrowed).
 */
async function refundPlayer(playerWallet, amount) {
  const treasury = getTreasuryKeypair();
  const mint = PONG_MINT();
  const player = new PublicKey(playerWallet);

  const treasuryATA = await getATA(mint, treasury.publicKey);
  const playerATA = await getATA(mint, player);

  const tx = new Transaction();

  const playerATAExists = await tokenAccountExists(playerATA);
  if (!playerATAExists) {
    tx.add(createAssociatedTokenAccountInstruction(
      treasury.publicKey, playerATA, player, mint, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID
    ));
  }

  tx.add(createTransferInstruction(
    treasuryATA, playerATA, treasury.publicKey, amount, [], TOKEN_PROGRAM
  ));

  tx.feePayer = treasury.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(treasury);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
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

  const treasuryATA = await getATA(mint, treasury.publicKey);
  const winnerATA = await getATA(mint, winner);

  const tx = new Transaction();

  const winnerATAExists = await tokenAccountExists(winnerATA);
  if (!winnerATAExists) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        treasury.publicKey, winnerATA, winner, mint, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // Transfer winnings to winner
  tx.add(createTransferInstruction(
    treasuryATA, winnerATA, treasury.publicKey, winnerShare, [], TOKEN_PROGRAM
  ));

  // Burn 5%
  tx.add(createBurnInstruction(
    treasuryATA, mint, treasury.publicKey, burnShare, [], TOKEN_PROGRAM
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

  const playerATA = await getATA(mint, player);
  const treasuryATA = await getATA(mint, treasury.publicKey);

  const tx = new Transaction();

  const treasuryExists = await tokenAccountExists(treasuryATA);
  if (!treasuryExists) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        player, treasuryATA, treasury.publicKey, mint, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  tx.add(
    createTransferInstruction(
      playerATA, treasuryATA, player, price, [], TOKEN_PROGRAM
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

  const treasuryATA = await getATA(mint, treasury.publicKey);

  const tx = new Transaction().add(
    createBurnInstruction(
      treasuryATA, mint, treasury.publicKey, burnAmount, [], TOKEN_PROGRAM
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
  refundPlayer,
  buildSkinPurchaseTransaction,
  burnSkinRevenue,
};
