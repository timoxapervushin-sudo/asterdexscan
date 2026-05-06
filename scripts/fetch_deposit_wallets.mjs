import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const WALLETS_FILE = process.env.ASTERDEX_WALLETS_FILE || path.join(ROOT_DIR, "asterdex_wallets.txt");
const STATE_FILE = process.env.ASTERDEX_WALLET_SCAN_STATE || path.join(DATA_DIR, "asterdex_wallet_sources.json");
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "JSGNKWPMV5VVFI53HHQ5NBSGBNMJ16X9UY";
const ETHERSCAN_V2 = "https://api.etherscan.io/v2/api";
const LOOKBACK_DAYS = Number(process.env.ASTERDEX_WALLET_LOOKBACK_DAYS || 200);
const MIN_USD = Number(process.env.ASTERDEX_MIN_DEPOSIT_USD || 99_000);
const PAGE_SIZE = Number(process.env.ASTERDEX_SCAN_PAGE_SIZE || 10_000);
const WATCH_INTERVAL_MS = Number(process.env.ASTERDEX_WALLET_SCAN_INTERVAL_MS || 10 * 60 * 1_000);
const SCAN_OVERLAP_BLOCKS = Number(process.env.ASTERDEX_SCAN_OVERLAP_BLOCKS || 25);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const SOURCES = [
  {
    id: "bsc",
    label: "BSC",
    chainId: "56",
    depositAddress: envAddress("ASTERDEX_BSC_DEPOSIT_ADDRESS", "0x128463A60784c4D3f46c23Af3f65Ed859Ba87974"),
    explorerUrl: "https://bscscan.com",
    preferRpc: true,
    avgBlockSec: 3,
    rpcMaxBlockSpan: Number(process.env.ASTERDEX_BSC_RPC_SPAN || 50_000),
    rpcUrls: envList("ASTERDEX_BSC_RPC_URLS", [
      "https://bsc-rpc.publicnode.com",
      "https://bsc.publicnode.com",
      "https://bsc-dataseed.binance.org"
    ]),
    tokens: [
      { symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955", decimals: 18 }
    ]
  },
  {
    id: "eth",
    label: "Ethereum",
    chainId: "1",
    depositAddress: envAddress("ASTERDEX_ETH_DEPOSIT_ADDRESS", "0x604DD02d620633Ae427888d41bfd15e38483736E"),
    explorerUrl: "https://etherscan.io",
    avgBlockSec: 12,
    rpcMaxBlockSpan: Number(process.env.ASTERDEX_ETH_RPC_SPAN || 10_000),
    rpcUrls: envList("ASTERDEX_ETH_RPC_URLS", [
      "https://ethereum.publicnode.com",
      "https://rpc.ankr.com/eth"
    ]),
    tokens: [
      { symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 }
    ]
  },
  {
    id: "arb",
    label: "Arbitrum",
    chainId: "42161",
    depositAddress: envAddress("ASTERDEX_ARB_DEPOSIT_ADDRESS", "0x9e36cb86a159d479ced94fa05036f235ac40e1d5"),
    explorerUrl: "https://arbiscan.io",
    avgBlockSec: 0.25,
    rpcMaxBlockSpan: Number(process.env.ASTERDEX_ARB_RPC_SPAN || 100_000),
    rpcUrls: envList("ASTERDEX_ARB_RPC_URLS", [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one.publicnode.com"
    ]),
    tokens: [
      { symbol: "USDC", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6 },
      { symbol: "USDT", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", decimals: 6 }
    ]
  }
];

const args = new Set(process.argv.slice(2));
const requestedSource = valueArg("--source");
const forceFullScan = args.has("--full");

main().catch((error) => {
  console.error(`[wallet-scan] fatal: ${error?.stack || error?.message || error}`);
  process.exitCode = 1;
});

async function main() {
  if (args.has("--help") || args.has("-h")) {
    printHelp();
    return;
  }

  if (args.has("--watch")) {
    await runWatch();
    return;
  }

  const sources = selectedSources();
  for (const source of sources) await scanAndPersist(source);
}

async function runWatch() {
  const sources = selectedSources();
  let index = 0;
  console.log(`[wallet-scan] watch mode: ${sources.map((source) => source.id).join(" -> ")}, interval ${Math.round(WATCH_INTERVAL_MS / 1000)}s`);
  while (true) {
    await scanAndPersist(sources[index]);
    index = (index + 1) % sources.length;
    await sleep(WATCH_INTERVAL_MS);
  }
}

async function scanAndPersist(source) {
  const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 24 * 60 * 60;
  const state = await readState();
  const existingWallets = await readWalletsFile();
  seedExistingWallets(state, existingWallets, cutoff);

  console.log(`[wallet-scan] ${source.label}: scanning deposits >= ${MIN_USD} over last ${LOOKBACK_DAYS} days`);
  const startedAt = Date.now();
  const deposits = await fetchDeposits(source, cutoff, state);
  const { added, touched } = upsertDeposits(state, source, deposits);
  const written = await writeActiveWallets(state, existingWallets, cutoff);
  await writeState(state);

  console.log(
    `[wallet-scan] ${source.label}: ${deposits.length} matching deposits, ${added} new wallets, ${touched} updated, ` +
    `${written.length} active wallets in file (${Math.round((Date.now() - startedAt) / 1000)}s)`
  );
}

async function fetchDeposits(source, cutoff, state) {
  if (!source.preferRpc) {
    try {
      return await fetchEtherscanDeposits(source, cutoff, state);
    } catch (error) {
      console.warn(`[wallet-scan] ${source.label}: Etherscan failed, using RPC fallback: ${error.message}`);
    }
  }
  return fetchRpcDeposits(source, cutoff, state);
}

async function fetchEtherscanDeposits(source, cutoff, state) {
  if (!ETHERSCAN_API_KEY) throw new Error("ETHERSCAN_API_KEY is empty");
  const deposits = [];
  const latest = await rpcBlockNumber(source);
  const cutoffBlock = await findBlockAtOrAfter(source, cutoff, latest).catch(() => 0);

  for (const token of source.tokens) {
    const startBlock = startBlockForToken(state, source, token, cutoffBlock);
    let page = 1;
    let sawOlder = false;
    console.log(`[wallet-scan] ${source.label}: API ${token.symbol} blocks ${startBlock}..${latest}`);

    while (!sawOlder) {
      const url = new URL(ETHERSCAN_V2);
      url.search = new URLSearchParams({
        chainid: source.chainId,
        module: "account",
        action: "tokentx",
        address: source.depositAddress,
        contractaddress: token.address,
        startblock: String(startBlock),
        endblock: String(latest),
        page: String(page),
        offset: String(PAGE_SIZE),
        sort: "desc",
        apikey: ETHERSCAN_API_KEY
      });

      const payload = await fetchJson(url);
      if (payload.status === "0") {
        if (String(payload.result || "").toLowerCase().includes("no transactions found")) break;
        throw new Error(String(payload.result || payload.message || "NOTOK"));
      }
      if (!Array.isArray(payload.result)) throw new Error(`unexpected API response: ${JSON.stringify(payload).slice(0, 180)}`);

      for (const tx of payload.result) {
        const timestamp = Number(tx.timeStamp || 0);
        if (timestamp < cutoff) {
          sawOlder = true;
          continue;
        }
        const parsed = parseTransferLike(source, token, {
          from: tx.from,
          to: tx.to,
          value: tx.value,
          timestamp,
          hash: tx.hash,
          blockNumber: tx.blockNumber
        });
        if (parsed) deposits.push(parsed);
      }

      if (payload.result.length < PAGE_SIZE) break;
      page += 1;
      await sleep(250);
    }

    setScanProgress(state, source, token, latest);
  }

  return deposits;
}

async function fetchRpcDeposits(source, cutoff, state) {
  const deposits = [];
  const latest = await rpcBlockNumber(source);
  const cutoffBlock = await findBlockAtOrAfter(source, cutoff, latest);

  for (const token of source.tokens) {
    const startBlock = startBlockForToken(state, source, token, cutoffBlock);
    console.log(`[wallet-scan] ${source.label}: RPC ${token.symbol} blocks ${startBlock}..${latest}`);
    let fromBlock = startBlock;
    let span = source.rpcMaxBlockSpan;

    while (fromBlock <= latest) {
      const toBlock = Math.min(latest, fromBlock + span - 1);
      try {
        const logs = await rpcGetLogs(source, {
          address: token.address,
          fromBlock: hex(fromBlock),
          toBlock: hex(toBlock),
          topics: [TRANSFER_TOPIC, null, addressTopic(source.depositAddress)]
        });

        for (const log of logs) {
          const from = topicAddress(log.topics?.[1]);
          const parsed = parseTransferLike(source, token, {
            from,
            to: source.depositAddress,
            value: BigInt(log.data || "0x0").toString(),
            timestamp: 0,
            hash: log.transactionHash,
            blockNumber: String(Number.parseInt(log.blockNumber, 16))
          });
          if (!parsed) continue;
          const block = await rpcBlockByNumber(source, Number.parseInt(log.blockNumber, 16));
          parsed.timestamp = Number.parseInt(block.timestamp, 16);
          if (parsed.timestamp >= cutoff) deposits.push(parsed);
        }

        fromBlock = toBlock + 1;
        await sleep(80);
      } catch (error) {
        if (span <= 100) throw error;
        span = Math.max(100, Math.floor(span / 2));
        console.warn(`[wallet-scan] ${source.label}: reducing RPC block span to ${span} after: ${error.message}`);
      }
    }

    setScanProgress(state, source, token, latest);
  }

  return deposits;
}

function parseTransferLike(source, token, tx) {
  const from = normalizeAddress(tx.from);
  const to = normalizeAddress(tx.to);
  if (!from || !to) return null;
  if (to !== normalizeAddress(source.depositAddress)) return null;
  if (from === to || from === ZERO_ADDRESS) return null;

  const valueRaw = toBigInt(tx.value);
  if (valueRaw < minRaw(token.decimals)) return null;

  return {
    wallet: from,
    source: source.id,
    chainId: source.chainId,
    token: token.symbol,
    tokenAddress: normalizeAddress(token.address),
    depositAddress: normalizeAddress(source.depositAddress),
    valueRaw: valueRaw.toString(),
    amount: Number(valueRaw) / 10 ** token.decimals,
    timestamp: Number(tx.timestamp || 0),
    hash: tx.hash,
    blockNumber: String(tx.blockNumber || "")
  };
}

function upsertDeposits(state, source, deposits) {
  let added = 0;
  let touched = 0;

  for (const deposit of deposits) {
    const now = Math.floor(Date.now() / 1000);
    const wallet = state.wallets[deposit.wallet] || {
      address: deposit.wallet,
      firstSeen: deposit.timestamp || now,
      lastSeen: 0,
      sources: {}
    };

    if (!state.wallets[deposit.wallet]) added += 1;
    else touched += 1;

    wallet.lastSeen = Math.max(Number(wallet.lastSeen || 0), deposit.timestamp || now);
    wallet.sources[source.id] = {
      lastSeen: Math.max(Number(wallet.sources?.[source.id]?.lastSeen || 0), deposit.timestamp || now),
      chainId: source.chainId,
      token: deposit.token,
      tokenAddress: deposit.tokenAddress,
      depositAddress: deposit.depositAddress,
      amount: deposit.amount,
      txHash: deposit.hash,
      blockNumber: deposit.blockNumber
    };
    state.wallets[deposit.wallet] = wallet;
  }

  state.updatedAt = new Date().toISOString();
  return { added, touched };
}

function seedExistingWallets(state, wallets, cutoff) {
  const now = Math.floor(Date.now() / 1000);
  for (const wallet of wallets) {
    if (state.wallets[wallet]) continue;
    state.wallets[wallet] = {
      address: wallet,
      firstSeen: now,
      lastSeen: Math.max(now, cutoff),
      legacy: true,
      sources: {}
    };
  }
}

async function writeActiveWallets(state, existingWallets, cutoff) {
  const active = new Set();
  for (const [address, row] of Object.entries(state.wallets || {})) {
    if (Number(row.lastSeen || 0) >= cutoff) active.add(address);
    else delete state.wallets[address];
  }

  const ordered = [];
  const seen = new Set();
  for (const wallet of existingWallets) {
    if (active.has(wallet) && !seen.has(wallet)) {
      ordered.push(wallet);
      seen.add(wallet);
    }
  }
  for (const wallet of Object.keys(state.wallets || {}).sort()) {
    if (!seen.has(wallet)) {
      ordered.push(wallet);
      seen.add(wallet);
    }
  }

  await mkdir(path.dirname(WALLETS_FILE), { recursive: true });
  await atomicWrite(WALLETS_FILE, ordered.length ? `${ordered.join("\n")}\n` : "");
  return ordered;
}

async function readWalletsFile() {
  const text = await readFile(WALLETS_FILE, "utf8").catch(() => "");
  const wallets = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const address = normalizeAddress(line.trim());
    if (address && !seen.has(address)) {
      wallets.push(address);
      seen.add(address);
    }
  }
  return wallets;
}

async function readState() {
  const text = await readFile(STATE_FILE, "utf8").catch(() => "");
  if (!text.trim()) return { version: 1, wallets: {}, scanProgress: {} };
  try {
    const parsed = JSON.parse(text);
    return { version: 1, wallets: {}, scanProgress: {}, ...parsed, wallets: parsed.wallets || {}, scanProgress: parsed.scanProgress || {} };
  } catch {
    return { version: 1, wallets: {}, scanProgress: {} };
  }
}

async function writeState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  await atomicWrite(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "accept": "application/json",
      "user-agent": "asterdex-wallet-scanner/1.0",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON: ${text.slice(0, 180)}`);
  }
}

async function rpcCall(source, method, params) {
  const errors = [];
  for (const rpcUrl of source.rpcUrls) {
    try {
      const payload = await fetchJson(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
      });
      if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
      return payload.result;
    } catch (error) {
      errors.push(`${rpcUrl}: ${error.message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

async function rpcBlockNumber(source) {
  return Number.parseInt(await rpcCall(source, "eth_blockNumber", []), 16);
}

async function rpcBlockByNumber(source, blockNumber) {
  return rpcCall(source, "eth_getBlockByNumber", [hex(blockNumber), false]);
}

async function rpcGetLogs(source, filter) {
  const logs = await rpcCall(source, "eth_getLogs", [filter]);
  return Array.isArray(logs) ? logs : [];
}

async function findBlockAtOrAfter(source, timestamp, latest) {
  let low = Math.max(0, latest - Math.ceil((Date.now() / 1000 - timestamp) / source.avgBlockSec * 1.4));
  let high = latest;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const block = await rpcBlockByNumber(source, mid);
    const blockTs = Number.parseInt(block.timestamp, 16);
    if (blockTs < timestamp) low = mid + 1;
    else high = mid;
  }

  return low;
}

function selectedSources() {
  if (!requestedSource) return SOURCES;
  const source = SOURCES.find((item) => item.id === requestedSource.toLowerCase());
  if (!source) throw new Error(`unknown --source ${requestedSource}; use one of: ${SOURCES.map((item) => item.id).join(", ")}`);
  return [source];
}

function startBlockForToken(state, source, token, cutoffBlock) {
  if (forceFullScan) return cutoffBlock;
  const tokenKey = normalizeAddress(token.address);
  const progress = state.scanProgress?.[source.id]?.[tokenKey];
  const last = Number(progress?.lastScannedBlock || 0);
  if (!last) return cutoffBlock;
  return Math.max(cutoffBlock, last - SCAN_OVERLAP_BLOCKS);
}

function setScanProgress(state, source, token, latest) {
  state.scanProgress ||= {};
  state.scanProgress[source.id] ||= {};
  state.scanProgress[source.id][normalizeAddress(token.address)] = {
    lastScannedBlock: latest,
    lastScannedAt: new Date().toISOString()
  };
}

function valueArg(name) {
  const prefix = `${name}=`;
  const arg = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function envAddress(name, fallback) {
  return normalizeAddress(process.env[name] || fallback);
}

function envList(name, fallback) {
  const raw = process.env[name];
  return raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : fallback;
}

function normalizeAddress(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(text) ? text : "";
}

function addressTopic(address) {
  return `0x${normalizeAddress(address).slice(2).padStart(64, "0")}`;
}

function topicAddress(topic) {
  const text = String(topic || "").toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(text) ? `0x${text.slice(26)}` : "";
}

function minRaw(decimals) {
  return BigInt(Math.trunc(MIN_USD)) * 10n ** BigInt(decimals);
}

function toBigInt(value) {
  const text = String(value || "0");
  return text.startsWith("0x") ? BigInt(text) : BigInt(text.replace(/\D/g, "") || "0");
}

function hex(value) {
  return `0x${Math.trunc(Number(value)).toString(16)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`
Usage:
  node scripts/fetch_deposit_wallets.mjs
  node scripts/fetch_deposit_wallets.mjs --source=bsc
  node scripts/fetch_deposit_wallets.mjs --full
  node scripts/fetch_deposit_wallets.mjs --watch

Environment:
  ETHERSCAN_API_KEY                    Etherscan V2 key for ETH/ARB
  ASTERDEX_WALLET_LOOKBACK_DAYS=200    Retention and scan window
  ASTERDEX_MIN_DEPOSIT_USD=99000       Minimum USDT/USDC deposit amount
  ASTERDEX_WALLET_SCAN_INTERVAL_MS     Watch interval; default 10 minutes
  ASTERDEX_SCAN_OVERLAP_BLOCKS=25      Re-scan overlap for incremental mode
  ASTERDEX_ETH_DEPOSIT_ADDRESS         ETH deposit wallet; defaults to BSC wallet from the request
`);
}
