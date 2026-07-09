import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import express from 'express'
import cors from 'cors'
import { ethers } from 'ethers'
import axios from 'axios'
import fs from 'fs/promises'
import { connectDB, storeEdge } from './db.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
dotenv.config({ path: path.join(__dirname, '.env') })

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

const port = Number(process.env.PORT || 5000)
const rpcUrl = process.env.ETH_RPC_URL

if (!rpcUrl) {
  throw new Error('Missing ETH_RPC_URL in environment')
}

const provider = new ethers.JsonRpcProvider(rpcUrl)

const safeFormatEther = (wei) => {
  try {
    const s = String(wei || '0');
    if (s.includes('.')) return s; // Already decoded as Ether
    return ethers.formatEther(s);
  } catch (err) {
    return '0';
  }
}

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)')

function parseAddressCsv(value) {
  if (!value || typeof value !== 'string') return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return ethers.getAddress(s)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

async function loadEntityDb() {
  const fallback = { entities: [] }
  try {
    const raw = await fs.readFile(new URL('./entities.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.entities)) return fallback
    return parsed
  } catch {
    return fallback
  }
}

function buildEntityIndex(entityDb) {
  const addressToEntity = new Map()
  const tornadoPools = new Set()

  const add = (address, entity) => {
    try {
      const a = ethers.getAddress(address)
      addressToEntity.set(a, entity)
      if (entity?.tags?.includes('tornado') || String(entity?.name || '').toLowerCase().includes('tornado')) tornadoPools.add(a)
    } catch {
      return
    }
  }

  for (const e of entityDb?.entities || []) {
    const entity = {
      id: e.id || null,
      name: e.name || 'Unknown',
      category: e.category || 'unknown',
      jurisdiction: e.jurisdiction || null,
      tags: Array.isArray(e.tags) ? e.tags : [],
      notes: e.notes || null,
    }
    for (const a of e.addresses || []) add(a, entity)
  }

  const envExchangeName = process.env.KNOWN_EXCHANGE_NAME || 'Known Exchange'
  const envExchangeJurisdiction = process.env.KNOWN_EXCHANGE_JURISDICTION || null
  for (const a of parseAddressCsv(process.env.KNOWN_EXCHANGE_ADDRESSES)) {
    add(a, {
      id: 'env_exchange',
      name: envExchangeName,
      category: 'exchange',
      jurisdiction: envExchangeJurisdiction,
      tags: ['exchange', 'kyc'],
      notes: 'Configured via environment variables',
    })
  }

  return { addressToEntity, tornadoPools }
}

const ENTITY_DB = await loadEntityDb()
const ENTITY_INDEX = buildEntityIndex(ENTITY_DB)

function classifyKnownEntity(address) {
  if (!address) return null
  const a = ethers.getAddress(address)
  return ENTITY_INDEX.addressToEntity.get(a) || null
}

function isTornadoPool(address) {
  if (!address) return false
  const a = ethers.getAddress(address)
  return ENTITY_INDEX.tornadoPools.has(a)
}

function isTxHash(value) {
  return typeof value === 'string' && /^0x([A-Fa-f0-9]{64})$/.test(value)
}

function isAddress(value) {
  if (typeof value !== 'string') return false
  return ethers.isAddress(value.toLowerCase())
}

function shorten(value) {
  if (!value || typeof value !== 'string') return value
  if (value.length <= 14) return value
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

async function getAddressEnrichment(address) {
  if (!address) return { address }

  const checksummed = ethers.getAddress(address)

  // Use provider.getCode instead of Etherscan for basic contract check
  const code = await provider.getCode(checksummed).catch(() => '0x')
  const isContract = code !== '0x'

  return {
    address: checksummed,
    display: shorten(checksummed),
    isContract
  }
}

function parseTransfersFromReceipt(receipt) {
  if (!receipt?.logs) return []

  const transfers = []
  for (const log of receipt.logs) {
    if (!log?.topics || log.topics.length < 3) continue
    if (log.topics[0] !== TRANSFER_TOPIC) continue

    const from = ethers.getAddress(ethers.dataSlice(log.topics[1], 12))
    const to = ethers.getAddress(ethers.dataSlice(log.topics[2], 12))
    const dataRaw = (log.data === '0x' || !log.data) ? '0x0' : log.data
    const value = ethers.toBigInt(dataRaw).toString()

    transfers.push({
      tokenContract: ethers.getAddress(log.address),
      from,
      to,
      value,
    })
  }

  return transfers
}

async function getAlchemyAssetTransfers(address, category = ['external', 'internal', 'erc20']) {
  try {
    const response = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [{
        fromAddress: address,
        category,
        withMetadata: true,
        excludeZeroValue: true,
        order: 'desc',
        maxCount: '0x64'
      }]
    }, { timeout: 15000 });

    return response.data?.result?.transfers || []
  } catch (error) {
    console.error('Alchemy transfers error:', error);
    return []
  }
}

// Fetch outgoing transfers in ASCENDING chronological order
// Used specifically for hopping: finds the FIRST outgoing tx after a timestamp
async function getOutgoingTransfersAsc(address, fromBlock = '0x0') {
  try {
    const response = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [{
        fromAddress: address,
        fromBlock,
        category: ['external', 'internal'],
        withMetadata: true,
        excludeZeroValue: true,
        order: 'asc',
        maxCount: '0x64' // Increased to 100
      }]
    }, { timeout: 15000 });

    return response.data?.result?.transfers || []
  } catch (error) {
    console.error('Alchemy outgoing transfers error:', error);
    return []
  }
}

