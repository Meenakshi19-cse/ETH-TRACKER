import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ethers } from 'ethers';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { connectDB, storeEdge } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const rpcUrl = process.env.ETH_RPC_URL;
if (!rpcUrl) {
  console.error("Missing ETH_RPC_URL in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(rpcUrl);
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');


async function loadEntityDb() {
  const fallback = { entities: [] };
  try {
    const raw = await fs.readFile(new URL('./entities.json', import.meta.url), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function buildEntityIndex(entityDb) {
  const addressToEntity = new Map();
  const tornadoPools = new Set();
  const add = (address, entity) => {
    try {
      const a = ethers.getAddress(address);
      addressToEntity.set(a, entity);
      if (entity?.tags?.includes('tornado') || String(entity?.name || '').toLowerCase().includes('tornado')) tornadoPools.add(a);
    } catch { return; }
  };
  for (const e of entityDb?.entities || []) {
    const entity = { id: e.id || null, name: e.name || 'Unknown', category: e.category || 'unknown', tags: Array.isArray(e.tags) ? e.tags : [] };
    for (const a of e.addresses || []) add(a, entity);
  }
  return { addressToEntity, tornadoPools };
}

let ENTITY_DB, ENTITY_INDEX;

async function initDb() {
  ENTITY_DB = await loadEntityDb();
  ENTITY_INDEX = buildEntityIndex(ENTITY_DB);
}

function isTornadoPool(address) {
  if (!address) return false;
  try {
    const a = ethers.getAddress(address);
    return ENTITY_INDEX.tornadoPools.has(a);
  } catch { return false; }
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
    return response.data?.result?.transfers || [];
  } catch (error) {
    console.error('Alchemy transfers error:', error);
    return [];
  }
}

async function getAddressSummary(address) {
  const a = ethers.getAddress(address);
  const balance = (await provider.getBalance(a)).toString();
  const transfers = await getAlchemyAssetTransfers(a);

  let mixerHit = false;
  for (const t of transfers) {
    if ((t.to && isTornadoPool(t.to)) || (t.from && isTornadoPool(t.from))) {
      mixerHit = true;
      break;
    }
  }

  return {
    address: a,
    balanceEth: ethers.formatEther(balance),
    txCount: transfers.length,
    mixerInteractionDetected: mixerHit,
    txSampleCount: transfers.length
  };
}

function classifyKnownEntity(address) {
  if (!address) return null
  const a = ethers.getAddress(address)
  return ENTITY_INDEX.addressToEntity.get(a) || null
}

async function classifyAddress(address, summary) {
  const entity = classifyKnownEntity(address)
  if (entity?.category === 'exchange') return 'EXCHANGE'

  const code = await provider.getCode(address).catch(() => '0x')
  if (code !== '0x') return 'CONTRACT'

  const txCount = Number(summary?.txSampleCount || 0)
  if (txCount > 500) return 'SERVICE_ACCOUNT'

  return 'PERSONAL_EOA'
}

function calculateConfidenceScore(classification, summary, distanceToExchange) {
  let score = 50
  if (classification === 'EXCHANGE') return 95
  if (classification === 'CONTRACT') score += 20
  if (classification === 'SERVICE_ACCOUNT') score += 15
  if (distanceToExchange !== Infinity) score += Math.max(0, (5 - distanceToExchange) * 10)
  const txCount = Number(summary?.txSampleCount || 0)
  if (txCount > 100) score += 5
  return Math.min(99, score)
}

async function traceUntilEntity({ startAddress, maxDepth = 5 }) {
  const hops = []
  const visited = new Set()
  let current = ethers.getAddress(startAddress)
  let cursorTs = 0

  for (let depth = 0; depth < maxDepth; depth++) {
    if (visited.has(current)) break;
    visited.add(current)

    const entity = classifyKnownEntity(current)
    if (entity) return { hops, stoppedReason: 'entity_hit', entityHit: { address: current, ...entity } }

    const transfers = await getAlchemyAssetTransfers(current)
    const next = transfers
      .filter((t) => t.from && ethers.getAddress(t.from) === current)
      .filter((t) => Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000) >= cursorTs)
      .find((t) => t.to && ethers.getAddress(t.to) !== current)

    if (!next || !next.to) break;

    const to = ethers.getAddress(next.to)
    const toEntity = classifyKnownEntity(to)
    const ts = Math.floor(new Date(next.metadata.blockTimestamp).getTime() / 1000)

    hops.push({
      depth,
      from: current,
      to,
      txHash: next.hash,
      timeStamp: ts,
      valueWei: BigInt(next.rawContract?.value || '0').toString(),
      entityHit: toEntity ? { address: to, ...toEntity } : null
    })

    // Store the edge in MongoDB for permanent storage
    try {
      await storeEdge({
        tx_hash: next.hash,
        from_address: current,
        to_address: to,
        value: BigInt(next.rawContract?.value || '0').toString(),
        block_number: next.blockNumber || 0,
        timestamp: ts,
        hop_number: depth
      });
    } catch (err) {
      console.error('Failed to store edge:', err);
    }

    if (toEntity) return { hops, stoppedReason: 'entity_hit', entityHit: { address: to, ...toEntity } }
    current = to
    cursorTs = ts
  }
  return { hops, stoppedReason: 'max_depth_reached' }
}

async function generateForensicReport(input, { maxDepth = 5 } = {}) {
  const trimmed = String(input || '').trim()
  let tx = null
  let rootAddress = null

  if (/^0x([A-Fa-f0-9]{64})$/.test(trimmed)) {
    tx = await provider.getTransaction(trimmed).catch(() => null)
    if (!tx) throw new Error('Transaction not found')
    rootAddress = ethers.getAddress(tx.from)
  } else {
    try { rootAddress = ethers.getAddress(trimmed) } catch { throw new Error('Invalid address or tx hash') }
  }

  const summary = await getAddressSummary(rootAddress)
  const classification = await classifyAddress(rootAddress, summary)
  const trace = await traceUntilEntity({ startAddress: rootAddress, maxDepth })
  const distanceToExchange = trace.stoppedReason === 'entity_hit' && trace.entityHit.category === 'exchange' ? trace.hops.length : Infinity

  return {
    step1: { hash: tx?.hash || null, from: rootAddress, to: tx?.to || null, value: tx ? ethers.formatEther(tx.value) : null },
    step2: { trace },
    step3: { label: classification },
    step4: { likelyType: classification, confidenceScore: calculateConfidenceScore(classification, summary, distanceToExchange) }
  }
}

// --- MCP Server Implementation ---

const server = new Server(
  {
    name: "end-user-forensics",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "analyze_address",
        description: "Analyze an Ethereum address for risk and mixer exposure.",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "string", description: "The Ethereum address to analyze." },
          },
          required: ["address"],
        },
      },
      {
        name: "lookup_entity",
        description: "Look up if an address belongs to a known entity (e.g., Tornado Cash).",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "string", description: "The Ethereum address to look up." },
          },
          required: ["address"],
        },
      },
      {
        name: "forensic_report",
        description: "Generate a multi-step forensic investigation report for a transaction or address.",
        inputSchema: {
          type: "object",
          properties: {
            input: { type: "string", description: "The Ethereum address or transaction hash." },
          },
          required: ["input"],
        },
      }
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "analyze_address") {
      const { address } = z.object({ address: z.string() }).parse(args);
      const summary = await getAddressSummary(address);
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }

    if (name === "lookup_entity") {
      const { address } = z.object({ address: z.string() }).parse(args);
      const a = ethers.getAddress(address);
      const entity = ENTITY_INDEX.addressToEntity.get(a) || null;
      return {
        content: [{ type: "text", text: JSON.stringify(entity || { message: "Unknown entity" }, null, 2) }],
      };
    }

    if (name === "forensic_report") {
      const { input } = z.object({ input: z.string() }).parse(args);
      const report = await generateForensicReport(input);
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    throw new Error(`Tool not found: ${name}`);
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  await initDb();

  // Initialize MongoDB connection
  try {
    await connectDB();
    console.error('MongoDB connection initialized');
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Forensic MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
