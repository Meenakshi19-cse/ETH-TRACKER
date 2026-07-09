import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const dbName = process.env.MONGODB_DB || 'forensics_db';

let client = null;
let db = null;

/**
 * Connect to MongoDB
 */
export async function connectDB() {
  if (db) return db;

  try {
    client = new MongoClient(mongoUri);
    await client.connect();
    db = client.db(dbName);
    console.error(`Connected to MongoDB: ${dbName}`);

    // Create indexes for efficient querying
    await createIndexes();

    return db;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

/**
 * Create indexes for the transaction_edges collection
 */
async function createIndexes() {
  try {
    // 1. Transaction Edges (Existing)
    const edges = db.collection('transaction_edges');
    await edges.createIndex({ tx_hash: 1 });
    await edges.createIndex({ from_address: 1, to_address: 1 });
    await edges.createIndex({ timestamp: -1 });

    // 2. Wallets (New: Graph-like structure)
    const wallets = db.collection('wallets');
    await wallets.createIndex({ address: 1 }, { unique: true });
    await wallets.createIndex({ risk_score: -1 });
    await wallets.createIndex({ entity_type: 1 });

    // 3. Alerts (New: For Dust Attacks and Mixer detection)
    const alerts = db.collection('alerts');
    await alerts.createIndex({ wallet_id: 1 });
    await alerts.createIndex({ tx_hash: 1 });
    await alerts.createIndex({ alert_type: 1 });
    await alerts.createIndex({ timestamp: -1 });

    // 4. Intel Reports (New: For investigator outputs)
    const reports = db.collection('intel_reports');
    await reports.createIndex({ seed_wallet: 1 });
    await reports.createIndex({ generated_at: -1 });

    console.error('Created advanced forensic indexes for graph architecture');
  } catch (error) {
    console.error('Error creating indexes:', error);
  }
}

/**
 * Upsert a Wallet document (Graph Node)
 */
export async function upsertWallet(walletData) {
  if (!db) await connectDB();
  const collection = db.collection('wallets');

  const update = {
    $set: {
      address: walletData.address,
      entity_type: walletData.entity_type || 'unknown',
      risk_score: walletData.risk_score || 0,
      last_updated: new Date()
    },
    $addToSet: {
      offchain_mentions: { $each: walletData.offchain_mentions || [] },
      chains: { $each: walletData.chains || ['ethereum'] },
      seen_on: { $each: walletData.seen_on || ['blockchain'] }
    }
  };

  return collection.updateOne({ address: walletData.address }, update, { upsert: true });
}

/**
 * Store an Alert (Forensic Hit)
 */
export async function storeAlert(alert) {
  if (!db) await connectDB();
  return db.collection('alerts').insertOne({
    ...alert,
    created_at: new Date()
  });
}

/**
 * Get OSINT Data for an address
 */
export async function getWalletOSINT(address) {
  if (!db) await connectDB();
  return db.collection('wallets').findOne({ address });
}

/**
 * Store a single transaction edge
 * @param {Object} edge - The edge data
 * @param {string} edge.tx_hash - Transaction hash
 * @param {string} edge.from_address - From address
 * @param {string} edge.to_address - To address
 * @param {string} edge.value - Value in wei
 * @param {number} edge.block_number - Block number
 * @param {number} edge.timestamp - Unix timestamp
 * @param {number} edge.hop_number - Hop number in the trace
 */

export async function storeEdge(edge) {
  if (!db) await connectDB();

  const collection = db.collection('transaction_edges');

  const document = {
    tx_hash: edge.tx_hash,
    from_address: edge.from_address,
    to_address: edge.to_address,
    value: edge.value,
    block_number: edge.block_number,
    timestamp: edge.timestamp,
    hop_number: edge.hop_number,
    created_at: new Date()
  };

  try {
    await collection.insertOne(document);
    console.error(`Stored edge: ${edge.from_address} -> ${edge.to_address} (hop ${edge.hop_number})`);
  } catch (error) {
    console.error('Error storing edge:', error);
    throw error;
  }
}

/**
 * Forensic Watchlist: Get historical stats for an address
 */
export async function getWalletStats(address) {
  if (!db) await connectDB();
  const collection = db.collection('transaction_edges');

  // Find all edges involving this address
  const edges = await collection.find({
    $or: [{ from_address: address }, { to_address: address }]
  }).toArray();

  let totalVolumeWei = 0n;
  edges.forEach(e => {
    try {
      const val = String(e.value || '0');
      if (val.includes('.')) {
        // If it's already an Ether string (has decimal), convert back to Wei
        totalVolumeWei += ethers.parseEther(val);
      } else {
        // Standard Wei string/hex
        totalVolumeWei += BigInt(val.startsWith('0x') ? val : val);
      }
    } catch (err) {
      console.warn(`Skipping invalid value in stats: ${e.value}`);
    }
  });

  return {
    total_txs: edges.length,
    total_value_wei: totalVolumeWei.toString()
  };
}

/**
 * Store multiple transaction edges in batch
 * @param {Array} edges - Array of edge objects
 */
export async function storeEdges(edges) {
  if (!db || edges.length === 0) return;

  const collection = db.collection('transaction_edges');

  const documents = edges.map(edge => ({
    tx_hash: edge.tx_hash,
    from_address: edge.from_address,
    to_address: edge.to_address,
    value: edge.value,
    block_number: edge.block_number,
    timestamp: edge.timestamp,
    hop_number: edge.hop_number,
    created_at: new Date()
  }));

  try {
    await collection.insertMany(documents);
    console.error(`Stored ${documents.length} edges in batch`);
  } catch (error) {
    console.error('Error storing edges batch:', error);
    throw error;
  }
}

/**
 * Get all edges (for analysis)
 * @param {Object} options - Query options
 * @param {number} options.limit - Max number of results
 * @param {number} options.skip - Number of results to skip
 */
export async function getEdges({ limit = 100, skip = 0 } = {}) {
  if (!db) await connectDB();

  const collection = db.collection('transaction_edges');

  return collection
    .find({})
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
}

/**
 * Get chronological transaction history for an address (Required for TEMPER AI)
 * Fetches all transactions where the user was sender or receiver, sorted historically
 */
export async function getChronologicalHistory(address, limit = 50) {
  if (!db) await connectDB();

  const collection = db.collection('transaction_edges');

  return collection
    .find({
      $or: [
        { from_address: address },
        { to_address: address }
      ]
    })
    .sort({ timestamp: 1 })
    .limit(limit)
    .toArray();
}

/**
 * Get edges for a specific from_address
 * @param {string} address - The from address
 */
export async function getEdgesByFromAddress(address) {
  if (!db) await connectDB();

  const collection = db.collection('transaction_edges');

  return collection
    .find({ from_address: address })
    .sort({ hop_number: 1 })
    .toArray();
}

/**
 * Get all edges connected to an address (as from or to)
 * @param {string} address - The address to search for
 */
export async function getEdgesByAddress(address) {
  if (!db) await connectDB();

  const collection = db.collection('transaction_edges');

  return collection
    .find({
      $or: [
        { from_address: address },
        { to_address: address }
      ]
    })
    .sort({ timestamp: -1 })
    .toArray();
}

/**
 * Get edge by transaction hash
 * @param {string} txHash - Transaction hash
 */
export async function getEdgeByTxHash(txHash) {
  if (!db) await connectDB();

  const collection = db.collection('transaction_edges');

  return collection.find({ tx_hash: txHash }).toArray();
}

/**
 * Clear all edges (for testing/reset)
 */
export async function clearEdges() {
  if (!db) await connectDB();

  const collection = db.collection('transaction_edges');
  const result = await collection.deleteMany({});
  console.error(`Cleared ${result.deletedCount} edges`);
  return result;
}

/**
 * Close MongoDB connection
 */
export async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.error('MongoDB connection closed');
  }
}

export default {
  connectDB,
  storeEdge,
  storeEdges,
  getEdges,
  getChronologicalHistory,
  getEdgesByFromAddress,
  getEdgesByAddress,
  getEdgeByTxHash,
  upsertWallet,
  storeAlert,
  getWalletOSINT,
  getWalletStats,
  clearEdges,
  closeDB
};