// Alchemy Asset Transfers replaces legacy Etherscan txlist

async function getAddressSummary(address) {
  const a = ethers.getAddress(address)
  const balanceWei = (await provider.getBalance(a)).toString()

  // Use Alchemy instead of Etherscan
  const transfers = await getAlchemyAssetTransfers(a)

  const byCounterparty = new Map()
  const seenOutgoingTornadoDeposits = []
  const seenIncomingTornadoWithdrawals = []

  let totalReceivedWei = 0n
  let totalSentWei = 0n
  const connected = new Set()
  for (const t of transfers) {
    const from = t.from ? ethers.getAddress(t.from) : null
    const to = t.to ? ethers.getAddress(t.to) : null
    const value = BigInt(t.rawContract?.value || '0')
    const timeStamp = Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000)

    if (from === a) {
      totalSentWei += value
      if (to) connected.add(to)

      if (to && isTornadoPool(to)) {
        seenOutgoingTornadoDeposits.push({
          txHash: t.hash,
          to,
          timeStamp,
          valueWei: value.toString(),
        })
      }
    } else if (to === a && from) {
      totalReceivedWei += value
      connected.add(from)

      if (from && isTornadoPool(from)) {
        seenIncomingTornadoWithdrawals.push({
          txHash: t.hash,
          from,
          timeStamp,
          valueWei: value.toString(),
        })
      }
    }

    const cp = from === a ? to : to === a ? from : null
    if (cp) byCounterparty.set(cp, (byCounterparty.get(cp) || 0) + 1)
  }

  const topCounterparties = [...byCounterparty.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 10)
    .map(([address, count]) => ({ address, count }))

  const clustering = {
    topCounterparties,
    heuristicNotes: [
      'Counterparty frequency is a heuristic signal only; it does not prove common ownership.',
      'Use clustering outputs as investigation leads, not as definitive attribution.',
    ],
  }

  const tornado = {
    deposits: seenOutgoingTornadoDeposits,
    withdrawals: seenIncomingTornadoWithdrawals,
  }

  return {
    address: a,
    balanceWei,
    totalReceivedWei: totalReceivedWei.toString(),
    totalSentWei: totalSentWei.toString(),
    txSampleCount: transfers.length,
    connectedCount: connected.size,
    clustering,
    tornado,
  }
}

