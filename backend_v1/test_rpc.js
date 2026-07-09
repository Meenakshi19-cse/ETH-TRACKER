import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const rpcUrl = process.env.ETH_RPC_URL;
console.log('Testing RPC URL:', rpcUrl);

try {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const blockNumber = await provider.getBlockNumber();
  console.log('Current block number:', blockNumber);
} catch (err) {
  console.error('RPC connection failed:', err.message);
}
/*{
     "id": "huobi_hot_1",
     "name": "Huobi (HTX)",
     "category": "exchange",
     "jurisdiction": "Global",
     "addresses": [
       "0xAb5C66752a9e8167967685F1450532fB96d5d24f",
       "0x6748F50f686bfbcA6Fe8ad62b22228b87F31ff2b",
       "0xfdb16996831753d5331fF813c29a93c76834A0AD",
       "0x46705dfff24256421A05D056c29E81Bdc09723B8"
     ],
     "tags": [
       "exchange",
       "kyc",
       "cex"
     ],
     "notes": "Huobi/HTX Hot Wallets"
   },
   {
     "id": "gemini_hot_1",
     "name": "Gemini",
     "category": "exchange",
     "jurisdiction": "US",
     "addresses": [
       "0xD24400ae8BfEBb18cA49Be86258a3C749cf46853",
       "0x6Fc82a5fe25A5cDb58BC74600A40A69C065263f8"
     ],
     "tags": [
       "exchange",
       "kyc",
       "cex"
     ],
     "notes": "Gemini Hot Wallets"
   },
   {
     "id": "bitfinex_hot_1",
     "name": "Bitfinex",
     "category": "exchange",
     "jurisdiction": "Global",
     "addresses": [
       "0x1151314c646Ce4E0eFD76d1aF4760aE66a9Fe30F",
       "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD1e",
       "0x876EabF441B2EE5B5b0554Fd502a8E0600950cFa"
     ],
     "tags": [
       "exchange",
       "kyc",
       "cex"
     ],
     "notes": "Bitfinex Hot Wallets"
   },
   {
     "id": "gate_io_hot_1",
     "name": "Gate.io",
     "category": "exchange",
     "jurisdiction": "Global",
     "addresses": [
       "0x0D0707963952f2fBA59dD06f2b425ace40b492Fe",
       "0x1C4b70a3968436B9A0a9cf5205c787eb81Bb558c"
     ],
     "tags": [
       "exchange",
       "kyc",
       "cex"
     ],
     "notes": "Gate.io Hot Wallets"
   }*/