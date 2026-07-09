import { ethers } from 'ethers';
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const rpcUrl = process.env.ETH_RPC_URL;
const provider = new ethers.JsonRpcProvider(rpcUrl);

const ENTITY_DB = JSON.parse(await fs.readFile(path.join(__dirname, 'entities.json'), 'utf8'));

function classifyKnownEntity(address) {
    try {
        const a = ethers.getAddress(address);
        for (const e of ENTITY_DB.entities) {
            if ((e.addresses || []).some(addr => {
                try {
                    return ethers.getAddress(addr) === a;
                } catch {
                    return false;
                }
            })) {
                return e;
            }
        }
    } catch (e) {
        console.error("Invalid address in classifyKnownEntity:", address);
    }
    return null;
}

async function getOutgoingTransfersAsc(address) {
    const response = await axios.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{
            fromAddress: address,
            category: ['external', 'internal'],
            withMetadata: true,
            excludeZeroValue: true,
            order: 'asc',
            maxCount: '0x64'
        }]
    });
    return response.data?.result?.transfers || [];
}

async function testTrace(startAddress) {
    console.log(`Starting trace for: ${startAddress}`);
    let current = ethers.getAddress(startAddress);
    let cursorTs = 0;
    const hops = [];
    const visited = new Set();
    const maxDepth = 5;

    for (let i = 0; i < maxDepth; i++) {
        const entity = classifyKnownEntity(current);
        if (entity) {
            console.log(`HIT ENTITY: ${entity.name} at ${current}`);
            break;
        }

        const transfers = await getOutgoingTransfersAsc(current);
        const candidates = transfers.filter((t) => {
            if (!t.to) return false;
            const ts = Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000);
            return ts > cursorTs;
        });

        if (candidates.length === 0) {
            console.log(`No further outgoing transfers from ${current}`);
            break;
        }

        const next = candidates.reduce((prev, curr) => {
            const prevVal = BigInt(prev.rawContract?.value || '0');
            const currVal = BigInt(curr.rawContract?.value || '0');
            return currVal > prevVal ? curr : prev;
        }, candidates[0]);

        const to = ethers.getAddress(next.to);
        const val = ethers.formatEther(next.rawContract?.value || '0');
        const ts = Math.floor(new Date(next.metadata.blockTimestamp).getTime() / 1000);

        console.log(`Hop ${i + 1}: ${current} -> ${to} (${val} ETH) TX: ${next.hash}`);

        hops.push({ from: current, to, hash: next.hash, value: val });

        if (visited.has(to)) {
            console.log("CYCLE DETECTED");
            break;
        }
        visited.add(to);
        current = to;
        cursorTs = ts;
    }
    return hops;
}

const target = '0x4675C7e5BaAFBFFbca748158bEcBA61ef3b0a263';
testTrace(target).catch(console.error);