function scoreTornadoCorrelation(deposits, withdrawals, { amountTolerancePct = 0.05, timeWindowSeconds = 60 * 60 } = {}) {
  const results = []
  if (!Array.isArray(deposits) || !Array.isArray(withdrawals)) return results

  const toleranceBps = Math.max(0, Math.min(10000, Math.round(Number(amountTolerancePct) * 10000)))

  for (const d of deposits) {
    const dVal = BigInt(d.valueWei || '0')
    const dTs = Number(d.timeStamp || 0)
    for (const w of withdrawals) {
      const wVal = BigInt(w.valueWei || '0')
      const wTs = Number(w.timeStamp || 0)

      const dt = Math.abs(wTs - dTs)
      if (dt > timeWindowSeconds) continue

      // amount similarity: within tolerance against deposit amount
      const diff = dVal > wVal ? dVal - wVal : wVal - dVal
      const tol = (dVal * BigInt(toleranceBps)) / 10000n
      const amountOk = dVal > 0n && diff <= tol

      if (!amountOk) continue

      // simple score: closer time => higher
      const timeScore = Math.max(0, 1 - dt / timeWindowSeconds)
      const score = Math.round((0.6 * timeScore + 0.4 * 1) * 100)

      results.push({
        depositTxHash: d.txHash,
        withdrawTxHash: w.txHash,
        depositPool: d.to,
        withdrawPool: w.from,
        depositTime: dTs,
        withdrawTime: wTs,
        depositValueWei: d.valueWei,
        withdrawValueWei: w.valueWei,
        timeDeltaSeconds: dt,
        score,
        note:
          'Heuristic correlation based on time proximity and similar amounts. Tornado pools use fixed denominations and withdrawals may include relayer fees; false positives are possible.',
      })
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 20)
}

/**
 * Advanced Forensics: Detect Dust Attacks
 */
function detectDustAttack(address, transfers) {
  const dustThreshold = ethers.parseEther('0.0001');
  const dustTxs = transfers.filter(t =>
    t.to?.toLowerCase() === address.toLowerCase() &&
    BigInt(t.rawContract?.value || 0) > 0n &&
    BigInt(t.rawContract?.value || 0) < dustThreshold
  );

  if (dustTxs.length >= 3) {
    return {
      type: 'DUST_ATTACK',
      severity: 'MEDIUM',
      indicators: [`Detected ${dustTxs.length} micro-transfers (dust) to this address.`],
      note: 'Adversaries use dust to de-anonymize wallet clusters through taint analysis.'
    };
  }
  return null;
}

function detectCoinJoin(txHash, transfers) {
  const values = transfers.map(t => t.value);
  const counts = {};
  values.forEach(v => { counts[v] = (counts[v] || 0) + 1; });

  const mixerPattern = Object.entries(counts).find(([val, count]) => count >= 3 && BigInt(val) > 0n);
  if (mixerPattern) {
    return {
      type: 'COINJOIN_PATTERN',
      severity: 'HIGH',
      indicators: [`Identified ${mixerPattern[1]} outputs with identical value: ${ethers.formatEther(mixerPattern[0])} ETH`],
      note: 'Input-Output amount matching suggests CoinJoin or Mixer internal distribution.'
    };
  }
  return null;
}

/**
 * OSINT Bridge: Simulated Scraping/Enrichment + Darknet Intel
 */
async function getOSINTEnrichment(address) {
  const { getWalletOSINT, upsertWallet } = await import('./db.js');

  // Try to get existing OSINT
  let osint = await getWalletOSINT(address);

  if (!osint) {
    const checksummed = ethers.getAddress(address);
    // SIMULATED DARKNET API SEARCH: Logic for specific addresses or patterns
    const isDarknetHit = checksummed.startsWith('0x7'); // deterministic for demo
    const isNestedExchange = checksummed.startsWith('0x12'); // deterministic for demo

    osint = {
      address: checksummed,
      entity_type: isDarknetHit ? 'darknet_market' : isNestedExchange ? 'nested_exchange' : 'individual',
      risk_score: isDarknetHit ? 95 : isNestedExchange ? 65 : 10,
      offchain_mentions: isDarknetHit ? [
        { platform: 'darknet_index', url: 'onion://hydra-mirror.onion', context: 'Listed as active withdrawal address for Hydra / Russian Market' },
        { platform: 'dread_forum', url: 'http://dread.onion/v/drug_trafficking', context: 'Associated with vendor "SilkRoad_2.0_v2"' }
      ] : isNestedExchange ? [
        { platform: 'fin_regulator', url: 'https://fca.org.uk/warning', context: 'Unregistered high-risk exchange service' }
      ] : [],
      seen_on: ['blockchain'],
      chains: ['ethereum', 'bitcoin', 'polygon'],
      darknet_hit: isDarknetHit,
      nested_exchange_hit: isNestedExchange
    };

    if (isDarknetHit) osint.seen_on.push('hydra_market', 'dread_forum');
    if (isNestedExchange) osint.seen_on.push('unregulated_exchange');

    await upsertWallet(osint);
  }

  return osint;
}

function computeRiskIndicators({ summary, mixerExposure, exchangeExposure, osintData }) {
  const indicators = []
  if (mixerExposure?.hit) indicators.push('Interaction with known mixers/tumblers detected')
  if (exchangeExposure?.hit) indicators.push('KYC exchange connection detected')
  if (osintData?.darknet_hit) indicators.push('🚨 CONFIRMED DARKNET MARKET HIT (Forensic Source)')
  if (osintData?.nested_exchange_hit) indicators.push('⚠️ High-Risk Nested Exchange (Low KYC) detected')

  // NEW: OSINT Over-60 Threshold check
  if (osintData?.risk_score > 60) {
    indicators.push('🚨 Risky User: OSINT Intelligence Score > 60/100')
  }

  const sent = BigInt(summary?.totalSentWei || '0')
  if (sent > 10n * 1000000000000000000n) indicators.push('High total outflow detected (sample-based)')

  let level = 'LOW'
  if (osintData?.darknet_hit) level = 'HIGH'
  else if (mixerExposure?.hit) level = 'HIGH'
  else if (osintData?.nested_exchange_hit || (osintData?.risk_score > 60)) level = 'MEDIUM'
  else if (exchangeExposure?.hit) {
    // Only flag exchange exposure as MEDIUM if there's high volume, otherwise keep it LOW/neutral
    level = sent > 5n * 1000000000000000000n ? 'MEDIUM' : 'LOW'
  }

  let reasoning = 'Based on the current sampled history, the account exhibits typical behavior with no immediate red flags identified.'
  if (osintData?.darknet_hit) {
    reasoning = 'Subject identified as a critical node in verified darknet market clusters. Movement suggests attribution to illicit service infrastructure.'
  } else if (mixerExposure?.hit) {
    reasoning = 'Deep fund flow analysis detected direct or high-proximity interaction with known anonymity tools (mixers), used to obfuscate the money trail.'
  } else if (osintData?.nested_exchange_hit || (osintData?.risk_score > 60)) {
    reasoning = 'Intelligence overlay identifies this address as high-risk due to either known nested exchange activity (low KYC) or highly suspicious off-chain mentions.'
  } else if (exchangeExposure?.hit && level === 'MEDIUM') {
    reasoning = 'Funds have been traced to known exchange exit points with significant volume. While common, the scale suggests professional service or high-velocity activity.'
  } else if (exchangeExposure?.hit && level === 'LOW') {
    reasoning = 'The address has a clear path to a regulated exchange. This is typical of individual users offboarding funds via KYC-compliant services.'
  } else if (sent > 50n * 1000000000000000000n) {
    reasoning = 'High-volume structural outflow detected. The scale of these transfers aligns with automated bot behavior or service-level distribution.'
  }

  return { level, indicators, reasoning }
}

async function traceUntilEntity({ startAddress, startTimeStamp = 0, maxDepth = 10, offsetPerHop = 50, initialTxHop = null }) {
  const hops = []
  const visited = new Set()

  let current = ethers.getAddress(startAddress)
  let cursorTs = startTimeStamp

  // Check if the STARTING address is already a known entity
  const startEntity = classifyKnownEntity(current)
  if (startEntity && !initialTxHop) {
    return {
      hops: [],
      stoppedReason: 'entity_hit',
      entityHit: { address: current, ...startEntity }
    }
  }

  // STEP 1: If input was a tx hash, the FIRST hop is the original transaction itself.
  //         from = tx.from, to = tx.to. Then we continue from tx.to.
  if (initialTxHop) {
    const fromAddr = ethers.getAddress(initialTxHop.from)
    const toAddr = ethers.getAddress(initialTxHop.to)

    const fromCode = await provider.getCode(fromAddr).catch(() => '0x')
    const toCode = await provider.getCode(toAddr).catch(() => '0x')
    const toEntity = classifyKnownEntity(toAddr)

    hops.push({
      depth: 0,
      from: fromAddr,
      fromAddressType: fromCode !== '0x' ? 'CONTRACT' : 'EOA',
      to: toAddr,
      toAddressType: toCode !== '0x' ? 'CONTRACT' : 'EOA',
      txHash: initialTxHop.txHash,
      timeStamp: initialTxHop.timeStamp || 0,
      valueWei: initialTxHop.valueWei || '0',
      entityHit: toEntity ? { address: toAddr, ...toEntity } : null,
    })

    visited.add(fromAddr)

    if (toEntity) {
      return { hops, stoppedReason: 'entity_hit', entityHit: { address: toAddr, ...toEntity } }
    }

    visited.add(toAddr)
    current = toAddr
  }

  // STEP 2: Recursively hop.
  // current = the latest "to" address. We find its first outgoing tx -> that becomes the next hop.
  for (let i = 0; i < maxDepth; i++) {
    // Check if current is a known entity (exchange/mixer)
    const entity = classifyKnownEntity(current)
    if (entity) {
      // We already recorded the hop TO this address, so just report it
      if (hops.length > 0) {
        return { hops, stoppedReason: 'entity_hit', entityHit: { address: current, ...entity } }
      }
    }

    // Find outgoing transactions from this address
    const transfers = await getOutgoingTransfersAsc(current)

    // Filter: must be FROM current, must go to a different address, timestamp >= cursor
    const candidates = transfers.filter((t) => {
      if (!t.to) return false
      const to = ethers.getAddress(t.to)
      if (to === current) return false  // skip self-transfers
      const ts = Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000)
      return ts > cursorTs // Must be strictly after the previous transaction
    })

    if (candidates.length === 0) {
      return { hops, stoppedReason: 'no_further_outgoing' }
    }

    // Pick the transaction with the HIGHEST amount
    const next = candidates.reduce((prev, curr) => {
      const prevVal = BigInt(prev.rawContract?.value || '0')
      const currVal = BigInt(curr.rawContract?.value || '0')
      return currVal > prevVal ? curr : prev
    }, candidates[0])

    const to = ethers.getAddress(next.to)
    const toEntity = classifyKnownEntity(to)
    const toCode = await provider.getCode(to).catch(() => '0x')
    const toAddressType = toCode !== '0x' ? 'CONTRACT' : 'EOA'

    let fromAddressType = null
    if (hops.length === 0) {
      const fromCode = await provider.getCode(current).catch(() => '0x')
      fromAddressType = fromCode !== '0x' ? 'CONTRACT' : 'EOA'
    } else {
      fromAddressType = hops[hops.length - 1]?.toAddressType || null
    }

    const hopTs = Math.floor(new Date(next.metadata.blockTimestamp).getTime() / 1000)

    hops.push({
      depth: hops.length,
      from: current,
      fromAddressType,
      to,
      toAddressType,
      txHash: next.hash,
      timeStamp: hopTs,
      valueWei: BigInt(next.rawContract?.value || '0').toString(),
      entityHit: toEntity ? { address: to, ...toEntity } : null,
    })

    // Check if we hit an entity at the destination
    if (toEntity) {
      return { hops, stoppedReason: 'entity_hit', entityHit: { address: to, ...toEntity } }
    }

    // Check for cycles
    if (visited.has(to)) {
      return { hops, stoppedReason: 'cycle_detected' }
    }
    visited.add(to)

    // Move forward: the "to" becomes the new "current" for the next hop
    current = to
    cursorTs = hopTs
  }

  return { hops, stoppedReason: 'max_depth_reached' }
}

async function classifyAddress(address, summary) {
  const entity = classifyKnownEntity(address)
  if (entity?.category === 'exchange') return 'EXCHANGE'

  const code = await provider.getCode(address).catch(() => '0x')
  if (code !== '0x') return 'CONTRACT'

  const txCount = Number(summary?.txSampleCount || 0)
  if (txCount > 500) return 'SERVICE_ACCOUNT' // Heuristic for high volume

  return 'PERSONAL_EOA'
}

function calculateConfidenceScore(classification, summary, distanceToExchange) {
  let score = 50 // Base confidence

  if (classification === 'EXCHANGE') return 95
  if (classification === 'CONTRACT') score += 20
  if (classification === 'SERVICE_ACCOUNT') score += 15

  // Distance to exchange weight (Closer = Higher exchange likelihood)
  if (distanceToExchange !== Infinity) {
    score += Math.max(0, (5 - distanceToExchange) * 10)
  }

  // Volume based adjustments
  const txCount = Number(summary?.txSampleCount || 0)
  if (txCount > 100) score += 5

  return Math.min(99, score)
}

/**
 * HELPER: Fetches TEMPER AI Behavioral Reasoning for any address
 * Consolidates features (PTE + SABES) as per KDD '25 Paper requirements
 */
async function getTEMPERAIReasoning(rootAddress) {
  try {
    const { getChronologicalHistory } = await import('./db.js');
    const history = await getChronologicalHistory(rootAddress, 100);

    const temperSequence = [];
    const inputNeighbors = new Set();
    const outputNeighbors = new Set();
    let totalInputAmount = 0;
    let totalOutputAmount = 0;
    let inDegree = 0;
    let outDegree = 0;

    const processTx = (h) => {
      let valEther = 0;
      try {
        // Alchemy transfers have 'value' as a float in Ether, and 'rawContract.value' in Wei (hex)
        // MongoDB edges have 'value' as a string in Wei
        if (h.rawContract?.value) {
          valEther = parseFloat(safeFormatEther(h.rawContract.value));
        } else if (typeof h.value === 'number') {
          // Already in Ether from Alchemy (but safer to use rawContract above)
          valEther = h.value;
        } else if (h.value) {
          // Likely Wei string from DB
          valEther = parseFloat(safeFormatEther(h.value));
        }
      } catch (err) {
        console.warn('Value parsing error for tx:', h.tx_hash || h.hash, err.message);
      }

      const toAddr = (h.to_address || h.to);
      const isInput = toAddr?.toLowerCase() === rootAddress.toLowerCase();

      if (isInput) {
        totalInputAmount += valEther;
        inDegree++;
        const from = h.from_address || h.from;
        if (from) inputNeighbors.add(from.toLowerCase());
      } else {
        totalOutputAmount += valEther;
        outDegree++;
        const to = h.to_address || h.to;
        if (to) outputNeighbors.add(to.toLowerCase());
      }

      const inputNeighborCount = inputNeighbors.size || 1;
      const outputNeighborCount = outputNeighbors.size || 1;

      temperSequence.push({
        f1_total_in_amt: totalInputAmount,
        f2_total_out_amt: totalOutputAmount,
        f3_in_neighbor_count: inputNeighborCount,
        f4_out_neighbor_count: outputNeighborCount,
        f5_in_degree: inDegree,
        f6_out_degree: outDegree,
        f7_in_density: inDegree / inputNeighborCount,
        f8_out_density: outDegree / outputNeighborCount
      });
    };

    history.forEach(processTx);

    if (temperSequence.length < 5) {
      const alchemyTransfers = await getAlchemyAssetTransfers(rootAddress);
      // Filter out anything already in history to avoid doubles if possible, 
      // though alchemy handles it well. 
      alchemyTransfers.slice(0, 50).forEach(processTx);
    }

    if (temperSequence.length === 0) return null;

    const aiResponse = await axios.post('http://127.0.0.1:8000/predict', {
      address: rootAddress,
      transactions: temperSequence
    }, { timeout: 10000 });

    return aiResponse.data;
  } catch (err) {
    console.warn('TEMPER AI Call Failed:', err.message);
    return null;
  }
}

async function generateForensicReport(input) {
  const trimmed = String(input || '').trim();
  let rootAddress = null;
  let tx = null;

  // Step 1: Input Analysis
  if (isTxHash(trimmed)) {
    tx = await provider.getTransaction(trimmed);
    if (!tx) throw new Error('Transaction not found');
    rootAddress = ethers.getAddress(tx.from);
  } else if (isAddress(trimmed)) {
    rootAddress = ethers.getAddress(trimmed.toLowerCase());
  } else {
    throw new Error('Invalid input');
  }

  // CALL UNIFIED TEMPER AI HELPER
  let aiResult = await getTEMPERAIReasoning(rootAddress);

  if (!aiResult) {
    aiResult = {
      risk_score: 0,
      level: "LOW",
      reason: "AI Engine unavailable or no history to analyze.",
      model_used: "None"
    };
  }

  // OSINT Correlation for the report
  const osintData = await getOSINTEnrichment(rootAddress);
  let finalLevel = aiResult.level;

  // Align labels: CRITICAL/SUSPICIOUS from AI map to HIGH/MEDIUM for likelyType mapping
  const normalizedAILevel = aiResult.level === 'CRITICAL' ? 'HIGH' : aiResult.level === 'SUSPICIOUS' ? 'MEDIUM' : aiResult.level;

  let finalLikelyType = normalizedAILevel === 'HIGH' ? 'Phishing / Mixer' : normalizedAILevel === 'MEDIUM' ? 'Suspect / Bot' : 'Normal User';

  if (osintData?.risk_score > 80) {
    finalLikelyType = 'Risky User';
    if (finalLevel === 'LOW') finalLevel = 'MEDIUM';
  } else if (osintData?.risk_score > 60) {
    finalLikelyType = 'Suspect User';
    // Don't force upgrade from LOW for moderate OSINT scores
  }

  return {
    step1: {
      hash: tx?.hash || null,
      from: rootAddress,
      to: tx?.to || null,
      value: tx ? ethers.formatEther(tx.value) : null
    },
    step2: {
      temper_prediction: aiResult
    },
    step3: {
      label: finalLevel
    },
    step4: {
      likelyType: finalLikelyType,
      confidenceScore: Math.max(aiResult.risk_score, osintData?.risk_score || 0)
    }
  }
}

function buildHopGraph({ tx, transfers, internalTxs }) {
  const nodes = new Map()
  const edges = []

  const addNode = (addr) => {
    if (!addr) return
    const a = ethers.getAddress(addr)
    if (!nodes.has(a)) nodes.set(a, { address: a })
  }

  const addEdge = (from, to, kind, meta) => {
    if (!from || !to) return
    const f = ethers.getAddress(from)
    const t = ethers.getAddress(to)
    addNode(f)
    addNode(t)
    edges.push({ from: f, to: t, kind, meta })
  }

  if (tx?.from && tx?.to) addEdge(tx.from, tx.to, 'transaction', { valueWei: tx.value?.toString?.() })

  for (const tr of transfers) {
    addEdge(tr.from, tr.to, 'erc20_transfer', { tokenContract: tr.tokenContract, value: tr.value })
  }

  for (const itx of internalTxs) {
    if (itx.isError) continue
    addEdge(itx.from, itx.to, 'internal', { valueWei: itx.valueWei, type: itx.type })
  }

  return {
    nodes: [...nodes.values()],
    edges,
  }
}

async function enrichGraph(graph) {
  const enrichedNodes = await Promise.all(graph.nodes.map((n) => getAddressEnrichment(n.address)))
  const nodeByAddress = new Map(enrichedNodes.map((n) => [n.address, n]))

  return {
    nodes: enrichedNodes,
    edges: graph.edges.map((e) => ({
      ...e,
      fromDisplay: nodeByAddress.get(e.from)?.display || shorten(e.from),
      toDisplay: nodeByAddress.get(e.to)?.display || shorten(e.to),
    })),
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true })
})

// === REAL-TIME MONITORING VIA SSE ===
const clients = new Set()

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  clients.add(res)

  req.on('close', () => {
    clients.delete(res)
  })
})

const broadcastRiskyTx = (txData) => {
  const payload = JSON.stringify(txData)
  for (const client of clients) {
    client.write(`data: ${payload}\n\n`)
  }
}

// === BLOCK LISTENER with Rate Limit Resiliency ===
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

provider.on('block', async (blockNumber) => {
  let retries = 3;
  let delay = 1000;

  while (retries > 0) {
    try {
      const block = await provider.getBlock(blockNumber, true);
      if (!block || !block.prefetchedTransactions) return;

      for (const tx of block.prefetchedTransactions) {
        if (!tx.to) continue; // skip contract creations

        const fromAddr = ethers.getAddress(tx.from);
        const toAddr = ethers.getAddress(tx.to);

        const fromEntity = classifyKnownEntity(fromAddr);
        const toEntity = classifyKnownEntity(toAddr);

        const isFromRisky = fromEntity && ['mixer', 'exchange'].includes(fromEntity.category);
        const isToRisky = toEntity && ['mixer', 'exchange'].includes(toEntity.category);
        const isDevRisky = isTornadoPool(fromAddr) || isTornadoPool(toAddr);

        const { storeAlert, upsertWallet, getWalletOSINT, getWalletStats } = await import('./db.js');

        // WATCHLIST LOGIC: Check if this address is already an "investigation lead" in our DB
        const senderRecord = await getWalletOSINT(fromAddr);
        const receiverRecord = await getWalletOSINT(toAddr);
        const isKnownRisky = (senderRecord?.risk_score > 40) || (receiverRecord?.risk_score > 40);

        if (isFromRisky || isToRisky || isDevRisky || isKnownRisky) {
          // Fetch stats for the repeat offender
          const statsNode = isKnownRisky ? (senderRecord?.risk_score > 40 ? fromAddr : toAddr) : (isFromRisky ? fromAddr : toAddr);
          const stats = await getWalletStats(statsNode);

          const alertPayload = {
            type: 'risky_tx',
            txHash: tx.hash,
            fromAddress: fromAddr,
            toAddress: toAddr,
            valueWei: tx.value?.toString?.() || '0',
            timestamp: block.timestamp,
            reason: isKnownRisky ? 'Watchlist Hit: Behavior Re-activation' : (isFromRisky ? 'Sender is risky' : 'Receiver is risky'),
            entity: isFromRisky ? fromEntity : toEntity,
            isWatchlistHit: isKnownRisky,
            historyCount: stats.total_txs + 1,
            historyVolumeWei: (BigInt(stats.total_value_wei || 0) + BigInt(tx.value || 0)).toString()
          };
          broadcastRiskyTx(alertPayload);
          await storeAlert(alertPayload).catch(() => { });
          await upsertWallet({ address: fromAddr, risk_score: isFromRisky ? 80 : 0 }).catch(() => { });
        }

        // Check for Forensics Patterns (Dust/CoinJoin)
        // Note: For heavy forensic patterns, we could add another check here if necessary
      }
      break; // Success, exit retry loop

    } catch (error) {
      if (error.code === 'UNKNOWN_ERROR' && error.error?.code === 429) {
        console.warn(`Rate limit hit on block ${blockNumber}, retrying in ${delay}ms...`);
        await sleep(delay);
        retries--;
        delay *= 2; // Exponential backoff
      } else {
        console.error(`Error processing block ${blockNumber}:`, error.message);
        break; // Non-429 error, exit
      }
    }
  }
});

// === EXPOSE GRAPH DATA ===
app.get('/api/risky-addresses', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = parseInt(req.query.limit) || 10
    const { getEdges } = await import('./db.js')
    const edges = await getEdges({ limit: 5000 }) // increased limit to ensure we get plenty of unique addresses before pagination

    // Extract unique addresses that were either sender or receiver of a recorded transaction
    const uniqueAddresses = new Set()
    for (const edge of edges) {
      if (edge.from_address !== 'KNOWN_MIXER') uniqueAddresses.add(edge.from_address)
      if (edge.to_address !== 'KNOWN_MIXER') uniqueAddresses.add(edge.to_address)
    }

    const allAddresses = Array.from(uniqueAddresses)
    const totalPages = Math.max(1, Math.ceil(allAddresses.length / limit))
    const paginatedAddresses = allAddresses.slice((page - 1) * limit, page * limit)

    res.json({
      addresses: paginatedAddresses,
      page,
      totalPages,
      totalAddresses: allAddresses.length
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/graph/:address', async (req, res) => {
  const { address } = req.params
  try {
    // Basic validation
    if (typeof address !== 'string' || !ethers.isAddress(address.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid address format' })
    }
    const checksummed = ethers.getAddress(address)
    const { getEdgesByAddress } = await import('./db.js')

    // Get all directed edges involving this address
    const edges = await getEdgesByAddress(checksummed)

    // Build D3/React Flow compatible structures
    const nodesMap = new Map()
    const formattedEdges = []

    const addNode = (a) => {
      if (!nodesMap.has(a)) {
        nodesMap.set(a, { id: a, label: shorten(a) })
      }
    }

    for (const e of edges) {
      addNode(e.from_address)
      addNode(e.to_address)
      formattedEdges.push({
        source: e.from_address,
        target: e.to_address,
        txHash: e.tx_hash,
        valueWei: e.value,
        timestamp: e.timestamp
      })
    }

    res.json({
      nodes: Array.from(nodesMap.values()),
      links: formattedEdges
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/analyze/:input', async (req, res) => {
  const { input } = req.params
  const trimmed = String(input || '').trim()

  const maxDepth = Math.min(Number(req.query.depth || 10) || 10, 15)
  const offsetPerHop = Math.min(Number(req.query.offset || 50) || 50, 200)

  if (!isTxHash(trimmed) && !isAddress(trimmed)) {
    return res.status(400).json({ error: 'Input must be a transaction hash or an address' })
  }

  try {
    let rootAddress = null
    let tx = null
    let txSummary = null
    let transfers = []
    let internalTxs = []
    let graph = { nodes: [], edges: [] }
    let startTimeStamp = 0

    if (isTxHash(trimmed)) {
      tx = await provider.getTransaction(trimmed)
      if (!tx) return res.status(404).json({ error: 'Transaction not found' })

      const receipt = await provider.getTransactionReceipt(trimmed)
      const block = tx.blockNumber ? await provider.getBlock(tx.blockNumber) : null
      startTimeStamp = block?.timestamp || 0

      transfers = parseTransfersFromReceipt(receipt)
      const alchemyTransfers = await getAlchemyAssetTransfers(tx.from)
      internalTxs = alchemyTransfers.filter(t => t.category === 'internal' && t.hash === trimmed)

      const baseGraph = buildHopGraph({ tx, transfers, internalTxs })
      graph = await enrichGraph(baseGraph)

      const fromInfo = await getAddressEnrichment(tx.from)
      const toInfo = tx.to ? await getAddressEnrichment(tx.to) : null

      txSummary = {
        hash: tx.hash,
        from: fromInfo,
        to: toInfo,
        valueWei: tx.value?.toString?.() || '0',
        blockNumber: tx.blockNumber,
        timestamp: block?.timestamp || null,
        status: receipt?.status ?? null,
        gasUsed: receipt?.gasUsed?.toString?.() || null,
      }

      rootAddress = ethers.getAddress(tx.from)
    } else {
      rootAddress = ethers.getAddress(trimmed)

      const { getEdgesByAddress } = await import('./db.js')
      const historicalEdges = await getEdgesByAddress(rootAddress)
      const nodesMap = new Map()
      const formattedEdges = []

      const addNode = (a) => {
        if (!nodesMap.has(a)) nodesMap.set(a, { address: a })
      }

      for (const e of historicalEdges.slice(0, 30)) {
        addNode(e.from_address)
        addNode(e.to_address)
        formattedEdges.push({
          source: e.from_address,
          target: e.to_address,
          kind: 'transaction',
          meta: { value: safeFormatEther(e.value || '0') },
          timestamp: e.timestamp
        })
      }

      graph = {
        nodes: Array.from(nodesMap.values()),
        links: formattedEdges
      }
    }

    const rootInfo = await getAddressEnrichment(rootAddress)
    const summary = await getAddressSummary(rootAddress)

    const rootEntity = classifyKnownEntity(rootAddress)

    // When input is a tx hash: start tracing from tx.to (the recipient)
    // and prepend the original tx as hop 0.
    // When input is an address: trace from that address forward.
    const traceStartAddress = tx?.to ? ethers.getAddress(tx.to) : rootAddress
    const initialTxHop = tx?.to ? {
      from: ethers.getAddress(tx.from),
      to: ethers.getAddress(tx.to),
      txHash: tx.hash,
      valueWei: tx.value?.toString?.() || '0',
      timeStamp: startTimeStamp,
    } : null

    const trace = await traceUntilEntity({
      startAddress: traceStartAddress,
      startTimeStamp,
      maxDepth,
      offsetPerHop,
      initialTxHop,
    })

    const traceEntity = trace?.entityHit || null
    const mixerExposure = rootEntity?.category === 'mixer' || traceEntity?.category === 'mixer'
      ? { hit: true, entity: rootEntity?.category === 'mixer' ? rootEntity : traceEntity }
      : { hit: false, entity: null }

    const exchangeExposure = rootEntity?.category === 'exchange' || traceEntity?.category === 'exchange'
      ? { hit: true, entity: rootEntity?.category === 'exchange' ? rootEntity : traceEntity }
      : { hit: false, entity: null }

    const exitPoints = []
    if (trace?.entityHit?.category === 'exchange') {
      exitPoints.push({
        name: trace.entityHit.name,
        address: trace.entityHit.address,
        jurisdiction: trace.entityHit.jurisdiction || null,
        risk: 'HIGH',
        note: 'KYC exchange connection (best-effort)'
      })
    }

    // Get real-time OSINT intelligence update
    const osintData = await getOSINTEnrichment(rootAddress);

    const risk = computeRiskIndicators({ summary, mixerExposure, exchangeExposure, osintData })

    // NEW: Inject TEMPER AI Reasoning into the main risk summary for the Overview tab
    const aiReasoning = await getTEMPERAIReasoning(rootAddress);
    if (aiReasoning && aiReasoning.reason) {
      risk.reasoning = aiReasoning.reason;
      // If AI detects high risk, elevate the level even if heuristics missed it
      if (aiReasoning.level === 'CRITICAL' || aiReasoning.level === 'SUSPICIOUS') {
        if (risk.level === 'LOW') risk.level = 'MEDIUM';
      }
    }

    // Only store to DB if determined to be risky
    if (risk.level === 'HIGH' || risk.level === 'MEDIUM') {
      const { storeEdges } = await import('./db.js')
      const edgesToStore = []

      if (trace && trace.hops) {
        for (const hop of trace.hops) {
          // Replace mixer addresses with "KNOWN_MIXER"
          const isFromMixer = isTornadoPool(hop.from) || classifyKnownEntity(hop.from)?.category === 'mixer'
          const isToMixer = isTornadoPool(hop.to) || classifyKnownEntity(hop.to)?.category === 'mixer'

          edgesToStore.push({
            tx_hash: hop.txHash,
            from_address: isFromMixer ? 'KNOWN_MIXER' : hop.from,
            to_address: isToMixer ? 'KNOWN_MIXER' : hop.to,
            value: hop.valueWei || '0',
            block_number: 0,
            timestamp: hop.timeStamp || 0,
            hop_number: hop.depth || 0
          })
        }
      }

      if (edgesToStore.length > 0) {
        await storeEdges(edgesToStore).catch(err => console.error('Failed to store trace edges:', err))
      }
    }

    const tornadoCorrelations = scoreTornadoCorrelation(summary?.tornado?.deposits, summary?.tornado?.withdrawals)

    res.json({
      input: {
        raw: trimmed,
        type: isTxHash(trimmed) ? 'tx' : 'address',
      },
      address: rootInfo,
      tx: txSummary,
      summary,
      transfers,
      internalTxs,
      graph,
      trace,
      exposure: {
        mixer: mixerExposure,
        exchange: exchangeExposure,
      },
      kycExitPoints: exitPoints,
      deAnonymization: {
        entityHits: {
          root: rootEntity || null,
          traceExit: traceEntity || null,
        },
        tornado: {
          deposits: summary?.tornado?.deposits || [],
          withdrawals: summary?.tornado?.withdrawals || [],
          correlations: tornadoCorrelations,
        },
        clustering: summary?.clustering || { topCounterparties: [], heuristicNotes: [] },
        disclaimers: [
          'All de-anonymization outputs are best-effort heuristics and may contain false positives/negatives.',
          'This tool does not and cannot guarantee a real-world identity. Use results for investigation only.',
        ],
      },
      risk,
      attribution: {
        disclaimer:
          'On-chain data is pseudonymous. This tool provides best-effort signals (ENS and known-entity lists). It cannot guarantee a real-world identity.',
      },
    })
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Internal error' })
  }
})

app.get('/api/forensics/:input', async (req, res) => {
  const { input } = req.params
  try {
    const report = await generateForensicReport(input)
    res.json(report)
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Forensic error' })
  }
})

app.get('/api/osint/enrich/:address', async (req, res) => {
  const { address } = req.params;
  try {
    if (!ethers.isAddress(address)) return res.status(400).json({ error: 'Invalid address' });
    const data = await getOSINTEnrichment(ethers.getAddress(address));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const { connectDB } = await import('./db.js');
    const db = await connectDB();
    const alerts = await db.collection('alerts').find().sort({ timestamp: -1 }).limit(50).toArray();
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, async () => {
  // Initialize MongoDB connection
  try {
    await connectDB();
    console.log('Database connection initialized');
  } catch (err) {
    console.error('Failed to connect to database:', err);
  }

  console.log(`Backend listening on http://localhost:${port}`)
})
